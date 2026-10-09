const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Metadata requests compute the layer extent with a full-table ST_Envelope_Agg. These tests cover the cache and the
// wait budget that keep that from re-running (or hanging) on every metadata request against a huge table.

let extentCalls = 0;
let cancelCalls = 0;
let closeCalls = 0;
let extentHangs = false;
let extentRejectsOnCancel = false; // simulate the real driver: a cancelled fetchAll() rejects
let extentSlowMs = 0;              // make the extent fetch take this long (to force concurrent overlap)
let cleanupSlowMs = 0;             // make cancel()/close() take this long (they are warehouse round-trips)
let acquireSlowMs = 0;             // make a BORROW (acquire #2+, never the request's own) take this long
let execSlowMs = 0;                // make the extent statement OPEN take this long (crossing the budget)
let closeFails = false;            // make the extent op's close() throw — the connection must be destroyed, not recycled
let cancelFails = false;           // make the extent op's cancel() throw — the aggregate may still be running
let connSeq = 0;
const releases = [];               // { id, destroy } — what the pool got back, and in what state
const sqlByConn = new Map();       // conn id -> [sql...] — proves which statements ran on which connection
const point = '{"type":"Point","coordinates":[-77,38]}';
const extentPolygon = '{"type":"Polygon","coordinates":[[[-80,30],[-70,30],[-70,40],[-80,40],[-80,30]]]}';

const connectionPoolStub = {
  getPool: () => ({
    poolLabel: () => "test-pool",
    acquire: async () => {
      // Only extent borrows (acquire #2+) are slowed: the request's own acquire is legitimately awaited by getData.
      if (acquireSlowMs && connSeq >= 1) await new Promise((r) => setTimeout(r, acquireSlowMs));
      const id = `test-conn-${++connSeq}`;
      return {
        id,
        session: {
          executeStatement: async (sql) => {
            if (!sqlByConn.has(id)) sqlByConn.set(id, []);
            sqlByConn.get(id).push(sql);
            const isExtent = /ST_Envelope_Agg/.test(sql);
            if (isExtent) extentCalls++;
            if (isExtent && execSlowMs) await new Promise((r) => setTimeout(r, execSlowMs));
            let release;
            let rejectHang;
            const hang = new Promise((resolve, reject) => { release = resolve; rejectHang = reject; });
            return {
              fetchAll: async () => {
                if (/^\s*DESCRIBE/i.test(sql)) return [];
                if (isExtent) {
                  if (extentHangs) return hang; // settles only when cancelled
                  if (extentSlowMs) await new Promise((r) => setTimeout(r, extentSlowMs));
                  return [{ extent: extentPolygon }];
                }
                return [{ id: 1, geometry: point }];
              },
              cancel: async () => {
                cancelCalls++;
                if (cancelFails && isExtent) throw new Error("cancel failed");
                // Only the EXTENT op's cancel/close are made slow: the main query's close() is legitimately awaited
                // by getData, so slowing every close would time the wrong thing.
                if (cleanupSlowMs && isExtent) await new Promise((r) => setTimeout(r, cleanupSlowMs));
                if (extentRejectsOnCancel) rejectHang(new Error("operation cancelled"));
                else release([]);
              },
              close: async () => {
                if (isExtent) {
                  closeCalls++;
                  if (closeFails) throw new Error("close failed");
                  if (cleanupSlowMs) await new Promise((r) => setTimeout(r, cleanupSlowMs));
                }
              },
            };
          },
        },
      };
    },
    release: (conn, opts) => { releases.push({ id: conn.id, destroy: !!(opts && opts.destroy) }); },
  }),
  shutdownPool: async () => {},
  getAllPoolStats: () => [],
};

const workspaceResolverStub = {
  resolveWorkspace: (alias) => ({ workspaceAlias: alias || "default", hostname: "test-host.databricks.com", authType: "pat", token: "t" }),
  clearProfileCache: () => {},
};

