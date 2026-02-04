/**
 * model.js
 * Databricks Custom Data Provider Model
 *
 * Implements ArcGIS Custom Data Feed interface for Databricks SQL Warehouse
 * with native geospatial function support (ST_*)
 *
 * Features:
 * - Connection pooling for optimal performance
 * - User authentication via authorize() method
 * - Audit logging for security tracking
 * - Environment variable configuration
 */

// Load environment variables
require('dotenv').config();

const configTemplate = require('./databricks-config.json');
const {
  translateToGeoJSON,
  buildSqlQuery,
  generateFiltersApplied,
  getExtentFromGeoJson,
  getAuditLogger,
} = require('./modules');
const { initializePool, getPool } = require('./modules/connectionPool');

// Load configuration from environment variables
const config = {
  databricks: {
    serverHostname: process.env.DATABRICKS_SERVER_HOSTNAME || configTemplate.databricks.serverHostname,
    httpPath: process.env.DATABRICKS_HTTP_PATH || configTemplate.databricks.httpPath,
    accessToken: process.env.DATABRICKS_ACCESS_TOKEN || configTemplate.databricks.accessToken,
    srid: parseInt(process.env.DATABRICKS_SRID) || configTemplate.databricks.srid,
    maxRecordCount: parseInt(process.env.DATABRICKS_MAX_RECORD_COUNT) || configTemplate.databricks.maxRecordCount,
    defaultTable: process.env.DATABRICKS_DEFAULT_TABLE || configTemplate.databricks.defaultTable,
    defaultGeometryColumn: process.env.DATABRICKS_GEOMETRY_COLUMN || configTemplate.databricks.defaultGeometryColumn,
    defaultIdField: process.env.DATABRICKS_ID_FIELD || configTemplate.databricks.defaultIdField
  }
};

// Validate required configuration
if (!config.databricks.serverHostname || !config.databricks.httpPath || !config.databricks.accessToken) {
  throw new Error('Missing required Databricks configuration. Please check your .env file.');
}

// Initialize audit logger
const auditLogger = getAuditLogger();

let requestCounter = 0;

/**
 * Model constructor
 */
function Model(koop) {
  console.log('✅ Databricks Custom Data Provider initialized ✅');
  console.log(`   Server: ${config.databricks.serverHostname}`);
  console.log(`   Default table: ${config.databricks.defaultTable || 'not configured'}`);
  console.log(`   User auth: ${process.env.ENABLE_USER_AUTH === 'true' ? 'ENABLED' : 'disabled'}`);
  console.log(`   Simple auth: ${process.env.ENABLE_SIMPLE_AUTH === 'true' ? 'ENABLED (testing only)' : 'disabled'}`);
  console.log(`   Audit log: ${process.env.ENABLE_AUDIT_LOG === 'true' ? 'ENABLED' : 'disabled'}`);

  // Initialize connection pool on first instantiation
  if (!Model.poolInitialized) {
    initializePool(config.databricks, {
      min: 2,    // Minimum connections (always ready)
      max: 10,   // Maximum connections (scale up under load)
      idleTimeout: 60000,      // Close idle connections after 60 seconds
      connectionTimeout: 30000 // Wait max 30 seconds for connection
    });
    Model.poolInitialized = true;
  }
}

/**
 * authorize() method - Called before getData() for user authentication
 *
 * This method is called automatically by ArcGIS when forwardUserIdentity is enabled.
 * It receives the authenticated user's information from ArcGIS and can:
 * - Allow or deny access
 * - Perform custom authorization logic
 * - Log authentication attempts
 *
 * @param {object} req - Request object with user information
 *   req._user - User object from ArcGIS (if forwardUserIdentity enabled)
 *   req._user.username - ArcGIS username
 *   req._user.groups - Array of user's groups
 *   req._user.role - User's role
 * @param {function} callback - Callback function(error, authorized)
 */
