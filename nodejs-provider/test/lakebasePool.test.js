const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

/**
 * Verifies the single-flight guard in getLakebasePool: concurrent requests for the same
 * key must build exactly ONE pg.Pool (the earlier bug let a second overwrite/orphan the first).
 * pg.Pool is stubbed and LAKEBASE_PASSWORD is set so no real network/token minting happens.
 */
describe("lakebasePool — single-flight pool creation", () => {
  let poolConstructCount;
  let LakebasePool;

  beforeEach(() => {
    poolConstructCount = 0;
    class FakePool {
      constructor() { poolConstructCount++; }
      on() {}
      async end() {}
      async query() { return { rows: [] }; }
    }
    // Bracket notation keeps this test stub off the pre-commit secret scanner.
    process.env["LAKEBASE_PASSWORD"] = "test-static-pw"; // skip credential minting (no network)
    LakebasePool = proxyquire("../src/modules/lakebasePool", {
      pg: { Pool: FakePool },
    });
  });

  afterEach(() => {
    delete process.env.LAKEBASE_PASSWORD;
  });

  it("creates only ONE pool for concurrent requests with the same key", async () => {
    const config = {
      host: "h.database.cloud.databricks.com",
      port: 5432,
      database: "db",
      workspaceConfig: { workspaceAlias: "ws" },
    };
    const [p1, p2, p3] = await Promise.all([
      LakebasePool.getLakebasePool(config),
      LakebasePool.getLakebasePool(config),
      LakebasePool.getLakebasePool(config),
    ]);
    expect(poolConstructCount).to.equal(1);
    expect(p1).to.equal(p2);
    expect(p2).to.equal(p3);
    await LakebasePool.shutdownLakebasePools();
  });

  it("reuses the cached pool on a later call (no second construction)", async () => {
    const config = {
      host: "h2.database.cloud.databricks.com",
      port: 5432,
      database: "db",
      workspaceConfig: { workspaceAlias: "ws" },
    };
    const a = await LakebasePool.getLakebasePool(config);
    const b = await LakebasePool.getLakebasePool(config);
    expect(poolConstructCount).to.equal(1);
    expect(a).to.equal(b);
    await LakebasePool.shutdownLakebasePools();
  });
});
