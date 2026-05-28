const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();

describe('connectionPool', () => {
  let connectionPool;
  let connectCallLog;

  beforeEach(() => {
    // New array each test. Capture it locally so old test pools (from a
    // previous beforeEach, still draining in the background) don't leak
    // their connect() calls into this test's expected log.
    const localLog = [];
    connectCallLog = localLog;

    const DBSQLClientStub = class {
      async connect(options) {
        localLog.push(options);
      }
      async openSession() {
        return { close: async () => {} };
      }
      async close() {}
    };

    connectionPool = proxyquire('../src/modules/connectionPool', {
      '@databricks/sql': { DBSQLClient: DBSQLClientStub },
    });
  });

  afterEach(async () => {
    await connectionPool.shutdownPool();
  });

  describe('getPool keying', () => {
    it('returns the same pool when called twice with same workspace + httpPath', () => {
      const ws = { workspaceAlias: 'A', hostname: 'a.example.com', authType: 'pat', token: 'x' };
      const a = connectionPool.getPool(ws, '/sql/1.0/warehouses/abc', { min: 0 });
      const b = connectionPool.getPool(ws, '/sql/1.0/warehouses/abc', { min: 0 });
      expect(a).to.equal(b);
    });

    it('returns different pools for different workspaces', () => {
      const wsA = { workspaceAlias: 'A', hostname: 'a.example.com', authType: 'pat', token: 'x' };
      const wsB = { workspaceAlias: 'B', hostname: 'b.example.com', authType: 'pat', token: 'y' };
      const a = connectionPool.getPool(wsA, '/path', { min: 0 });
      const b = connectionPool.getPool(wsB, '/path', { min: 0 });
      expect(a).to.not.equal(b);
    });

    it('returns different pools for different httpPaths within same workspace', () => {
      const ws = { workspaceAlias: 'A', hostname: 'a.example.com', authType: 'pat', token: 'x' };
      const a = connectionPool.getPool(ws, '/sql/1.0/warehouses/abc', { min: 0 });
      const b = connectionPool.getPool(ws, '/sql/1.0/warehouses/xyz', { min: 0 });
      expect(a).to.not.equal(b);
    });

    it('exposes getAllPoolStats with one entry per active pool', () => {
      const wsA = { workspaceAlias: 'A', hostname: 'a.example.com', authType: 'pat', token: 'x' };
      const wsB = { workspaceAlias: 'B', hostname: 'b.example.com', authType: 'pat', token: 'y' };
      connectionPool.getPool(wsA, '/path1', { min: 0 });
      connectionPool.getPool(wsB, '/path2', { min: 0 });
      const stats = connectionPool.getAllPoolStats();
      expect(stats).to.have.lengthOf(2);
      const keys = stats.map((s) => s.poolKey).sort();
      expect(keys).to.deep.equal(['A|/path1', 'B|/path2']);
    });
  });

  describe('createConnection auth modes', () => {
    it('passes the PAT token to client.connect for PAT profiles', async () => {
      connectionPool.getPool(
        {
          workspaceAlias: 'A',
          hostname: 'a.example.com',
          authType: 'pat',
          token: 'dapi-aaa',
        },
        '/sql/1.0/warehouses/abc',
        { min: 1 }
      );
      // Allow warmUp's createConnection promise to resolve
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(connectCallLog).to.have.lengthOf(1);
      expect(connectCallLog[0]).to.include({
        host: 'a.example.com',
        path: '/sql/1.0/warehouses/abc',
        token: 'dapi-aaa',
      });
      expect(connectCallLog[0].authType).to.be.undefined;
      expect(connectCallLog[0].oauthClientId).to.be.undefined;
    });

    it('passes OAuth M2M creds with authType: databricks-oauth', async () => {
      connectionPool.getPool(
        {
          workspaceAlias: 'B',
          hostname: 'b.example.com',
          authType: 'oauth-m2m',
          clientId: 'sp-bbb',
          clientSecret: 'secret-bbb',
        },
        '/sql/1.0/warehouses/xyz',
        { min: 1 }
      );
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(connectCallLog).to.have.lengthOf(1);
      expect(connectCallLog[0]).to.include({
        host: 'b.example.com',
        path: '/sql/1.0/warehouses/xyz',
        authType: 'databricks-oauth',
        oauthClientId: 'sp-bbb',
        oauthClientSecret: 'secret-bbb',
      });
      expect(connectCallLog[0].token).to.be.undefined;
    });

    it('does not call client.connect at all when min: 0', async () => {
      connectionPool.getPool(
        { workspaceAlias: 'A', hostname: 'a.example.com', authType: 'pat', token: 'x' },
        '/path',
        { min: 0 }
      );
      await new Promise((r) => setImmediate(r));
      expect(connectCallLog).to.have.lengthOf(0);
    });
  });

  describe('shutdownPool', () => {
    it('clears all pools and removes them from getAllPoolStats', async () => {
      connectionPool.getPool(
        { workspaceAlias: 'A', hostname: 'a', authType: 'pat', token: 'x' },
        '/p',
        { min: 0 }
      );
      connectionPool.getPool(
        { workspaceAlias: 'B', hostname: 'b', authType: 'pat', token: 'y' },
        '/p',
        { min: 0 }
      );
      expect(connectionPool.getAllPoolStats()).to.have.lengthOf(2);

      await connectionPool.shutdownPool();
      expect(connectionPool.getAllPoolStats()).to.have.lengthOf(0);
    });
  });

  describe('pool stats reflect the keyed structure', () => {
    it('reports its poolKey in getStats()', () => {
      const pool = connectionPool.getPool(
        { workspaceAlias: 'WORKSPACE_A', hostname: 'a.example.com', authType: 'pat', token: 'x' },
        '/sql/1.0/warehouses/abc',
        { min: 0 }
      );
      expect(pool.getStats().poolKey).to.equal('WORKSPACE_A|/sql/1.0/warehouses/abc');
    });
  });
});
