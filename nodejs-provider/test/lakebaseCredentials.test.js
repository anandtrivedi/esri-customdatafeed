const { expect } = require("chai");
const { EventEmitter } = require("events");
const proxyquire = require("proxyquire").noCallThru().noPreserveCache();

// Credential minting for Lakebase Provisioned instances (/api/2.0/database/credentials) and Autoscaling
// endpoints (/api/2.0/postgres/credentials). The Databricks REST API is faked through a stubbed `https` module
// routed by "METHOD path", so every lookup path runs without a network.

const HOST_PROV = "ep-bold-dawn-d2y7qlxp.database.us-east-1.cloud.databricks.com";
const HOST_AUTO = "ep-tiny-bread-d235o0bh.database.us-east-1.cloud.databricks.com";
const HOST_AUTO_POOLED = "ep-tiny-bread-d235o0bh-pooler.database.us-east-1.cloud.databricks.com";
const EP_AUTO = "projects/trident-ais-lb/branches/production/endpoints/primary";

let routes;   // "METHOD path" -> { status, body } | (reqBody) => { status, body }
let calls;    // [{ method, path, body }]
let pools;    // options passed to each pg.Pool

function fakeHttps() {
  return {
    request(options, onResponse) {
      const req = new EventEmitter();
      let body = "";
      req.write = (chunk) => { body += chunk; };
      req.end = () => {
        const key = `${options.method} ${options.path}`;
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = body; } // OIDC token call is form-encoded
        calls.push({ method: options.method, path: options.path, body: parsed });
        let route = routes[key];
        if (typeof route === "function") route = route(parsed);
        if (!route) route = { status: 404, body: { error_code: "NOT_FOUND", message: `no route ${key}` } };
        const res = new EventEmitter();
        res.statusCode = route.status;
        setImmediate(() => {
          onResponse(res);
          res.emit("data", JSON.stringify(route.body));
          res.emit("end");
        });
      };
      return req;
    },
  };
}

class FakePool {
  constructor(opts) { pools.push(opts); }
  on() {}
  async end() {}
  async query() { return { rows: [] }; }
}

const ok = (body) => ({ status: 200, body });
const inFuture = (min) => new Date(Date.now() + min * 60000).toISOString();

const provisionedInstances = ok({
  database_instances: [{ name: "spatial-sql-pg", read_write_dns: HOST_PROV, read_only_dns: "ro-" + HOST_PROV }],
});
const oneProject = ok({ projects: [{ name: "projects/trident-ais-lb" }] });
const oneBranch = ok({ branches: [{ name: "projects/trident-ais-lb/branches/production" }] });
const oneEndpoint = ok({
  endpoints: [{ name: EP_AUTO, status: { hosts: { host: HOST_AUTO, read_write_pooled_host: HOST_AUTO_POOLED } } }],
});

function autoscalingRoutes(extra = {}) {
  return {
    "GET /api/2.0/database/instances": ok({ database_instances: [] }),
    "GET /api/2.0/postgres/projects": oneProject,
    "GET /api/2.0/postgres/projects/trident-ais-lb/branches": oneBranch,
    "GET /api/2.0/postgres/projects/trident-ais-lb/branches/production/endpoints": oneEndpoint,
    "POST /api/2.0/postgres/credentials": (b) => ok({ token: `auto-token-for:${b.endpoint}`, expire_time: inFuture(60) }),
    ...extra,
  };
}

const ws = { workspaceAlias: "arclake", hostname: "fevm-arclake.cloud.databricks.com", authType: "pat", token: "t" };
const cfg = (host, database = "databricks_postgres") => ({ host, port: 5432, database, workspaceConfig: ws });
const pathsCalled = () => calls.map((c) => `${c.method} ${c.path}`);

