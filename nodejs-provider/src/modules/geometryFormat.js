/**
 * geometryFormat.js
 * Handles different geometry column formats (WKT, WKB, GeoJSON, native GEOMETRY)
 * Uses explicit format configuration, name-based fallback, or schema-probe auto-detection
 */

// Cache: "tableName:columnName" → 'WKT' | 'WKB' | 'GEOMETRY'
// Populated on first query via DESCRIBE TABLE, persists for CDF process lifetime.
// Column types don't change at runtime, so no expiry needed.
const formatCache = new Map();

/**
 * Detect geometry format using explicit configuration or name-based detection
 *
 * Priority:
 * 1. Use explicit geometryFormat parameter (most reliable, production)
 * 2. Fall back to name-based detection (convention, testing)
 *
 * @param {string} geometryColumn - Name of geometry column
 * @param {number} srid - Spatial reference ID
 * @param {string} explicitFormat - Optional explicit format: 'WKT' | 'WKB' | 'GEOJSON' | 'GEOMETRY'
 * @returns {object} { expression: string, format: string }
 */
function getGeometryExpression(geometryColumn, srid = 4326, explicitFormat = null) {
  // Priority 1: Use explicit format if provided (production approach)
  if (explicitFormat) {
    const formatUpper = explicitFormat.toUpperCase();

    switch (formatUpper) {
      case 'WKT':
        return {
          expression: `ST_GeomFromText(${geometryColumn}, ${srid})`,
          format: 'WKT',
          description: 'Well-Known Text (configured)',
          detectionMethod: 'explicit'
        };

      case 'WKB':
        return {
          expression: `ST_GeomFromWKB(${geometryColumn}, ${srid})`,
          format: 'WKB',
          description: 'Well-Known Binary (configured)',
          detectionMethod: 'explicit'
        };

      case 'GEOJSON':
        return {
          expression: `ST_GeomFromGeoJSON(${geometryColumn})`,
          format: 'GEOJSON',
          description: 'GeoJSON (configured)',
          detectionMethod: 'explicit'
        };

      case 'GEOMETRY':
        return {
          expression: geometryColumn,
          format: 'GEOMETRY',
          description: 'Native GEOMETRY (configured)',
          detectionMethod: 'explicit'
        };

      default:
        console.warn(`Invalid geometryFormat: ${explicitFormat}, falling back to name detection`);
    }
  }

  // Priority 2: Name-based detection (convention, testing)
  const colLower = geometryColumn.toLowerCase();

  // WKT format (STRING column with Well-Known Text)
  if (colLower.includes('wkt') || colLower.includes('_wkt')) {
    return {
      expression: `ST_GeomFromText(${geometryColumn}, ${srid})`,
      format: 'WKT',
      description: 'Well-Known Text (name-based)',
      detectionMethod: 'name'
    };
  }

  // WKB format (BINARY column with Well-Known Binary)
  if (colLower.includes('wkb') || colLower.includes('_wkb')) {
    return {
      expression: `ST_GeomFromWKB(${geometryColumn}, ${srid})`,
      format: 'WKB',
      description: 'Well-Known Binary (name-based)',
      detectionMethod: 'name'
    };
  }

  // GeoJSON format (STRING column with GeoJSON text)
  if (colLower.includes('geojson') || colLower.includes('_geojson')) {
    return {
      expression: `ST_GeomFromGeoJSON(${geometryColumn})`,
      format: 'GEOJSON',
      description: 'GeoJSON (name-based)',
      detectionMethod: 'name'
    };
  }

  // Default to native GEOMETRY type
  return {
    expression: geometryColumn,
    format: 'GEOMETRY',
    description: 'Native GEOMETRY (default)',
    detectionMethod: 'default'
  };
}

/**
 * Get SQL expression for converting geometry to GeoJSON
 *
 * @param {string} geometryColumn - Name of geometry column
 * @param {number} srid - Spatial reference ID
 * @param {string} explicitFormat - Optional explicit format (WKT, WKB, GEOJSON, GEOMETRY)
 * @returns {string} SQL expression that returns GeoJSON
 */
function getGeometryToGeoJSON(geometryColumn, srid = 4326, explicitFormat = null) {
  const { expression, format, detectionMethod } = getGeometryExpression(geometryColumn, srid, explicitFormat);

  if (detectionMethod && explicitFormat) {
    console.log(`Geometry format for ${geometryColumn}: ${format} (${detectionMethod})`);
  }

  return `ST_AsGeoJSON(${expression})`;
}

