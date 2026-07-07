import { expect } from "chai";
import AdmZip from "adm-zip";
import { repackageCdpk, registerProviderFlow, unregisterProviderFlow } from "../src/provider.js";

function makeCdpk({ name = "databricks-geospatial-provider" } = {}) {
  const zip = new AdmZip();
  zip.addFile("cdconfig.json", Buffer.from(JSON.stringify({ name, type: "provider", version: "1.1.1" })));
  zip.addFile("package.json", Buffer.from("{}"));
  zip.addFile("src/index.js", Buffer.from("// entry"));
  return zip.toBuffer();
}

function readEntry(buffer, entryName) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry(entryName);
  return entry ? zip.readAsText(entry) : null;
}

describe("repackageCdpk", () => {
  it("returns the original buffer untouched when no changes requested", () => {
    const src = makeCdpk();
    const out = repackageCdpk(src, {});
    expect(out.buffer).to.equal(src);
    expect(out.providerName).to.equal("databricks-geospatial-provider");
  });

  it("renames the provider inside cdconfig.json", () => {
    const out = repackageCdpk(makeCdpk(), { providerName: "databricks-geo-mcp-test" });
    expect(out.providerName).to.equal("databricks-geo-mcp-test");
    expect(out.originalName).to.equal("databricks-geospatial-provider");
    const cfg = JSON.parse(readEntry(out.buffer, "cdconfig.json"));
    expect(cfg.name).to.equal("databricks-geo-mcp-test");
    expect(cfg.fileName).to.equal("databricks-geo-mcp-test.cdpk");
    expect(readEntry(out.buffer, "src/index.js")).to.equal("// entry");
  });

  it("bakes envVars as a .env entry", () => {
    const out = repackageCdpk(makeCdpk(), {
      envVars: { DATABRICKS_SERVER_HOSTNAME: "x.cloud.databricks.com", DATABRICKS_HTTP_PATH: "/sql/1.0/warehouses/abc" },
    });
    const env = readEntry(out.buffer, ".env");
    expect(env).to.include("DATABRICKS_SERVER_HOSTNAME=x.cloud.databricks.com");
    expect(env).to.include("DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/abc");
  });

  it("rejects invalid provider names and env var names", () => {
    expect(() => repackageCdpk(makeCdpk(), { providerName: "Bad Name!" })).to.throw(/Provider name/);
    expect(() => repackageCdpk(makeCdpk(), { envVars: { "bad-key": "v" } })).to.throw(/Invalid env var names/);
  });

  it("rejects archives without cdconfig.json", () => {
    const zip = new AdmZip();
    zip.addFile("readme.txt", Buffer.from("hi"));
    expect(() => repackageCdpk(zip.toBuffer(), {})).to.throw(/no cdconfig.json/);
  });
});

function fakeClient({ providersBefore = [], providersAfter = [] } = {}) {
  const calls = [];
  let listCount = 0;
  return {
    calls,
    listProviders: async () => (listCount++ === 0 ? providersBefore : providersAfter),
    uploadFile: async (buffer, name) => {
      calls.push(["upload", name, buffer.length]);
      return { itemID: "i-test-123" };
    },
    request: async (path, params, opts) => {
      calls.push(["request", path, params, opts?.method]);
      return { status: "success" };
    },
  };
}

describe("registerProviderFlow", () => {
  const MANIFEST = { name: "p2", parameterKeys: [] };

  it("uploads then registers with the itemID", async () => {
    const client = fakeClient({ providersBefore: [], providersAfter: [MANIFEST] });
    const out = await registerProviderFlow(client, Buffer.from("zip"), "p2", { mode: "register" });
    expect(out.name).to.equal("p2");
    expect(client.calls[0][0]).to.equal("upload");
    expect(client.calls[1]).to.deep.equal(["request", "services/types/customdataproviders/register", { id: "i-test-123" }, "POST"]);
  });

  it("refuses register when the provider already exists", async () => {
    const client = fakeClient({ providersBefore: [{ name: "p2" }] });
    try {
      await registerProviderFlow(client, Buffer.from("z"), "p2", { mode: "register" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/already registered/);
    }
  });

  it("refuses update when the provider does not exist", async () => {
    const client = fakeClient({ providersBefore: [] });
    try {
      await registerProviderFlow(client, Buffer.from("z"), "p2", { mode: "update" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/not registered/);
    }
  });
});

describe("unregisterProviderFlow", () => {
  it("refuses when services still use the provider", async () => {
    const client = fakeClient({});
    try {
      await unregisterProviderFlow(client, "p1", [
        { serviceName: "Svc1", dataProviderName: "p1" },
        { serviceName: "Svc2", dataProviderName: "other" },
      ]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/Refusing to unregister/);
      expect(e.message).to.include("Svc1");
      expect(e.message).to.not.include("Svc2");
    }
  });

  it("unregisters when no services depend on it", async () => {
    const client = fakeClient({ providersBefore: [{ name: "p1", cdpkFile: "p1.cdpk" }], providersAfter: [] });
    const out = await unregisterProviderFlow(client, "p1", [{ serviceName: "Svc2", dataProviderName: "other" }]);
    expect(out.unregistered).to.equal("p1");
    expect(client.calls[0]).to.deep.equal([
      "request",
      "services/types/customdataproviders/unregister",
      { customdataFilename: "p1.cdpk" },
      "POST",
    ]);
  });
});
