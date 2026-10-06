const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Metadata requests compute the layer extent with a full-table ST_Envelope_Agg. These tests cover the cache and the
// wait budget that keep that from re-running (or hanging) on every metadata request against a huge table.

let extentCalls = 0;
let cancelCalls = 0;
let extentHangs = false;
let extentRejectsOnCancel = false; // simulate the real driver: a cancelled fetchAll() rejects
let extentSlowMs = 0;              // make the extent fetch take this long (to force concurrent overlap)
const point = '{"type":"Point","coordinates":[-77,38]}';
const extentPolygon = '{"type":"Polygon","coordinates":[[[-80,30],[-70,30],[-70,40],[-80,40],[-80,30]]]}';

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
              if (extentRejectsOnCancel) rejectHang(new Error("operation cancelled"));
              else release([]);
            },
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
    extentCalls = 0; cancelCalls = 0; extentHangs = false; extentRejectsOnCancel = false; extentSlowMs = 0;
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
