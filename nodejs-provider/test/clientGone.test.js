const { expect } = require("chai");
const { EventEmitter } = require("events");
const proxyquire = require("proxyquire").noCallThru().noPreserveCache();

// When the client closes the response (Map Viewer drops tiles on pan/zoom), the provider cancels the SQL and returns
// the connection, and doesn't start queries for clients that left while queued.

const point = '{"type":"Point","coordinates":[-77,38]}';
let log;
function harness({ acquireDelayMs = 0 } = {}) {
  log = { executed: 0, cancelled: 0, released: [] };
  const pool = {
    poolLabel: () => "test-pool",
    acquire: async () => {
      if (acquireDelayMs) await new Promise((r) => setTimeout(r, acquireDelayMs));
      return {
        id: "c1",
        session: {
          executeStatement: async (sql) => {
            if (/^\s*DESCRIBE/i.test(sql)) return { fetchAll: async () => [], close: async () => {} };
            log.executed++;
            let rejectFetch;
            const fetchP = new Promise((resolve, reject) => { rejectFetch = reject; setTimeout(() => resolve([{ id: 1, geometry: point }]), 300); });
            return {
              fetchAll: () => fetchP,
              cancel: async () => { log.cancelled++; rejectFetch(new Error("Operation canceled")); },
              close: async () => {},
            };
          },
        },
      };
    },
    release: (conn, opts = {}) => log.released.push(opts.destroy === true ? "destroyed" : "released"),
  };
  return proxyquire("../src/model", {
    "./modules/connectionPool": { getPool: () => pool, shutdownPool: async () => {}, getAllPoolStats: () => [] },
    "./modules/lakebasePool": { getLakebasePool: async () => ({}), shutdownLakebasePools: async () => {} },
    "./modules/workspaceResolver": { resolveWorkspace: () => ({ workspaceAlias: "d", hostname: "h", authType: "pat", token: "t" }), clearProfileCache: () => {} },
    dotenv: { config: () => {} },
  });
}
const mkReq = () => {
  const res = new EventEmitter(); res.writableEnded = false;
  // a data request (not metadata) so only the main query runs
  return { res, req: { res, query: { f: "json", where: "1=1", outFields: "*", resultRecordCount: 10 }, params: { tableName: "c.s.t", geometryColumn: "geometry", idField: "id", geometryFormat: "GEOMETRY" }, ip: "127.0.0.1" } };
};
const run = (Model, req) => new Promise((resolve) => new Model().getData(req, (err, data) => resolve({ err, data })));

describe("client goes away", function () {
  before(() => {
    process.env.DATABRICKS_SERVER_HOSTNAME = "h"; process.env.DATABRICKS_HTTP_PATH = "/p"; process.env.DATABRICKS_ACCESS_TOKEN = "t";
    process.env.ENABLE_AUDIT_LOG = "false"; process.env.ENABLE_USER_AUTH = "false"; process.env.ENABLE_SIMPLE_AUTH = "false";
  });

  it("cancels the running SQL and returns the connection to the pool (not destroyed)", async () => {
    const Model = harness();
    const { res, req } = mkReq();
    const p = run(Model, req);
    setTimeout(() => res.emit("close"), 50);
    const { err } = await p;
    await new Promise((r) => setTimeout(r, 20)); // release happens in the finally block after the callback
    expect(err).to.be.an("error");
    expect(log.cancelled).to.equal(1);
    expect(log.released).to.deep.equal(["released"]);
  });

  it("doesn't run a query whose client left while it was waiting for a connection", async () => {
    const Model = harness({ acquireDelayMs: 100 });
    const { res, req } = mkReq();
    const p = run(Model, req);
    setTimeout(() => res.emit("close"), 20);
    const { err } = await p;
    expect(err).to.be.an("error");
    expect(log.executed).to.equal(0);
    expect(log.released).to.deep.equal(["released"]);
  });

  it("does nothing when the response closes after it was sent", async () => {
    const Model = harness();
    const { res, req } = mkReq();
    const { err, data } = await run(Model, req);
    res.writableEnded = true; res.emit("close");
    expect(err).to.equal(null);
    expect(data.features).to.have.lengthOf(1);
    expect(log.cancelled).to.equal(0);
    expect(log.released).to.deep.equal(["released"]);
  });

  it("works when the request has no res (other callers)", async () => {
    const Model = harness();
    const { req } = mkReq(); delete req.res;
    const { err } = await run(Model, req);
    expect(err).to.equal(null);
  });
});
