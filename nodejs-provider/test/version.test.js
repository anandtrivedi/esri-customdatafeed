const { expect } = require("chai");

// version.js reads process.env.CDF_DEPLOYMENT_LABEL at call time (not require
// time), so we can toggle it per test. Require fresh to avoid cache surprises.
const versionPath = "../src/modules/version";

function load() {
  delete require.cache[require.resolve(versionPath)];
  return require(versionPath);
}

describe("version (telemetry identity)", () => {
  const SAVED = process.env.CDF_DEPLOYMENT_LABEL;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.CDF_DEPLOYMENT_LABEL;
    else process.env.CDF_DEPLOYMENT_LABEL = SAVED;
  });

  it("exposes a maintainer-controlled release constant (not derived from package.json)", () => {
    const { CONNECTOR_RELEASE } = load();
    expect(CONNECTOR_RELEASE).to.match(/^\d+\.\d+\.\d+$/);
  });

  describe("without a deployment label", () => {
    beforeEach(() => { delete process.env.CDF_DEPLOYMENT_LABEL; });

    it("userAgentTag is just product/release", () => {
      const { userAgentTag, CONNECTOR_RELEASE } = load();
      expect(userAgentTag("esri_databricks-customdatafeed"))
        .to.equal(`esri_databricks-customdatafeed/${CONNECTOR_RELEASE}`);
    });

    it("applicationName is just product/release", () => {
      const { applicationName, CONNECTOR_RELEASE } = load();
      expect(applicationName("esri_databricks-lakebase-customdatafeed"))
        .to.equal(`esri_databricks-lakebase-customdatafeed/${CONNECTOR_RELEASE}`);
    });

    it("deploymentLabel is null", () => {
      expect(load().deploymentLabel()).to.equal(null);
    });
  });

  describe("with a deployment label", () => {
    it("appends a separate ;deploy/ token in the user-agent (version stays parseable)", () => {
      process.env.CDF_DEPLOYMENT_LABEL = "AGE-11.5";
      const { userAgentTag, CONNECTOR_RELEASE } = load();
      const tag = userAgentTag("esri_databricks-customdatafeed");
      expect(tag).to.equal(`esri_databricks-customdatafeed/${CONNECTOR_RELEASE}; deploy/AGE-11.5`);
      // the dashboard's version regex stops at ';' — must capture only the release
      const version = /esri_[a-z-]+\/([0-9][^; )]*)/.exec(tag)[1];
      expect(version).to.equal(CONNECTOR_RELEASE);
    });

    it("appends a space-separated deploy/ token in application_name", () => {
      process.env.CDF_DEPLOYMENT_LABEL = "AGE-12.1";
      const { applicationName, CONNECTOR_RELEASE } = load();
      expect(applicationName("esri_databricks-lakebase-customdatafeed"))
        .to.equal(`esri_databricks-lakebase-customdatafeed/${CONNECTOR_RELEASE} deploy/AGE-12.1`);
    });

    it("sanitizes unsafe characters (no ; ( ) that would break parsing)", () => {
      process.env.CDF_DEPLOYMENT_LABEL = "ArcGIS (Pro); v11.5";
      const tag = load().userAgentTag("esri_databricks-customdatafeed");
      expect(tag).to.not.match(/[;()]deploy/);
      expect(tag.split("; deploy/")[1]).to.match(/^[A-Za-z0-9._-]+$/);
    });

    it("bounds the label length", () => {
      process.env.CDF_DEPLOYMENT_LABEL = "x".repeat(200);
      const label = load().deploymentLabel();
      expect(label.length).to.be.at.most(32);
    });

    it("keeps Postgres application_name within the 63-byte limit", () => {
      process.env.CDF_DEPLOYMENT_LABEL = "y".repeat(200);
      const name = load().applicationName("esri_databricks-lakebase-customdatafeed");
      expect(name.length).to.be.at.most(63);
    });

    it("treats whitespace-only label as no label", () => {
      process.env.CDF_DEPLOYMENT_LABEL = "   ";
      expect(load().deploymentLabel()).to.equal(null);
    });
  });
});
