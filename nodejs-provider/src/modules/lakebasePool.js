/**
 * lakebasePool.js
 * Manages PostgreSQL connection pools for Lakebase (Databricks managed PostgreSQL)
 *
 * Each editable service gets its own pool keyed by "host:port/database".
 * Uses the `pg` module's built-in Pool (connection pooling, health checks, etc.).
 *
 * Auth: Automatically generates short-lived OAuth tokens via the Databricks
 * /api/2.0/database/credentials endpoint using DATABRICKS_ACCESS_TOKEN (PAT).
 * Falls back to LAKEBASE_PASSWORD env var if set explicitly.
 */

const { Pool } = require('pg');
const https = require('https');
const pkg = require('../../package.json');

// Map of serviceKey -> { pool, tokenExpiry }
const pools = {};

// Cache of hostname -> instanceName (doesn't change, so cache permanently)
const instanceNameCache = {};

// Token buffer: refresh 5 minutes before expiry
const TOKEN_BUFFER_MS = 5 * 60 * 1000;

/**
 * Build a unique key for a Lakebase service configuration.
 */
function serviceKey(config) {
  return `${config.host}:${config.port || 5432}/${config.database}`;
}

/**
 * Make an HTTPS request to the Databricks workspace API.
 * @returns {Promise<object>} Parsed JSON response
 */
function databricksApiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const workspaceHost = process.env.DATABRICKS_SERVER_HOSTNAME;
    const pat = process.env.DATABRICKS_ACCESS_TOKEN;

    if (!workspaceHost || !pat) {
      return reject(new Error(
        'DATABRICKS_SERVER_HOSTNAME and DATABRICKS_ACCESS_TOKEN are required for Lakebase token generation'
      ));
    }

    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: workspaceHost,
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      rejectUnauthorized: false,
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
 * We list all instances and match by read_write_dns.
 */
async function resolveInstanceName(host) {
  if (instanceNameCache[host]) {
    return instanceNameCache[host];
  }

  const response = await databricksApiRequest('GET', '/api/2.0/database/instances');
  const instances = response.database_instances || [];

  for (const inst of instances) {
    if (inst.read_write_dns === host || inst.read_only_dns === host) {
      instanceNameCache[host] = inst.name;
      return inst.name;
    }
  }

  throw new Error(
    `No Lakebase instance found with hostname "${host}". ` +
    'Set LAKEBASE_PASSWORD env var for manual auth, or add LAKEBASE_INSTANCE_NAME.'
  );
}

/**
 * Generate a fresh Lakebase database credential via Databricks REST API.
 *
 * @param {string} instanceName - Lakebase instance name
 * @returns {Promise<{token: string, expiration_time: string}>}
 */
async function generateDatabaseCredential(instanceName) {
  const result = await databricksApiRequest('POST', '/api/2.0/database/credentials', {
    request_id: `cdf-${Date.now()}`,
    instance_names: [instanceName],
  });

  if (!result.token) {
    throw new Error(`No token in credential response: ${JSON.stringify(result).substring(0, 200)}`);
  }

  return result;
}

/**
 * Get a fresh Lakebase password. Tries auto-generation first, falls back to env var.
 *
 * @param {string} host - Lakebase hostname
 * @returns {Promise<{password: string, expiry: number|null}>}
 */
async function getLakebasePassword(host) {
  // If LAKEBASE_PASSWORD is explicitly set, use it (static token or native password)
  if (process.env.LAKEBASE_PASSWORD) {
    return { password: process.env.LAKEBASE_PASSWORD, expiry: null };
  }

  // Resolve instance name from hostname (or use env var override)
  const instanceName = process.env.LAKEBASE_INSTANCE_NAME || await resolveInstanceName(host);

  console.log(`[LakebasePool] Generating fresh credential for instance "${instanceName}"...`);
  const cred = await generateDatabaseCredential(instanceName);
  const expiry = cred.expiration_time
    ? new Date(cred.expiration_time).getTime()
    : Date.now() + 55 * 60 * 1000; // Default 55 min if no expiry provided

  console.log(`[LakebasePool] Token generated, expires: ${cred.expiration_time || 'unknown'}`);
  return { password: cred.token, expiry };
}

/**
 * Check if a pool's token is expired or about to expire.
 */
function isTokenExpired(key) {
  const entry = pools[key];
  if (!entry || !entry.tokenExpiry) return false; // No expiry tracked = static password
  return Date.now() >= (entry.tokenExpiry - TOKEN_BUFFER_MS);
}

/**
 * Get or create a pg.Pool for a given Lakebase service config.
 * Automatically refreshes expired tokens by recreating the pool.
 *
 * @param {object} config
 * @param {string} config.host     - Lakebase hostname
 * @param {number} [config.port=5432] - Lakebase port
 * @param {string} config.database - Database name
 * @param {string} [config.user]   - Username
 * @returns {Promise<Pool>}
 */
async function getLakebasePool(config) {
  const key = serviceKey(config);

  // Return existing pool if token is still valid
  if (pools[key] && !isTokenExpired(key)) {
    return pools[key].pool;
  }

  // Token expired — close old pool and create new one
  if (pools[key]) {
    console.log(`[LakebasePool] Token expired for ${key}, refreshing...`);
    try {
      await pools[key].pool.end();
    } catch (err) {
      console.error(`[LakebasePool] Error closing expired pool ${key}:`, err.message);
    }
    delete pools[key];
  }

  const { password, expiry } = await getLakebasePassword(config.host);

  const sslVerify = process.env.LAKEBASE_SSL_VERIFY === 'true';
  const poolMin = parseInt(process.env.LAKEBASE_POOL_MIN) || 2;
  const poolMax = parseInt(process.env.LAKEBASE_POOL_MAX) || 10;

  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user: config.user || process.env.LAKEBASE_USER || 'databricks',
    password,
    ssl: { rejectUnauthorized: sslVerify },
    application_name: `esri_databricks-lakebase-customdatafeed/${pkg.version}`,
    min: poolMin,
    max: poolMax,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error(`[LakebasePool] Unexpected error on idle client (${key}):`, err.message);
    // If auth error, invalidate pool so next request triggers refresh
    if (err.message && err.message.includes('authorization')) {
      console.log(`[LakebasePool] Auth error detected, invalidating pool ${key}`);
      delete pools[key];
    }
  });

  pools[key] = { pool, tokenExpiry: expiry };
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
