/**
 * connectionPool.js
 * Manages reusable Databricks SQL connection pools, keyed per
 * (workspace, warehouse) pair.
 *
 * One DatabricksConnectionPool instance per unique
 *   `${workspaceAlias}|${httpPath}`
 * combination. Pools are created lazily on the first getPool() call
 * for a given key, and pre-warm `min` connections on construction.
 *
 * Auth modes (resolved per workspace profile):
 *   - PAT:        token in workspaceConfig
 *   - OAuth M2M:  client_id + client_secret in workspaceConfig
 *                 (the Node SQL driver handles token refresh internally)
 */

const { DBSQLClient } = require('@databricks/sql');
const { userAgentTag } = require('./version');

class DatabricksConnectionPool {
  constructor(workspaceConfig, httpPath, options = {}) {
    this.workspaceConfig = workspaceConfig;
    this.httpPath = httpPath;
    this.minConnections = options.min ?? 2;
    this.maxConnections = options.max ?? 10;
    this.idleTimeout = options.idleTimeout ?? 60000;
    this.connectionTimeout = options.connectionTimeout ?? 30000;

    this.pool = [];
    this.activeConnections = 0;
    this.waitQueue = [];
    this.shuttingDown = false;

    console.log(`[Pool ${this.poolLabel()}] Initialized (min: ${this.minConnections}, max: ${this.maxConnections})`);

    this.warmUp();
  }

  poolLabel() {
    return `${this.workspaceConfig.workspaceAlias}|${this.httpPath}`;
  }

  async warmUp() {
    if (this.minConnections === 0) return;
    try {
      const promises = [];
      for (let i = 0; i < this.minConnections; i++) {
        promises.push(this.createConnection());
      }
      await Promise.all(promises);
      console.log(`[Pool ${this.poolLabel()}] Warmed up with ${this.minConnections} connections`);
    } catch (error) {
      console.error(`[Pool ${this.poolLabel()}] Failed to warm up:`, error.message);
    }
  }

  async createConnection() {
    const client = new DBSQLClient();
    const baseOptions = {
      host: this.workspaceConfig.hostname,
      path: this.httpPath,
      userAgentEntry: userAgentTag('esri_databricks-customdatafeed'),
    };

    let connectOptions;
    if (this.workspaceConfig.authType === 'oauth-m2m') {
      connectOptions = {
        ...baseOptions,
        authType: 'databricks-oauth',
        oauthClientId: this.workspaceConfig.clientId,
        oauthClientSecret: this.workspaceConfig.clientSecret,
      };
    } else {
      connectOptions = {
        ...baseOptions,
        token: this.workspaceConfig.token,
      };
    }

    try {
      await client.connect(connectOptions);
      const session = await client.openSession();

      const connection = {
        client,
        session,
        inUse: false,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        id: Math.random().toString(36).substr(2, 9),
      };

      this.pool.push(connection);
      console.log(`[Pool ${this.poolLabel()}] Connection ${connection.id} created (pool size: ${this.pool.length})`);
      return connection;
    } catch (error) {
      console.error(`[Pool ${this.poolLabel()}] Failed to create connection:`, error.message);
      throw error;
    }
  }

