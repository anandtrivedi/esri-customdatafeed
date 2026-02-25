/**
 * lakebaseQuery.js
 * Builds parameterized SELECT queries for Lakebase (PostgreSQL + PostGIS)
 *
 * Maps ArcGIS query parameters to PostgreSQL/PostGIS syntax.
 * All user-supplied values use $1, $2, ... placeholders.
 * Identifiers validated via sanitize.validateIdentifier().
 *
 * PostGIS provides native ST_Overlaps and ST_Crosses — no DE-9IM
 * workarounds needed (unlike the Databricks SQL path in geometry.js).
 */

const {
  validateFieldName,
  validateIdentifier,
  checkWhereClauseSafety,
  validateInteger,
} = require('./sanitize');

/**
 * Build a parameterized SELECT statement for Lakebase reads.
 *
 * @param {object} geoParams - ArcGIS query parameters (where, objectIds, geometry, outFields, etc.)
 * @param {object} sourceConfig
 * @param {string} sourceConfig.lakebaseSchema - PostgreSQL schema
 * @param {string} sourceConfig.lakebaseTable  - Table name
 * @param {string} sourceConfig.geometryColumn - Geometry column name
 * @param {string} sourceConfig.idField        - ID column name
 * @param {number} [sourceConfig.dbWKID=4326]  - SRID
 * @param {number} [sourceConfig.maxRecordCountPerPage=2000] - Max records
 * @returns {{ sql: string, params: any[] }}
 */
function buildLakebaseSelectSql(geoParams, sourceConfig) {
  const {
    where,
    outFields = '*',
    orderByFields,
    objectIds,
    geometry,
    inSR,
    spatialRel = 'esriSpatialRelIntersects',
    resultOffset,
    resultRecordCount,
    returnCountOnly,
    returnIdsOnly,
    returnGeometry = true,
  } = geoParams;

  const schema = sourceConfig.lakebaseSchema;
  const table = sourceConfig.lakebaseTable;
  const geometryColumn = sourceConfig.geometryColumn;
  const idField = sourceConfig.idField;
  const srid = sourceConfig.dbWKID || 4326;
  const maxRecords = sourceConfig.maxRecordCountPerPage || 2000;
  const fetchSize = Math.min(parseInt(resultRecordCount) || maxRecords, maxRecords);

  validateIdentifier(schema);
  validateIdentifier(table);
  validateIdentifier(geometryColumn);
  validateIdentifier(idField);

  const params = [];
  let paramIndex = 1;

  // --- SELECT clause ---
  let selectClause;
  if (returnCountOnly) {
    selectClause = 'COUNT(*) AS count';
  } else if (returnIdsOnly) {
    selectClause = idField;
  } else {
    const geomExpr = `ST_AsGeoJSON(${geometryColumn}) AS ${geometryColumn}`;

    if (outFields === '*') {
      // Select all columns, replacing raw geometry with GeoJSON
      selectClause = `*, ${geomExpr}`;
    } else {
      const fieldList = outFields.split(',').map(f => validateFieldName(f));
      if (!fieldList.includes(idField)) {
        fieldList.push(idField);
      }
      selectClause = `${fieldList.join(', ')}, ${geomExpr}`;
    }
  }

  // --- WHERE clauses ---
  const whereClauses = [];

  if (where) {
    checkWhereClauseSafety(where);
    whereClauses.push(where);
  }

  if (objectIds) {
    const ids = String(objectIds).split(',')
      .map(id => Number(id.trim()))
      .filter(n => Number.isFinite(n) && Number.isInteger(n));

    if (ids.length > 0) {
      const idPlaceholders = ids.map(id => {
        params.push(id);
        return `$${paramIndex++}`;
      });
      whereClauses.push(`${idField} IN (${idPlaceholders.join(', ')})`);
    } else {
      // All IDs were invalid — return empty result set
      whereClauses.push('1 = 0');
    }
  }

  if (geometry) {
    const geoJsonFilter = parseGeometryFilter(geometry);
    if (geoJsonFilter) {
      params.push(JSON.stringify(geoJsonFilter));
      const geomParam = buildGeomParam(paramIndex, srid, inSR);
      const spatialPredicate = getSpatialPredicate(spatialRel, geometryColumn, geomParam);
      whereClauses.push(spatialPredicate);
      paramIndex++;
    }
  }

  const whereStr = whereClauses.length > 0
    ? ` WHERE ${whereClauses.join(' AND ')}`
    : '';

  // --- ORDER BY ---
  let orderByStr = '';
  if (orderByFields && !returnCountOnly) {
    const fields = orderByFields.split(',').map(f => {
      const parts = f.trim().split(/\s+/);
      const fieldName = parts[0].replace(/[^a-zA-Z0-9_]/g, '');
      const direction = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      return `${fieldName} ${direction}`;
    });
    orderByStr = ` ORDER BY ${fields.join(', ')}`;
  }

  // --- LIMIT / OFFSET ---
  let limitStr = '';
  let offsetStr = '';
  if (!returnCountOnly && !returnIdsOnly) {
    // Fetch one extra row to detect exceededTransferLimit
    limitStr = ` LIMIT ${Number(fetchSize) + 1}`;

    const offset = resultOffset ? validateInteger(resultOffset, 0) : 0;
    if (offset > 0) {
      offsetStr = ` OFFSET ${offset}`;
    }
  }

  const sql = `SELECT ${selectClause} FROM ${schema}.${table}${whereStr}${orderByStr}${limitStr}${offsetStr}`;
  return { sql, params };
}

