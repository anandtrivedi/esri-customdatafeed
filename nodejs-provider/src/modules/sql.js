/**
 * sql.js
 * Builds SQL queries for Databricks with geospatial support
 */

const { getGeometryQuery } = require("./geometry");

/**
 * Build SQL query with support for ArcGIS query parameters
 */
function buildSqlQuery(
  geoParams,
  idField,
  geometryField,
  tableName,
  dbWKID,
  fetchSize
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
    selectClause = `${outFields}`;
  } else if (outFields === "*") {
    // Use ST_AsGeoJSON to convert geometry to GeoJSON
    selectClause = `* EXCEPT (${geometryField}), ST_AsGeoJSON(${geometryField}) AS ${geometryField}`;
  } else {
    let outputFields = outFields;
    if (!outFields.includes(idField)) {
      // Koop needs OBJECTID field in geojson
      outputFields = outFields.concat(`, ${idField}`);
    }
    selectClause = `${outputFields}, ST_AsGeoJSON(${geometryField}) AS ${geometryField}`;
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
  const offsetClause =
    resultOffset && !returnIdsOnly ? ` OFFSET ${resultOffset}` : "";

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
}) {
  const sqlWhereComponents = [];

  if (!where && objectIds === undefined && !geometry && !time) {
    return "";
  }

  // Add WHERE clause
  if (where) {
    sqlWhereComponents.push(where);
  }

  // Add objectIds filter
  if (idField && objectIds) {
    const objectIdsComponent = objectIds
      .split(",")
      .map((val) => {
        return isNaN(val) ? `'${val}'` : val;
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
      dbWKID
    );
    sqlWhereComponents.push(geomComponent);
  }

  // Add time filter
  if (time) {
    const timeComponent = buildTimeFilter(time);
    if (timeComponent) {
      sqlWhereComponents.push(timeComponent);
    }
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
 * Note: Assumes timestamp field is named 'ts' or 'timestamp'
 */
function buildTimeFilter(timeParam) {
  if (!timeParam) return null;

  try {
    const [startMs, endMs] = timeParam.split(",").map(Number);

    if (isNaN(startMs) || isNaN(endMs)) {
      console.error("Invalid time parameter:", timeParam);
      return null;
    }

    // Convert milliseconds to ISO timestamp
    const startTime = new Date(startMs).toISOString();
    const endTime = new Date(endMs).toISOString();

    // Try common timestamp field names
    // Note: In production, this should be a configurable field name
    return `(ts >= '${startTime}' AND ts <= '${endTime}') OR (timestamp >= '${startTime}' AND timestamp <= '${endTime}')`;
  } catch (error) {
    console.error("Error parsing time parameter:", error);
    return null;
  }
}

module.exports = {
  buildSqlQuery,
};
