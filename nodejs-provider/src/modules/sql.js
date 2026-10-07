/**
 * sql.js
 * Builds SQL queries for Databricks with geospatial support
 */

const { getGeometryQuery } = require("./geometry");
const { getGeometryToGeoJSON } = require("./geometryFormat");
const {
  validateFieldName,
  checkWhereClauseSafety,
  validateInteger,
} = require("./sanitize");

/**
 * Build SQL query with support for ArcGIS query parameters
 */
function buildSqlQuery(
  geoParams,
  idField,
  geometryField,
  tableName,
  dbWKID,
  fetchSize,
  geometryFormat = null,
  timeColumn = null
) {
  const {
    where,
    outFields = "*",
    orderByFields,
    objectIds,
    geometry,
    inSR,
    resultOffset,
    spatialRel,
    returnIdsOnly,
    returnCountOnly,
    returnDistinctValues,
    returnGeometry = true,
    time,
    resultType,
  } = geoParams;

  // Build SELECT clause
  let selectClause = "";
  if (returnCountOnly) {
    selectClause = "COUNT(1)";
  } else if (returnIdsOnly) {
    selectClause = `${idField}`;
  } else if (returnDistinctValues && !returnGeometry) {
    // Return requested fields + id; let CDF runtime's winnow handle DISTINCT
    const sanitizedFields = outFields.split(",").map((f) => validateFieldName(f)).join(", ");
    const fieldList = outFields.split(",").map((f) => f.trim());
    selectClause = fieldList.includes(idField) ? sanitizedFields : `${sanitizedFields}, ${idField}`;
  } else if (outFields === "*") {
    // Convert geometry to GeoJSON (supports WKT, WKB, GeoJSON, native GEOMETRY)
    const geomToGeoJSON = getGeometryToGeoJSON(geometryField, dbWKID, geometryFormat);
    selectClause = `* EXCEPT (${geometryField}), ${geomToGeoJSON} AS ${geometryField}`;
  } else {
    const sanitizedOutFields = outFields.split(",").map((f) => validateFieldName(f)).join(", ");
    let outputFields = sanitizedOutFields;
    const fieldList = outFields.split(",").map((f) => f.trim());
    if (!fieldList.includes(idField)) {
      // CDF runtime needs the ID field for OBJECTID mapping
      outputFields = sanitizedOutFields + `, ${idField}`;
    }
    // Convert geometry to GeoJSON (supports WKT, WKB, GeoJSON, native GEOMETRY)
    const geomToGeoJSON = getGeometryToGeoJSON(geometryField, dbWKID, geometryFormat);
    selectClause = `${outputFields}, ${geomToGeoJSON} AS ${geometryField}`;
  }

  const from = ` FROM ${tableName}`;

  // Build WHERE clause
  const whereClause = buildSqlWhere({
    where,
    objectIds,
    idField,
    geometry,
    geometryField,
    inSR,
    spatialRel,
    dbWKID,
    time,
    timeColumn,
    geometryFormat,
  });

  // Build ORDER BY clause with sanitization. Feature-tile requests (resultType=tile, no offset) don't page and draw in
  // any order, but clients still send orderByFields=<objectId> ASC. On a large table that forces a sort of every row in
  // the tile before the LIMIT (33 s vs 2 s on a 28B-row table), so tiles get no ORDER BY.
  const unorderedTile = String(resultType || "").toLowerCase() === "tile" && !resultOffset;
  const orderByClause = unorderedTile ? "" : buildOrderByClause(orderByFields);

  // Build DISTINCT clause
  const distinctClause = returnDistinctValues ? `DISTINCT ` : "";

  // Build LIMIT and OFFSET clauses
  const limitClause =
    fetchSize && !returnIdsOnly && !returnDistinctValues
      ? ` LIMIT ${fetchSize + 1}`
      : "";
  const sanitizedOffset = resultOffset ? validateInteger(resultOffset, 0) : 0;
  const offsetClause =
    sanitizedOffset && !returnIdsOnly ? ` OFFSET ${sanitizedOffset}` : "";

  return `SELECT ${distinctClause}${selectClause}${from}${whereClause}${orderByClause}${limitClause}${offsetClause}`;
}

/**
 * Build WHERE clause from query parameters
 */
