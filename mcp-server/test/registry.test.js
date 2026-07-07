import { expect } from "chai";
import { TargetRegistry } from "../src/registry.js";

function makeRegistry({ local = {}, scope = {}, secrets = {} } = {}) {
  return new TargetRegistry({
    secretScope: Object.keys(scope).length ? "gis-targets" : undefined,
    deps: {
      loadLocalTargets: () => local,
      getAuth: () => ({ host: "https://x", token: "t" }),
      listSecretKeys: async () => Object.keys(scope),
      getSecret: async (auth, scopeName, key) => scope[key] ?? secrets[`${scopeName}/${key}`],
    },
  });
}

const LOCAL_TARGET = {
  adminUrl: "https://gis.example.com:6443/arcgis/admin",
  user: "siteadmin",
  password: "pw-inline",
  allowSelfSigned: true,
};

describe("TargetRegistry", () => {
  it("resolves the single registered target when none is named", async () => {
    const reg = makeRegistry({ local: { demo: LOCAL_TARGET } });
    const t = await reg.resolve(undefined);
    expect(t.name).to.equal("demo");
    expect(t.password).to.equal("pw-inline");
  });

  it("requires an explicit target when several are registered", async () => {
    const reg = makeRegistry({ local: { a: LOCAL_TARGET, b: LOCAL_TARGET } });
    try {
      await reg.resolve(undefined);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/Multiple GIS targets/);
    }
  });

  it("matches targets by URL hostname", async () => {
    const reg = makeRegistry({ local: { demo: LOCAL_TARGET } });
    const t = await reg.resolve("https://gis.example.com:6443/arcgis/admin");
    expect(t.name).to.equal("demo");
    const t2 = await reg.resolve("gis.example.com");
    expect(t2.name).to.equal("demo");
  });

  it("rejects unknown targets with a registration-pointing message", async () => {
    const reg = makeRegistry({ local: { demo: LOCAL_TARGET } });
    try {
      await reg.resolve("https://other.example.com/arcgis/admin");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/not registered/);
      expect(e.message).to.match(/never accepted/);
    }
  });

  it("loads targets from the secret scope (key = target name, value = JSON)", async () => {
    const reg = makeRegistry({
      scope: {
        "dod-cop": JSON.stringify({
          adminUrl: "https://cop.mil:6443/arcgis/admin",
          user: "siteadmin",
          passwordRef: "env:COP_PW",
        }),
        "not-a-target": "just-a-password",
      },
    });
    process.env.COP_PW = "secret-pw";
    const targets = await reg.listTargets();
    expect(targets).to.have.property("dod-cop");
    expect(targets).to.not.have.property("not-a-target");
    const t = await reg.resolve("dod-cop");
    expect(t.password).to.equal("secret-pw");
    delete process.env.COP_PW;
  });

  it("resolves secret: password refs through the secrets API", async () => {
    const reg = makeRegistry({
      local: {
        demo: { adminUrl: "https://g:6443/arcgis/admin", user: "u", passwordRef: "secret:gis-targets/demo-pw" },
      },
      secrets: { "gis-targets/demo-pw": "from-scope" },
    });
    const t = await reg.resolve("demo");
    expect(t.password).to.equal("from-scope");
  });

  it("never exposes passwords through listTargets", async () => {
    const reg = makeRegistry({ local: { demo: LOCAL_TARGET } });
    const listed = await reg.listTargets();
    expect(JSON.stringify(listed)).to.not.include("pw-inline");
    expect(listed.demo.credentialSource).to.equal("inline");
  });

  it("gives an operator-pointing error when no targets exist", async () => {
    const reg = makeRegistry({});
    try {
      await reg.resolve("anything");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/No GIS targets registered/);
    }
  });
});
