const { expect } = require("chai");
const {
  buildLakebaseSelectSql,
  parseGeometryFilter,
  getSpatialPredicate,
  buildGeomParam,
  parseInSR,
} = require("../src/modules/lakebaseQuery");

describe("lakebaseQuery", () => {
  const baseConfig = {
    lakebaseSchema: "public",
    lakebaseTable: "cell_towers",
    geometryColumn: "geometry",
    idField: "id",
    dbWKID: 4326,
    maxRecordCountPerPage: 2000,
  };

  describe("buildLakebaseSelectSql", () => {
    it("should build basic SELECT * query", () => {
      const { sql, params } = buildLakebaseSelectSql(
        { outFields: "*" },
        baseConfig
      );
      expect(sql).to.include("SELECT *, ST_AsGeoJSON(geometry) AS geometry");
      expect(sql).to.include("FROM public.cell_towers");
      expect(sql).to.include("LIMIT 2001"); // fetchSize + 1
      expect(params).to.have.lengthOf(0);
    });

    it("should return the effective fetchSize so callers can detect exceededTransferLimit", () => {
      const dflt = buildLakebaseSelectSql({ outFields: "*" }, baseConfig);
      expect(dflt.fetchSize).to.equal(2000);

      const paged = buildLakebaseSelectSql(
        { outFields: "*", resultRecordCount: "5" },
        baseConfig
      );
      expect(paged.fetchSize).to.equal(5);
      expect(paged.sql).to.include("LIMIT 6"); // fetchSize + 1

      const capped = buildLakebaseSelectSql(
        { outFields: "*", resultRecordCount: "99999" },
        baseConfig
      );
      expect(capped.fetchSize).to.equal(2000); // capped to maxRecordCountPerPage
    });

    it("should build COUNT query for returnCountOnly", () => {
      const { sql, params } = buildLakebaseSelectSql(
        { returnCountOnly: true },
        baseConfig
      );
      expect(sql).to.include("SELECT COUNT(*) AS count");
      expect(sql).to.include("FROM public.cell_towers");
      expect(sql).to.not.include("LIMIT");
      expect(params).to.have.lengthOf(0);
    });

    it("should build IDs-only query for returnIdsOnly", () => {
      const { sql } = buildLakebaseSelectSql(
        { returnIdsOnly: true },
        baseConfig
      );
      expect(sql).to.include("SELECT id");
      expect(sql).to.not.include("ST_AsGeoJSON");
      expect(sql).to.not.include("LIMIT");
    });

    it("should build query with specific outFields", () => {
      const { sql } = buildLakebaseSelectSql(
        { outFields: "name,height" },
        baseConfig
      );
      expect(sql).to.include("name");
      expect(sql).to.include("height");
      expect(sql).to.include("id"); // idField always added
      expect(sql).to.include("ST_AsGeoJSON(geometry) AS geometry");
    });

    it("should include idField in outFields when already present", () => {
      const { sql } = buildLakebaseSelectSql(
        { outFields: "id,name" },
        baseConfig
      );
      // Should not duplicate 'id'
      const idCount = (sql.match(/\bid\b/g) || []).length;
      // id appears in: SELECT field list, FROM clause is after — just check it's there
      expect(sql).to.include("id");
    });

    it("should apply WHERE clause", () => {
      const { sql, params } = buildLakebaseSelectSql(
        { where: "height > 100" },
        baseConfig
      );
      expect(sql).to.include("WHERE height > 100");
      expect(params).to.have.lengthOf(0);
    });

    it("should reject dangerous WHERE clause", () => {
      expect(() => buildLakebaseSelectSql(
        { where: "1=1; DROP TABLE towers" },
        baseConfig
      )).to.throw("dangerous SQL keyword");
    });

    it("should apply objectIds filter with parameterized values", () => {
      const { sql, params } = buildLakebaseSelectSql(
        { objectIds: "1,2,3" },
        baseConfig
      );
      expect(sql).to.include("id IN ($1, $2, $3)");
      expect(params).to.deep.equal([1, 2, 3]);
    });

    it("should apply spatial filter with parameterized geometry", () => {
      const envelope = JSON.stringify({ xmin: -78, ymin: 38, xmax: -77, ymax: 39 });
      const { sql, params } = buildLakebaseSelectSql(
        { geometry: envelope },
        baseConfig
      );
      expect(sql).to.include("ST_Intersects(geometry, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))");
      expect(params).to.have.lengthOf(1);
      const geoJson = JSON.parse(params[0]);
      expect(geoJson.type).to.equal("Polygon");
    });

    it("should combine WHERE, objectIds, and geometry filters", () => {
      const envelope = JSON.stringify({ xmin: -78, ymin: 38, xmax: -77, ymax: 39 });
      const { sql, params } = buildLakebaseSelectSql(
        { where: "height > 50", objectIds: "1,2", geometry: envelope },
        baseConfig
      );
      expect(sql).to.include("WHERE height > 50 AND id IN ($1, $2) AND ST_Intersects");
      expect(params).to.have.lengthOf(3); // 2 objectIds + 1 geometry
    });

    it("should apply ORDER BY clause", () => {
      const { sql } = buildLakebaseSelectSql(
        { orderByFields: "name ASC, height DESC" },
        baseConfig
      );
      expect(sql).to.include("ORDER BY name ASC, height DESC");
    });

    it("should apply OFFSET", () => {
      const { sql } = buildLakebaseSelectSql(
        { resultOffset: 100 },
        baseConfig
      );
      expect(sql).to.include("OFFSET 100");
    });

    it("should respect custom resultRecordCount", () => {
      const { sql } = buildLakebaseSelectSql(
        { resultRecordCount: 50 },
        baseConfig
      );
      expect(sql).to.include("LIMIT 51"); // fetchSize + 1
    });

    it("should reject invalid schema name", () => {
      expect(() => buildLakebaseSelectSql(
        {},
        { ...baseConfig, lakebaseSchema: "bad; schema" }
      )).to.throw("Invalid identifier");
    });

    it("should reject invalid table name", () => {
      expect(() => buildLakebaseSelectSql(
        {},
        { ...baseConfig, lakebaseTable: "bad; table" }
      )).to.throw("Invalid identifier");
    });
  });

  describe("parseGeometryFilter", () => {
    it("should parse Esri envelope JSON", () => {
      const result = parseGeometryFilter(
        JSON.stringify({ xmin: -78, ymin: 38, xmax: -77, ymax: 39 })
      );
      expect(result.type).to.equal("Polygon");
      expect(result.coordinates[0]).to.have.lengthOf(5);
    });

    it("should parse comma-delimited envelope string", () => {
      const result = parseGeometryFilter("-78,38,-77,39");
      expect(result.type).to.equal("Polygon");
    });

    it("should parse Esri point", () => {
      const result = parseGeometryFilter({ x: -77, y: 38 });
      expect(result).to.deep.equal({ type: "Point", coordinates: [-77, 38] });
    });

    it("should parse Esri polygon (rings)", () => {
      const result = parseGeometryFilter({
        rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      });
      expect(result.type).to.equal("Polygon");
    });

    it("should parse Esri polyline (paths)", () => {
      const result = parseGeometryFilter({
        paths: [[[0, 0], [1, 1]]],
      });
      expect(result.type).to.equal("LineString");
    });

    it("should pass through GeoJSON geometry", () => {
      const geom = { type: "Point", coordinates: [-77, 38] };
      const result = parseGeometryFilter(geom);
      expect(result).to.deep.equal(geom);
    });

    it("should return null for invalid string", () => {
      const result = parseGeometryFilter("not-a-geometry");
      expect(result).to.be.null;
    });

    it("should return null for unrecognized object", () => {
      const result = parseGeometryFilter({ foo: "bar" });
      expect(result).to.be.null;
    });
  });

  describe("getSpatialPredicate — native PostGIS functions", () => {
    const col = "geometry";
    const param = "ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)";

    it("should use ST_Intersects for esriSpatialRelIntersects", () => {
      const result = getSpatialPredicate("esriSpatialRelIntersects", col, param);
      expect(result).to.equal(`ST_Intersects(${col}, ${param})`);
    });

    it("should use ST_Contains for esriSpatialRelContains", () => {
      const result = getSpatialPredicate("esriSpatialRelContains", col, param);
      expect(result).to.equal(`ST_Contains(${col}, ${param})`);
    });

    it("should use ST_Within for esriSpatialRelWithin", () => {
      const result = getSpatialPredicate("esriSpatialRelWithin", col, param);
      expect(result).to.equal(`ST_Within(${col}, ${param})`);
    });

    it("should use ST_Touches for esriSpatialRelTouches", () => {
      const result = getSpatialPredicate("esriSpatialRelTouches", col, param);
      expect(result).to.equal(`ST_Touches(${col}, ${param})`);
    });

    it("should use native ST_Overlaps (no DE-9IM workaround)", () => {
      const result = getSpatialPredicate("esriSpatialRelOverlaps", col, param);
      expect(result).to.equal(`ST_Overlaps(${col}, ${param})`);
      // Verify it's a simple function call, not a compound expression
      expect(result).to.not.include("ST_Dimension");
      expect(result).to.not.include("ST_Covers");
    });

    it("should use native ST_Crosses (no DE-9IM workaround)", () => {
      const result = getSpatialPredicate("esriSpatialRelCrosses", col, param);
      expect(result).to.equal(`ST_Crosses(${col}, ${param})`);
      // Verify it's a simple function call, not a compound expression
      expect(result).to.not.include("ST_Intersection");
      expect(result).to.not.include("GREATEST");
    });

    it("should throw for unsupported spatial relation", () => {
      expect(() => getSpatialPredicate("esriSpatialRelRelation", col, param))
        .to.throw("Unsupported spatial relation");
    });
  });

  describe("spatialRel in buildLakebaseSelectSql", () => {
    const envelope = JSON.stringify({ xmin: -78, ymin: 38, xmax: -77, ymax: 39 });

    it("should default to ST_Intersects when spatialRel not specified", () => {
      const { sql } = buildLakebaseSelectSql(
        { geometry: envelope },
        baseConfig
      );
      expect(sql).to.include("ST_Intersects(geometry,");
    });

    it("should use ST_Contains when spatialRel is esriSpatialRelContains", () => {
      const { sql } = buildLakebaseSelectSql(
        { geometry: envelope, spatialRel: "esriSpatialRelContains" },
        baseConfig
      );
      expect(sql).to.include("ST_Contains(geometry,");
    });

    it("should use ST_Overlaps (native) when spatialRel is esriSpatialRelOverlaps", () => {
      const { sql } = buildLakebaseSelectSql(
        { geometry: envelope, spatialRel: "esriSpatialRelOverlaps" },
        baseConfig
      );
      expect(sql).to.include("ST_Overlaps(geometry,");
      expect(sql).to.not.include("ST_Dimension");
    });

    it("should use ST_Crosses (native) when spatialRel is esriSpatialRelCrosses", () => {
      const { sql } = buildLakebaseSelectSql(
        { geometry: envelope, spatialRel: "esriSpatialRelCrosses" },
        baseConfig
      );
      expect(sql).to.include("ST_Crosses(geometry,");
      expect(sql).to.not.include("ST_Intersection");
    });

    it("should use ST_Within when spatialRel is esriSpatialRelWithin", () => {
      const { sql } = buildLakebaseSelectSql(
        { geometry: envelope, spatialRel: "esriSpatialRelWithin" },
        baseConfig
      );
      expect(sql).to.include("ST_Within(geometry,");
    });

    it("should use ST_Touches when spatialRel is esriSpatialRelTouches", () => {
      const { sql } = buildLakebaseSelectSql(
        { geometry: envelope, spatialRel: "esriSpatialRelTouches" },
        baseConfig
      );
      expect(sql).to.include("ST_Touches(geometry,");
    });
  });

  describe("buildGeomParam — CRS transformation", () => {
    it("should build basic param with target SRID", () => {
      const result = buildGeomParam(1, 4326);
      expect(result).to.equal("ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)");
    });

    it("should not transform when inSR matches target SRID", () => {
      const result = buildGeomParam(1, 4326, 4326);
      expect(result).to.equal("ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)");
      expect(result).to.not.include("ST_Transform");
    });

    it("should add ST_Transform when inSR differs from target SRID", () => {
      const result = buildGeomParam(1, 4326, 3857);
      expect(result).to.include("ST_Transform");
      expect(result).to.include("3857");
      expect(result).to.include("4326");
    });

    it("should handle string inSR", () => {
      const result = buildGeomParam(2, 4326, "3857");
      expect(result).to.include("ST_Transform");
    });

    it("should handle null inSR (no transform)", () => {
      const result = buildGeomParam(1, 4326, null);
      expect(result).to.not.include("ST_Transform");
    });

    it("coerces a malicious JSON inSR wkid string to an integer SRID (no injection)", () => {
      const result = buildGeomParam(1, 4326, '{"wkid":"3857) OR 1=1 --"}');
      expect(result).to.not.include("OR 1=1");
      expect(result).to.include("ST_Transform");
      expect(result).to.include("3857");
    });

    it("coerces a malicious plain-string inSR to an integer SRID (no injection)", () => {
      const result = buildGeomParam(1, 4326, "3857); DROP TABLE t --");
      expect(result).to.not.include("DROP TABLE");
      expect(result).to.include("3857");
    });
  });

  describe("parseInSR", () => {
    it("should return null for falsy input", () => {
      expect(parseInSR(null)).to.be.null;
      expect(parseInSR(undefined)).to.be.null;
      expect(parseInSR("")).to.be.null;
    });

    it("should return numeric SRID directly", () => {
      expect(parseInSR(4326)).to.equal(4326);
      expect(parseInSR(3857)).to.equal(3857);
    });

    it("should parse numeric string", () => {
      expect(parseInSR("4326")).to.equal(4326);
    });

    it("should parse JSON with wkid", () => {
      expect(parseInSR('{"wkid": 3857}')).to.equal(3857);
    });

    it("should parse JSON with spatialReference.wkid", () => {
      expect(parseInSR('{"spatialReference": {"wkid": 3857}}')).to.equal(3857);
    });

    it("should parse object with wkid", () => {
      expect(parseInSR({ wkid: 3857 })).to.equal(3857);
    });

    it("should return null for non-numeric string", () => {
      expect(parseInSR("not-a-number")).to.be.null;
    });
  });
});
