const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// timeInfo.timeExtent: [min, max] of the configured time column, so clients (Map Viewer's time slider) request one
// interval at a time instead of every year at once. Cached, time-boxed, and finished in the background when slow.

let timeCalls = 0;
let timeCancelCalls = 0; // how many times the time-extent op was cancelled (background-cap path)
let timeSlowMs = 0;
let timeFails = false;
let timeNull = false; // simulate an empty table / all-NULL time column: min/max come back NULL
let acquireCount = 0; // connections borrowed from the pool (request + extent + background)
let releaseCount = 0; // connections returned to the pool
let requireParallel = false; // bar either extent from completing until BOTH are in flight (proves concurrency)
let extentFetches = 0;
let openParallelGate = null;
let borrowSlowMs = 0; // slow every BORROW (acquire #2+): pool contention, the statement never opens
const T0 = 1420070400000; // 2015-01-01
const T1 = 1735689599000; // 2024-12-31 23:59:59
const point = '{"type":"Point","coordinates":[-77,38]}';
const extentPolygon = '{"type":"Polygon","coordinates":[[[-80,30],[-70,30],[-70,40],[-80,40],[-80,30]]]}';

const connectionPoolStub = {
  getPool: () => ({
    poolLabel: () => "test-pool",
    acquire: async () => {
      acquireCount++;
      if (borrowSlowMs && acquireCount > 1) await new Promise((r) => setTimeout(r, borrowSlowMs));
      return {
        id: `test-conn-${acquireCount}`,
        session: {
          executeStatement: async (sql) => {
            const isTime = /unix_millis/.test(sql);
            if (isTime) timeCalls++;
            return {
              fetchAll: async () => {
                if (/^\s*DESCRIBE/i.test(sql)) return [];
                const isSpatialExtent = /ST_Envelope_Agg/.test(sql);
                if (isSpatialExtent || isTime) {
                  if (requireParallel) {
                    extentFetches++;
                    if (extentFetches === 2) openParallelGate(); // both in flight — let them both proceed
                    await parallelGatePromise; // resolves only once the other extent is also in flight
                  }
                }
                if (isTime) {
                  if (timeFails) throw new Error("boom");
                  if (timeSlowMs) await new Promise((r) => setTimeout(r, timeSlowMs));
                  if (timeNull) return [{ t0: null, t1: null }]; // empty table / all-NULL column → min/max NULL
                  return [{ t0: String(T0), t1: String(T1) }]; // the driver returns BIGINT as strings
                }
                if (isSpatialExtent) return [{ extent: extentPolygon }];
                return [{ id: 1, geometry: point }];
              },
              cancel: async () => { timeCancelCalls++; },
              close: async () => {},
            };
          },
        },
      };
    },
    release: () => { releaseCount++; },
  }),
  shutdownPool: async () => {},
  getAllPoolStats: () => [],
};

// The parallel gate: a promise each in-flight extent fetch awaits; it resolves when BOTH extent fetches are in flight.
let parallelGatePromise = null;
function resetParallelGate() {
  extentFetches = 0;
  parallelGatePromise = new Promise((resolve) => { openParallelGate = resolve; });
}

