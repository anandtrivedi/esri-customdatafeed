import { expect } from "chai";
import { buildServiceJson, assertOwnService, getProviderManifest, PROVIDER_NAME } from "../src/publish.js";

const MANIFEST_KEYS = [
  "workspace",
  "warehouseHttpPath",
  "tableName",
  "geometryColumn",
  "idField",
  "geometryFormat",
  "timeColumn",
  "lakebaseHost",
  "lakebasePort",
  "lakebaseDatabase",
  "lakebaseSchema",
  "lakebaseTable",
  "maxRecordCount",
  "srid",
];

describe("buildServiceJson", () => {
  const params = {
    tableName: "cat.sch.roads",
    geometryColumn: "geom",
    geometryFormat: "WKT",
    idField: "id",
    srid: "4326",
  };

  it("includes every manifest key, empty string when unused", () => {
    const json = buildServiceJson({ serviceName: "Roads", params, manifestParams: MANIFEST_KEYS });
    const sp = json.jsonProperties.customDataProviderInfo.serviceParameters;
    expect(Object.keys(sp)).to.have.members(MANIFEST_KEYS);
    expect(sp.tableName).to.equal("cat.sch.roads");
    expect(sp.lakebaseHost).to.equal("");
    expect(json.provider).to.equal("CUSTOMDATA");
    expect(json.jsonProperties.customDataProviderInfo.dataProviderName).to.equal(PROVIDER_NAME);
    expect(json.capabilities).to.equal("Query");
    expect(json.configuredState).to.equal("STARTED");
  });

  it("rejects parameters the provider manifest does not declare", () => {
    expect(() =>
      buildServiceJson({ serviceName: "X", params: { ...params, bogus: "1" }, manifestParams: MANIFEST_KEYS })
    ).to.throw(/Unknown service parameters.*bogus/);
  });

  it("rejects unsafe service names", () => {
    expect(() => buildServiceJson({ serviceName: "bad name!", params, manifestParams: MANIFEST_KEYS })).to.throw(/Service name/);
    expect(() => buildServiceJson({ serviceName: "1leading", params, manifestParams: MANIFEST_KEYS })).to.throw(/Service name/);
  });

  it("sets editing capabilities when requested", () => {
    const json = buildServiceJson({ serviceName: "Edit1", params, manifestParams: MANIFEST_KEYS, editing: true });
    expect(json.capabilities).to.include("Editing");
  });
});

describe("assertOwnService", () => {
  it("allows deletion of our provider's services", () => {
    const svc = { jsonProperties: { customDataProviderInfo: { dataProviderName: PROVIDER_NAME } } };
    expect(() => assertOwnService(svc, "Mine")).to.not.throw();
  });
  it("refuses foreign services", () => {
    expect(() => assertOwnService({ jsonProperties: {} }, "SampleWorldCities")).to.throw(/Refusing to delete/);
    expect(() =>
      assertOwnService({ jsonProperties: { customDataProviderInfo: { dataProviderName: "other" } } }, "X")
    ).to.throw(/Refusing to delete/);
  });
});

describe("getProviderManifest", () => {
  it("extracts parameter keys from the registered provider", async () => {
    const client = {
      listProviders: async () => [
        {
          name: PROVIDER_NAME,
          type: "provider",
          arcgisVersion: "12.0.0",
          editingEnabled: true,
          cdpkFile: "databricks-geospatial-provider.cdpk",
          properties: { serviceParameters: MANIFEST_KEYS.map((key) => ({ key })) },
        },
      ],
    };
    const manifest = await getProviderManifest(client);
    expect(manifest.parameterKeys).to.deep.equal(MANIFEST_KEYS);
    expect(manifest.editingEnabled).to.equal(true);
  });

  it("throws a setup-pointing error when the provider is missing", async () => {
    const client = { listProviders: async () => [] };
    try {
      await getProviderManifest(client);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/not registered/);
    }
  });
});
