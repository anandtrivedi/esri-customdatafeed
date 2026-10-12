import { expect } from "chai";
import { getAuth, listSecretKeys, execSql } from "../src/databricks.js";
import { ArcGisClient } from "../src/arcgis.js";

// Snapshot + restore the env vars getAuth reads, and global.fetch.
const ENV_KEYS = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"];

describe("getAuth app-runtime OAuth M2M", () => {
  let saved, savedFetch, calls;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => delete process.env[k]);
    savedFetch = global.fetch;
    calls = [];
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
    global.fetch = savedFetch;
  });

  it("exchanges injected client id/secret for an OAuth token via /oidc/v1/token", async () => {
    process.env.DATABRICKS_HOST = "https://ws.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ access_token: "minted-oauth-token", expires_in: 3600 }) };
    };
    const auth = await getAuth({});
    expect(auth.host).to.equal("https://ws.cloud.databricks.com");
    expect(auth.token).to.equal("minted-oauth-token");
    expect(calls[0].url).to.equal("https://ws.cloud.databricks.com/oidc/v1/token");
    expect(calls[0].opts.headers.Authorization).to.match(/^Basic /);
    expect(calls[0].opts.body).to.include("grant_type=client_credentials");
  });

  it("caches the token (no second exchange within its lifetime)", async () => {
    process.env.DATABRICKS_HOST = "https://ws2.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "sp-client-id-2";
    process.env.DATABRICKS_CLIENT_SECRET = "sp-secret";
    global.fetch = async () => {
      calls.push(1);
      return { ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    };
    await getAuth({});
    await getAuth({});
    expect(calls.length).to.equal(1);
  });

  it("surfaces a clear error when the exchange fails", async () => {
    process.env.DATABRICKS_HOST = "https://ws3.cloud.databricks.com";
    process.env.DATABRICKS_CLIENT_ID = "bad";
    process.env.DATABRICKS_CLIENT_SECRET = "bad";
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error_description: "invalid client" }) });
    try {
      await getAuth({});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/M2M token exchange failed/);
      expect(e.message).to.match(/invalid client/);
    }
  });

  it("prefers an explicit PAT env over M2M", async () => {
    process.env.DATABRICKS_HOST = "https://ws4.cloud.databricks.com";
    process.env.DATABRICKS_TOKEN = "pat-token";
    process.env.DATABRICKS_CLIENT_ID = "sp";
    process.env.DATABRICKS_CLIENT_SECRET = "sp";
    global.fetch = async () => {
      throw new Error("should not exchange when PAT present");
    };
    const auth = await getAuth({});
    expect(auth.token).to.equal("pat-token");
  });
});

describe("listSecretKeys", () => {
  let savedFetch;
  beforeEach(() => { savedFetch = global.fetch; });
  afterEach(() => { global.fetch = savedFetch; });

  it("treats a missing scope as no targets (matches error_code, which the message itself doesn't contain)", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST", message: "Scope gis-targets does not exist!" }),
    });
    const keys = await listSecretKeys({ host: "https://ws", token: "t" }, "gis-targets");
    expect(keys).to.deep.equal([]);
  });

  it("still throws other API errors", async () => {
    global.fetch = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error_code: "PERMISSION_DENIED", message: "no" }) });
    let err;
    try { await listSecretKeys({ host: "https://ws", token: "t" }, "gis-targets"); } catch (e) { err = e; }
    expect(err).to.exist;
    expect(err.message).to.include("PERMISSION_DENIED");
  });
});

describe("execSql", () => {
  let savedFetch;
  beforeEach(() => { savedFetch = global.fetch; });
  afterEach(() => { global.fetch = savedFetch; });

  it("cancels the statement when it gives up waiting (instead of leaving it running on the warehouse)", async () => {
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(`${opts.method} ${url}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ statement_id: "s1", status: { state: "RUNNING" } }) };
    };
    let err;
    try { await execSql({ host: "https://ws", token: "t" }, "wh", "SELECT 1", { timeoutSeconds: 0 }); } catch (e) { err = e; }
    expect(err.message).to.match(/timed out/);
    expect(calls).to.include("POST https://ws/api/2.0/sql/statements/s1/cancel");
  });
});

describe("ArcGisClient.listServices", () => {
  it("includes services in folders, as folder/name", async () => {
    const c = new ArcGisClient({ adminUrl: "https://gis.example.com:6443/arcgis/admin", user: "u", password: "p" });
    c.request = async (p) => (p === "services"
      ? { folders: ["/", "System", "Utilities", "Ops"], services: [{ serviceName: "Root", type: "FeatureServer" }] }
      : p === "services/Ops" ? { services: [{ serviceName: "Ships", type: "FeatureServer" }] } : { services: [] });
    const names = (await c.listServices()).map((s) => s.serviceName);
    expect(names).to.deep.equal(["Root", "Ops/Ships"]);
  });
});
