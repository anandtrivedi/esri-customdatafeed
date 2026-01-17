/**
 * model.js
 * Databricks Custom Data Provider Model
 *
 * Implements ArcGIS Custom Data Feed interface for Databricks SQL Warehouse
 * with native geospatial function support (ST_*)
 */

const { DBSQLClient } = require('@databricks/sql');
const config = require('./databricks-config.json');
const {
  translateToGeoJSON,
  buildSqlQuery,
  generateFiltersApplied,
  getExtentFromGeoJson,
} = require('./modules');

let requestCounter = 0;

/**
 * Model constructor
 */
function Model(koop) {
  console.log('✅ Databricks Custom Data Provider initialized ✅');
}

/**
 * Main getData method required by ArcGIS Custom Data Feeds
 * Fetches data from Databricks and returns GeoJSON with metadata
 *
 * @param {object} req - Request object with service parameters and query params
 * @param {function} callback - Callback function(error, geojson)
 */
Model.prototype.getData = function(req, callback) {
  requestCounter++;

  // Convert boolean strings to actual booleans
  Object.keys(req.query).forEach((key) => {
    if (req.query[key] + "".toLowerCase() === "true") {
      req.query[key] = true;
    } else if (req.query[key] + "".toLowerCase() === "false") {
      req.query[key] = false;
    }
  });

  const { query: geoserviceParams } = req;
  const { resultRecordCount, returnCountOnly } = geoserviceParams;

  // Extract service parameters (configured when creating Feature Service)
  const sourceConfig = {
    tableName: req.params.tableName || config.databricks.defaultTable,
    geometryColumn: req.params.geometryColumn || config.databricks.defaultGeometryColumn || 'geometry',
    idField: req.params.idField || config.databricks.defaultIdField || 'id',
    dbWKID: config.databricks.srid || 4326,
    maxRecordCountPerPage: config.databricks.maxRecordCount || 2000,
    name: req.params.tableName ? req.params.tableName.split('.').pop() : 'DatabricksLayer',
    description: `Databricks table: ${req.params.tableName || config.databricks.defaultTable}`
  };

  // Check if this is a metadata-only request
  const isMetadataRequest =
    (Object.keys(geoserviceParams).length === 1 &&
      geoserviceParams.hasOwnProperty("f")) ||
    Object.keys(geoserviceParams).length === 0;

  // Set fetch size (1 for metadata, configured max for data)
  const fetchSize = isMetadataRequest
    ? 1
    : resultRecordCount || sourceConfig.maxRecordCountPerPage;

  // Create Databricks client
  const client = new DBSQLClient();
  const connectOptions = {
    token: config.databricks.accessToken,
    host: config.databricks.serverHostname,
    path: config.databricks.httpPath
  };

  console.log(`Query ${requestCounter}: Connecting to Databricks...`);

  // Connect and execute query (following Koop pattern)
  client.connect(connectOptions)
    .then(async client => {
      let session;
      let queryOperation;
      let extentOperation;

      try {
        session = await client.openSession();
        console.log(`Query ${requestCounter}: Session opened`);

        // Build SQL query using helper module
        const sqlQuery = buildSqlQuery(
          geoserviceParams,
          sourceConfig.idField,
          sourceConfig.geometryColumn,
          sourceConfig.tableName,
          sourceConfig.dbWKID,
          fetchSize
        );

        console.log(`Query ${requestCounter}: ${sqlQuery.substring(0, 150)}...`);

        // Calculate extent for metadata requests
        let dbExtent = null;
        if (isMetadataRequest) {
          try {
            const extentQuery = `
              SELECT ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(${sourceConfig.geometryColumn}))) AS extent
              FROM ${sourceConfig.tableName}
            `;

            extentOperation = await session.executeStatement(extentQuery, { runAsync: true });
            const extentRows = await extentOperation.fetchAll();
            await extentOperation.close();
            extentOperation = null;

            if (extentRows.length > 0 && extentRows[0].extent) {
              dbExtent = getExtentFromGeoJson(
                JSON.parse(extentRows[0].extent),
                sourceConfig.dbWKID
              );
            }
          } catch (error) {
            console.warn('Failed to calculate extent:', error.message);
          }
        }

        // Execute main query
        queryOperation = await session.executeStatement(sqlQuery, { runAsync: true });
        const rows = await queryOperation.fetchAll();
        await queryOperation.close();
        queryOperation = null;

        console.log(`Query ${requestCounter}: Received ${rows.length} rows`);

        // Initialize GeoJSON response
        let geojson = { type: "FeatureCollection", features: [] };

        if (rows.length === 0) {
          await session.close();
          await client.close();
          return callback(null, geojson);
        }

        // Check if we exceeded transfer limit
        let exceededTransferLimit = false;
        if (!returnCountOnly && rows.length > sourceConfig.maxRecordCountPerPage) {
          exceededTransferLimit = true;
          rows.pop(); // Remove extra row used for detection
        }

        // Build response based on query type
        if (returnCountOnly) {
          geojson.count = Number(rows[0]["count(1)"]);
        } else {
          geojson = translateToGeoJSON(rows, sourceConfig);
        }

        // Add filtersApplied
        geojson.filtersApplied = generateFiltersApplied(
          geoserviceParams,
          sourceConfig.idField,
          sourceConfig.geometryColumn
        );

        // Add metadata
        geojson.metadata = {
          name: sourceConfig.name,
          description: sourceConfig.description,
          geometryType: this.inferGeometryType(rows, sourceConfig.geometryColumn),
          maxRecordCount: sourceConfig.maxRecordCountPerPage,
          exceededTransferLimit,
          idField: sourceConfig.idField,
          fields: this.extractFields(rows, sourceConfig.geometryColumn, sourceConfig.idField),
          ...(dbExtent && { extent: dbExtent }),
        };

        // Add CRS information
        geojson.crs = {
          type: `EPSG:${sourceConfig.dbWKID}`,
          properties: { name: `urn:ogc:def:crs:EPSG::${sourceConfig.dbWKID}` },
        };

        console.log(`Query ${requestCounter}: Returning ${geojson.features ? geojson.features.length : 0} features`);

        callback(null, geojson);

      } catch (error) {
        console.error(`Query ${requestCounter}: Error executing query:`, error);
        callback(error);
      } finally {
        // Ensure resources are cleaned up
        try {
          if (extentOperation) await extentOperation.close();
          if (queryOperation) await queryOperation.close();
          if (session) await session.close();
          await client.close();
        } catch (cleanupError) {
          console.error(`Query ${requestCounter}: Error during cleanup:`, cleanupError);
        }
      }
    })
    .catch((error) => {
      console.error(`Query ${requestCounter}: Error connecting to Databricks:`, error);
      callback(error);
    });
};

