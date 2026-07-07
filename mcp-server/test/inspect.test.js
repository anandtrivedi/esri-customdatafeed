import { expect } from "chai";
import { inspectTable, buildPublishViewSql, validateTableName } from "../src/inspect.js";

// Fake runSql: returns canned results keyed by statement prefix match.
function fakeRunSql(fixtures) {
  const log = [];
  const run = async (statement) => {
    log.push(statement);
    const hit = fixtures.find(([prefix]) => statement.startsWith(prefix));
    if (!hit) throw new Error(`No fixture for: ${statement}`);
    return hit[1];
  };
  run.log = log;
  return run;
}

const DESCRIBE_WKT = [
  "DESCRIBE TABLE cat.sch.roads",
  {
    columns: [],
    rows: [
      ["road_id", "int", null],
      ["name", "string", null],
      ["geometry_wkt", "string", null],
      ["updated_at", "timestamp", null],
    ],
  },
];

describe("validateTableName", () => {
  it("accepts 3-part names", () => {
    expect(validateTableName("cat.sch.tbl")).to.equal("cat.sch.tbl");
  });
  it("rejects injection attempts and short names", () => {
    expect(() => validateTableName("cat.sch.tbl; DROP TABLE x")).to.throw(/3-part/);
    expect(() => validateTableName("sch.tbl")).to.throw(/3-part/);
    expect(() => validateTableName("cat.sch.tbl`--")).to.throw(/3-part/);
  });
});

describe("inspectTable", () => {
  it("derives WKT geometry, id field, and time column", async () => {
    const runSql = fakeRunSql([
      DESCRIBE_WKT,
      ["SELECT geometry_wkt FROM cat.sch.roads", { columns: [], rows: [["LINESTRING (1 2, 3 4)"], ["POINT (5 6)"]] }],
      ["SELECT count(*), count(road_id)", { columns: [], rows: [["100", "100", "100", "1", "100"]] }],
    ]);
    const result = await inspectTable(runSql, "cat.sch.roads");
    expect(result.readyToPublish).to.equal(true);
    expect(result.geometry).to.include({ column: "geometry_wkt", format: "WKT" });
    expect(result.idField).to.include({ column: "road_id", unique: true, int32Safe: true });
    expect(result.timeColumn).to.equal("updated_at");
    expect(result.serviceParameters).to.deep.include({
      tableName: "cat.sch.roads",
      geometryColumn: "geometry_wkt",
      geometryFormat: "WKT",
      idField: "road_id",
      srid: "4326",
    });
  });

  it("detects GeoJSON stored in a hinted string column", async () => {
    const runSql = fakeRunSql([
      [
        "DESCRIBE TABLE cat.sch.places",
        { columns: [], rows: [["id", "bigint", null], ["geojson_col", "string", null]] },
      ],
      ["SELECT geojson_col FROM cat.sch.places", { columns: [], rows: [['{"type":"Point","coordinates":[1,2]}']] }],
      ["SELECT count(*), count(id)", { columns: [], rows: [["10", "10", "10", "1", "10"]] }],
    ]);
    const result = await inspectTable(runSql, "cat.sch.places");
    expect(result.geometry).to.include({ column: "geojson_col", format: "GEOJSON" });
    expect(result.warnings.join(" ")).to.match(/4326/);
  });

  it("flags BIGINT ids beyond the OBJECTID limit as blocking", async () => {
    const runSql = fakeRunSql([
      [
        "DESCRIBE TABLE cat.sch.big",
        { columns: [], rows: [["id", "bigint", null], ["geom_wkt", "string", null]] },
      ],
      ["SELECT geom_wkt FROM cat.sch.big", { columns: [], rows: [["POINT (0 0)"]] }],
      ["SELECT count(*), count(id)", { columns: [], rows: [["5", "5", "5", "1", "9999999999"]] }],
    ]);
    const result = await inspectTable(runSql, "cat.sch.big");
    expect(result.readyToPublish).to.equal(false);
    expect(result.errors.join(" ")).to.match(/32-bit OBJECTID/);
    expect(result.errors.join(" ")).to.match(/create_publish_view/);
    expect(result.serviceParameters).to.equal(null);
  });

  it("uses native GEOMETRY type with sampled SRID", async () => {
    const runSql = fakeRunSql([
      [
        "DESCRIBE TABLE cat.sch.geo",
        { columns: [], rows: [["id", "int", null], ["geom", "geometry", null]] },
      ],
      ["SELECT st_srid(geom)", { columns: [], rows: [["3857"]] }],
      ["SELECT count(*), count(id)", { columns: [], rows: [["7", "7", "7", "1", "7"]] }],
    ]);
    const result = await inspectTable(runSql, "cat.sch.geo");
    expect(result.geometry).to.include({ column: "geom", format: "GEOMETRY", srid: 3857 });
  });

  it("reports missing geometry as blocking", async () => {
    const runSql = fakeRunSql([
      ["DESCRIBE TABLE cat.sch.plain", { columns: [], rows: [["id", "int", null], ["name", "string", null]] }],
      ["SELECT count(*), count(id)", { columns: [], rows: [["3", "3", "3", "1", "3"]] }],
    ]);
    const result = await inspectTable(runSql, "cat.sch.plain");
    expect(result.readyToPublish).to.equal(false);
    expect(result.errors.join(" ")).to.match(/No geometry column/);
  });
});

describe("buildPublishViewSql", () => {
  it("builds a ROW_NUMBER view with validated identifiers", () => {
    const sql = buildPublishViewSql("cat.sch.src", "cat.sch.src_publish", { orderBy: "created_at" });
    expect(sql).to.include("CREATE OR REPLACE VIEW cat.sch.src_publish");
    expect(sql).to.include("ROW_NUMBER() OVER (ORDER BY created_at)");
    expect(sql).to.include("AS objectid");
  });
  it("rejects unsafe orderBy silently (falls back to positional)", () => {
    const sql = buildPublishViewSql("cat.sch.src", "cat.sch.v", { orderBy: "x; DROP" });
    expect(sql).to.include("ORDER BY 1");
  });
});
