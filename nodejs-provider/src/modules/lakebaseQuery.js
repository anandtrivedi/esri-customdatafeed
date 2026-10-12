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
const { esriRingsToGeoJSON, esriPathsToGeoJSON } = require('./esriGeometry');
const { looksProjectedGeometry } = require('./geometry');

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
 * @returns {{ sql: string, params: any[], fetchSize: number }} fetchSize is the
 *   effective page size (LIMIT is fetchSize + 1 so the caller can detect
 *   exceededTransferLimit and pop the extra row)
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
    resultType,
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
    // Parenthesized so the filters ANDed on below can't be split by an OR in the client's clause
    whereClauses.push(`(${where})`);
  }

  if (objectIds) {
    const ids = String(objectIds).split(',')
      .map(id => Number(id.trim()))
      // Safe integers only (see sql.js): a rounded id above 2^53 - 1 would match the wrong row.
      .filter(n => Number.isSafeInteger(n));

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
      const geomParam = buildGeomParam(paramIndex, srid, inSR || geometrySourceSR(geometry, srid));
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
  // Tiles (resultType=tile, no offset) get no ORDER BY, as in sql.js: order is irrelevant and the sort is expensive.
  const unorderedTile = String(resultType || '').toLowerCase() === 'tile' && !resultOffset;
  if (orderByFields && !returnCountOnly && !unorderedTile) {
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

  // returnIdsOnly has no page LIMIT (clients want every id); bound it to the ceiling + 1 like the Lakehouse builder so
  // the caller can error instead of holding millions of ids in the shared process.
  const maxReturnIds = Number(sourceConfig.maxReturnIds) || 0;
  if (returnIdsOnly && !returnCountOnly && maxReturnIds > 0) limitStr = ` LIMIT ${maxReturnIds + 1}`;

  const sql = `SELECT ${selectClause} FROM ${schema}.${table}${whereStr}${orderByStr}${limitStr}${offsetStr}`;
  return { sql, params, fetchSize };
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

  // Esri polygon — split into Polygon/MultiPolygon by ring winding
  if (parsed.rings) {
    return esriRingsToGeoJSON(parsed.rings);
  }

  // Esri polyline — single path → LineString, multi → MultiLineString
  if (parsed.paths) {
    return esriPathsToGeoJSON(parsed.paths);
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

  // If inSR differs from target SRID, transform. Coerce the source SRID to an integer HERE
  // (the sink): parseInSR can return a client-supplied wkid STRING (from a JSON inSR param or the
  // geometry's embedded spatialReference), and it is interpolated (not parameterized) below —
  // validate to prevent SQL injection. validateInteger parses leading digits, 0 (falsy) for garbage.
  const rawSR = parseInSR(inSR);
  let sourceSR = rawSR == null ? null : validateInteger(rawSR, 0);
  // Esri's Web Mercator codes aren't in PostGIS's spatial_ref_sys; ST_Transform needs the EPSG code.
  if (ESRI_WEB_MERCATOR.has(sourceSR)) sourceSR = 3857;
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
/**
 * Source SRID when the request has no inSR: the filter geometry's own spatialReference, else Web Mercator if the
 * coordinates can't be degrees (Map Viewer tile envelopes can carry neither — same fallback as geometry.js).
 */
function geometrySourceSR(geometry, srid) {
  let g = geometry;
  if (typeof g === 'string') {
    try { g = JSON.parse(g); } catch (e) {
      g = g.split(',').map(Number); // "xmin,ymin,xmax,ymax" — no SR to read, but the heuristic still applies
      if (g.length !== 4 || g.some((v) => !Number.isFinite(v))) return null;
    }
  }
  const sr = g && g.spatialReference;
  // latestWkid is the EPSG code (3857); wkid can be Esri's 102100, which PostGIS doesn't know.
  if (sr && (sr.latestWkid || sr.wkid)) return sr.latestWkid || sr.wkid;
  if (Number(srid) === 4326 && looksProjectedGeometry(g)) {
    // Once per process: Map Viewer can send this on every tile.
    if (!warnedAssumedMercator) {
      warnedAssumedMercator = true;
      console.warn('[lakebaseQuery] filter has no SR and out-of-4326-range coords; assuming Web Mercator (3857)');
    }
    return 3857;
  }
  return null;
}

const ESRI_WEB_MERCATOR = new Set([102100, 102113, 900913]);
let warnedAssumedMercator = false;

function parseInSR(inSR) {
  if (!inSR) return null;
  if (typeof inSR === 'number') return inSR;
  if (typeof inSR === 'string') {
    try {
      const parsed = JSON.parse(inSR);
      return parsed.spatialReference?.latestWkid || parsed.spatialReference?.wkid || parsed.latestWkid || parsed.wkid || parseInt(inSR, 10) || null;
    } catch {
      const num = parseInt(inSR, 10);
      return isNaN(num) ? null : num;
    }
  }
  if (typeof inSR === 'object') {
    return inSR.spatialReference?.latestWkid || inSR.spatialReference?.wkid || inSR.latestWkid || inSR.wkid || null;
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
