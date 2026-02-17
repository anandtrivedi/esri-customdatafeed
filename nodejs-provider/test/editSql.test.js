const { expect } = require("chai");
const {
  buildInsertSql,
  buildUpdateSql,
  buildDeleteSql,
  toGeoJSON,
} = require("../src/modules/editSql");

describe("editSql", () => {
  describe("toGeoJSON", () => {
    it("should pass through GeoJSON Point", () => {
      const geom = { type: "Point", coordinates: [-77.0, 38.9] };
      const result = toGeoJSON(geom);
      expect(result).to.deep.equal({ type: "Point", coordinates: [-77.0, 38.9] });
    });

    it("should convert Esri point to GeoJSON", () => {
      const geom = { x: -77.0, y: 38.9 };
      const result = toGeoJSON(geom);
      expect(result).to.deep.equal({ type: "Point", coordinates: [-77.0, 38.9] });
    });

    it("should convert Esri polygon to GeoJSON", () => {
      const geom = { rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
      const result = toGeoJSON(geom);
      expect(result).to.deep.equal({
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      });
    });

    it("should convert Esri single-path polyline to GeoJSON LineString", () => {
      const geom = { paths: [[[0, 0], [1, 1], [2, 2]]] };
      const result = toGeoJSON(geom);
      expect(result).to.deep.equal({
        type: "LineString",
        coordinates: [[0, 0], [1, 1], [2, 2]],
      });
    });

    it("should convert Esri multi-path polyline to GeoJSON MultiLineString", () => {
      const geom = { paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] };
      const result = toGeoJSON(geom);
      expect(result).to.deep.equal({
        type: "MultiLineString",
        coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]],
      });
    });

    it("should return null for null input", () => {
      expect(toGeoJSON(null)).to.be.null;
    });

    it("should return null for unrecognized geometry", () => {
      expect(toGeoJSON({ foo: "bar" })).to.be.null;
    });

    it("should throw for non-numeric point coordinates", () => {
      expect(() => toGeoJSON({ x: "bad", y: 38.9 })).to.throw("Invalid point coordinates");
      expect(() => toGeoJSON({ x: -77.0, y: NaN })).to.throw("Invalid point coordinates");
    });
  });

  describe("buildInsertSql", () => {
    it("should build INSERT with attributes and geometry", () => {
      const result = buildInsertSql(
        "public", "cell_towers",
        { name: "Tower A", height: 50 },
        { x: -77.0, y: 38.9 },
        "geometry", "id", 4326
      );
      expect(result.sql).to.equal(
        "INSERT INTO public.cell_towers (name, height, geometry) VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)) RETURNING id"
      );
      expect(result.params).to.have.lengthOf(3);
      expect(result.params[0]).to.equal("Tower A");
      expect(result.params[1]).to.equal(50);
      expect(JSON.parse(result.params[2])).to.deep.equal({
        type: "Point",
        coordinates: [-77.0, 38.9],
      });
    });

    it("should skip idField in attributes", () => {
      const result = buildInsertSql(
        "public", "towers",
        { id: 999, name: "Tower B" },
        null,
        "geometry", "id", 4326
      );
      expect(result.sql).to.include("(name)");
      expect(result.sql).to.not.include("(id,");
      expect(result.params).to.deep.equal(["Tower B"]);
    });

    it("should build INSERT with attributes only (no geometry)", () => {
      const result = buildInsertSql(
        "public", "towers",
        { name: "Tower C", height: 30 },
        null,
        "geometry", "id", 4326
      );
      expect(result.sql).to.include("(name, height)");
      expect(result.sql).to.include("VALUES ($1, $2)");
      expect(result.sql).to.not.include("ST_GeomFromGeoJSON");
      expect(result.params).to.deep.equal(["Tower C", 30]);
    });

    it("should build INSERT with geometry only (no attributes)", () => {
      const result = buildInsertSql(
        "public", "towers",
        {},
        { x: -77.0, y: 38.9 },
        "geometry", "id", 4326
      );
      expect(result.sql).to.include("(geometry)");
      expect(result.params).to.have.lengthOf(1);
    });

    it("should throw for empty attributes and null geometry", () => {
      expect(() => buildInsertSql(
        "public", "towers", {}, null, "geometry", "id", 4326
      )).to.throw("INSERT requires at least one column");
    });

    it("should use RETURNING with the idField", () => {
      const result = buildInsertSql(
        "public", "towers",
        { name: "X" },
        null,
        "geometry", "objectid", 4326
      );
      expect(result.sql).to.include("RETURNING objectid");
    });

    it("should reject invalid schema name (SQL injection)", () => {
      expect(() => buildInsertSql(
        "public; DROP TABLE--", "towers",
        { name: "X" }, null, "geometry", "id", 4326
      )).to.throw("Invalid identifier");
    });

    it("should reject invalid table name (SQL injection)", () => {
      expect(() => buildInsertSql(
        "public", "towers; DROP TABLE--",
        { name: "X" }, null, "geometry", "id", 4326
      )).to.throw("Invalid identifier");
    });

    it("should reject invalid column name in attributes", () => {
      expect(() => buildInsertSql(
        "public", "towers",
        { "name; DROP TABLE x": "bad" }, null, "geometry", "id", 4326
      )).to.throw("Invalid identifier");
    });

    it("should use parameterized values (no string interpolation for values)", () => {
      const result = buildInsertSql(
        "public", "towers",
        { name: "O'Malley's Tower; DROP TABLE towers--" },
        null, "geometry", "id", 4326
      );
      // The dangerous string should be in params, not in SQL
      expect(result.sql).to.not.include("O'Malley");
      expect(result.sql).to.not.include("DROP TABLE");
      expect(result.params[0]).to.equal("O'Malley's Tower; DROP TABLE towers--");
    });
  });

  describe("buildUpdateSql", () => {
    it("should build UPDATE with attributes and geometry", () => {
      const result = buildUpdateSql(
        "public", "towers",
        { id: 42, name: "Updated Tower", height: 60 },
        { x: -78.0, y: 39.0 },
        "geometry", "id", 4326
      );
      expect(result.sql).to.equal(
        "UPDATE public.towers SET name = $1, height = $2, geometry = ST_SetSRID(ST_GeomFromGeoJSON($3), 4326) WHERE id = $4"
      );
      expect(result.params[0]).to.equal("Updated Tower");
      expect(result.params[1]).to.equal(60);
      expect(result.params[3]).to.equal(42); // object ID in WHERE clause
    });

    it("should build UPDATE with attributes only", () => {
      const result = buildUpdateSql(
        "public", "towers",
        { id: 42, name: "Updated" },
        null,
        "geometry", "id", 4326
      );
      expect(result.sql).to.include("SET name = $1");
      expect(result.sql).to.include("WHERE id = $2");
      expect(result.sql).to.not.include("ST_GeomFromGeoJSON");
    });

    it("should throw when idField is missing from attributes", () => {
      expect(() => buildUpdateSql(
        "public", "towers",
        { name: "No ID" },
        null,
        "geometry", "id", 4326
      )).to.throw("UPDATE requires id in attributes");
    });

    it("should throw when only idField is provided (nothing to update)", () => {
      expect(() => buildUpdateSql(
        "public", "towers",
        { id: 42 },
        null,
        "geometry", "id", 4326
      )).to.throw("UPDATE requires at least one column to update");
    });

    it("should reject invalid identifiers", () => {
      expect(() => buildUpdateSql(
        "bad schema!", "towers",
        { id: 1, name: "X" }, null, "geometry", "id", 4326
      )).to.throw("Invalid identifier");
    });
  });

  describe("buildDeleteSql", () => {
    it("should build DELETE for single ID", () => {
      const result = buildDeleteSql("public", "towers", "id", [42]);
      expect(result.sql).to.equal("DELETE FROM public.towers WHERE id IN ($1)");
      expect(result.params).to.deep.equal([42]);
    });

    it("should build DELETE for multiple IDs", () => {
      const result = buildDeleteSql("public", "towers", "id", [1, 2, 3]);
      expect(result.sql).to.equal("DELETE FROM public.towers WHERE id IN ($1, $2, $3)");
      expect(result.params).to.deep.equal([1, 2, 3]);
    });

    it("should throw for empty objectIds array", () => {
      expect(() => buildDeleteSql("public", "towers", "id", [])).to.throw(
        "DELETE requires at least one objectId"
      );
    });

    it("should throw for non-array objectIds", () => {
      expect(() => buildDeleteSql("public", "towers", "id", 42)).to.throw(
        "DELETE requires at least one objectId"
      );
    });

    it("should reject invalid schema name", () => {
      expect(() => buildDeleteSql("bad; schema", "towers", "id", [1])).to.throw(
        "Invalid identifier"
      );
    });

    it("should convert string IDs to numbers", () => {
      const result = buildDeleteSql("public", "towers", "id", ["42", "43"]);
      expect(result.params).to.deep.equal([42, 43]);
    });
  });
});