function buildSqlWhere({
  where,
  objectIds,
  idField,
  geometry,
  geometryField,
  inSR,
  spatialRel,
  dbWKID,
  time,
  timeColumn,
  geometryFormat = null,
}) {
  const sqlWhereComponents = [];

  if (!where && objectIds === undefined && !geometry && !time) {
    return "";
  }

  // Add WHERE clause (with DDL/DML keyword check)
  if (where) {
    checkWhereClauseSafety(where);
    // Parenthesized: the time/geometry/objectId filters are ANDed on below, and AND binds tighter than OR, so a bare
    // "a OR b" would leave those filters applying to "b" only — on a large table, a near-full scan.
    sqlWhereComponents.push(`(${where})`);
  }

  // Add objectIds filter (IDs must be integers — used as ArcGIS OBJECTIDs)
  if (idField && objectIds) {
    const ids = objectIds
      .split(",")
      .map((val) => val.trim())
      .filter((val) => val !== "")
      .map(Number)
      .filter((n) => Number.isFinite(n) && Number.isInteger(n));

    if (ids.length > 0) {
      sqlWhereComponents.push(`${idField} IN (${ids.join(",")})`);
    } else {
      // All IDs were invalid — return empty result set
      sqlWhereComponents.push("1 = 0");
    }
  }

  // Add spatial filter
  if (geometry && geometryField) {
    const geomComponent = getGeometryQuery(
      geometry,
      geometryField,
      inSR,
      spatialRel,
      dbWKID,
      geometryFormat
    );
    sqlWhereComponents.push(geomComponent);
  }

  // Add time filter
  if (time) {
    const timeComponent = buildTimeFilter(time, timeColumn);
    if (timeComponent) {
      sqlWhereComponents.push(timeComponent);
    }
  }

  if (sqlWhereComponents.length === 0) {
    return "";
  }

  return " WHERE " + sqlWhereComponents.join(" AND ");
}

/**
 * Build ORDER BY clause with sanitization
 * Supports formats like: "field1 ASC", "field1 ASC, field2 DESC"
 */
function buildOrderByClause(orderByFields) {
  if (!orderByFields) return "";

  const fields = orderByFields.split(",").map((f) => f.trim());

  const sanitizedFields = fields.map((field) => {
    const parts = field.split(/\s+/);
    const fieldName = parts[0];
    const direction = parts[1]?.toUpperCase();

    // Sanitize field name (allow alphanumeric and underscore)
    const sanitizedField = fieldName.replace(/[^a-zA-Z0-9_]/g, "");

    const validDirection = direction === "DESC" ? "DESC" : "ASC";

    return `${sanitizedField} ${validDirection}`;
  });

  return ` ORDER BY ${sanitizedFields.join(", ")}`;
}

/**
 * Build time filter from time parameter
 * Format: "startTime,endTime" (Unix milliseconds)
 *
 * @param {string} timeParam - Comma-separated start,end in Unix milliseconds
 * @param {string|null} timeColumn - Name of the timestamp column (configured per service)
 */
function buildTimeFilter(timeParam, timeColumn) {
  if (timeParam === undefined || timeParam === null || timeParam === "" || !timeColumn) return null;

  // ArcGIS REST `time` takes three forms: an instant ("t"), a range ("t1,t2"), or an open-ended range with null for
  // either end ("null,t2" / "t1,null"). Map Viewer's time slider sends an instant in instant mode. This used to accept
  // only "t1,t2": an instant parsed as NaN, the filter was dropped, and the query scanned all of history.
  // An unreadable value is an error rather than "no filter", for the same reason.
  const sanitizedColumn = timeColumn.replace(/[^a-zA-Z0-9_]/g, "");
  const toIso = (raw) => {
    const v = String(raw).trim();
    if (v === "" || v.toLowerCase() === "null") return null;
    const ms = Number(v);
    if (!Number.isFinite(ms)) throw new Error(`Invalid time parameter: ${timeParam}`);
    return new Date(ms).toISOString();
  };

  const parts = String(timeParam).split(",");
  if (parts.length > 2) throw new Error(`Invalid time parameter: ${timeParam}`);
  if (parts.length === 1) {
    const at = toIso(parts[0]);
    return at ? `${sanitizedColumn} = '${at}'` : null;
  }
  const start = toIso(parts[0]);
  const end = toIso(parts[1]);
  if (start && end) return `${sanitizedColumn} >= '${start}' AND ${sanitizedColumn} <= '${end}'`;
  if (start) return `${sanitizedColumn} >= '${start}'`;
  if (end) return `${sanitizedColumn} <= '${end}'`;
  return null; // "null,null": explicitly unbounded
}

module.exports = {
  buildSqlQuery,
};
