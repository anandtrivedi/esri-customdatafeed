const { expect } = require("chai");
const { buildSqlQuery } = require("../src/modules/sql");

describe("sql", () => {
  const defaultArgs = {
    idField: "OBJECTID",
    geometryField: "geometry",
    tableName: "catalog.schema.points",
    dbWKID: 4326,
    fetchSize: 2000,
    geometryFormat: "GEOMETRY",
    timeColumn: null,
  };

  function build(geoParams, overrides = {}) {
    const args = { ...defaultArgs, ...overrides };
    return buildSqlQuery(
      geoParams,
      args.idField,
      args.geometryField,
      args.tableName,
      args.dbWKID,
      args.fetchSize,
      args.geometryFormat,
      args.timeColumn
    );
  }

  describe("buildSqlQuery", () => {
    it("should build a basic SELECT * query", () => {
      const sql = build({});
      expect(sql).to.include("SELECT ");
      expect(sql).to.include("* EXCEPT (geometry)");
      expect(sql).to.include("FROM catalog.schema.points");
    });

    it("should build a COUNT query when returnCountOnly is true", () => {
      const sql = build({ returnCountOnly: true });
      expect(sql).to.include("SELECT COUNT(1)");
    });

    it("should build an ID-only query when returnIdsOnly is true", () => {
      const sql = build({ returnIdsOnly: true });
      expect(sql).to.include("SELECT OBJECTID");
    });

    it("should handle DISTINCT with returnDistinctValues", () => {
      const sql = build({
        returnDistinctValues: true,
        returnGeometry: false,
        outFields: "status",
      });
      expect(sql).to.include("SELECT DISTINCT status");
    });

    it("should handle specific outFields", () => {
      const sql = build({ outFields: "name,status" });
      expect(sql).to.include("name, status");
      // Should auto-add OBJECTID since it's not in outFields
      expect(sql).to.include("OBJECTID");
    });

    it("should not duplicate idField in outFields if already included", () => {
      const sql = build({ outFields: "name,OBJECTID" });
      // Should have exactly the fields + geom conversion
      expect(sql).to.include("name, OBJECTID, ST_AsGeoJSON");
    });

    it("should add LIMIT clause based on fetchSize", () => {
      const sql = build({}, { fetchSize: 100 });
      expect(sql).to.include("LIMIT 101"); // fetchSize + 1
    });

    it("should add OFFSET clause", () => {
      const sql = build({ resultOffset: "50" });
      expect(sql).to.include("OFFSET 50");
    });

    it("should build ORDER BY clause", () => {
      const sql = build({ orderByFields: "name ASC" });
      expect(sql).to.include("ORDER BY name ASC");
    });

    it("should build ORDER BY with multiple fields", () => {
      const sql = build({ orderByFields: "name ASC, id DESC" });
      expect(sql).to.include("ORDER BY name ASC, id DESC");
    });

    it("should build WHERE clause from where parameter", () => {
      const sql = build({ where: "status = 'active'" });
      expect(sql).to.include("WHERE status = 'active'");
    });

    it("should build WHERE clause from objectIds", () => {
      const sql = build({ objectIds: "1,2,3" });
      expect(sql).to.include("OBJECTID IN (1,2,3)");
    });

    it("should combine multiple WHERE conditions with AND", () => {
      const sql = build({ where: "status = 'active'", objectIds: "1,2" });
      expect(sql).to.include("WHERE status = 'active' AND OBJECTID IN (1,2)");
    });

    it("should return empty WHERE when no filters", () => {
      const sql = build({});
      expect(sql).to.not.include("WHERE");
    });

    it("should not add LIMIT for returnIdsOnly", () => {
      const sql = build({ returnIdsOnly: true }, { fetchSize: 100 });
      expect(sql).to.not.include("LIMIT");
    });

    it("should handle geometry filter with spatial relation", () => {
      const geom = JSON.stringify({
        xmin: -180,
        ymin: -90,
        xmax: 180,
        ymax: 90,
        spatialReference: { wkid: 4326 },
      });
      const sql = build({
        geometry: geom,
        spatialRel: "esriSpatialRelIntersects",
      });
      expect(sql).to.include("ST_Intersects");
      expect(sql).to.include("WHERE");
    });
  });

  describe("SQL injection protection", () => {
    it("should sanitize outFields with injection attempt", () => {
      expect(() =>
        build({
          outFields: "name; DROP TABLE users--",
          returnDistinctValues: true,
          returnGeometry: false,
        })
      ).to.throw(/Invalid field name/);
    });

    it("should sanitize outFields with subquery attempt", () => {
      expect(() =>
        build({ outFields: "(SELECT password FROM users)" })
      ).to.throw(/Invalid field name/);
    });

    it("should escape single quotes in objectIds", () => {
      const sql = build({ objectIds: "'; DROP TABLE x--" });
      // The input single quote is doubled by escapeSqlString: ' -> ''
      // Then wrapped in quotes: '''' ; DROP TABLE x--'
      // This breaks the injection — the attacker's quote is neutralized.
      expect(sql).to.include("'''");
      expect(sql).to.include("OBJECTID IN (");
    });

    it("should reject DDL in where clause", () => {
      expect(() => build({ where: "1=1; DROP TABLE users" })).to.throw(
        /dangerous SQL keyword/i
      );
    });

    it("should reject DELETE in where clause", () => {
      expect(() =>
        build({ where: "1=1; DELETE FROM users" })
      ).to.throw(/dangerous SQL keyword/i);
    });

    it("should reject UPDATE in where clause", () => {
      expect(() =>
        build({ where: "1=1; UPDATE users SET admin=1" })
      ).to.throw(/dangerous SQL keyword/i);
    });

    it("should sanitize resultOffset to integer", () => {
      const sql = build({ resultOffset: "10; DROP TABLE users" });
      expect(sql).to.include("OFFSET 10");
      expect(sql).to.not.include("DROP");
    });

    it("should handle NaN resultOffset gracefully", () => {
      const sql = build({ resultOffset: "abc" });
      // Should fallback to 0, which means no OFFSET clause
      expect(sql).to.not.include("OFFSET");
    });

    it("should allow normal WHERE clauses", () => {
      const sql = build({ where: "status = 'active' AND count > 10" });
      expect(sql).to.include(
        "WHERE status = 'active' AND count > 10"
      );
    });

    it("should allow 1=1 WHERE clause (ArcGIS default)", () => {
      const sql = build({ where: "1=1" });
      expect(sql).to.include("WHERE 1=1");
    });

    it("should allow valid comma-separated outFields", () => {
      const sql = build({ outFields: "name,status,count_total" });
      expect(sql).to.include("name");
      expect(sql).to.include("status");
      expect(sql).to.include("count_total");
    });
  });

  describe("time filter", () => {
    it("should build time filter when time and timeColumn are provided", () => {
      const sql = build(
        { time: "1704067200000,1704153600000" },
        { timeColumn: "created_at" }
      );
      expect(sql).to.include("created_at >=");
      expect(sql).to.include("created_at <=");
    });

    it("should not add time filter without timeColumn", () => {
      const sql = build({ time: "1704067200000,1704153600000" });
      expect(sql).to.not.include(">=");
    });
  });
});