/**
 * Get SQL expression for geometry field in WHERE clause (spatial operations)
 *
 * @param {string} geometryColumn - Name of geometry column
 * @param {number} srid - Spatial reference ID
 * @param {string} explicitFormat - Optional explicit format (WKT, WKB, GEOJSON, GEOMETRY)
 * @returns {string} SQL expression for geometry field
 */
function getGeometryFieldExpression(geometryColumn, srid = 4326, explicitFormat = null) {
  const { expression } = getGeometryExpression(geometryColumn, srid, explicitFormat);
  return expression;
}

/**
 * Resolve the geometry format for a Lakehouse table column.
 *
 * Detection priority:
 *   1. Explicit format from service config (e.g. geometryFormat='WKT')
 *   2. Name-based hints (column name contains 'wkt', 'wkb', or 'geojson')
 *   3. Schema probe via DESCRIBE TABLE — runs once, result cached for process lifetime
 *
 * The schema probe maps Databricks data_type to format:
 *   'string'  → WKT  (most common for text-stored geometries)
 *   'binary'  → WKB
 *   anything else (geometry, geography, etc.) → GEOMETRY (native type, used as-is)
 *
 * @param {string} tableName - Fully-qualified table name (catalog.schema.table)
 * @param {string} geometryColumn - Name of the geometry column
 * @param {string|null} explicitFormat - Explicit format from service config, if any
 * @param {function} executeQuery - async (sql) => rows[] — executes a SQL statement on the Databricks connection
 * @returns {Promise<string>} Resolved format: 'WKT' | 'WKB' | 'GEOJSON' | 'GEOMETRY'
 */
async function resolveGeometryFormat(tableName, geometryColumn, explicitFormat, executeQuery) {
  // Priority 1: Explicit config — trust the user's setting
  if (explicitFormat) {
    return explicitFormat.toUpperCase();
  }

  // Priority 2: Name-based hints (same logic as getGeometryExpression fallback)
  const colLower = geometryColumn.toLowerCase();
  if (colLower.includes('wkt')) return 'WKT';
  if (colLower.includes('wkb')) return 'WKB';
  if (colLower.includes('geojson')) return 'GEOJSON';

  // Priority 3: Schema probe with caching
  const cacheKey = `${tableName}:${geometryColumn}`;
  if (formatCache.has(cacheKey)) {
    return formatCache.get(cacheKey);
  }

  // Probe the table schema via DESCRIBE TABLE to determine the column's data type.
  // This runs once per table+column combination and is cached for the process lifetime.
  try {
    const rows = await executeQuery(`DESCRIBE TABLE ${tableName}`);
    const colLowerName = geometryColumn.toLowerCase();
    const match = rows.find(r =>
      (r.col_name || r.COL_NAME || '').toLowerCase() === colLowerName
    );

    if (match) {
      const dataType = (match.data_type || match.DATA_TYPE || '').toLowerCase();

      let format;
      if (dataType === 'string') {
        format = 'WKT';
      } else if (dataType === 'binary') {
        format = 'WKB';
      } else {
        // 'geometry', 'geography', or other native types — use column directly
        format = 'GEOMETRY';
      }

      console.log(`Geometry format auto-detected for ${tableName}.${geometryColumn}: ${format} (data_type=${dataType})`);
      formatCache.set(cacheKey, format);
      return format;
    }

    // Column not found in DESCRIBE output — fall back to GEOMETRY
    console.warn(`Geometry column '${geometryColumn}' not found in DESCRIBE TABLE ${tableName}, defaulting to GEOMETRY`);
    formatCache.set(cacheKey, 'GEOMETRY');
    return 'GEOMETRY';
  } catch (error) {
    // Probe failed (permissions, network, etc.) — default to GEOMETRY to avoid breaking queries.
    // Cached so we don't retry a failing DESCRIBE on every request.
    console.warn(`DESCRIBE TABLE probe failed for ${tableName}: ${error.message}, defaulting to GEOMETRY`);
    formatCache.set(cacheKey, 'GEOMETRY');
    return 'GEOMETRY';
  }
}

/**
 * Clear the format cache. Exported for testing.
 */
function clearFormatCache() {
  formatCache.clear();
}

module.exports = {
  getGeometryExpression,
  getGeometryToGeoJSON,
  getGeometryFieldExpression,
  resolveGeometryFormat,
  clearFormatCache
};
