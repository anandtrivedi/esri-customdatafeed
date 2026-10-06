const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// timeInfo.timeExtent: [min, max] of the configured time column, so clients (Map Viewer's time slider) request one
// interval at a time instead of every year at once. Cached, time-boxed, and finished in the background when slow.

let timeCalls = 0;
let timeSlowMs = 0;
let timeFails = false;
const T0 = 1420070400000; // 2015-01-01
const T1 = 1735689599000; // 2024-12-31 23:59:59
const point = '{"type":"Point","coordinates":[-77,38]}';

const connectionPoolStub = {
  getPool: () => ({
    poolLabel: () => "test-pool",
    acquire: async () => ({
      id: "test-conn",
      session: {
        executeStatement: async (sql) => {
          const isTime = /unix_millis/.test(sql);
          if (isTime) timeCalls++;
          return {
            fetchAll: async () => {
              if (/^\s*DESCRIBE/i.test(sql) || /ST_Envelope_Agg/.test(sql)) return [];
              if (isTime) {
                if (timeFails) throw new Error("boom");
                if (timeSlowMs) await new Promise((r) => setTimeout(r, timeSlowMs));
                return [{ t0: String(T0), t1: String(T1) }]; // the driver returns BIGINT as strings
              }
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
};

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
    timeCalls = 0; timeSlowMs = 0; timeFails = false;
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

  it("when slow, answers without it, finishes in the background, and the next request has it", async () => {
    timeSlowMs = 300; // longer than the 50 ms wait, shorter than the 2 s background cap
    const model = new Model();
    const first = await getData(model, req("catalog.schema.big"));
    expect(first.metadata.timeInfo.timeExtent).to.equal(null);
    await sleep(400);
    const second = await getData(model, req("catalog.schema.big"));
    expect(second.metadata.timeInfo.timeExtent).to.deep.equal([T0, T1]);
    expect(timeCalls).to.equal(1); // the background query was reused, not restarted
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
});
