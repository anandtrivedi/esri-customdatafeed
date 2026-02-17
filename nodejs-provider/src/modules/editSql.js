/**
 * editSql.js
 * Parameterized INSERT / UPDATE / DELETE SQL builders for Lakebase (PostgreSQL + PostGIS)
 *
 * All user-supplied values use $1, $2, ... placeholders (pg parameterized queries).
 * Identifiers (table, column names) are validated via sanitize.validateIdentifier().
 */

const { validateIdentifier } = require('./sanitize');

/**
 * Convert ArcGIS/Esri geometry JSON to GeoJSON for PostGIS ST_GeomFromGeoJSON.
 *
 * Handles:
 *  - Already GeoJSON ({ type: "Point", coordinates: [...] })
 *  - Esri point ({ x, y })
 *  - Esri polygon ({ rings: [...] })
 *  - Esri polyline ({ paths: [...] })
 *
 * @param {object} geom - Geometry object
 * @returns {object} GeoJSON geometry
 */
function toGeoJSON(geom) {
  if (!geom) return null;

  // Already GeoJSON
  if (geom.type && geom.coordinates) {
    return { type: geom.type, coordinates: geom.coordinates };
  }

  // Esri point
  if (geom.x !== undefined && geom.y !== undefined) {
    if (typeof geom.x !== 'number' || typeof geom.y !== 'number' || isNaN(geom.x) || isNaN(geom.y)) {
      throw new Error('Invalid point coordinates: x and y must be numbers');
    }
    return { type: 'Point', coordinates: [geom.x, geom.y] };
  }

  // Esri polygon
  if (geom.rings) {
    return { type: 'Polygon', coordinates: geom.rings };
  }

  // Esri polyline
  if (geom.paths) {
    if (geom.paths.length === 1) {
      return { type: 'LineString', coordinates: geom.paths[0] };
    }
    return { type: 'MultiLineString', coordinates: geom.paths };
  }

  return null;
}

/**
 * Build a parameterized INSERT statement.
 *
 * @param {string} schema - PostgreSQL schema name
 * @param {string} table  - Table name
 * @param {object} attributes - Key/value attribute pairs
 * @param {object|null} geometry - Geometry object (Esri or GeoJSON)
 * @param {string} geometryColumn - Name of the geometry column
 * @param {string} idField - Name of the ID column (returned via RETURNING)
 * @param {number} [srid=4326] - SRID for geometry
 * @returns {{ sql: string, params: any[] }}
 */
function buildInsertSql(schema, table, attributes, geometry, geometryColumn, idField, srid = 4326) {
  validateIdentifier(schema);
  validateIdentifier(table);
  validateIdentifier(geometryColumn);
  validateIdentifier(idField);

  const columns = [];
  const placeholders = [];
  const params = [];
  let paramIndex = 1;

  // Add attribute columns
  if (attributes) {
    for (const [col, val] of Object.entries(attributes)) {
      if (col === idField) continue; // Skip ID — auto-generated
      validateIdentifier(col);
      columns.push(col);
      placeholders.push(`$${paramIndex}`);
      params.push(val);
      paramIndex++;
    }
  }

  // Add geometry column
  if (geometry) {
    const geoJson = toGeoJSON(geometry);
    if (geoJson) {
      columns.push(geometryColumn);
      placeholders.push(`ST_SetSRID(ST_GeomFromGeoJSON($${paramIndex}), ${Number(srid)})`);
      params.push(JSON.stringify(geoJson));
      paramIndex++;
    }
  }

  if (columns.length === 0) {
    throw new Error('INSERT requires at least one column');
  }

  const sql = `INSERT INTO ${schema}.${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${idField}`;
  return { sql, params };
}

/**
 * Build a parameterized UPDATE statement.
 *
 * @param {string} schema - PostgreSQL schema name
 * @param {string} table  - Table name
 * @param {object} attributes - Key/value attribute pairs (must include idField value)
 * @param {object|null} geometry - Geometry object (Esri or GeoJSON), null to skip geometry update
 * @param {string} geometryColumn - Name of the geometry column
 * @param {string} idField - Name of the ID column
 * @param {number} [srid=4326] - SRID for geometry
 * @returns {{ sql: string, params: any[] }}
 */
function buildUpdateSql(schema, table, attributes, geometry, geometryColumn, idField, srid = 4326) {
  validateIdentifier(schema);
  validateIdentifier(table);
  validateIdentifier(geometryColumn);
  validateIdentifier(idField);

  const setClauses = [];
  const params = [];
  let paramIndex = 1;

  // Extract the object ID for the WHERE clause
  const objectId = attributes[idField];
  if (objectId === undefined || objectId === null) {
    throw new Error(`UPDATE requires ${idField} in attributes`);
  }

  // Build SET clauses for attributes (skip the ID itself)
  for (const [col, val] of Object.entries(attributes)) {
    if (col === idField) continue;
    validateIdentifier(col);
    setClauses.push(`${col} = $${paramIndex}`);
    params.push(val);
    paramIndex++;
  }

  // Add geometry SET clause
  if (geometry) {
    const geoJson = toGeoJSON(geometry);
    if (geoJson) {
      setClauses.push(`${geometryColumn} = ST_SetSRID(ST_GeomFromGeoJSON($${paramIndex}), ${Number(srid)})`);
      params.push(JSON.stringify(geoJson));
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    throw new Error('UPDATE requires at least one column to update');
  }

  // WHERE clause uses the object ID
  params.push(objectId);
  const sql = `UPDATE ${schema}.${table} SET ${setClauses.join(', ')} WHERE ${idField} = $${paramIndex}`;

  return { sql, params };
}

/**
 * Build a parameterized DELETE statement.
 *
 * @param {string} schema - PostgreSQL schema name
 * @param {string} table  - Table name
 * @param {string} idField - Name of the ID column
 * @param {number[]} objectIds - Array of object IDs to delete
 * @returns {{ sql: string, params: any[] }}
 */
function buildDeleteSql(schema, table, idField, objectIds) {
  validateIdentifier(schema);
  validateIdentifier(table);
  validateIdentifier(idField);

  if (!Array.isArray(objectIds) || objectIds.length === 0) {
    throw new Error('DELETE requires at least one objectId');
  }

  const placeholders = objectIds.map((_, i) => `$${i + 1}`);
  const sql = `DELETE FROM ${schema}.${table} WHERE ${idField} IN (${placeholders.join(', ')}) RETURNING ${idField}`;
  const params = objectIds.map(Number);

  return { sql, params };
}

module.exports = {
  buildInsertSql,
  buildUpdateSql,
  buildDeleteSql,
  toGeoJSON,
};