/**
 * Parse an ArcGIS geometry filter into GeoJSON for PostGIS.
 *
 * @param {string|object} geometry - Geometry from ArcGIS query params
 * @returns {object|null} GeoJSON geometry
 */
function parseGeometryFilter(geometry) {
  let parsed = geometry;
  if (typeof geometry === 'string') {
    try {
      parsed = JSON.parse(geometry);
    } catch {
      // Try comma-delimited envelope: xmin,ymin,xmax,ymax
      const parts = geometry.split(',').map(n => Number(n.trim()));
      if (parts.length === 4 && parts.every(n => !isNaN(n))) {
        return {
          type: 'Polygon',
          coordinates: [[
            [parts[0], parts[1]],
            [parts[2], parts[1]],
            [parts[2], parts[3]],
            [parts[0], parts[3]],
            [parts[0], parts[1]],
          ]],
        };
      }
      return null;
    }
  }

  // Esri envelope
  if (parsed.xmin !== undefined) {
    return {
      type: 'Polygon',
      coordinates: [[
        [parsed.xmin, parsed.ymin],
        [parsed.xmax, parsed.ymin],
        [parsed.xmax, parsed.ymax],
        [parsed.xmin, parsed.ymax],
        [parsed.xmin, parsed.ymin],
      ]],
    };
  }

  // Esri point
  if (parsed.x !== undefined && parsed.y !== undefined) {
    return { type: 'Point', coordinates: [parsed.x, parsed.y] };
  }

  // Esri polygon
  if (parsed.rings) {
    return { type: 'Polygon', coordinates: parsed.rings };
  }

  // Esri polyline
  if (parsed.paths) {
    return parsed.paths.length === 1
      ? { type: 'LineString', coordinates: parsed.paths[0] }
      : { type: 'MultiLineString', coordinates: parsed.paths };
  }

  // Already GeoJSON
  if (parsed.type && parsed.coordinates) {
    return parsed;
  }

  return null;
}

/**
 * Build the PostGIS geometry parameter expression, handling CRS transformation.
 *
 * @param {number} paramIndex - Current $N index for the GeoJSON parameter
 * @param {number} srid - Target SRID (typically 4326)
 * @param {string|number} [inSR] - Source spatial reference if different from srid
 * @returns {string} SQL expression like "ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)"
 */
function buildGeomParam(paramIndex, srid, inSR) {
  const base = `ST_SetSRID(ST_GeomFromGeoJSON($${paramIndex}), ${Number(srid)})`;

  // If inSR differs from target SRID, transform
  const sourceSR = parseInSR(inSR);
  if (sourceSR && sourceSR !== Number(srid)) {
    return `ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($${paramIndex}), ${sourceSR}), ${Number(srid)})`;
  }

  return base;
}

/**
 * Parse the ArcGIS inSR parameter to a numeric SRID.
 *
 * @param {string|number|object} inSR
 * @returns {number|null}
 */
function parseInSR(inSR) {
  if (!inSR) return null;
  if (typeof inSR === 'number') return inSR;
  if (typeof inSR === 'string') {
    try {
      const parsed = JSON.parse(inSR);
      return parsed.spatialReference?.wkid || parsed.wkid || parseInt(inSR, 10) || null;
    } catch {
      const num = parseInt(inSR, 10);
      return isNaN(num) ? null : num;
    }
  }
  if (typeof inSR === 'object') {
    return inSR.spatialReference?.wkid || inSR.wkid || null;
  }
  return null;
}

/**
 * Map an ArcGIS spatialRel to a native PostGIS predicate.
 *
 * PostGIS supports all 6 predicates natively — no DE-9IM workarounds needed.
 *
 * @param {string} spatialRel - ArcGIS spatial relationship
 * @param {string} geomColumn - Table geometry column name
 * @param {string} geomParam - SQL expression for the filter geometry
 * @returns {string} SQL WHERE clause fragment
 */
function getSpatialPredicate(spatialRel, geomColumn, geomParam) {
  switch (spatialRel) {
    case 'esriSpatialRelIntersects':
      return `ST_Intersects(${geomColumn}, ${geomParam})`;
    case 'esriSpatialRelContains':
      return `ST_Contains(${geomColumn}, ${geomParam})`;
    case 'esriSpatialRelWithin':
      return `ST_Within(${geomColumn}, ${geomParam})`;
    case 'esriSpatialRelTouches':
      return `ST_Touches(${geomColumn}, ${geomParam})`;
    case 'esriSpatialRelOverlaps':
      return `ST_Overlaps(${geomColumn}, ${geomParam})`;
    case 'esriSpatialRelCrosses':
      return `ST_Crosses(${geomColumn}, ${geomParam})`;
    default:
      throw new Error(`Unsupported spatial relation: ${spatialRel}`);
  }
}

module.exports = {
  buildLakebaseSelectSql,
  parseGeometryFilter,
  getSpatialPredicate,
  buildGeomParam,
  parseInSR,
};
