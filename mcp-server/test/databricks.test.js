import { expect } from "chai";
import { getAuth } from "../src/databricks.js";

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
