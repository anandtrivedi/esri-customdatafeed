const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru().noPreserveCache();

// CloudFetch must be off on every statement unless DATABRICKS_USE_CLOUDFETCH says otherwise. With it on, a host that
// can't reach the workspace's storage gets a 403 per download, and @databricks/sql 1.12.0 leaves the concurrent
// downloads it didn't await to reject unhandled, which exits the whole CDF process (testing/repro-cloudfetch-unhandled.js).

let calls = [];
const point = '{"type":"Point","coordinates":[-77,38]}';
const extentPolygon = '{"type":"Polygon","coordinates":[[[-80,30],[-70,30],[-70,40],[-80,40],[-80,30]]]}';

const connectionPoolStub = {
  getPool: () => ({
    poolLabel: () => "test-pool",
    acquire: async () => ({
      id: "test-conn",
      session: {
        executeStatement: async (sql, options) => {
          calls.push({ sql, options });
          return {
            fetchAll: async () => {
              if (/^\s*DESCRIBE/i.test(sql)) return [{ col_name: "geometry", data_type: "geometry(4326)" }];
              if (/ST_Envelope_Agg/.test(sql)) return [{ extent: extentPolygon }];
              if (/min\(|max\(/i.test(sql)) return [{ t0: "2024-01-01T00:00:00Z", t1: "2024-12-31T00:00:00Z" }];
              return [{ id: 1, geometry: point, ts: "2024-07-04T00:00:00Z" }];
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

const workspaceResolverStub = {
  resolveWorkspace: (alias) => ({ workspaceAlias: alias || "default", hostname: "test-host.databricks.com", authType: "pat", token: "t" }),
  clearProfileCache: () => {},
};

const loadModel = () => proxyquire("../src/model", {
  "./modules/connectionPool": connectionPoolStub,
  "./modules/lakebasePool": { getLakebasePool: async () => ({}), shutdownLakebasePools: async () => {} },
  "./modules/workspaceResolver": workspaceResolverStub,
  dotenv: { config: () => {} },
});

// metadata request with a time column and no explicit geometryFormat: runs the DESCRIBE probe, the extent, the
// time extent and the main query, i.e. every executeStatement path in model.js
const req = () => ({
  query: { f: "json" },
  params: { tableName: "catalog.schema.t", geometryColumn: "geometry", idField: "id", timeColumn: "ts" },
  ip: "127.0.0.1",
});
const getData = (model, r) => new Promise((resolve, reject) => model.getData(r, (err, res) => (err ? reject(err) : resolve(res))));

describe("CloudFetch is off by default on every statement", function () {
  before(() => {
    process.env.DATABRICKS_SERVER_HOSTNAME = "test-host.databricks.com";
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/endpoints/test";
    process.env.DATABRICKS_ACCESS_TOKEN = "test-token";
    process.env.ENABLE_AUDIT_LOG = "false";
    process.env.ENABLE_USER_AUTH = "false";
    process.env.ENABLE_SIMPLE_AUTH = "false";
  });
  beforeEach(() => { calls = []; delete process.env.DATABRICKS_USE_CLOUDFETCH; });
  after(() => { delete process.env.DATABRICKS_USE_CLOUDFETCH; });

  it("sends useCloudFetch: false on every executeStatement when the env var is unset", async () => {
    const Model = loadModel();
    await getData(new Model(), req());
    await new Promise((r) => setTimeout(r, 20)); // background time-extent query
    // every executeStatement path ran: DESCRIBE probe, spatial extent, time extent, main query
    const ran = (re) => calls.some((c) => re.test(c.sql));
    expect(ran(/^\s*DESCRIBE/i), "DESCRIBE probe").to.equal(true);
    expect(ran(/ST_Envelope_Agg/), "spatial extent").to.equal(true);
    expect(ran(/\bMIN\s*\(/i), "time extent").to.equal(true);
    expect(ran(/LIMIT\s+\d+/i), "main query").to.equal(true);
    for (const c of calls) expect(c.options, c.sql.slice(0, 60)).to.include({ useCloudFetch: false, runAsync: true });
  });

  for (const v of ["true", "TRUE", "1", "yes"]) {
    it(`turns CloudFetch on only when DATABRICKS_USE_CLOUDFETCH=${v}`, async () => {
      process.env.DATABRICKS_USE_CLOUDFETCH = v;
      const Model = loadModel();
      await getData(new Model(), req());
      expect(calls.length).to.be.at.least(1);
      for (const c of calls) expect(c.options.useCloudFetch).to.equal(true);
    });
  }

  for (const v of ["false", "0", "no", "-", ""]) {
    it(`keeps CloudFetch off for DATABRICKS_USE_CLOUDFETCH=${JSON.stringify(v)}`, async () => {
      process.env.DATABRICKS_USE_CLOUDFETCH = v;
      const Model = loadModel();
      await getData(new Model(), req());
      for (const c of calls) expect(c.options.useCloudFetch).to.equal(false);
    });
  }
});