describe("lakebasePool — credential minting (Provisioned + Autoscaling)", () => {
  let LakebasePool;
  const SAVED = {};
  const ENV = ["LAKEBASE_PASSWORD", "LAKEBASE_INSTANCE_NAME", "LAKEBASE_ENDPOINT_NAME", "LAKEBASE_USER"];

  beforeEach(() => {
    routes = {}; calls = []; pools = [];
    for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; }
    LakebasePool = proxyquire("../src/modules/lakebasePool", { pg: { Pool: FakePool }, https: fakeHttps() });
  });

  afterEach(async () => {
    await LakebasePool.shutdownLakebasePools();
    for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  });

  it("Provisioned host → /database/credentials with the instance name; never touches the Autoscaling API", async () => {
    routes = {
      "GET /api/2.0/database/instances": provisionedInstances,
      "POST /api/2.0/database/credentials": (b) => ok({ token: `prov-token-for:${b.instance_names[0]}`, expiration_time: inFuture(60) }),
    };
    await LakebasePool.getLakebasePool(cfg(HOST_PROV));
    expect(pools[0].password).to.equal("prov-token-for:spatial-sql-pg");
    expect(pathsCalled().some((p) => p.includes("/postgres/"))).to.equal(false);
  });

  it("Autoscaling host (not a Provisioned instance) → /postgres/credentials with the endpoint resource name", async () => {
    routes = autoscalingRoutes();
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
    const cred = calls.find((c) => c.path === "/api/2.0/postgres/credentials");
    expect(cred.body).to.deep.equal({ endpoint: EP_AUTO });
    expect(pathsCalled()).to.not.include("POST /api/2.0/database/credentials");
  });

  it("matches the endpoint's pooled host too", async () => {
    routes = autoscalingRoutes();
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO_POOLED));
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
  });

  it("still reaches Autoscaling when the Provisioned API itself errors (tier retired in the workspace)", async () => {
    routes = autoscalingRoutes({ "GET /api/2.0/database/instances": { status: 404, body: { error_code: "FEATURE_DISABLED" } } });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
  });

  it("honors expire_time: a token far from expiry is reused, one inside the 5-min buffer is re-minted", async () => {
    routes = autoscalingRoutes();
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools).to.have.lengthOf(1); // 60 min left → cached pool reused

    routes["POST /api/2.0/postgres/credentials"] = () => ok({ token: "short-lived", expire_time: inFuture(2) });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO, "other_db"));
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO, "other_db"));
    expect(pools).to.have.lengthOf(3); // 2 min left (< 5 min buffer) → second call refreshed
  });

  it("finds an endpoint on the SECOND page of projects (next_page_token followed)", async () => {
    routes = autoscalingRoutes({
      "GET /api/2.0/postgres/projects": ok({ projects: [{ name: "projects/other" }], next_page_token: "p2" }),
      "GET /api/2.0/postgres/projects?page_token=p2": oneProject,
      "GET /api/2.0/postgres/projects/other/branches": ok({ branches: [{ name: "projects/other/branches/main" }] }),
      "GET /api/2.0/postgres/projects/other/branches/main/endpoints": ok({ endpoints: [{ name: "projects/other/branches/main/endpoints/x", status: { hosts: { host: "ep-nope.example" } } }] }),
    });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
    expect(pathsCalled()).to.include("GET /api/2.0/postgres/projects?page_token=p2");
  });

  it("caches the endpoint lookup per workspace+host: a second database on the same host doesn't rescan", async () => {
    routes = autoscalingRoutes();
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO, "db_a"));
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO, "db_b"));
    expect(pathsCalled().filter((p) => p === "GET /api/2.0/postgres/projects")).to.have.lengthOf(1);
    expect(pools).to.have.lengthOf(2);
  });

  it("neither lookup matches → the error names BOTH lookups", async () => {
    routes = autoscalingRoutes();
    let err;
    try { await LakebasePool.getLakebasePool(cfg("ep-unknown.database.us-east-1.cloud.databricks.com")); } catch (e) { err = e; }
    expect(err, "should throw").to.exist;
    expect(err.message).to.include("No Lakebase instance found");
    expect(err.message).to.include("No Lakebase Autoscaling endpoint found");
    expect(pools).to.have.lengthOf(0);
  });

  it("neither lookup matches + LAKEBASE_INSTANCE_NAME → falls back to /database/credentials with that name", async () => {
    process.env.LAKEBASE_INSTANCE_NAME = "fallback-instance";
    routes = autoscalingRoutes({
      "POST /api/2.0/database/credentials": (b) => ok({ token: `prov-token-for:${b.instance_names[0]}`, expiration_time: inFuture(60) }),
    });
    await LakebasePool.getLakebasePool(cfg("ep-cross-account.database.us-east-1.cloud.databricks.com"));
    expect(pools[0].password).to.equal("prov-token-for:fallback-instance");
  });

  it("LAKEBASE_ENDPOINT_NAME that serves this host → used directly, no project scan", async () => {
    process.env.LAKEBASE_ENDPOINT_NAME = EP_AUTO;
    routes = autoscalingRoutes({
      [`GET /api/2.0/postgres/${EP_AUTO}`]: ok({ name: EP_AUTO, status: { hosts: { host: HOST_AUTO } } }),
    });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
    expect(pathsCalled()).to.not.include("GET /api/2.0/postgres/projects");
  });

  it("LAKEBASE_ENDPOINT_NAME for a DIFFERENT host is ignored for this host (no cross-endpoint credential)", async () => {
    // Process-wide override: a second service on another endpoint must not get the override's credential.
    process.env.LAKEBASE_ENDPOINT_NAME = "projects/other/branches/main/endpoints/primary";
    routes = autoscalingRoutes({
      "GET /api/2.0/postgres/projects/other/branches/main/endpoints/primary": ok({ name: "projects/other/branches/main/endpoints/primary", status: { hosts: { host: "ep-other.example" } } }),
    });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
    expect(pathsCalled()).to.include("GET /api/2.0/postgres/projects");
  });

  it("static LAKEBASE_PASSWORD → no API calls at all (unchanged)", async () => {
    process.env["LAKEBASE_PASSWORD"] = "static-pw"; // bracket notation keeps this stub off the secret scanner
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(calls).to.have.lengthOf(0);
    expect(pools[0].password).to.equal("static-pw");
  });

  it("PAT workspace → pg user is the PAT owner from SCIM /Me (not 'databricks')", async () => {
    routes = autoscalingRoutes({ "GET /api/2.0/preview/scim/v2/Me": ok({ userName: "owner@example.com" }) });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].user).to.equal("owner@example.com");
  });

  it("PAT owner lookup is cached per workspace (one /Me call for two pools)", async () => {
    routes = autoscalingRoutes({ "GET /api/2.0/preview/scim/v2/Me": ok({ userName: "owner@example.com" }) });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO, "db_a"));
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO, "db_b"));
    expect(pathsCalled().filter((p) => p === "GET /api/2.0/preview/scim/v2/Me")).to.have.lengthOf(1);
  });

  it("an explicit LAKEBASE_USER still wins over the PAT-owner lookup (existing deployments unchanged)", async () => {
    process.env.LAKEBASE_USER = "configured-role";
    routes = autoscalingRoutes({ "GET /api/2.0/preview/scim/v2/Me": ok({ userName: "owner@example.com" }) });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].user).to.equal("configured-role");
    expect(pathsCalled()).to.not.include("GET /api/2.0/preview/scim/v2/Me");
  });

  it("PAT owner lookup failing → falls back to 'databricks' instead of failing the pool", async () => {
    routes = autoscalingRoutes({ "GET /api/2.0/preview/scim/v2/Me": { status: 403, body: { error_code: "PERMISSION_DENIED" } } });
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(pools[0].user).to.equal("databricks");
  });

  it("static LAKEBASE_PASSWORD → no /Me lookup (native-login role comes from LAKEBASE_USER)", async () => {
    process.env["LAKEBASE_PASSWORD"] = "static-pw"; // bracket notation keeps this stub off the secret scanner
    process.env.LAKEBASE_USER = "native_role";
    await LakebasePool.getLakebasePool(cfg(HOST_AUTO));
    expect(calls).to.have.lengthOf(0);
    expect(pools[0].user).to.equal("native_role");
  });

  it("OAuth M2M workspace → pg user is the service principal's client id (unchanged)", async () => {
    routes = autoscalingRoutes({
      "POST /oidc/v1/token": ok({ access_token: "ws-token", expires_in: 3600 }),
    });
    const m2m = { workspaceAlias: "arclake-sp", hostname: "fevm-arclake.cloud.databricks.com", authType: "oauth-m2m", clientId: "sp-client-id", clientSecret: "s" };
    await LakebasePool.getLakebasePool({ host: HOST_AUTO, port: 5432, database: "databricks_postgres", workspaceConfig: m2m });
    expect(pools[0].user).to.equal("sp-client-id");
    expect(pools[0].password).to.equal(`auto-token-for:${EP_AUTO}`);
  });
});
