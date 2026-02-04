/**
 * geometryFormat.js
 * Handles different geometry column formats (WKT, WKB, GeoJSON, native GEOMETRY)
 * Uses explicit format configuration with name-based fallback
 */

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

module.exports = {
  getGeometryExpression,
  getGeometryToGeoJSON,
  getGeometryFieldExpression
};
