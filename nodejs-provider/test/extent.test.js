const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Metadata requests compute the layer extent with a full-table ST_Envelope_Agg. These tests cover the cache and the
// wait budget that keep that from re-running (or hanging) on every metadata request against a huge table.

let extentCalls = 0;
let cancelCalls = 0;
let extentHangs = false;
const point = '{"type":"Point","coordinates":[-77,38]}';

const connectionPoolStub = {
  getPool: () => ({
    poolLabel: () => "test-pool",
    acquire: async () => ({
      id: "test-conn",
      session: {
        executeStatement: async (sql) => {
          const isExtent = /ST_Envelope_Agg/.test(sql);
          if (isExtent) extentCalls++;
          let release;
          const hang = new Promise((resolve) => { release = resolve; });
          return {
            fetchAll: async () => {
              if (/^\s*DESCRIBE/i.test(sql)) return [];
              if (isExtent) {
                if (extentHangs) return hang; // resolves only when cancelled
                return [{ extent: '{"type":"Polygon","coordinates":[[[-80,30],[-70,30],[-70,40],[-80,40],[-80,30]]]}' }];
              }
              return [{ id: 1, geometry: point }];
            },
            cancel: async () => { cancelCalls++; release([]); },
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
    extentCalls = 0; cancelCalls = 0; extentHangs = false;
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
});
