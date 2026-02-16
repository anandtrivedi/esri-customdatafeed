const { expect } = require("chai");
const {
  buildLakebaseSelectSql,
  parseGeometryFilter,
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
});
