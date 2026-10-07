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

    it("drops ORDER BY on feature-tile requests (resultType=tile)", () => {
      // Map Viewer sends orderByFields=<objectId> ASC on every tile; the sort is the cost, not the order
      const sql = build({ orderByFields: "id ASC", resultType: "tile" });
      expect(sql).to.not.include("ORDER BY");
      expect(sql).to.include("LIMIT");
    });

    it("keeps ORDER BY on tile requests that page with resultOffset", () => {
      const sql = build({ orderByFields: "id ASC", resultType: "tile", resultOffset: "5000" });
      expect(sql).to.include("ORDER BY id ASC");
    });

    it("keeps ORDER BY for standard (non-tile) queries", () => {
      expect(build({ orderByFields: "id ASC", resultType: "standard" })).to.include("ORDER BY id ASC");
      expect(build({ orderByFields: "id ASC" })).to.include("ORDER BY id ASC");
    });

    it("should build WHERE clause from where parameter", () => {
      const sql = build({ where: "status = 'active'" });
      expect(sql).to.include("WHERE (status = 'active')");
    });

    it("should build WHERE clause from objectIds", () => {
      const sql = build({ objectIds: "1,2,3" });
      expect(sql).to.include("OBJECTID IN (1,2,3)");
    });

    it("should combine multiple WHERE conditions with AND", () => {
      const sql = build({ where: "status = 'active'", objectIds: "1,2" });
      expect(sql).to.include("WHERE (status = 'active') AND OBJECTID IN (1,2)");
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

    it("should reject non-integer objectIds (injection attempt returns empty)", () => {
      const sql = build({ objectIds: "'; DROP TABLE x--" });
      // Non-integer values are filtered out; with no valid IDs, 1=0 ensures empty result
      expect(sql).to.include("1 = 0");
      expect(sql).to.not.include("DROP");
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
        "WHERE (status = 'active' AND count > 10)"
      );
    });

    it("should allow 1=1 WHERE clause (ArcGIS default)", () => {
      const sql = build({ where: "1=1" });
      expect(sql).to.include("WHERE (1=1)");
    });

    it("keeps an OR in the client WHERE from escaping the time and geometry filters", () => {
      const sql = build(
        { where: "vessel_type = 70 OR vessel_type = 80", time: "1720094400000,1720098000000" },
        { timeColumn: "base_datetime" }
      );
      // without the parentheses AND binds first and the time filter only applies to the last OR term
      expect(sql).to.match(/WHERE \(vessel_type = 70 OR vessel_type = 80\) AND .*base_datetime/);
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

    it("handles an instant (Map Viewer slider in instant mode) as equality, not as no filter", () => {
      const sql = build({ time: "1688479200000" }, { timeColumn: "base_datetime" });
      expect(sql).to.include("base_datetime = '2023-07-04T14:00:00.000Z'");
      expect(sql).to.not.include(">=");
    });

    it("handles open-ended ranges with null on either side", () => {
      expect(build({ time: "null,1688479200000" }, { timeColumn: "t" })).to.include("t <= '2023-07-04T14:00:00.000Z'")
        .and.to.not.include("t >=");
      expect(build({ time: "1688479200000,null" }, { timeColumn: "t" })).to.include("t >= '2023-07-04T14:00:00.000Z'")
        .and.to.not.include("t <=");
      expect(build({ time: "null,null" }, { timeColumn: "t" })).to.not.match(/t [<>=]/);
    });

    it("rejects an unreadable time value instead of silently dropping the filter", () => {
      expect(() => build({ time: "yesterday" }, { timeColumn: "t" })).to.throw(/Invalid time parameter/);
      expect(() => build({ time: "1,2,3" }, { timeColumn: "t" })).to.throw(/Invalid time parameter/);
    });

    it("should not add time filter without timeColumn", () => {
      const sql = build({ time: "1704067200000,1704153600000" });
      expect(sql).to.not.include(">=");
    });
  });
});
