// Table inspection: derive CDF service parameters from Unity Catalog metadata
// so users never fill them in by hand. Mirrors the detection heuristics in
// nodejs-provider/src/modules/geometryFormat.js, but works from DESCRIBE +
// sampling via the Statement Execution API.

import { OBJECTID_MAX } from "./databricks.js";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GEOM_NAME_HINTS = ["geometry", "geom", "shape", "location", "wkt", "wkb", "geojson", "point", "the_geom"];
const ID_NAME_SCORES = { objectid: 4, id: 3, fid: 2 };
const TIME_NAME_HINTS = ["time", "date", "timestamp", "_at", "_ts"];
const WKT_RE = /^\s*(SRID=\d+\s*;\s*)?(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*[(ZM]/i;
const HEX_RE = /^[0-9A-Fa-f]{16,}$/;

export function validateTableName(table) {
  const parts = String(table).split(".");
  if (parts.length !== 3 || !parts.every((p) => IDENT_RE.test(p))) {
    throw new Error(`Table must be a 3-part Unity Catalog name (catalog.schema.table) of plain identifiers — got '${table}'`);
  }
  return parts.join(".");
}

function classifyStringSample(values) {
  const nonNull = values.filter((v) => v != null && v !== "");
  if (nonNull.length === 0) return null;
  if (nonNull.every((v) => WKT_RE.test(v))) return "WKT";
  if (nonNull.every((v) => HEX_RE.test(v))) return "WKB";
  const asJson = nonNull.every((v) => {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed.type === "string" && ("coordinates" in parsed || parsed.type === "GeometryCollection");
    } catch {
      return false;
    }
  });
  if (asJson) return "GEOJSON";
  return null;
}

function nameScore(colName) {
  const lower = colName.toLowerCase();
  for (const hint of GEOM_NAME_HINTS) if (lower.includes(hint)) return GEOM_NAME_HINTS.indexOf(hint) === 0 ? 3 : 2;
  return 0;
}

/**
 * Inspect a UC table and derive publishable service parameters.
 * @param {function} runSql — async (statement) => { columns, rows }
 * @param {string} table — catalog.schema.table
 */
export async function inspectTable(runSql, table, { sampleLimit = 5 } = {}) {
  const fqn = validateTableName(table);
  const warnings = [];
  const errors = [];

  const desc = await runSql(`DESCRIBE TABLE ${fqn}`);
  const columns = [];
  for (const [name, type] of desc.rows) {
    if (!name || name.startsWith("#")) break; // partition/metadata section
    columns.push({ name, type: (type || "").toUpperCase() });
  }
  if (columns.length === 0) throw new Error(`DESCRIBE TABLE ${fqn} returned no columns`);

  // ---- geometry detection -------------------------------------------------
  let geometry = null;
  const nativeGeom = columns.find((c) => c.type.startsWith("GEOMETRY") || c.type.startsWith("GEOGRAPHY"));
  if (nativeGeom) {
    geometry = { column: nativeGeom.name, format: "GEOMETRY", srid: 4326, confidence: "high" };
    try {
      const sridRes = await runSql(
        `SELECT st_srid(${nativeGeom.name}) FROM ${fqn} WHERE ${nativeGeom.name} IS NOT NULL LIMIT 1`
      );
      if (sridRes.rows[0]?.[0] != null) geometry.srid = Number(sridRes.rows[0][0]);
    } catch {
      warnings.push(`Could not read ST_SRID(${nativeGeom.name}) — assuming 4326.`);
    }
  } else {
    const candidates = columns
      .filter((c) => ["STRING", "BINARY", "VARCHAR"].some((t) => c.type.startsWith(t)))
      .map((c) => ({ ...c, score: nameScore(c.name) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const cand of candidates) {
      if (cand.type.startsWith("BINARY")) {
        geometry = { column: cand.name, format: "WKB", srid: 4326, confidence: "medium" };
        warnings.push(`Geometry format WKB inferred from BINARY type of '${cand.name}' — override geometryFormat if wrong.`);
        break;
      }
      const sample = await runSql(`SELECT ${cand.name} FROM ${fqn} WHERE ${cand.name} IS NOT NULL LIMIT ${sampleLimit}`);
      const format = classifyStringSample(sample.rows.map((r) => r[0]));
      if (format) {
        geometry = { column: cand.name, format, srid: 4326, confidence: "high" };
        break;
      }
    }
    if (geometry?.format === "GEOJSON") {
      warnings.push("GeoJSON storage: SRID is fixed to 4326 by ST_GeomFromGeoJSON.");
    }
  }
  if (!geometry) {
    errors.push(
      "No geometry column detected. If geometry lives in a generically-named STRING column, " +
        "re-run with an explicit geometryColumn/geometryFormat override."
    );
  }

  // ---- id field detection -------------------------------------------------
  const intCols = columns.filter((c) => ["INT", "BIGINT", "SMALLINT", "TINYINT", "LONG"].some((t) => c.type.startsWith(t)));
  const scored = intCols
    .map((c) => {
      const lower = c.name.toLowerCase();
      let score = ID_NAME_SCORES[lower] || 0;
      if (!score && lower.endsWith("_id")) score = 1;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
  let idField = null;
  const idCandidate = scored[0];
  if (idCandidate) {
    const stats = await runSql(
      `SELECT count(*), count(${idCandidate.name}), count(DISTINCT ${idCandidate.name}), min(${idCandidate.name}), max(${idCandidate.name}) FROM ${fqn}`
    );
    const [total, nonNull, distinct, min, max] = stats.rows[0].map(Number);
    idField = {
      column: idCandidate.name,
      rowCount: total,
      unique: distinct === nonNull,
      nonNull: nonNull === total,
      min,
      max,
      int32Safe: max <= OBJECTID_MAX && min >= -OBJECTID_MAX,
    };
    if (!idField.unique) errors.push(`idField '${idCandidate.name}' is not unique (${distinct} distinct of ${nonNull}).`);
    if (!idField.nonNull) errors.push(`idField '${idCandidate.name}' has NULLs (${total - nonNull}).`);
    if (!idField.int32Safe)
      errors.push(
        `idField '${idCandidate.name}' exceeds the 32-bit OBJECTID limit (max=${max} > ${OBJECTID_MAX}). ` +
          "Use create_publish_view to generate a view with a ROW_NUMBER() objectid."
      );
  } else {
    errors.push("No integer id column found. Use create_publish_view to add a ROW_NUMBER() objectid.");
  }

  // ---- time column --------------------------------------------------------
  const timeCol = columns.find(
    (c) =>
      (c.type.startsWith("TIMESTAMP") || c.type === "DATE") &&
      TIME_NAME_HINTS.some((h) => c.name.toLowerCase().includes(h))
  ) || columns.find((c) => c.type.startsWith("TIMESTAMP") || c.type === "DATE");

  const ready = errors.length === 0;
  return {
    table: fqn,
    columns,
    rowCount: idField?.rowCount ?? null,
    geometry,
    idField,
    timeColumn: timeCol?.name || null,
    serviceParameters: ready
      ? {
          tableName: fqn,
          geometryColumn: geometry.column,
          geometryFormat: geometry.format,
          idField: idField.column,
          srid: String(geometry.srid),
          timeColumn: timeCol?.name || "",
        }
      : null,
    warnings,
    errors,
    readyToPublish: ready,
  };
}

/** SQL for a publish-safe view when the source table has no usable int32 id. */
export function buildPublishViewSql(sourceTable, viewName, { orderBy } = {}) {
  const src = validateTableName(sourceTable);
  const view = validateTableName(viewName);
  const order = orderBy && IDENT_RE.test(orderBy) ? orderBy : "1";
  return `CREATE OR REPLACE VIEW ${view} AS SELECT CAST(ROW_NUMBER() OVER (ORDER BY ${order}) AS INT) AS objectid, * FROM ${src}`;
}
