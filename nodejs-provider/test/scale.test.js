const { expect } = require("chai");
const { parseMinScale, zoomToScale } = require("../src/modules/scale");

describe("parseMinScale", () => {
  it("returns null when unset", () => {
    for (const v of [undefined, null, "", "  "]) expect(parseMinScale(v)).to.equal(null);
  });

  it("accepts a scale denominator, with or without 1: and thousands separators", () => {
    expect(parseMinScale("577791")).to.equal(577791);
    expect(parseMinScale("1:577,791")).to.equal(577791);
    expect(parseMinScale(288895.3)).to.equal(288895);
  });

  it("converts a Web Mercator zoom level to its scale", () => {
    expect(parseMinScale("zoom 10")).to.equal(577791);
    expect(parseMinScale("Level 8")).to.equal(2311162);
    expect(parseMinScale("z12")).to.equal(144448);
    expect(parseMinScale("LOD:11")).to.equal(288895);
    expect(zoomToScale(0)).to.equal(591657528);
  });

  it("rejects malformed values and out-of-range zooms", () => {
    for (const v of ["big", "-5", "0", "zoom 30", "zoom ten"]) expect(() => parseMinScale(v), v).to.throw(/minScale/);
  });
});
