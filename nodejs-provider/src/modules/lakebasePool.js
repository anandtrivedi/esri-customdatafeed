/**
 * lakebasePool.js
 * Manages PostgreSQL connection pools for Lakebase (Databricks managed PostgreSQL)
 *
 * Each editable service gets its own pool keyed by "host:port/database".
 * Uses the `pg` module's built-in Pool (connection pooling, health checks, etc.).
 *
 * Auth: LAKEBASE_PASSWORD env var (Databricks OAuth token or service principal secret).
 */

const { Pool } = require('pg');

// Map of serviceKey -> pg.Pool
const pools = {};

/**
 * Build a unique key for a Lakebase service configuration.
 * @param {object} config - { host, port, database, schema, table, user }
 * @returns {string}
 */
function serviceKey(config) {
  return `${config.host}:${config.port || 5432}/${config.database}`;
}

/**
 * Get or create a pg.Pool for a given Lakebase service config.
 *
 * @param {object} config
 * @param {string} config.host     - Lakebase hostname
 * @param {number} [config.port=5432] - Lakebase port
 * @param {string} config.database - Database name
 * @param {string} [config.user='databricks'] - Username
 * @returns {Pool}
 */
function getLakebasePool(config) {
  const key = serviceKey(config);

  if (pools[key]) {
    return pools[key];
  }

  const password = process.env.LAKEBASE_PASSWORD;
  if (!password) {
    throw new Error('LAKEBASE_PASSWORD environment variable is required for Lakebase connections');
  }

  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user: config.user || 'databricks',
    password,
    ssl: { rejectUnauthorized: false },
    min: 2,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error(`[LakebasePool] Unexpected error on idle client (${key}):`, err.message);
  });

  pools[key] = pool;
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
      await pools[key].end();
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