  async acquire() {
    if (this.shuttingDown) {
      throw new Error('Connection pool is shutting down');
    }

    const available = this.pool.find((conn) => !conn.inUse);
    if (available) {
      available.inUse = true;
      available.lastUsed = Date.now();
      this.activeConnections++;
      return available;
    }

    if (this.pool.length < this.maxConnections) {
      const newConnection = await this.createConnection();
      newConnection.inUse = true;
      this.activeConnections++;
      return newConnection;
    }

    console.log(`[Pool ${this.poolLabel()}] Waiting for available connection (active: ${this.activeConnections}/${this.maxConnections})`);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.waitQueue.findIndex((item) => item.resolve === resolve);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new Error('Connection acquisition timeout'));
      }, this.connectionTimeout);

      this.waitQueue.push({ resolve, reject, timeoutId });
    });
  }

  release(connection, { destroy = false } = {}) {
    if (!connection) return;

    this.activeConnections--;

    if (destroy) {
      // The connection errored — its session may be dead (warehouse restart,
      // network drop). Close it instead of recycling, and refill for any waiters.
      this.destroyConnection(connection);
      this.refillForWaiters();
      return;
    }

    connection.inUse = false;
    connection.lastUsed = Date.now();

    if (this.waitQueue.length > 0) {
      const { resolve, timeoutId } = this.waitQueue.shift();
      clearTimeout(timeoutId);
      connection.inUse = true;
      this.activeConnections++;
      resolve(connection);
    }

    this.cleanupIdleConnections();
  }

  // After a connection is destroyed, create a replacement for the next waiter
  // (waiters are only queued when the pool is at max, so destroying freed a slot).
  refillForWaiters() {
    if (this.waitQueue.length === 0 || this.shuttingDown || this.pool.length >= this.maxConnections) {
      return;
    }
    this.createConnection()
      .then((conn) => {
        const waiter = this.waitQueue.shift();
        if (!waiter) return; // all waiters timed out — connection stays idle in pool
        clearTimeout(waiter.timeoutId);
        conn.inUse = true;
        this.activeConnections++;
        waiter.resolve(conn);
      })
      .catch((err) => {
        // Waiters will hit their own acquisition timeout; next acquire() retries
        console.error(`[Pool ${this.poolLabel()}] Failed to create replacement connection: ${err.message}`);
      });
  }

  async cleanupIdleConnections() {
    if (this.pool.length <= this.minConnections) return;

    const now = Date.now();
    const toRemove = this.pool.filter(
      (conn) => !conn.inUse && (now - conn.lastUsed) > this.idleTimeout
    );

    if (toRemove.length > 0 && (this.pool.length - toRemove.length) >= this.minConnections) {
      for (const conn of toRemove) {
        await this.destroyConnection(conn);
      }
    }
  }

  async destroyConnection(connection) {
    try {
      const idx = this.pool.indexOf(connection);
      if (idx > -1) this.pool.splice(idx, 1);

      if (connection.session) await connection.session.close();
      if (connection.client) await connection.client.close();

      console.log(`[Pool ${this.poolLabel()}] Connection ${connection.id} destroyed (pool size: ${this.pool.length})`);
    } catch (error) {
      console.error(`[Pool ${this.poolLabel()}] Error destroying connection ${connection.id}:`, error.message);
    }
  }

  getStats() {
    return {
      poolKey: this.poolLabel(),
      totalConnections: this.pool.length,
      activeConnections: this.activeConnections,
      idleConnections: this.pool.length - this.activeConnections,
      waitingRequests: this.waitQueue.length,
      minConnections: this.minConnections,
      maxConnections: this.maxConnections,
    };
  }

  async shutdown() {
    console.log(`[Pool ${this.poolLabel()}] Shutting down...`);
    this.shuttingDown = true;

    for (const { reject, timeoutId } of this.waitQueue) {
      clearTimeout(timeoutId);
      reject(new Error('Connection pool shutting down'));
    }
    this.waitQueue = [];

    const closePromises = this.pool.map((conn) => this.destroyConnection(conn));
    await Promise.all(closePromises);

    console.log(`[Pool ${this.poolLabel()}] Shut down`);
  }
}

// Map of `${workspaceAlias}|${httpPath}` -> DatabricksConnectionPool
const pools = {};

function poolKey(workspaceConfig, httpPath) {
  return `${workspaceConfig.workspaceAlias}|${httpPath}`;
}

/**
 * Get or create a connection pool for the given workspace + warehouse.
 * Pools are cached by `${workspaceAlias}|${httpPath}`.
 *
 * @param {object} workspaceConfig - resolved profile from workspaceResolver
 * @param {string} httpPath        - SQL warehouse HTTP path
 * @param {object} [options]       - { min, max, idleTimeout, connectionTimeout }
 */
function getPool(workspaceConfig, httpPath, options) {
  const key = poolKey(workspaceConfig, httpPath);
  if (pools[key]) return pools[key];
  pools[key] = new DatabricksConnectionPool(workspaceConfig, httpPath, options);
  return pools[key];
}

async function shutdownPool() {
  const keys = Object.keys(pools);
  await Promise.all(keys.map((k) => pools[k].shutdown()));
  for (const k of keys) delete pools[k];
}

function getAllPoolStats() {
  return Object.values(pools).map((p) => p.getStats());
}

module.exports = {
  getPool,
  shutdownPool,
  getAllPoolStats,
  DatabricksConnectionPool,
  // Internal helpers — exposed for tests
  _internal: { poolKey, pools },
};
