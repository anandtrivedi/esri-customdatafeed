const { expect } = require("chai");
const {
  getGeometryExpression,
  getGeometryToGeoJSON,
  getGeometryFieldExpression,
} = require("../src/modules/geometryFormat");

describe("geometryFormat", () => {
  describe("getGeometryExpression", () => {
    describe("explicit format", () => {
      it("should return ST_GeomFromText for WKT", () => {
        const result = getGeometryExpression("geom_col", 4326, "WKT");
        expect(result.expression).to.equal("ST_GeomFromText(geom_col, 4326)");
        expect(result.format).to.equal("WKT");
        expect(result.detectionMethod).to.equal("explicit");
      });

      it("should return ST_GeomFromWKB for WKB", () => {
        const result = getGeometryExpression("geom_col", 4326, "WKB");
        expect(result.expression).to.equal("ST_GeomFromWKB(geom_col, 4326)");
        expect(result.format).to.equal("WKB");
        expect(result.detectionMethod).to.equal("explicit");
      });

      it("should return ST_GeomFromGeoJSON for GEOJSON", () => {
        const result = getGeometryExpression("geom_col", 4326, "GEOJSON");
        expect(result.expression).to.equal("ST_GeomFromGeoJSON(geom_col)");
        expect(result.format).to.equal("GEOJSON");
        expect(result.detectionMethod).to.equal("explicit");
      });

      it("should return raw column for GEOMETRY", () => {
        const result = getGeometryExpression("geom_col", 4326, "GEOMETRY");
        expect(result.expression).to.equal("geom_col");
        expect(result.format).to.equal("GEOMETRY");
        expect(result.detectionMethod).to.equal("explicit");
      });

      it("should be case-insensitive for format string", () => {
        const result = getGeometryExpression("geom_col", 4326, "wkt");
        expect(result.format).to.equal("WKT");
      });

      it("should fall back to name detection for invalid format", () => {
        const result = getGeometryExpression("geom_col", 4326, "INVALID");
        // Falls through to name detection, then default
        expect(result.format).to.equal("GEOMETRY");
        expect(result.detectionMethod).to.equal("default");
      });
    });

    describe("name-based detection", () => {
      it("should detect WKT from column name containing 'wkt'", () => {
        const result = getGeometryExpression("geom_wkt", 4326);
        expect(result.format).to.equal("WKT");
        expect(result.detectionMethod).to.equal("name");
      });

      it("should detect WKB from column name containing 'wkb'", () => {
        const result = getGeometryExpression("geom_wkb", 4326);
        expect(result.format).to.equal("WKB");
        expect(result.detectionMethod).to.equal("name");
      });

      it("should detect GeoJSON from column name containing 'geojson'", () => {
        const result = getGeometryExpression("geom_geojson", 4326);
        expect(result.format).to.equal("GEOJSON");
        expect(result.detectionMethod).to.equal("name");
      });

      it("should default to GEOMETRY for unknown column names", () => {
        const result = getGeometryExpression("geometry", 4326);
        expect(result.format).to.equal("GEOMETRY");
        expect(result.detectionMethod).to.equal("default");
      });

      it("should be case-insensitive for column name detection", () => {
        const result = getGeometryExpression("GEOM_WKT", 4326);
        expect(result.format).to.equal("WKT");
      });
    });

    describe("SRID handling", () => {
      it("should use provided SRID for WKT", () => {
        const result = getGeometryExpression("geom_col", 3857, "WKT");
        expect(result.expression).to.include("3857");
      });

      it("should use provided SRID for WKB", () => {
        const result = getGeometryExpression("geom_col", 3857, "WKB");
        expect(result.expression).to.include("3857");
      });

      it("should default SRID to 4326", () => {
        const result = getGeometryExpression("geom_col", undefined, "WKT");
        expect(result.expression).to.include("4326");
      });
    });
  });

  describe("getGeometryToGeoJSON", () => {
    it("should wrap expression in ST_AsGeoJSON for GEOMETRY", () => {
      const result = getGeometryToGeoJSON("geom_col", 4326, "GEOMETRY");
      expect(result).to.equal("ST_AsGeoJSON(geom_col)");
    });

    it("should wrap expression in ST_AsGeoJSON for WKT", () => {
      const result = getGeometryToGeoJSON("geom_col", 4326, "WKT");
      expect(result).to.equal("ST_AsGeoJSON(ST_GeomFromText(geom_col, 4326))");
    });

    it("should wrap expression in ST_AsGeoJSON for WKB", () => {
      const result = getGeometryToGeoJSON("geom_col", 4326, "WKB");
      expect(result).to.equal("ST_AsGeoJSON(ST_GeomFromWKB(geom_col, 4326))");
    });

    it("should wrap expression in ST_AsGeoJSON for GEOJSON", () => {
      const result = getGeometryToGeoJSON("geom_col", 4326, "GEOJSON");
      expect(result).to.equal("ST_AsGeoJSON(ST_GeomFromGeoJSON(geom_col))");
    });
  });

  describe("getGeometryFieldExpression", () => {
    it("should return raw column for GEOMETRY format", () => {
      const result = getGeometryFieldExpression("geom_col", 4326, "GEOMETRY");
      expect(result).to.equal("geom_col");
    });

    it("should return ST_GeomFromText for WKT format", () => {
      const result = getGeometryFieldExpression("geom_col", 4326, "WKT");
      expect(result).to.equal("ST_GeomFromText(geom_col, 4326)");
    });

    it("should return appropriate expression for name-based detection", () => {
      const result = getGeometryFieldExpression("my_wkb_col", 4326);
      expect(result).to.equal("ST_GeomFromWKB(my_wkb_col, 4326)");
    });
  });
});
