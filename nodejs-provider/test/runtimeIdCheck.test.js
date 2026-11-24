const { expect } = require("chai");
const path = require("path");
const { findStrictIdCheck, runtimeRejectsFalsyIds, _resetForTests } = require("../src/modules/runtimeIdCheck");

describe("runtimeIdCheck", () => {
  const root = "/srv/arcgis/server/framework/runtime/customdata";
  const providerDir = path.join(root, "providers", "databricks-geospatial-provider", "src", "modules");
  const checkFile = path.join(root, "framework", "packages", "winnow", "src", "filter-and-transform", "transforms", "transform-to-esri-properties.js");
  // The 12.1 file as shipped by Esri (the line that matters).
  const strict = "  if (idFieldDefinition && !properties?.[idFieldDefinition]) {\n    throw new Error(`idField is set to ...`);";
  const fakeFs = (files) => ({ exists: (p) => p in files, read: (p) => files[p] });

  afterEach(() => { delete process.env.CDF_DROP_FALSY_IDS; _resetForTests(); });

  it("finds the 12.1 strict check above the provider directory", () => {
    expect(findStrictIdCheck([providerDir], fakeFs({ [checkFile]: strict }))).to.equal(checkFile);
  });

  it("returns null on a 12.0 runtime (no such file)", () => {
    expect(findStrictIdCheck([providerDir], fakeFs({}))).to.equal(null);
  });

  it("returns null when the file exists but Esri no longer tests for a falsy id", () => {
    const relaxed = "  if (idFieldDefinition && properties?.[idFieldDefinition] == null) {";
    expect(findStrictIdCheck([providerDir], fakeFs({ [checkFile]: relaxed }))).to.equal(null);
  });

  it("treats an unreadable file as absent", () => {
    const fs = { exists: () => true, read: () => { throw new Error("EACCES"); } };
    expect(findStrictIdCheck([providerDir], fs)).to.equal(null);
  });

  it("CDF_DROP_FALSY_IDS=true|false overrides detection", () => {
    process.env.CDF_DROP_FALSY_IDS = "true";
    expect(runtimeRejectsFalsyIds()).to.equal(true);
    process.env.CDF_DROP_FALSY_IDS = "false";
    expect(runtimeRejectsFalsyIds()).to.equal(false);
  });

  it("auto-detects false in the repo (no CDF runtime next to it)", () => {
    const ol = console.log; console.log = () => {};
    try { expect(runtimeRejectsFalsyIds()).to.equal(false); } finally { console.log = ol; }
  });
});