Model.prototype.authorize = function(req, callback) {
  const enableUserAuth = process.env.ENABLE_USER_AUTH === 'true';
  const enableSimpleAuth = process.env.ENABLE_SIMPLE_AUTH === 'true';
  const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

  // If no authentication is enabled, allow all requests
  if (!enableUserAuth && !enableSimpleAuth) {
    return callback(null, true);
  }

  // Simple token authentication (for development/testing)
  if (enableSimpleAuth) {
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.SIMPLE_AUTH_TOKEN;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      auditLogger.logAuthFailure('anonymous', 'simple_token', ipAddress, 'Missing or invalid authorization header');
      return callback(new Error('Authorization required. Use: Authorization: Bearer <token>'), false);
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    if (token !== expectedToken) {
      auditLogger.logAuthFailure('anonymous', 'simple_token', ipAddress, 'Invalid token');
      return callback(new Error('Invalid authentication token'), false);
    }

    auditLogger.logAuthSuccess('simple_token_user', 'simple_token', ipAddress);
    return callback(null, true);
  }

  // ArcGIS user authentication (production)
  if (enableUserAuth) {
    const user = req._user;

    if (!user || !user.username) {
      auditLogger.logAuthFailure('anonymous', 'arcgis', ipAddress, 'No user information from ArcGIS');
      return callback(new Error('User authentication required'), false);
    }

    // Example authorization logic - customize based on your needs:
    // - Check user's role
    // - Check user's groups
    // - Check against allowed users list
    // - Query external authorization service

    // For now, allow all authenticated ArcGIS users
    // To restrict access, add your authorization logic here

    auditLogger.logAuthSuccess(user.username, 'arcgis', ipAddress);
    return callback(null, true);

    // Example: Restrict to specific groups
    // const allowedGroups = ['GIS_Analysts', 'Data_Viewers'];
    // const hasAccess = user.groups && user.groups.some(group => allowedGroups.includes(group));
    // if (!hasAccess) {
    //   auditLogger.logAuthorizationFailure(user.username, 'N/A', ipAddress, 'User not in allowed groups');
    //   return callback(new Error('Access denied: insufficient permissions'), false);
    // }
  }

  callback(null, true);
};

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

  // Use connection pool (works with serverless and classic SQL warehouses)
  const pool = getPool();
  let connection = null;

  console.log(`Query ${requestCounter}: Acquiring connection from pool...`);

  // Acquire connection and execute query
  pool.acquire()
    .then(async (conn) => {
      connection = conn;
      let queryOperation;
      let extentOperation;

      try {
        console.log(`Query ${requestCounter}: Using pooled connection ${connection.id}`);

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

            extentOperation = await connection.session.executeStatement(extentQuery, { runAsync: true });
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
        queryOperation = await connection.session.executeStatement(sqlQuery, { runAsync: true });
        const rows = await queryOperation.fetchAll();
        await queryOperation.close();
        queryOperation = null;

        console.log(`Query ${requestCounter}: Received ${rows.length} rows`);

        // Initialize GeoJSON response
        let geojson = { type: "FeatureCollection", features: [] };

        if (rows.length === 0) {
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

        const recordCount = geojson.features ? geojson.features.length : (geojson.count || 0);
        console.log(`Query ${requestCounter}: Returning ${recordCount} ${geojson.count ? 'count' : 'features'}`);

        // Log query to audit log
        const username = req._user?.username || 'anonymous';
        const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
        auditLogger.logQuery(username, sourceConfig.tableName, geoserviceParams, recordCount, ipAddress);

        callback(null, geojson);

      } catch (error) {
        console.error(`Query ${requestCounter}: Error executing query:`, error);
        callback(error);
      } finally {
        // Clean up operations (not connection - it goes back to pool)
        try {
          if (extentOperation) await extentOperation.close();
          if (queryOperation) await queryOperation.close();
        } catch (cleanupError) {
          console.error(`Query ${requestCounter}: Error during cleanup:`, cleanupError);
        }

        // Release connection back to pool (reused for next request)
        if (connection) {
          pool.release(connection);
          console.log(`Query ${requestCounter}: Connection ${connection.id} released back to pool`);
        }
      }
    })
    .catch((error) => {
      console.error(`Query ${requestCounter}: Error acquiring connection:`, error);
      callback(error);

      // Ensure connection is released even on acquisition error
      if (connection) {
        pool.release(connection);
      }
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
