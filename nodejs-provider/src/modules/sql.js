/**
 * sql.js
 * Builds SQL queries for Databricks with geospatial support
 */

const { getGeometryQuery } = require("./geometry");
const { getGeometryToGeoJSON } = require("./geometryFormat");
const {
  validateFieldName,
  escapeSqlString,
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

  // Build ORDER BY clause with sanitization
  const orderByClause = buildOrderByClause(orderByFields);

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
    sqlWhereComponents.push(where);
  }

  // Add objectIds filter
  if (idField && objectIds) {
    const objectIdsComponent = objectIds
      .split(",")
      .map((val) => {
        const trimmed = val.trim();
        return isNaN(trimmed) ? `'${escapeSqlString(trimmed)}'` : trimmed;
      })
      .join(",")
      .replace(/^/, `${idField} IN (`)
      .replace(/$/, ")");

    sqlWhereComponents.push(objectIdsComponent);
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

  try {
    // Split by comma for multiple fields
    const fields = orderByFields.split(",").map((f) => f.trim());

    // Process each field
    const sanitizedFields = fields.map((field) => {
      // Split field and direction
      const parts = field.split(/\s+/);
      const fieldName = parts[0];
      const direction = parts[1]?.toUpperCase();

      // Sanitize field name (allow alphanumeric and underscore)
      const sanitizedField = fieldName.replace(/[^a-zA-Z0-9_]/g, "");

      // Validate direction
      const validDirection =
        direction === "DESC" ? "DESC" : "ASC";

      return `${sanitizedField} ${validDirection}`;
    });

    return ` ORDER BY ${sanitizedFields.join(", ")}`;
  } catch (error) {
    console.error("Error building ORDER BY clause:", error);
    return "";
  }
}

/**
 * Build time filter from time parameter
 * Format: "startTime,endTime" (Unix milliseconds)
 *
 * @param {string} timeParam - Comma-separated start,end in Unix milliseconds
 * @param {string|null} timeColumn - Name of the timestamp column (configured per service)
 */
function buildTimeFilter(timeParam, timeColumn) {
  if (!timeParam || !timeColumn) return null;

  try {
    const [startMs, endMs] = timeParam.split(",").map(Number);

    if (isNaN(startMs) || isNaN(endMs)) {
      console.error("Invalid time parameter:", timeParam);
      return null;
    }

    // Sanitize column name (allow alphanumeric and underscore only)
    const sanitizedColumn = timeColumn.replace(/[^a-zA-Z0-9_]/g, "");

    // Convert milliseconds to ISO timestamp
    const startTime = new Date(startMs).toISOString();
    const endTime = new Date(endMs).toISOString();

    return `${sanitizedColumn} >= '${startTime}' AND ${sanitizedColumn} <= '${endTime}'`;
  } catch (error) {
    console.error("Error parsing time parameter:", error);
    return null;
  }
}

module.exports = {
  buildSqlQuery,
};
