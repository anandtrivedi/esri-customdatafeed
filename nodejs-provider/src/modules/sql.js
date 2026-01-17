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
  });

  // Build ORDER BY clause
  const orderByClause = orderByFields ? ` ORDER BY ${orderByFields}` : "";

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
}) {
  const sqlWhereComponents = [];

  if (!where && objectIds === undefined && !geometry) {
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

  return " WHERE " + sqlWhereComponents.join(" AND ");
}

module.exports = {
  buildSqlQuery,
};