describe("Lakehouse metadata extent", function () {
  let Model;
  const req = (table) => ({
    query: { f: "json" },
    params: { tableName: table, geometryColumn: "geometry", idField: "id", geometryFormat: "GEOMETRY" },
    ip: "127.0.0.1",
  });
  const getData = (model, r) => new Promise((resolve, reject) => model.getData(r, (err, res) => (err ? reject(err) : resolve(res))));

  before(() => {
    process.env.DATABRICKS_SERVER_HOSTNAME = "test-host.databricks.com";
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/endpoints/test";
    process.env.DATABRICKS_ACCESS_TOKEN = "test-token";
    process.env.ENABLE_AUDIT_LOG = "false";
    process.env.ENABLE_USER_AUTH = "false";
    process.env.ENABLE_SIMPLE_AUTH = "false";
    process.env.CDF_EXTENT_WAIT_MS = "50";
    Model = proxyquire("../src/model", {
      "./modules/connectionPool": connectionPoolStub,
      "./modules/lakebasePool": { getLakebasePool: async () => ({}), shutdownLakebasePools: async () => {} },
      "./modules/workspaceResolver": workspaceResolverStub,
      dotenv: { config: () => {} },
    });
  });

  beforeEach(() => {
    extentCalls = 0; cancelCalls = 0; closeCalls = 0; extentHangs = false; extentRejectsOnCancel = false;
    extentSlowMs = 0; cleanupSlowMs = 0; acquireSlowMs = 0; execSlowMs = 0; closeFails = false; cancelFails = false; connSeq = 0;
    releases.length = 0; sqlByConn.clear();
    Model._extentCache.clear();
  });

  after(() => { delete process.env.CDF_EXTENT_WAIT_MS; });

  it("computes the extent once per table and serves later metadata requests from the cache", async () => {
    const model = new Model();
    const a = await getData(model, req("catalog.schema.t1"));
    const b = await getData(model, req("catalog.schema.t1"));
    expect(extentCalls).to.equal(1);
    expect(a.metadata.extent).to.deep.equal(b.metadata.extent);
    expect(a.metadata.extent).to.include({ xmin: -80, xmax: -70 });
  });

  it("keeps separate cache entries per table", async () => {
    const model = new Model();
    await getData(model, req("catalog.schema.t1"));
    await getData(model, req("catalog.schema.t2"));
    expect(extentCalls).to.equal(2);
  });

  it("cancels an extent that runs past the wait budget and still answers the metadata request", async () => {
    extentHangs = true;
    const model = new Model();
    const t0 = Date.now();
    const res = await getData(model, req("catalog.schema.huge"));
    expect(Date.now() - t0).to.be.below(2000);
    expect(cancelCalls).to.equal(1);
    expect(res.metadata).to.not.have.property("extent");
    expect(res.features).to.have.lengthOf(1);
  });

  it("does not retry a too-big table's extent on the next metadata request", async () => {
    extentHangs = true;
    const model = new Model();
    await getData(model, req("catalog.schema.huge"));
    await getData(model, req("catalog.schema.huge"));
    expect(extentCalls).to.equal(1);
    expect(cancelCalls).to.equal(1);
  });

  it("sinks the cancelled fetchAll() rejection so it never becomes an unhandled rejection", async () => {
    // Real @databricks/sql rejects a cancelled operation's fetchAll(). Promise.race already resolved via timeout, so
    // without the .catch() sink that rejection would be unhandled and crash the process on Node >= 15.
    extentHangs = true;
    extentRejectsOnCancel = true;
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const model = new Model();
      const res = await getData(model, req("catalog.schema.huge"));
      await new Promise((r) => setTimeout(r, 50)); // let the post-cancel rejection fire if it's going to
      expect(res.metadata).to.not.have.property("extent");
      expect(res.features).to.have.lengthOf(1);
      expect(cancelCalls).to.equal(1);
      expect(unhandled).to.have.lengthOf(0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("de-dupes concurrent cold-cache metadata requests into a single extent query", async () => {
    // The post-restart scenario: a burst of metadata requests arrives before any extent has been computed. They must
    // share one in-flight ST_Envelope_Agg, not each fire their own full-table scan.
    extentSlowMs = 20; // completes within the 50 ms wait budget, but slowly enough that both requests overlap
    const model = new Model();
    const [a, b] = await Promise.all([
      getData(model, req("catalog.schema.t1")),
      getData(model, req("catalog.schema.t1")),
    ]);
    expect(extentCalls).to.equal(1);
    expect(a.metadata.extent).to.deep.equal(b.metadata.extent);
    expect(a.metadata.extent).to.include({ xmin: -80, xmax: -70 });
  });

  it("runs the extent on its own borrowed connection, never the request's", async () => {
    const model = new Model();
    await getData(model, req("catalog.schema.t1"));
    const conns = [...sqlByConn.entries()];
    const extentConn = conns.find(([, sqls]) => sqls.some((s) => /ST_Envelope_Agg/.test(s)));
    expect(extentConn, "an extent query ran").to.exist;
    expect(extentConn[1].every((s) => /ST_Envelope_Agg/.test(s)), "the extent connection hosts only the extent").to.be.true;
    const featureConn = conns.find(([, sqls]) => sqls.some((s) => !/ST_Envelope_Agg/.test(s)));
    expect(featureConn, "the feature query ran").to.exist;
    expect(featureConn[1].some((s) => /ST_Envelope_Agg/.test(s)), "the request's connection never hosts the extent").to.be.false;
  });

  it("answers the timeout without waiting for the cancel/close round-trips (cleanup is off the critical path)", async () => {
    // Each awaited cancel()/close() is a warehouse round-trip; inline they added 2 round-trips to every extent
    // timeout before the metadata response could go out. Observed live: 10 s budget + round-trips, twice, stacked.
    extentHangs = true;
    cleanupSlowMs = 300; // cancel() and close() each take 300 ms — awaited inline that is +600 ms on the response
    const model = new Model();
    const t0 = Date.now();
    const res = await getData(model, req("catalog.schema.huge"));
    expect(Date.now() - t0).to.be.below(200); // ~the 50 ms budget, not 50 + 600
    expect(cancelCalls).to.equal(1); // invoked immediately — its completion is not awaited
    expect(res.metadata).to.not.have.property("extent");
    expect(res.features).to.have.lengthOf(1);
    await new Promise((r) => setTimeout(r, 1000)); // let the detached cleanup (2×300 ms) settle with margin
    expect(closeCalls).to.equal(1);
  });

  it("bounds a queued borrow by the wait budget: a slow acquire can't stall the metadata response", async () => {
    // Pool-saturation scenario: the extent borrow sits in the pool's wait queue. The borrow is INSIDE the time
    // box, so the response is bounded by the budget — not by the pool's 30 s acquisition timeout.
    acquireSlowMs = 200; // the extent borrow is granted after 200 ms; the budget is 50 ms
    const model = new Model();
    const t0 = Date.now();
    const res = await getData(model, req("catalog.schema.huge"));
    expect(Date.now() - t0).to.be.below(180); // answered at the budget, not after the acquire
    expect(res.metadata).to.not.have.property("extent");
    await new Promise((r) => setTimeout(r, 350)); // the late borrow settles
    expect(extentCalls).to.equal(0); // the statement was never even opened — the result was already negatively cached
    expect(releases.some((r) => r.id === "test-conn-2"), "the late-borrowed connection was returned").to.be.true;
    // The negative entry is TRANSIENT (pool contention, ~60 s), not the 1 h "table too big" TTL.
    const entry = [...Model._extentCache.entries()].find(([k]) => k.includes("catalog.schema.huge"));
    expect(entry, "negative cache entry written").to.exist;
    expect(entry[1].ttl).to.be.at.most(61000);
  });

  it("cancels at statement-OPEN when the budget expires while the statement is still opening", async () => {
    // The statement open crosses the budget and the fetch then hangs. The cleanup must fire as soon as the statement
    // OPENS — if `work` were chained to the fetch's outcome (async-return promise adoption), the cancel would wait
    // out the entire hanging fetch and never fire.
    execSlowMs = 100;
    extentHangs = true;
    const model = new Model();
    const t0 = Date.now();
    const res = await getData(model, req("catalog.schema.huge"));
    expect(Date.now() - t0).to.be.below(180); // answered at the budget
    expect(res.metadata).to.not.have.property("extent");
    expect(cancelCalls).to.equal(0); // nothing to cancel yet — the statement hadn't opened
    await new Promise((r) => setTimeout(r, 300)); // the open lands at ~100 ms
    expect(cancelCalls).to.equal(1); // cancelled as soon as it OPENED, not after the (hanging) fetch
  });

  it("destroys (not recycles) the borrowed connection when its operation fails to close", async () => {
    closeFails = true;
    const model = new Model();
    const res = await getData(model, req("catalog.schema.t1"));
    expect(res.metadata.extent).to.include({ xmin: -80, xmax: -70 }); // the fetch itself succeeded
    await new Promise((r) => setTimeout(r, 50)); // detached cleanup settles
    const extentRelease = releases.find((r) => r.id === "test-conn-2");
    expect(extentRelease, "the extent connection was returned").to.exist;
    expect(extentRelease.destroy).to.be.true; // close failed — session state unknown, so don't hand it to the next borrower
  });

  it("destroys (not recycles) the borrowed connection when cancelling a timed-out extent fails", async () => {
    // A failed cancel means the ST_Envelope_Agg may still be running on that session; recycling it would park the next
    // tile behind a full-table aggregate.
    extentHangs = true; cancelFails = true;
    const model = new Model();
    await getData(model, req("catalog.schema.t1"));
    await new Promise((r) => setTimeout(r, 50));
    const extentRelease = releases.find((r) => r.id === "test-conn-2");
    expect(extentRelease, "the extent connection was returned").to.exist;
    expect(extentRelease.destroy).to.be.true;
  });

  it("retries after a transient (non-timeout) extent error instead of caching it forever", async () => {
    // A query error is negatively cached with a short TTL (EXTENT_ERROR_RETRY_MS), not the 24 h success TTL, so a
    // transient failure doesn't suppress the extent for a day — but also doesn't re-run on every request.
    process.env.CDF_EXTENT_ERROR_RETRY_MS = "1"; // 1 ms short TTL so it elapses between the two requests
    const errModel = proxyquire("../src/model", {
      "./modules/connectionPool": {
        getPool: () => ({
          poolLabel: () => "err-pool",
          acquire: async () => ({
            id: "c",
            session: {
              executeStatement: async (sql) => {
                const isExtent = /ST_Envelope_Agg/.test(sql);
                if (isExtent) extentCalls++;
                return {
                  fetchAll: async () => {
                    if (/^\s*DESCRIBE/i.test(sql)) return [];
                    if (isExtent) throw new Error("permission denied on ST_Envelope_Agg");
                    return [{ id: 1, geometry: point }];
                  },
                  cancel: async () => {},
                  close: async () => {},
                };
              },
            },
          }),
          release: () => {},
        }),
        shutdownPool: async () => {},
        getAllPoolStats: () => [],
      },
      "./modules/lakebasePool": { getLakebasePool: async () => ({}), shutdownLakebasePools: async () => {} },
      "./modules/workspaceResolver": workspaceResolverStub,
      dotenv: { config: () => {} },
    });
    try {
      const model = new errModel();
      const r1 = await getData(model, req("catalog.schema.flaky"));
      await new Promise((r) => setTimeout(r, 5)); // let the 1 ms error TTL elapse
      const r2 = await getData(model, req("catalog.schema.flaky"));
      expect(r1.metadata).to.not.have.property("extent");
      expect(r2.metadata).to.not.have.property("extent");
      expect(extentCalls).to.equal(2); // short TTL (=0) elapsed, so it retried rather than serving a stale negative
    } finally {
      delete process.env.CDF_EXTENT_ERROR_RETRY_MS;
    }
  });
});
