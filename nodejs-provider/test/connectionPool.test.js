const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();

describe('connectionPool', () => {
  let connectionPool;
  let connectCallLog;
  let sessionLog;
  let tokenRequests;

  beforeEach(() => {
    // New array each test. Capture it locally so old test pools (from a
    // previous beforeEach, still draining in the background) don't leak
    // their connect() calls into this test's expected log.
    const localLog = [];
    connectCallLog = localLog;
    const localSessions = [];
    sessionLog = localSessions;

    const DBSQLClientStub = class {
      async connect(options) {
        localLog.push(options);
      }
      async openSession(request) {
        localSessions.push(request);
        return { close: async () => {} };
      }
      async close() {}
    };

    tokenRequests = [];
    connectionPool = proxyquire('../src/modules/connectionPool', {
      '@databricks/sql': { DBSQLClient: DBSQLClientStub },
      './oauthToken': { getOAuthToken: async (ws, scope) => { tokenRequests.push({ clientId: ws.clientId, scope }); return `tok-${scope}`; } },
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

    it('OAuth M2M: authenticates with our own sql-scoped token, not the driver M2M flow (which asks all-apis)', async () => {
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
      const opts = connectCallLog[0];
      expect(opts).to.include({ host: 'b.example.com', path: '/sql/1.0/warehouses/xyz', authType: 'custom' });
      expect(opts.oauthClientId).to.be.undefined;
      expect(opts.oauthClientSecret).to.be.undefined;
      expect(opts.token).to.be.undefined;
      expect(await opts.provider.authenticate()).to.deep.equal({ Authorization: 'Bearer tok-sql' });
      expect(tokenRequests).to.deep.equal([{ clientId: 'sp-bbb', scope: 'sql' }]);
    });

    // A driver that always fails with the bare Thrift 403, and an https whose GET answers from `rest` (null = unreachable).
    function forbiddenPool(rest, auth = { authType: 'pat', token: 'pat-x' }) {
      const calls = [];
      const fakeHttps = { get(opts, onRes) {
        const { EventEmitter } = require('events');
        const req = new EventEmitter();
        req.setTimeout = () => req; req.destroy = () => {};
        calls.push(opts);
        setImmediate(() => {
          if (!rest) return req.emit('error', new Error('ECONNREFUSED'));
          const res = new EventEmitter(); res.statusCode = rest.status;
          onRes(res); res.emit('data', JSON.stringify(rest.body)); res.emit('end');
        });
        return req;
      } };
      const cp = proxyquire('../src/modules/connectionPool', {
        https: fakeHttps,
        '@databricks/sql': { DBSQLClient: class {
          async connect() {}
          async openSession() { throw new Error('Received a response with a bad HTTP status code: 403'); }
          async close() {}
        } },
        './oauthToken': { getOAuthToken: async (ws, scope) => `tok-${scope}` },
      });
      const pool = cp.getPool({ workspaceAlias: 'C', hostname: 'c.example.com', ...auth }, '/sql/1.0/warehouses/wh1', { min: 0 });
      return { cp, pool, calls };
    }

    it("explains a 403 with Databricks' own REST message (IP access list)", async () => {
      const { cp, pool, calls } = forbiddenPool({ status: 403, body: { error_code: 403,
        message: 'Source IP address: 1.2.3.4 is blocked by Databricks IP ACL for workspace: 7 [ReqId: abc]' } },
      { authType: 'oauth-m2m', clientId: 'sp', clientSecret: 's' });
      const err = await pool.acquire().then(() => null, (e) => e);
      expect(err.message).to.include('bad HTTP status code: 403').and.include('blocked by Databricks IP ACL for workspace: 7');
      expect(err.message).to.not.include('ReqId').and.not.include('entitlement');
      expect(calls[0].path).to.equal('/api/2.0/sql/warehouses/wh1');
      expect(calls[0].headers.Authorization).to.equal('Bearer tok-sql');
      await cp.shutdownPool();
    });

    it('falls back to the generic hint when REST gives no reason, and asks REST once per minute', async () => {
      const { cp, pool, calls } = forbiddenPool(null);
      for (let i = 0; i < 2; i++) {
        const err = await pool.acquire().then(() => null, (e) => e);
        expect(err.message).to.include('IP access list').and.include('Databricks SQL access').and.include('"sql" scope');
      }
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].headers.Authorization).to.equal('Bearer pat-x');
      await cp.shutdownPool();
    });

    it('a burst of concurrent 403s shares one REST lookup', async () => {
      const { cp, pool, calls } = forbiddenPool({ status: 403, body: { message: 'Source IP address: 1.2.3.4 is blocked by Databricks IP ACL' } });
      const errs = await Promise.all(Array.from({ length: 8 }, () => pool.acquire().then(() => null, (e) => e)));
      expect(calls).to.have.lengthOf(1); // was 8
      for (const e of errs) expect(e.message).to.include('blocked by Databricks IP ACL');
      await cp.shutdownPool();
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

  describe('session STATEMENT_TIMEOUT', () => {
    afterEach(() => { delete process.env.DATABRICKS_QUERY_TIMEOUT; });

    it('opens every session with STATEMENT_TIMEOUT=120 by default (warehouses ignore queryTimeout)', async () => {
      const ws = { workspaceAlias: 'T', hostname: 't.example.com', authType: 'pat', token: 'x' };
      const pool = connectionPool.getPool(ws, '/sql/1.0/warehouses/t1', { min: 0 });
      await pool.createConnection();
      expect(sessionLog[0]).to.deep.equal({ configuration: { STATEMENT_TIMEOUT: '120' } });
    });

    it('derives STATEMENT_TIMEOUT from DATABRICKS_QUERY_TIMEOUT (ms -> s)', async () => {
      process.env.DATABRICKS_QUERY_TIMEOUT = '45000';
      const ws = { workspaceAlias: 'T', hostname: 't.example.com', authType: 'pat', token: 'x' };
      const pool = connectionPool.getPool(ws, '/sql/1.0/warehouses/t2', { min: 0 });
      await pool.createConnection();
      expect(sessionLog[0].configuration.STATEMENT_TIMEOUT).to.equal('45');
    });
  });

  describe('max connections under concurrent acquire', () => {
    it('never opens more than max when many acquires arrive while connections are still opening', async () => {
      let opened = 0;
      const SlowClient = class {
        async connect() { await new Promise((r) => setTimeout(r, 20)); }
        async openSession() { opened++; return { close: async () => {} }; }
        async close() {}
      };
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: SlowClient } });
      const ws = { workspaceAlias: 'C', hostname: 'c.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/c', { min: 0, max: 10, connectionTimeout: 500 });
      const got = await Promise.allSettled(Array.from({ length: 15 }, () => pool.acquire()));
      const ok = got.filter((g) => g.status === 'fulfilled');
      expect(opened).to.equal(10);
      expect(pool.pool.length).to.equal(10);
      expect(ok).to.have.lengthOf(10);
      expect(pool.activeConnections).to.equal(10);
      for (const g of ok) pool.release(g.value);
      await cp.shutdownPool();
    });
  });

  describe('warm-up connections count against max', () => {
    it('never opens more than max when acquires arrive while warm-up is still opening', async () => {
      let opened = 0;
      const SlowClient = class {
        async connect() { await new Promise((r) => setTimeout(r, 20)); }
        async openSession() { opened++; return { close: async () => {} }; }
        async close() {}
      };
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: SlowClient } });
      const ws = { workspaceAlias: 'W', hostname: 'w.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/w', { min: 2, max: 4, connectionTimeout: 500 });
      const got = await Promise.allSettled(Array.from({ length: 6 }, () => pool.acquire()));
      await new Promise((r) => setTimeout(r, 50)); // warm-up settles
      expect(opened).to.equal(4); // was 6: 2 uncounted warm-up opens + 4 for the acquires
      for (const g of got) if (g.status === 'fulfilled') pool.release(g.value);
      await cp.shutdownPool();
    });
  });

  describe('warm-up connections serve requests that queued meanwhile', () => {
    it('with min == max, acquires that arrive during warm-up get the warm-up connections instead of timing out', async () => {
      let opened = 0;
      const SlowClient = class {
        async connect() { await new Promise((r) => setTimeout(r, 30)); }
        async openSession() { opened++; return { close: async () => {} }; }
        async close() {}
      };
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: SlowClient } });
      const ws = { workspaceAlias: 'M', hostname: 'm.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/m', { min: 3, max: 3, connectionTimeout: 400 });
      const t0 = Date.now();
      const got = await Promise.allSettled(Array.from({ length: 5 }, () => pool.acquire()));
      const ok = got.filter((g) => g.status === 'fulfilled').map((g) => g.value);
      expect(opened).to.equal(3);
      expect(ok).to.have.lengthOf(3); // was 0: all five timed out with 3 idle connections in the pool
      expect(new Set(ok.map((c) => c.id)).size).to.equal(3); // each connection handed out once
      expect(ok.every((c) => c.inUse)).to.equal(true);
      expect(pool.activeConnections).to.equal(3);
      expect(got.filter((g) => g.status === 'rejected').map((g) => g.reason.message)).to.deep.equal(['Connection acquisition timeout', 'Connection acquisition timeout']);
      expect(Date.now() - t0).to.be.below(1000);
      for (const c of ok) pool.release(c);
      expect(pool.activeConnections).to.equal(0);
      await cp.shutdownPool();
    });

    it('a warm-up connection with no one waiting stays idle in the pool', async () => {
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: class {
        async connect() {} async openSession() { return { close: async () => {} }; } async close() {} } } });
      const pool = cp.getPool({ workspaceAlias: 'I', hostname: 'i.example.com', authType: 'pat', token: 'x' }, '/p', { min: 2, max: 4 });
      await new Promise((r) => setTimeout(r, 20));
      expect(pool.pool.map((c) => c.inUse)).to.deep.equal([false, false]);
      expect(pool.activeConnections).to.equal(0);
      await cp.shutdownPool();
    });
  });

  describe('new connections are checked out before they join the pool', () => {
    it('a connection created for acquire() is already inUse when it is pushed to the pool', async () => {
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: class {
        async connect() {} async openSession() { return { close: async () => {} }; } async close() {} } } });
      const ws = { workspaceAlias: 'R', hostname: 'r.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/r', { min: 0, max: 2 });
      const seenAtPush = [];
      const push = pool.pool.push.bind(pool.pool);
      pool.pool.push = (c) => { seenAtPush.push(c.inUse); return push(c); };
      const c = await pool.acquire();
      expect(seenAtPush).to.deep.equal([true]); // visible to other acquires only once it's taken
      expect(c.inUse).to.equal(true);
      pool.release(c);
      await cp.shutdownPool();
    });
  });

  describe('a failed openSession does not leak the client', () => {
    it('closes the connected client when openSession rejects, and rethrows the error', async () => {
      let closed = 0;
      // connect() succeeds, openSession() fails — the client is connected but has no session, so createConnection
      // must close it before rethrowing or the socket leaks (and the pool slot never frees).
      const FailingSessionClient = class {
        async connect() {}
        async openSession() { throw new Error('session open failed'); }
        async close() { closed++; }
      };
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: FailingSessionClient } });
      const ws = { workspaceAlias: 'F', hostname: 'f.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/f', { min: 0, max: 2, connectionTimeout: 300 });

      let err = null;
      try { await pool.acquire(); } catch (e) { err = e; }

      expect(err).to.be.an('error');
      expect(err.message).to.equal('session open failed'); // the real error propagates, not a TypeError
      expect(closed).to.equal(1);                           // client was closed, not leaked
      expect(pool.pool.length).to.equal(0);                 // nothing half-open left in the pool
      expect(pool.creating).to.equal(0);                    // the in-flight reservation was released
      await cp.shutdownPool();
    });

    it('still propagates the original openSession error even if client.close() also throws', async () => {
      const BothFailClient = class {
        async connect() {}
        async openSession() { throw new Error('session open failed'); }
        async close() { throw new Error('close blew up too'); }
      };
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: BothFailClient } });
      const ws = { workspaceAlias: 'F2', hostname: 'f2.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/f2', { min: 0, max: 2, connectionTimeout: 300 });

      let err = null;
      try { await pool.acquire(); } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.equal('session open failed'); // close-time noise must not mask the real cause
      expect(pool.creating).to.equal(0);
      await cp.shutdownPool();
    });

    it('does NOT close the client on a successful open (guards against moving close() out of the catch)', async () => {
      let closed = 0;
      const HealthyClient = class {
        async connect() {}
        async openSession() { return { close: async () => {} }; }
        async close() { closed++; }
      };
      const cp = proxyquire('../src/modules/connectionPool', { '@databricks/sql': { DBSQLClient: HealthyClient } });
      const ws = { workspaceAlias: 'F3', hostname: 'f3.example.com', authType: 'pat', token: 'x' };
      const pool = cp.getPool(ws, '/sql/1.0/warehouses/f3', { min: 0, max: 2 });
      const c = await pool.acquire();
      expect(closed).to.equal(0); // the live, pooled client must not be closed
      pool.release(c);
      await cp.shutdownPool();
    });
  });
});
