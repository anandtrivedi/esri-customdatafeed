const { expect } = require("chai");
const { EventEmitter } = require("events");
const proxyquire = require("proxyquire").noCallThru().noPreserveCache();

// Service principal tokens minted at /oidc/v1/token with a narrow scope (sql / postgres) instead of all-apis.
// `https` is faked: each request records its form body and answers from `respond(scope)`.

let requests; // [{ path, body, scope, auth }]
let respond;  // (scope) => { status, body }

function fakeHttps() {
  return {
    request(options, onResponse) {
      const req = new EventEmitter();
      let body = "";
      req.write = (chunk) => { body += chunk; };
      req.setTimeout = (ms, cb) => { req.timeoutCb = cb; return req; };
      req.destroy = (err) => { req.emit("error", err || new Error("destroyed")); };
      req.end = () => {
        const scope = new URLSearchParams(body).get("scope");
        requests.push({ path: options.path, body, scope, auth: options.headers.Authorization });
        const route = respond(scope);
        if (route === "HANG") { setImmediate(req.timeoutCb); return; }
        const res = new EventEmitter();
        res.statusCode = route.status;
        setImmediate(() => { onResponse(res); res.emit("data", JSON.stringify(route.body)); res.emit("end"); });
      };
      return req;
    },
  };
}

const ws = { workspaceAlias: "sp", hostname: "w.cloud.databricks.com", clientId: "cid", clientSecret: "sec" };
const ok = (token, expiresIn = 3600) => ({ status: 200, body: { access_token: token, expires_in: expiresIn } });

describe("oauthToken", () => {
  let oauth;
  beforeEach(() => {
    requests = [];
    respond = (scope) => ok(`tok-${scope}`);
    oauth = proxyquire("../src/modules/oauthToken", { https: fakeHttps() });
  });

  it("asks only for the requested scope, with client-credentials basic auth", async () => {
    expect(await oauth.getOAuthToken(ws, "sql")).to.equal("tok-sql");
    expect(requests).to.have.lengthOf(1);
    expect(requests[0].path).to.equal("/oidc/v1/token");
    expect(requests[0].scope).to.equal("sql");
    expect(requests[0].body).to.include("grant_type=client_credentials").and.not.include("all-apis");
    expect(requests[0].auth).to.equal("Basic " + Buffer.from("cid:sec").toString("base64"));
  });

  it("caches per scope and shares one in-flight request between concurrent callers", async () => {
    const [a, b] = await Promise.all([oauth.getOAuthToken(ws, "sql"), oauth.getOAuthToken(ws, "sql")]);
    expect(a).to.equal("tok-sql");
    expect(b).to.equal("tok-sql");
    await oauth.getOAuthToken(ws, "sql");
    expect(await oauth.getOAuthToken(ws, "postgres")).to.equal("tok-postgres");
    expect(requests.map((r) => r.scope)).to.deep.equal(["sql", "postgres"]);
  });

  it("refreshes a token that is within 5 minutes of expiry", async () => {
    respond = (scope) => ok(`tok-${scope}-${requests.length}`, 240); // 4 min: already inside the buffer
    expect(await oauth.getOAuthToken(ws, "sql")).to.equal("tok-sql-1");
    expect(await oauth.getOAuthToken(ws, "sql")).to.equal("tok-sql-2");
  });

  it("falls back to all-apis only when the workspace calls the scope invalid", async () => {
    respond = (scope) => (scope === "sql" ? { status: 400, body: { error: "invalid_scope" } } : ok(`tok-${scope}`));
    const warns = []; const orig = console.warn; console.warn = (m) => warns.push(m);
    try {
      expect(await oauth.getOAuthToken(ws, "sql")).to.equal("tok-all-apis");
    } finally { console.warn = orig; }
    expect(requests.map((r) => r.scope)).to.deep.equal(["sql", "all-apis"]);
    expect(warns).to.have.lengthOf(1);
  });

  it("does not retry with all-apis when the secret lacks the scope (access_denied)", async () => {
    respond = () => ({ status: 400, body: { error: "access_denied", error_description: "Scopes 'sql' are not assigned to the client" } });
    const err = await oauth.getOAuthToken(ws, "sql").then(() => null, (e) => e);
    expect(err.message).to.include('scope "sql"').and.include("not assigned");
    expect(requests).to.have.lengthOf(1);
  });

  it("does not cache a failure", async () => {
    respond = () => ({ status: 401, body: { error: "invalid_client" } });
    await oauth.getOAuthToken(ws, "sql").catch(() => {});
    respond = (scope) => ok(`tok-${scope}`);
    expect(await oauth.getOAuthToken(ws, "sql")).to.equal("tok-sql");
  });

  it("times out a hung token endpoint", async () => {
    respond = () => "HANG";
    const err = await oauth.getOAuthToken(ws, "sql", { timeoutMs: 10 }).then(() => null, (e) => e);
    expect(err.message).to.match(/timed out/);
  });
});
