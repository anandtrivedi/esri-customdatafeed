/**
 * lakebasePool.js
 * Manages PostgreSQL connection pools for Lakebase (Databricks managed PostgreSQL)
 *
 * Each editable service gets its own pool keyed by
 *   "${workspaceAlias}|${host}:${port}/${database}"
 *
 * Auth: Mints short-lived Lakebase OAuth tokens via the Databricks
 * /api/2.0/database/credentials endpoint (Provisioned instances) or
 * /api/2.0/postgres/credentials (Autoscaling endpoints). The credentials API itself is
 * authenticated using the resolved workspace profile:
 *   - PAT profiles:        Authorization: Bearer <pat>
 *   - OAuth M2M profiles:  exchange client_id+client_secret at /oidc/v1/token
 *                          for a workspace API token, then use as Bearer.
 *
 * Falls back to LAKEBASE_PASSWORD env var if set explicitly (skips token
 * generation entirely; useful for static test creds).
 */

const { Pool } = require('pg');
const https = require('https');
const { applicationName } = require('./version');

// Map of serviceKey -> { pool, tokenExpiry, workspaceConfig }
const pools = {};

// Single-flight guard: serviceKey -> in-flight Promise<Pool> currently (re)creating that pool.
// Without this, two concurrent requests for the same key when the pool is absent or its token
// has expired both pass the fast-path guard, both mint a credential + build a pg.Pool, and the
// second overwrites the first in `pools` — orphaning the first pool (its idle connections never
// close, it's not in `pools` for shutdown, and its token never refreshes).
const poolsCreating = {};

// Cache of `${workspaceAlias}|${host}` -> instanceName (doesn't change per workspace)
const instanceNameCache = {};

// Cache of workspaceAlias -> { token, expiry } for OAuth M2M workspace API tokens
const workspaceApiTokenCache = {};

// Token buffer: refresh 5 minutes before expiry
const TOKEN_BUFFER_MS = 5 * 60 * 1000;

// TLS verification for Databricks REST API calls (/oidc/v1/token, /api/2.0/database/*).
// These target *.cloud.databricks.com with publicly-trusted certs, so verification
// is on by default. Set DATABRICKS_API_SSL_VERIFY=false only behind a
// TLS-intercepting proxy with an untrusted CA.
function apiTlsVerify() {
  return process.env.DATABRICKS_API_SSL_VERIFY !== 'false';
}

/**
 * Build a unique pool key. Includes workspace alias so two services
 * pointing at the same Lakebase host but using different workspace
 * profiles get distinct pools (extreme edge case but safe).
 */
function serviceKey(config) {
  const alias = config.workspaceConfig ? config.workspaceConfig.workspaceAlias : 'default';
  return `${alias}|${config.host}:${config.port || 5432}/${config.database}`;
}

function instanceCacheKey(workspaceAlias, host) {
  return `${workspaceAlias}|${host}`;
}

/**
 * Mint an OAuth M2M workspace API token via /oidc/v1/token.
 * Uses the Client Credentials grant. Tokens cached per workspaceAlias.
 */