/**
 * Infer geometry type from first row
 */
Model.prototype.inferGeometryType = function(rows, geometryColumn) {
  if (rows.length === 0 || !rows[0][geometryColumn]) {
    return 'Point';
  }

  try {
    const firstGeom = JSON.parse(rows[0][geometryColumn]);
    const typeMap = {
      'Point': 'Point',
      'MultiPoint': 'MultiPoint',
      'LineString': 'Polyline',
      'MultiLineString': 'Polyline',
      'Polygon': 'Polygon',
      'MultiPolygon': 'Polygon'
    };
    return typeMap[firstGeom.type] || 'Point';
  } catch (error) {
    return 'Point';
  }
};

/**
 * Extract field definitions from first row
 */
Model.prototype.extractFields = function(rows, geometryColumn, idField) {
  if (rows.length === 0) {
    return [];
  }

  const fields = [];
  const firstRow = rows[0];

  for (const key in firstRow) {
    if (key !== geometryColumn) {
      fields.push({
        name: key,
        type: this.inferFieldType(firstRow[key]),
        alias: key,
        editable: false
      });
    }
  }

  return fields;
};

/**
 * Infer Esri field type from JavaScript value
 */
Model.prototype.inferFieldType = function(value) {
  if (value === null || value === undefined) {
    return 'esriFieldTypeString';
  }

  const jsType = typeof value;

  if (jsType === 'number') {
    return Number.isInteger(value) ? 'esriFieldTypeInteger' : 'esriFieldTypeDouble';
  } else if (jsType === 'boolean') {
    return 'esriFieldTypeInteger';
  } else if (value instanceof Date) {
    return 'esriFieldTypeDate';
  } else {
    return 'esriFieldTypeString';
  }
};

module.exports = Model;
