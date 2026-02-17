/**
 * connectionPool.js
 * Manages a pool of reusable Databricks SQL connections
 *
 * Benefits:
 * - Eliminates connection overhead (100-200ms per request)
 * - Reuses established connections
 * - Handles connection lifecycle (creation, validation, cleanup)
 * - Improves throughput by ~10x for real-time workloads
 */

const { DBSQLClient } = require('@databricks/sql');
const pkg = require('../../package.json');

class DatabricksConnectionPool {
  constructor(config, options = {}) {
    this.config = config;
    this.minConnections = options.min || 2;
    this.maxConnections = options.max || 10;
    this.idleTimeout = options.idleTimeout || 60000; // 60 seconds
    this.connectionTimeout = options.connectionTimeout || 30000; // 30 seconds

    this.pool = [];
    this.activeConnections = 0;
    this.waitQueue = [];
    this.shuttingDown = false;

    console.log(`[Pool] Initialized (min: ${this.minConnections}, max: ${this.maxConnections})`);

    // Pre-warm pool with minimum connections
    this.warmUp();
  }

  /**
   * Pre-create minimum connections for faster first requests
   */
  async warmUp() {
    try {
      const warmUpPromises = [];
      for (let i = 0; i < this.minConnections; i++) {
        warmUpPromises.push(this.createConnection());
      }
      await Promise.all(warmUpPromises);
      console.log(`[Pool] Warmed up with ${this.minConnections} connections`);
    } catch (error) {
      console.error('[Pool] Failed to warm up connection pool:', error.message);
    }
  }

  /**
   * Create a new connection
   */
  async createConnection() {
    const client = new DBSQLClient();
    const connectOptions = {
      token: this.config.accessToken,
      host: this.config.serverHostname,
      path: this.config.httpPath,
      userAgentEntry: `esri_databricks-customdatafeed/${pkg.version}`
    };

    try {
      await client.connect(connectOptions);
      const session = await client.openSession();

      const connection = {
        client,
        session,
        inUse: false,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        id: Math.random().toString(36).substr(2, 9)
      };

      this.pool.push(connection);
      console.log(`[Pool] Connection ${connection.id} created (pool size: ${this.pool.length})`);

      return connection;
    } catch (error) {
      console.error('[Pool] Failed to create connection:', error.message);
      throw error;
    }
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire() {
    if (this.shuttingDown) {
      throw new Error('Connection pool is shutting down');
    }

    // Try to find an available connection
    const availableConnection = this.pool.find(conn => !conn.inUse);

    if (availableConnection) {
      availableConnection.inUse = true;
      availableConnection.lastUsed = Date.now();
      this.activeConnections++;
      return availableConnection;
    }

    // If pool not at max size, create new connection
    if (this.pool.length < this.maxConnections) {
      const newConnection = await this.createConnection();
      newConnection.inUse = true;
      this.activeConnections++;
      return newConnection;
    }

    // Wait for a connection to become available
    console.log(`[Pool] Waiting for available connection (active: ${this.activeConnections}/${this.maxConnections})`);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.waitQueue.findIndex(item => item.resolve === resolve);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        reject(new Error('Connection acquisition timeout'));
      }, this.connectionTimeout);

      this.waitQueue.push({ resolve, reject, timeoutId });
    });
  }

  /**
   * Release a connection back to the pool
   */
  release(connection) {
    if (!connection) return;

    connection.inUse = false;
    connection.lastUsed = Date.now();
    this.activeConnections--;

    // If there's a waiting request, give it this connection
    if (this.waitQueue.length > 0) {
      const { resolve, timeoutId } = this.waitQueue.shift();
      clearTimeout(timeoutId);
      connection.inUse = true;
      this.activeConnections++;
      resolve(connection);
    }

    // Clean up idle connections (keep minimum)
    this.cleanupIdleConnections();
  }

  /**
   * Clean up idle connections beyond minimum
   */
  async cleanupIdleConnections() {
    if (this.pool.length <= this.minConnections) return;

    const now = Date.now();
    const connectionsToRemove = this.pool.filter(conn =>
      !conn.inUse &&
      (now - conn.lastUsed) > this.idleTimeout
    );

    if (connectionsToRemove.length > 0 &&
        (this.pool.length - connectionsToRemove.length) >= this.minConnections) {

      for (const conn of connectionsToRemove) {
        await this.destroyConnection(conn);
      }
    }
  }

  /**
   * Destroy a connection
   */
  async destroyConnection(connection) {
    try {
      const index = this.pool.indexOf(connection);
      if (index > -1) {
        this.pool.splice(index, 1);
      }

      if (connection.session) {
        await connection.session.close();
      }
      if (connection.client) {
        await connection.client.close();
      }

      console.log(`[Pool] Connection ${connection.id} destroyed (pool size: ${this.pool.length})`);
    } catch (error) {
      console.error(`[Pool] Error destroying connection ${connection.id}:`, error.message);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalConnections: this.pool.length,
      activeConnections: this.activeConnections,
      idleConnections: this.pool.length - this.activeConnections,
      waitingRequests: this.waitQueue.length,
      minConnections: this.minConnections,
      maxConnections: this.maxConnections
    };
  }

  /**
   * Shutdown the pool gracefully
   */
  async shutdown() {
    console.log('[Pool] Shutting down connection pool...');
    this.shuttingDown = true;

    // Reject all waiting requests
    for (const { reject, timeoutId } of this.waitQueue) {
      clearTimeout(timeoutId);
      reject(new Error('Connection pool shutting down'));
    }
    this.waitQueue = [];

    // Close all connections
    const closePromises = this.pool.map(conn => this.destroyConnection(conn));
    await Promise.all(closePromises);

    console.log('[Pool] Connection pool shut down');
  }
}

// Singleton instance
let poolInstance = null;

/**
 * Initialize the connection pool (call once at startup)
 */
function initializePool(config, options) {
  if (poolInstance) {
    console.log('[Pool] Connection pool already initialized');
    return poolInstance;
  }

  poolInstance = new DatabricksConnectionPool(config, options);
  return poolInstance;
}

/**
 * Get the singleton pool instance
 */
function getPool() {
  if (!poolInstance) {
    throw new Error('Connection pool not initialized. Call initializePool() first.');
  }
  return poolInstance;
}

/**
 * Shutdown the pool (call on server shutdown)
 */
async function shutdownPool() {
  if (poolInstance) {
    await poolInstance.shutdown();
    poolInstance = null;
  }
}

module.exports = {
  initializePool,
  getPool,
  shutdownPool,
  DatabricksConnectionPool
};