function mintWorkspaceApiToken(workspaceConfig) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(
      `${workspaceConfig.clientId}:${workspaceConfig.clientSecret}`
    ).toString('base64');

    const body = 'grant_type=client_credentials&scope=all-apis';

    const options = {
      hostname: workspaceConfig.hostname,
      port: 443,
      path: '/oidc/v1/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: apiTlsVerify(),
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.access_token) {
              reject(new Error(`OAuth M2M response missing access_token: ${data.substring(0, 200)}`));
              return;
            }
            const expiresInMs = (parsed.expires_in || 3600) * 1000;
            resolve({ token: parsed.access_token, expiry: Date.now() + expiresInMs });
          } catch (e) {
            reject(new Error(`Failed to parse OAuth M2M response: ${e.message}`));
          }
        } else {
          reject(new Error(`OAuth M2M token endpoint returned ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`OAuth M2M token request failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Get a workspace API bearer token for the given workspace profile.
 * For PAT profiles, returns the static token. For OAuth M2M profiles,
 * mints (and caches) a short-lived workspace token.
 */
async function getWorkspaceApiToken(workspaceConfig) {
  if (workspaceConfig.authType === 'pat') {
    return workspaceConfig.token;
  }

  const alias = workspaceConfig.workspaceAlias;
  const cached = workspaceApiTokenCache[alias];
  if (cached && Date.now() < (cached.expiry - TOKEN_BUFFER_MS)) {
    return cached.token;
  }

  console.log(`[LakebasePool] Minting OAuth M2M workspace token for "${alias}"...`);
  const fresh = await mintWorkspaceApiToken(workspaceConfig);
  workspaceApiTokenCache[alias] = fresh;
  console.log(`[LakebasePool] Workspace token cached for "${alias}", expires in ${Math.round((fresh.expiry - Date.now()) / 60000)}m`);
  return fresh.token;
}

/**
 * Make an HTTPS request to the Databricks workspace API.
 *
 * @param {string} method - HTTP method
 * @param {string} path   - API path (e.g. /api/2.0/database/instances)
 * @param {object|null} body - Optional JSON body
 * @param {object} workspaceConfig - Resolved workspace profile (hostname + auth)
 * @returns {Promise<object>} Parsed JSON response
 */
async function databricksApiRequest(method, path, body, workspaceConfig) {
  if (!workspaceConfig) {
    throw new Error('databricksApiRequest requires a workspaceConfig');
  }

  const apiToken = await getWorkspaceApiToken(workspaceConfig);

  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: workspaceConfig.hostname,
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      rejectUnauthorized: apiTlsVerify(),
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse API response: ${e.message}`));
          }
        } else {
          reject(new Error(`Databricks API ${path} returned ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Databricks API request failed: ${err.message}`));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Look up the Lakebase instance name from its hostname.
 * The hostname format is: instance-{uuid}.database.cloud.databricks.com
 * We list all instances visible to this workspace and match by read_write_dns.
 */
async function resolveInstanceName(host, workspaceConfig) {
  const cacheKey = instanceCacheKey(workspaceConfig.workspaceAlias, host);
  if (instanceNameCache[cacheKey]) {
    return instanceNameCache[cacheKey];
  }

  const response = await databricksApiRequest('GET', '/api/2.0/database/instances', null, workspaceConfig);
  const instances = response.database_instances || [];

  for (const inst of instances) {
    if (inst.read_write_dns === host || inst.read_only_dns === host) {
      instanceNameCache[cacheKey] = inst.name;
      return inst.name;
    }
  }

  throw new Error(
    `No Lakebase instance found with hostname "${host}" in workspace "${workspaceConfig.workspaceAlias}". ` +
    'Set LAKEBASE_PASSWORD env var for manual auth, or add LAKEBASE_INSTANCE_NAME.'
  );
}

/**
 * Generate a fresh Lakebase database credential via Databricks REST API.
 */
async function generateDatabaseCredential(instanceName, workspaceConfig) {
  const result = await databricksApiRequest(
    'POST',
    '/api/2.0/database/credentials',
    {
      request_id: `cdf-${Date.now()}`,
      instance_names: [instanceName],
    },
    workspaceConfig
  );

  if (!result.token) {
    throw new Error(`No token in credential response: ${JSON.stringify(result).substring(0, 200)}`);
  }

  return result;
}

// Cache of `${workspaceAlias}|${host}` -> Autoscaling endpoint resource name
const endpointNameCache = {};

/** GET every page of a /api/2.0/postgres list call and return the items under `field`. */
async function listAllPages(path, field, workspaceConfig) {
  const items = [];
  let pageToken = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = pageToken ? `${path}${sep}page_token=${encodeURIComponent(pageToken)}` : path;
    const response = await databricksApiRequest('GET', url, null, workspaceConfig);
    items.push(...(response[field] || []));
    pageToken = response.next_page_token || null;
  } while (pageToken);
  return items;
}

function endpointServesHost(ep, host) {
  const hosts = (ep && ep.status && ep.status.hosts) || {};
  return hosts.host === host || hosts.read_write_pooled_host === host;
}

/**
 * Find the Autoscaling endpoint resource name (projects/{p}/branches/{b}/endpoints/{e}) whose direct or pooled
 * host matches. LAKEBASE_ENDPOINT_NAME skips the scan in workspaces with many projects — but it is process-wide,
 * so it's only used when that endpoint really serves this host; other services' hosts still get scanned.
 */
async function resolveEndpointName(host, workspaceConfig) {
  const cacheKey = instanceCacheKey(workspaceConfig.workspaceAlias, host);
  if (endpointNameCache[cacheKey]) {
    return endpointNameCache[cacheKey];
  }
  const override = process.env.LAKEBASE_ENDPOINT_NAME;
  if (override) {
    try {
      const ep = await databricksApiRequest('GET', `/api/2.0/postgres/${override}`, null, workspaceConfig);
      if (endpointServesHost(ep, host)) {
        endpointNameCache[cacheKey] = override;
        return override;
      }
      console.log(`[LakebasePool] LAKEBASE_ENDPOINT_NAME "${override}" doesn't serve "${host}"; scanning projects`);
    } catch (err) {
      console.log(`[LakebasePool] LAKEBASE_ENDPOINT_NAME lookup failed (${err.message}); scanning projects`);
    }
  }

  // One unreadable project or branch (no permission, transient error) is skipped, not fatal: the endpoint may be
  // in a later one. The skips are reported if nothing matches.
  const projects = await listAllPages('/api/2.0/postgres/projects', 'projects', workspaceConfig);
  const skipped = [];
  for (const project of projects) {
    let branches;
    try {
      branches = await listAllPages(`/api/2.0/postgres/${project.name}/branches`, 'branches', workspaceConfig);
    } catch (err) {
      skipped.push(`${project.name} (${err.message.substring(0, 80)})`);
      continue;
    }
    for (const branch of branches) {
      let endpoints;
      try {
        endpoints = await listAllPages(`/api/2.0/postgres/${branch.name}/endpoints`, 'endpoints', workspaceConfig);
      } catch (err) {
        skipped.push(`${branch.name} (${err.message.substring(0, 80)})`);
        continue;
      }
      for (const ep of endpoints) {
        if (endpointServesHost(ep, host)) {
          endpointNameCache[cacheKey] = ep.name;
          return ep.name;
        }
      }
    }
  }
  if (skipped.length) {
    console.log(`[LakebasePool] Endpoint scan skipped ${skipped.length} unreadable project(s)/branch(es): ${skipped.slice(0, 3).join('; ')}`);
  }

  throw new Error(
    `No Lakebase Autoscaling endpoint found with hostname "${host}" in workspace "${workspaceConfig.workspaceAlias}"` +
    (skipped.length ? ` (${skipped.length} project(s)/branch(es) couldn't be read)` : '') + '. ' +
    'Set LAKEBASE_ENDPOINT_NAME (projects/<p>/branches/<b>/endpoints/<e>) or LAKEBASE_PASSWORD.'
  );
}

/**
 * Generate a Lakebase Autoscaling credential via /api/2.0/postgres/credentials.
 * Normalized to the Provisioned response shape ({ token, expiration_time }).
 */
async function generateEndpointCredential(endpointName, workspaceConfig) {
  const result = await databricksApiRequest(
    'POST',
    '/api/2.0/postgres/credentials',
    { endpoint: endpointName },
    workspaceConfig
  );
  if (!result.token) {
    throw new Error(`No token in credential response: ${JSON.stringify(result).substring(0, 200)}`);
  }
  return { token: result.token, expiration_time: result.expire_time };
}

/**
 * Get a fresh Lakebase password. Tries auto-generation first, falls back to env var.
 */
async function getLakebasePassword(host, workspaceConfig) {
  if (process.env.LAKEBASE_PASSWORD) {
    return { password: process.env.LAKEBASE_PASSWORD, expiry: null };
  }

  if (!workspaceConfig) {
    throw new Error('Cannot generate Lakebase token: workspaceConfig is required');
  }

  // Provisioned instances and Autoscaling endpoints both use ep-*.database.* hostnames now, so the host alone
  // can't tell them apart: look for a Provisioned instance first, then an Autoscaling endpoint. A host already
  // known to be an Autoscaling endpoint skips the Provisioned lookup on every later refresh.
  // LAKEBASE_INSTANCE_NAME is only a fallback when the host isn't visible to the workspace (e.g. cross-account DNS);
  // a value of the form projects/.../endpoints/... is treated as an Autoscaling endpoint name.
  // Lookup failures fall through to the next option; a MINT failure is reported as-is (never masked by a fallback).
  const cacheKey = instanceCacheKey(workspaceConfig.workspaceAlias, host);
  let endpointName = endpointNameCache[cacheKey] || null;
  let instanceName = null;
  if (!endpointName) {
    try {
      instanceName = await resolveInstanceName(host, workspaceConfig);
    } catch (instanceErr) {
      try {
        endpointName = await resolveEndpointName(host, workspaceConfig);
      } catch (endpointErr) {
        const fallback = process.env.LAKEBASE_INSTANCE_NAME;
        if (!fallback) {
          throw new Error(`${instanceErr.message} Autoscaling lookup also failed: ${endpointErr.message}`);
        }
        console.log(`[LakebasePool] Host lookup failed (${instanceErr.message}; ${endpointErr.message}); falling back to LAKEBASE_INSTANCE_NAME`);
        if (fallback.startsWith('projects/')) endpointName = fallback;
        else instanceName = fallback;
      }
    }
  }

  let cred;
  try {
    if (endpointName) {
      console.log(`[LakebasePool] Generating fresh credential for Autoscaling endpoint "${endpointName}" via workspace "${workspaceConfig.workspaceAlias}"...`);
      cred = await generateEndpointCredential(endpointName, workspaceConfig);
    } else {
      console.log(`[LakebasePool] Generating fresh credential for instance "${instanceName}" via workspace "${workspaceConfig.workspaceAlias}"...`);
      cred = await generateDatabaseCredential(instanceName, workspaceConfig);
    }
  } catch (mintErr) {
    // Forget the host's resolution so the next request re-resolves it (the instance or endpoint may have been
    // recreated under a new name), instead of re-minting against a stale name until a restart.
    delete endpointNameCache[cacheKey];
    delete instanceNameCache[cacheKey];
    throw mintErr;
  }

  const expiry = cred.expiration_time
    ? new Date(cred.expiration_time).getTime()
    : Date.now() + 55 * 60 * 1000;

  console.log(`[LakebasePool] Token generated, expires: ${cred.expiration_time || 'unknown'}`);
  return { password: cred.token, expiry };
}

function isTokenExpired(key) {
  const entry = pools[key];
  if (!entry || !entry.tokenExpiry) return false;
  return Date.now() >= (entry.tokenExpiry - TOKEN_BUFFER_MS);
}

/**
 * Get or create a pg.Pool for a given Lakebase service config.
 * Automatically refreshes expired tokens by recreating the pool.
 *
 * @param {object} config
 * @param {object} config.workspaceConfig - Resolved workspace profile (required unless LAKEBASE_PASSWORD is set)
 * @param {string} config.host     - Lakebase hostname
 * @param {number} [config.port=5432] - Lakebase port
 * @param {string} config.database - Database name
 * @param {string} [config.user]   - Username
 * @returns {Promise<Pool>}
 */
async function getLakebasePool(config) {
  const key = serviceKey(config);

  if (pools[key] && !isTokenExpired(key)) {
    return pools[key].pool;
  }

  // Single-flight: if another request is already (re)creating this pool, await THAT one
  // instead of building a second. There is no `await` between this check and the assignment
  // below, so the check + set are atomic on the event loop — no window for two creations.
  if (poolsCreating[key]) {
    return poolsCreating[key];
  }

  const creation = createLakebasePool(key, config);
  poolsCreating[key] = creation;
  try {
    return await creation;
  } finally {
    delete poolsCreating[key];
  }
}

// Cache of workspaceAlias -> PAT owner's username (from SCIM /Me)
const tokenOwnerCache = {};

/** Username that owns the workspace PAT — the identity a minted Lakebase credential belongs to. */
async function resolveTokenOwner(workspaceConfig) {
  const alias = workspaceConfig.workspaceAlias;
  if (tokenOwnerCache[alias]) return tokenOwnerCache[alias];
  try {
    const me = await databricksApiRequest('GET', '/api/2.0/preview/scim/v2/Me', null, workspaceConfig);
    // A service principal's Postgres role is its application id (same as the OAuth M2M path), even if /Me also
    // carries a userName for it.
    const owner = me.applicationId || me.userName || null;
    if (owner) tokenOwnerCache[alias] = owner;
    return owner;
  } catch (err) {
    throw new Error(
      `Couldn't determine the Postgres user for PAT workspace "${alias}" (SCIM /Me failed: ${err.message}). ` +
      'Set LAKEBASE_USER to the Databricks username that owns the token.'
    );
  }
}

/**
 * Postgres role to log in as. A minted Lakebase credential belongs to the workspace identity, so the role must
 * be that identity: the SP's client id for OAuth M2M, the PAT owner for PAT profiles (otherwise
 * "password authentication failed for user 'databricks'"). An explicit LAKEBASE_USER still wins over the lookup
 * (and is the native-login role when LAKEBASE_PASSWORD is a static password). If the PAT owner can't be determined
 * the pool fails with an actionable error rather than guessing a role that can't work.
 */
async function resolvePgUser(config) {
  const ws = config.workspaceConfig;
  if (config.user) return config.user;
  if (ws && ws.authType === 'oauth-m2m' && ws.clientId) return ws.clientId;
  if (process.env.LAKEBASE_USER) return process.env.LAKEBASE_USER;
  if (ws && ws.authType === 'pat' && !process.env.LAKEBASE_PASSWORD) {
    const owner = await resolveTokenOwner(ws);
    if (owner) return owner;
    throw new Error(`SCIM /Me for PAT workspace "${ws.workspaceAlias}" returned no username. Set LAKEBASE_USER.`);
  }
  return 'databricks';
}

/**
 * Actually (re)create the pg.Pool for a key: close any expired pool, mint a credential,
 * build the pool, and register it in `pools`. Only ever run one-at-a-time per key via the
 * single-flight guard in getLakebasePool().
 */
async function createLakebasePool(key, config) {
  if (pools[key]) {
    console.log(`[LakebasePool] Token expired for ${key}, refreshing...`);
    try {
      await pools[key].pool.end();
    } catch (err) {
      console.error(`[LakebasePool] Error closing expired pool ${key}:`, err.message);
    }
    delete pools[key];
  }

  const { password, expiry } = await getLakebasePassword(config.host, config.workspaceConfig);
  const user = await resolvePgUser(config);

  const sslVerify = process.env.LAKEBASE_SSL_VERIFY === 'true';
  const poolMin = parseInt(process.env.LAKEBASE_POOL_MIN) || 2;
  const poolMax = parseInt(process.env.LAKEBASE_POOL_MAX) || 10;

  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user,
    password,
    ssl: { rejectUnauthorized: sslVerify },
    application_name: applicationName('esri_databricks-lakebase-customdatafeed'),
    min: poolMin,
    max: poolMax,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error(`[LakebasePool] Unexpected error on idle client (${key}):`, err.message);
    if (err.message && err.message.includes('authorization')) {
      console.log(`[LakebasePool] Auth error detected, invalidating pool ${key}`);
      delete pools[key];
    }
  });

  pools[key] = { pool, tokenExpiry: expiry, workspaceConfig: config.workspaceConfig };
  console.log(`[LakebasePool] Pool created for ${key}`);

  return pool;
}

/**
 * Shut down all Lakebase pools gracefully.
 */
async function shutdownLakebasePools() {
  const keys = Object.keys(pools);
  for (const key of keys) {
    try {
      await pools[key].pool.end();
      console.log(`[LakebasePool] Pool ${key} closed`);
    } catch (err) {
      console.error(`[LakebasePool] Error closing pool ${key}:`, err.message);
    }
    delete pools[key];
  }
}

module.exports = {
  getLakebasePool,
  shutdownLakebasePools,
};
