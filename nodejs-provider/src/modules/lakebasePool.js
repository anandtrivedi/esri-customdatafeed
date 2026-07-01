/**
 * lakebasePool.js
 * Manages PostgreSQL connection pools for Lakebase (Databricks managed PostgreSQL)
 *
 * Each editable service gets its own pool keyed by
 *   "${workspaceAlias}|${host}:${port}/${database}"
 *
 * Auth: Mints short-lived Lakebase OAuth tokens via the Databricks
 * /api/2.0/database/credentials endpoint. The credentials API itself is
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

  // Resolve the instance from the service's lakebaseHost so multiple services can
  // target different instances; LAKEBASE_INSTANCE_NAME is only a fallback when the
  // host isn't visible to the workspace (e.g. cross-account DNS).
  let instanceName;
  try {
    instanceName = await resolveInstanceName(host, workspaceConfig);
  } catch (err) {
    if (process.env.LAKEBASE_INSTANCE_NAME) {
      console.log(`[LakebasePool] Host lookup failed (${err.message}); falling back to LAKEBASE_INSTANCE_NAME`);
      instanceName = process.env.LAKEBASE_INSTANCE_NAME;
    } else {
      throw err;
    }
  }

  console.log(`[LakebasePool] Generating fresh credential for instance "${instanceName}" via workspace "${workspaceConfig.workspaceAlias}"...`);
  const cred = await generateDatabaseCredential(instanceName, workspaceConfig);
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

  const sslVerify = process.env.LAKEBASE_SSL_VERIFY === 'true';
  const poolMin = parseInt(process.env.LAKEBASE_POOL_MIN) || 2;
  const poolMax = parseInt(process.env.LAKEBASE_POOL_MAX) || 10;

  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    // Postgres role to log in as. For OAuth M2M (service principal) workspaces the
    // Lakebase credential is minted for the SP, so the pg role must be the SP's
    // client id — otherwise Postgres rejects it ("OAuth: User is not authorized").
    // PAT/default workspaces fall back to LAKEBASE_USER (a human/PAT identity).
    user: config.user
      || (config.workspaceConfig && config.workspaceConfig.authType === 'oauth-m2m' && config.workspaceConfig.clientId)
      || process.env.LAKEBASE_USER
      || 'databricks',
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
