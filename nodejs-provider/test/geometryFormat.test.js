const { expect } = require("chai");
const {
  getGeometryExpression,
  getGeometryToGeoJSON,
  getGeometryFieldExpression,
  resolveGeometryFormat,
  clearFormatCache,
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

  describe("resolveGeometryFormat", () => {
    // Helper: stub executeQuery that should never be called
    const neverCalled = async () => { throw new Error("executeQuery should not be called"); };

    beforeEach(() => {
      clearFormatCache();
    });

    describe("explicit format (no probe)", () => {
      it("should return explicit format immediately without probing", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", "WKT", neverCalled);
        expect(result).to.equal("WKT");
      });

      it("should normalize explicit format to uppercase", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", "wkb", neverCalled);
        expect(result).to.equal("WKB");
      });

      it("should return GEOJSON for explicit geojson format", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", "geojson", neverCalled);
        expect(result).to.equal("GEOJSON");
      });

      it("should return GEOMETRY for explicit geometry format", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", "GEOMETRY", neverCalled);
        expect(result).to.equal("GEOMETRY");
      });
    });

    describe("name-based detection (no probe)", () => {
      it("should detect WKT from column name containing 'wkt'", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geom_wkt", null, neverCalled);
        expect(result).to.equal("WKT");
      });

      it("should detect WKB from column name containing 'wkb'", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "my_wkb_col", null, neverCalled);
        expect(result).to.equal("WKB");
      });

      it("should detect GEOJSON from column name containing 'geojson'", async () => {
        const result = await resolveGeometryFormat("catalog.schema.tbl", "data_geojson", null, neverCalled);
        expect(result).to.equal("GEOJSON");
      });
    });

    describe("schema probe", () => {
      it("should detect STRING column as WKT", async () => {
        const stub = async () => [
          { col_name: "id", data_type: "bigint" },
          { col_name: "geometry", data_type: "string" },
        ];
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("WKT");
      });

      it("should detect BINARY column as WKB", async () => {
        const stub = async () => [
          { col_name: "id", data_type: "bigint" },
          { col_name: "geometry", data_type: "binary" },
        ];
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("WKB");
      });

      it("should detect native geometry column as GEOMETRY", async () => {
        const stub = async () => [
          { col_name: "id", data_type: "bigint" },
          { col_name: "geometry", data_type: "geometry" },
        ];
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("GEOMETRY");
      });

      it("should handle case-insensitive column name matching", async () => {
        const stub = async () => [
          { col_name: "GEOMETRY", data_type: "string" },
        ];
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("WKT");
      });

      it("should handle uppercase DESCRIBE output keys", async () => {
        const stub = async () => [
          { COL_NAME: "geometry", DATA_TYPE: "binary" },
        ];
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("WKB");
      });

      it("should default to GEOMETRY when column not found in DESCRIBE output", async () => {
        const stub = async () => [
          { col_name: "id", data_type: "bigint" },
          { col_name: "name", data_type: "string" },
        ];
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("GEOMETRY");
      });
    });

    describe("caching", () => {
      it("should cache the result and not probe again on second call", async () => {
        let probeCount = 0;
        const stub = async () => {
          probeCount++;
          return [{ col_name: "geometry", data_type: "string" }];
        };

        const first = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(first).to.equal("WKT");
        expect(probeCount).to.equal(1);

        const second = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, neverCalled);
        expect(second).to.equal("WKT");
        // neverCalled would throw if probe ran again — passing proves cache was used
      });

      it("should use separate cache entries for different tables", async () => {
        const stubString = async () => [{ col_name: "geometry", data_type: "string" }];
        const stubBinary = async () => [{ col_name: "geometry", data_type: "binary" }];

        const r1 = await resolveGeometryFormat("catalog.schema.tbl_a", "geometry", null, stubString);
        const r2 = await resolveGeometryFormat("catalog.schema.tbl_b", "geometry", null, stubBinary);
        expect(r1).to.equal("WKT");
        expect(r2).to.equal("WKB");
      });
    });

    describe("probe failure", () => {
      it("should default to GEOMETRY when probe throws an error", async () => {
        const stub = async () => { throw new Error("Connection timeout"); };
        const result = await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(result).to.equal("GEOMETRY");
      });

      it("should cache the GEOMETRY default after probe failure", async () => {
        let probeCount = 0;
        const stub = async () => {
          probeCount++;
          throw new Error("Connection timeout");
        };

        await resolveGeometryFormat("catalog.schema.fail_tbl", "geometry", null, stub);
        expect(probeCount).to.equal(1);

        // Second call uses cache — neverCalled would throw if probe ran again
        const result = await resolveGeometryFormat("catalog.schema.fail_tbl", "geometry", null, neverCalled);
        expect(result).to.equal("GEOMETRY");
      });
    });

    describe("clearFormatCache", () => {
      it("should clear the cache so next call probes again", async () => {
        let probeCount = 0;
        const stub = async () => {
          probeCount++;
          return [{ col_name: "geometry", data_type: "string" }];
        };

        await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(probeCount).to.equal(1);

        clearFormatCache();

        await resolveGeometryFormat("catalog.schema.tbl", "geometry", null, stub);
        expect(probeCount).to.equal(2);
      });
    });
  });
});
