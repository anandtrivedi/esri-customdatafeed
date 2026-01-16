const { DBSQLClient } = require('@databricks/sql');
const config = require('./databricks-config.json');

/**
 * Model class for Databricks Custom Data Provider
 * Implements the getData() method required by ArcGIS Custom Data Feeds
 */
function Model() {
  this.client = null;
  this.session = null;
}

/**
 * Initialize Databricks connection
 */
Model.prototype.connect = async function() {
  if (!this.client) {
    this.client = new DBSQLClient();

    const connectOptions = {
      host: config.databricks.serverHostname,
      path: config.databricks.httpPath,
      token: config.databricks.accessToken
    };

    this.session = await this.client.connect(connectOptions);
  }
  return this.session;
};

/**
 * Close Databricks connection
 */
Model.prototype.close = async function() {
  if (this.session) {
    await this.session.close();
  }
  if (this.client) {
    await this.client.close();
  }
  this.client = null;
  this.session = null;
};

/**
 * Main getData method required by ArcGIS Custom Data Feeds
 * Fetches data from Databricks and returns GeoJSON
 *
 * @param {object} req - Express request object with service parameters
 * @param {function} callback - Optional callback (can use async/await instead)
 * @returns {object} GeoJSON FeatureCollection with metadata
 */
Model.prototype.getData = async function(req, callback) {
  try {
    // Extract service parameters from request
    const tableName = req.params.tableName;
    const geometryColumn = req.params.geometryColumn || 'geometry';
    const idField = req.params.idField || 'id';

    // Extract query parameters for filtering
    const where = req.query.where;
    const resultRecordCount = req.query.resultRecordCount || 2000;
    const resultOffset = req.query.resultOffset || 0;

    // Connect to Databricks
    const session = await this.connect();

    // Build SQL query with ST_AsGeoJSON for geometry conversion
    let sql = `
      SELECT
        *,
        ST_AsGeoJSON(${geometryColumn}) as geometry_geojson
      FROM ${tableName}
    `;

    // Add WHERE clause if provided
    if (where) {
      sql += ` WHERE ${where}`;
    }

    // Add LIMIT and OFFSET
    sql += ` LIMIT ${resultRecordCount} OFFSET ${resultOffset}`;

    // Execute query
    const queryOperation = await session.executeStatement(sql);
    const result = await queryOperation.fetchAll();
    await queryOperation.close();

    // Convert Databricks results to GeoJSON
    const geojson = this.convertToGeoJSON(result, geometryColumn, idField);

    // Add required metadata for ArcGIS
    geojson.metadata = this.buildMetadata(result, tableName, geometryColumn, idField);

    // Indicate which filters were applied
    geojson.filtersApplied = {
      where: !!where,
      resultRecordCount: true,
      resultOffset: true
    };

    // Return via callback if provided, otherwise return directly
    if (callback) {
      callback(null, geojson);
    } else {
      return geojson;
    }

  } catch (error) {
    console.error('Error fetching data from Databricks:', error);

    if (callback) {
      callback(error);
    } else {
      throw error;
    }
  }
};

/**
 * Convert Databricks results to GeoJSON FeatureCollection
 */
Model.prototype.convertToGeoJSON = function(rows, geometryColumn, idField) {
  const features = rows.map(row => {
    // Parse the GeoJSON geometry from ST_AsGeoJSON result
    const geometryGeoJSON = row.geometry_geojson ?
      JSON.parse(row.geometry_geojson) : null;

    // Build properties object (exclude geometry_geojson helper field)
    const properties = {};
    for (const key in row) {
      if (key !== 'geometry_geojson' && key !== geometryColumn) {
        properties[key] = row[key];
      }
    }

    return {
      type: 'Feature',
      id: row[idField],
      properties: properties,
      geometry: geometryGeoJSON
    };
  });

  return {
    type: 'FeatureCollection',
    features: features
  };
};

/**
 * Build ArcGIS metadata for the GeoJSON
 */
Model.prototype.buildMetadata = function(rows, tableName, geometryColumn, idField) {
  // Infer geometry type from first feature
  let geometryType = null;
  if (rows.length > 0 && rows[0].geometry_geojson) {
    const firstGeom = JSON.parse(rows[0].geometry_geojson);
    geometryType = this.mapGeoJSONTypeToEsri(firstGeom.type);
  }

  // Infer fields from first row
  const fields = [];
  if (rows.length > 0) {
    const firstRow = rows[0];
    for (const key in firstRow) {
      if (key !== 'geometry_geojson' && key !== geometryColumn) {
        fields.push({
          name: key,
          type: this.inferFieldType(firstRow[key]),
          alias: key,
          editable: false
        });
      }
    }
  }

  return {
    name: tableName.split('.').pop(), // Use table name as layer name
    description: `Databricks table: ${tableName}`,
    geometryType: geometryType,
    idField: idField,
    fields: fields,
    maxRecordCount: 2000,
    supportsPagination: true,
    hasZ: false,
    inputCrs: 4326, // Assume WGS84
    defaultVisibility: true
  };
};

/**
 * Map GeoJSON geometry type to Esri geometry type
 */
Model.prototype.mapGeoJSONTypeToEsri = function(geojsonType) {
  const typeMap = {
    'Point': 'Point',
    'MultiPoint': 'MultiPoint',
    'LineString': 'Polyline',
    'MultiLineString': 'Polyline',
    'Polygon': 'Polygon',
    'MultiPolygon': 'Polygon'
  };
  return typeMap[geojsonType] || 'Point';
};

/**
 * Infer Esri field type from JavaScript value
 */
Model.prototype.inferFieldType = function(value) {
  if (value === null || value === undefined) {
    return 'string';
  }

  const jsType = typeof value;

  if (jsType === 'number') {
    return Number.isInteger(value) ? 'integer' : 'double';
  } else if (jsType === 'boolean') {
    return 'integer'; // Esri doesn't have boolean, use integer
  } else if (value instanceof Date) {
    return 'date';
  } else {
    return 'string';
  }
};

module.exports = Model;
