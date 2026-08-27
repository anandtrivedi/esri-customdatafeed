const { expect } = require("chai");
const {
  esriRingsToGeoJSON,
  esriPathsToGeoJSON,
  signedArea,
} = require("../src/modules/esriGeometry");

describe("esriGeometry", () => {
  describe("signedArea", () => {
    it("should be positive for a counter-clockwise ring", () => {
      const ccw = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
      expect(signedArea(ccw)).to.be.greaterThan(0);
    });

    it("should be negative for a clockwise ring", () => {
      const cw = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
      expect(signedArea(cw)).to.be.lessThan(0);
    });
  });

  describe("esriRingsToGeoJSON", () => {
    it("should return an empty Polygon for empty/invalid input", () => {
      expect(esriRingsToGeoJSON([])).to.deep.equal({ type: "Polygon", coordinates: [] });
      expect(esriRingsToGeoJSON(null)).to.deep.equal({ type: "Polygon", coordinates: [] });
    });

    it("should return a Polygon for a single exterior ring", () => {
      const ring = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]; // CW
      expect(esriRingsToGeoJSON([ring])).to.deep.equal({
        type: "Polygon",
        coordinates: [ring],
      });
    });

    it("should treat the first ring as exterior even if it is counter-clockwise", () => {
      // Defensive: some clients emit CCW-first rings; the first ring always starts a polygon.
      const ccw = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
      const result = esriRingsToGeoJSON([ccw]);
      expect(result.type).to.equal("Polygon");
      expect(result.coordinates).to.deep.equal([ccw]);
    });

    it("should attach counter-clockwise rings as holes", () => {
      const ext = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]; // CW
      const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]; // CCW
      expect(esriRingsToGeoJSON([ext, hole])).to.deep.equal({
        type: "Polygon",
        coordinates: [ext, hole],
      });
    });

    it("should return a MultiPolygon for two exterior rings", () => {
      const a = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]; // CW
      const b = [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]]; // CW
      expect(esriRingsToGeoJSON([a, b])).to.deep.equal({
        type: "MultiPolygon",
        coordinates: [[a], [b]],
      });
    });
  });

  describe("esriPathsToGeoJSON", () => {
    it("should return a LineString for a single path", () => {
      const path = [[0, 0], [1, 1], [2, 2]];
      expect(esriPathsToGeoJSON([path])).to.deep.equal({
        type: "LineString",
        coordinates: path,
      });
    });

    it("should return a MultiLineString for multiple paths", () => {
      const paths = [[[0, 0], [1, 1]], [[2, 2], [3, 3]]];
      expect(esriPathsToGeoJSON(paths)).to.deep.equal({
        type: "MultiLineString",
        coordinates: paths,
      });
    });
  });
});