describe("Lakehouse metadata time extent", function () {
  let Model;
  const req = (table, extra = {}) => ({
    query: { f: "json" },
    params: { tableName: table, geometryColumn: "geometry", idField: "id", geometryFormat: "GEOMETRY", timeColumn: "event_date", ...extra },
    ip: "127.0.0.1",
  });
  const getData = (model, r) => new Promise((resolve, reject) => model.getData(r, (err, res) => (err ? reject(err) : resolve(res))));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  before(() => {
    process.env.DATABRICKS_SERVER_HOSTNAME = "test-host.databricks.com";
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/endpoints/test";
    process.env.DATABRICKS_ACCESS_TOKEN = "test-token";
    process.env.ENABLE_AUDIT_LOG = "false";
    process.env.ENABLE_USER_AUTH = "false";
    process.env.ENABLE_SIMPLE_AUTH = "false";
    process.env.CDF_EXTENT_WAIT_MS = "50";
    process.env.CDF_TIME_EXTENT_BG_MS = "2000";
    Model = proxyquire("../src/model", {
      "./modules/connectionPool": connectionPoolStub,
      "./modules/lakebasePool": { getLakebasePool: async () => ({}), shutdownLakebasePools: async () => {} },
      "./modules/workspaceResolver": {
        resolveWorkspace: (alias) => ({ workspaceAlias: alias || "default", hostname: "test-host.databricks.com", authType: "pat", token: "t" }),
        clearProfileCache: () => {},
      },
      dotenv: { config: () => {} },
    });
  });

  beforeEach(() => {
    timeCalls = 0; timeCancelCalls = 0; timeSlowMs = 0; timeFails = false; timeNull = false; acquireCount = 0; releaseCount = 0;
    requireParallel = false; borrowSlowMs = 0;
    resetParallelGate();
    Model._extentCache.clear();
  });

  after(() => { delete process.env.CDF_EXTENT_WAIT_MS; delete process.env.CDF_TIME_EXTENT_BG_MS; });

  it("fills timeInfo.timeExtent with [min, max] of the time column as numbers", async () => {
    const res = await getData(new Model(), req("catalog.schema.t1"));
    expect(res.metadata.timeInfo.startTimeField).to.equal("event_date");
    expect(res.metadata.timeInfo.timeExtent).to.deep.equal([T0, T1]);
  });

  it("computes it once per table and serves later requests from the cache", async () => {
    const model = new Model();
    await getData(model, req("catalog.schema.t1"));
    await getData(model, req("catalog.schema.t1"));
    expect(timeCalls).to.equal(1);
  });

  it("serves a cached time extent on data (non-metadata) responses without computing", async () => {
    const model = new Model();
    await getData(model, req("catalog.schema.t1"));
    const data = await getData(model, { ...req("catalog.schema.t1"), query: { f: "json", where: "1=1", resultRecordCount: "5" } });
    expect(data.metadata.timeInfo.timeExtent).to.deep.equal([T0, T1]);
    expect(timeCalls).to.equal(1);
  });

  it("when slow, answers without it, lets the SAME query finish in the background on its own connection, and the next request has it", async () => {
    timeSlowMs = 300; // longer than the 50 ms wait, shorter than the 2 s background cap
    const model = new Model();
    const first = await getData(model, req("catalog.schema.big"));
    expect(first.metadata.timeInfo.timeExtent).to.equal(null);
    await sleep(400); // the background continuation finishes and fills the cache
    // The foreground stopped WAITING at the budget, not running: the one min/max query kept going on its own
    // borrowed connection (no duplicate re-query), and no live op ever rides the request's released connection.
    expect(timeCalls).to.equal(1);
    expect(acquireCount).to.equal(3); // request + spatial extent + the time extent's dedicated connection
    expect(releaseCount).to.equal(3); // all three were returned to the pool
    const second = await getData(model, req("catalog.schema.big"));
    expect(second.metadata.timeInfo.timeExtent).to.deep.equal([T0, T1]);
    expect(timeCalls).to.equal(1); // second request served from cache, no new query
  });

  it("runs the spatial and time extents in parallel — one wait budget, not two stacked", async () => {
    // The stub bars either extent fetch from completing until BOTH are in flight, so this is deterministic: no
    // timing margins. If the extents still ran sequentially on one connection (the pre-1.1.7 behavior), the
    // SPATIAL extent would sit at the barrier past the 50 ms budget and time out — its assertion below is the
    // one that discriminates. (The time extent would eventually open the gate itself and still return a range.)
    requireParallel = true;
    const res = await getData(new Model(), req("catalog.schema.par"));
    expect(res.metadata.extent).to.include({ xmin: -80, xmax: -70 });
    expect(res.metadata.timeInfo.timeExtent).to.deep.equal([T0, T1]);
  });

  it("cancels a min/max that blows the background cap — bounded, not run to completion", async () => {
    // The cap must CANCEL the stuck statement and free its borrowed connection at the cap, not wait for the fetch
    // to finish naturally (which, on a genuinely stuck statement, is never).
    timeSlowMs = 3000; // longer than the 2 s background cap
    const model = new Model();
    const first = await getData(model, req("catalog.schema.stuck"));
    expect(first.metadata.timeInfo.timeExtent).to.equal(null);
    await sleep(2400); // the cap fires at ~2 s after hand-off
    expect(timeCancelCalls).to.equal(1); // cancelled AT the cap
    expect(releaseCount).to.equal(3);     // ...and its borrowed connection was released
    expect(timeCalls).to.equal(1);        // no duplicate query was ever started
  });

  it("a background cap hit while still WAITING for a connection caches the miss for 1 min, not an hour", async () => {
    // Never getting a connection is pool contention, not a slow query; an hour of timeExtent: null makes Map Viewer
    // request every date per tile, which keeps the pool saturated.
    borrowSlowMs = 2600; // longer than the 2 s background cap: the min/max never opens
    const model = new Model();
    await getData(model, req("catalog.schema.busy"));
    await sleep(2300);
    const entry = [...Model._extentCache.entries()].find(([k]) => k.includes("|time|"));
    expect(entry, "time extent negatively cached").to.exist;
    expect(entry[1].extent).to.equal(null);
    expect(entry[1].ttl).to.equal(60 * 1000);
    await sleep(400); // let the late borrow land and be released
  });

  it("has no timeInfo at all when no time column is configured", async () => {
    const res = await getData(new Model(), req("catalog.schema.t1", { timeColumn: undefined }));
    expect(res.metadata).to.not.have.property("timeInfo");
    expect(timeCalls).to.equal(0);
  });

  it("still answers (timeExtent null) when the min/max query fails", async () => {
    timeFails = true;
    const res = await getData(new Model(), req("catalog.schema.t1"));
    expect(res.metadata.timeInfo.timeExtent).to.equal(null);
    expect(res.features).to.have.lengthOf(1);
  });

  it("returns null (not [0,0]) when the table is empty / the time column is all NULL", async () => {
    timeNull = true;
    const res = await getData(new Model(), req("catalog.schema.empty"));
    expect(res.metadata.timeInfo.timeExtent).to.equal(null); // NOT [0, 0] from Number(null)
  });

  it("degrades to null (no 500) when the time column name is invalid", async () => {
    // validateFieldName throws on a bad column; it must be caught, not propagate out and 500 every metadata request
    const res = await getData(new Model(), req("catalog.schema.t1", { timeColumn: "bad; name" }));
    expect(res.metadata.timeInfo.timeExtent).to.equal(null);
    expect(res.features).to.have.lengthOf(1);
    expect(timeCalls).to.equal(0); // never reached executeStatement
  });
});
