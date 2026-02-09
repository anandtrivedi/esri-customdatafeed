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
  getGeometryFieldExpression,
  validateIdentifier,
} = require('./modules');
const { initializePool, getPool, shutdownPool } = require('./modules/connectionPool');

// Table name validation: must be catalog.schema.table or just a table name
const TABLE_NAME_PATTERN = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){0,2}$/;

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
    defaultIdField: process.env.DATABRICKS_ID_FIELD || configTemplate.databricks.defaultIdField,
    queryTimeout: parseInt(process.env.DATABRICKS_QUERY_TIMEOUT) || 120000 // 2 minutes default
  }
};

// Validate required configuration
if (!config.databricks.serverHostname || !config.databricks.httpPath || !config.databricks.accessToken) {
  throw new Error('Missing required Databricks configuration. Please check your .env file.');
}

// Initialize audit logger
const auditLogger = getAuditLogger();

let requestCounter = 0;

// Graceful shutdown: release pooled connections on process exit
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down connection pool...');
  await shutdownPool();
});
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down connection pool...');
  await shutdownPool();
});

/**
 * Model class - CDF runtime injects {logger} in the constructor.
 * The logger routes to ArcGIS Server's log system when deployed.
 */
class Model {
  static poolInitialized = false;

  constructor({ logger } = {}) {
    this.logger = logger || console;

    this.logger.info('Databricks Custom Data Provider initialized');
    this.logger.info(`  Server: ${config.databricks.serverHostname}`);
    this.logger.info(`  Default table: ${config.databricks.defaultTable || 'not configured'}`);
    this.logger.info(`  User auth: ${process.env.ENABLE_USER_AUTH === 'true' ? 'ENABLED' : 'disabled'}`);
    this.logger.info(`  Simple auth: ${process.env.ENABLE_SIMPLE_AUTH === 'true' ? 'ENABLED (testing only)' : 'disabled'}`);
    this.logger.info(`  Audit log: ${process.env.ENABLE_AUDIT_LOG === 'true' ? 'ENABLED' : 'disabled'}`);

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
  authorize(req, callback) {
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
  }

  /**
   * Main getData method required by ArcGIS Custom Data Feeds
   * Fetches data from Databricks and returns GeoJSON with metadata
   *
   * @param {object} req - Request object with service parameters and query params
   * @param {function} callback - Callback function(error, geojson)
   */
  getData(req, callback) {
    requestCounter++;

    // Convert boolean strings to actual booleans
    Object.keys(req.query).forEach((key) => {
      const val = (req.query[key] + "").toLowerCase();
      if (val === "true") {
        req.query[key] = true;
      } else if (val === "false") {
        req.query[key] = false;
      }
    });

    const { query: geoserviceParams } = req;
    const { resultRecordCount, returnCountOnly } = geoserviceParams;

    // Extract service parameters (configured when creating Feature Service)
    // Validate user-provided column names to prevent SQL injection
    const rawGeometryColumn = req.params.geometryColumn || config.databricks.defaultGeometryColumn || 'geometry';
    const rawIdField = req.params.idField || config.databricks.defaultIdField || 'id';

    try {
      if (req.params.geometryColumn) validateIdentifier(rawGeometryColumn);
      if (req.params.idField) validateIdentifier(rawIdField);
    } catch (validationError) {
      this.logger.error(`Input validation failed: ${validationError.message}`);
      return callback(validationError);
    }

    const sourceConfig = {
      tableName: req.params.tableName || config.databricks.defaultTable,
      geometryColumn: rawGeometryColumn,
      geometryFormat: req.params.geometryFormat || null, // Optional: 'WKT' | 'WKB' | 'GEOJSON' | 'GEOMETRY'
      idField: rawIdField,
      timeColumn: req.params.timeColumn || null,
      dbWKID: config.databricks.srid || 4326,
      maxRecordCountPerPage: config.databricks.maxRecordCount || 2000,
      name: req.params.tableName ? req.params.tableName.split('.').pop() : 'DatabricksLayer',
      description: `Databricks table: ${req.params.tableName || config.databricks.defaultTable}`
    };

    // Validate table name format to prevent SQL injection via misconfiguration
    if (sourceConfig.tableName && !TABLE_NAME_PATTERN.test(sourceConfig.tableName)) {
      this.logger.error(`Invalid table name format: ${sourceConfig.tableName}`);
      return callback(new Error(`Invalid table name format: expected catalog.schema.table`));
    }

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

    this.logger.info(`Query ${requestCounter}: Acquiring connection from pool...`);

    // Acquire connection and execute query
    pool.acquire()
      .then(async (conn) => {
        connection = conn;
        let queryOperation;
        let extentOperation;

        try {
          this.logger.info(`Query ${requestCounter}: Using pooled connection ${connection.id}`);

          // Build SQL query using helper module
          const sqlQuery = buildSqlQuery(
            geoserviceParams,
            sourceConfig.idField,
            sourceConfig.geometryColumn,
            sourceConfig.tableName,
            sourceConfig.dbWKID,
            fetchSize,
            sourceConfig.geometryFormat,
            sourceConfig.timeColumn
          );

          this.logger.info(`Query ${requestCounter}: ${sqlQuery.substring(0, 150)}...`);

          // Calculate extent for metadata requests
          let dbExtent = null;
          if (isMetadataRequest) {
            try {
              // Handle all geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)
              const geomExpression = getGeometryFieldExpression(sourceConfig.geometryColumn, sourceConfig.dbWKID, sourceConfig.geometryFormat);

              // ST_Envelope_Agg computes the bounding box in a single aggregate pass,
              // more efficient than ST_Envelope(ST_Union_Agg(...)) which materializes
              // the full union geometry first
              const extentQuery = `
                SELECT ST_AsGeoJSON(ST_Envelope_Agg(${geomExpression})) AS extent
                FROM ${sourceConfig.tableName}
              `;

              extentOperation = await connection.session.executeStatement(extentQuery, {
                runAsync: true,
                queryTimeout: config.databricks.queryTimeout
              });
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
              this.logger.warn(`Failed to calculate extent: ${error.message}`);
            }
          }

          // Execute main query
          queryOperation = await connection.session.executeStatement(sqlQuery, {
            runAsync: true,
            queryTimeout: config.databricks.queryTimeout
          });
          const rows = await queryOperation.fetchAll();
          await queryOperation.close();
          queryOperation = null;

          this.logger.info(`Query ${requestCounter}: Received ${rows.length} rows`);

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
            inputCrs: sourceConfig.dbWKID,
            fields: this.extractFields(rows, sourceConfig.geometryColumn, sourceConfig.idField),
            ...(dbExtent && { extent: dbExtent }),
          };

          // Add CRS information
          geojson.crs = {
            type: `EPSG:${sourceConfig.dbWKID}`,
            properties: { name: `urn:ogc:def:crs:EPSG::${sourceConfig.dbWKID}` },
          };

          const recordCount = geojson.features ? geojson.features.length : (geojson.count || 0);
          this.logger.info(`Query ${requestCounter}: Returning ${recordCount} ${geojson.count ? 'count' : 'features'}`);

          // Log query to audit log
          const username = req._user?.username || 'anonymous';
          const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
          auditLogger.logQuery(username, sourceConfig.tableName, geoserviceParams, recordCount, ipAddress);

          callback(null, geojson);

        } catch (error) {
          this.logger.error(`Query ${requestCounter}: Error executing query: ${error.message}`);
          callback(error);
        } finally {
          // Clean up operations (not connection - it goes back to pool)
          try {
            if (extentOperation) await extentOperation.close();
            if (queryOperation) await queryOperation.close();
          } catch (cleanupError) {
            this.logger.error(`Query ${requestCounter}: Error during cleanup: ${cleanupError.message}`);
          }

          // Release connection back to pool (reused for next request)
          if (connection) {
            pool.release(connection);
            this.logger.info(`Query ${requestCounter}: Connection ${connection.id} released back to pool`);
          }
        }
      })
      .catch((error) => {
        this.logger.error(`Query ${requestCounter}: Error acquiring connection: ${error.message}`);
        callback(error);

        // Ensure connection is released even on acquisition error
        if (connection) {
          pool.release(connection);
        }
      });
  }

  /**
   * Infer geometry type from first row
   */
  inferGeometryType(rows, geometryColumn) {
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
  }

  /**
   * Extract field definitions from first row
   */
  extractFields(rows, geometryColumn, idField) {
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
  }

  /**
   * Infer Esri field type from JavaScript value
   */
  inferFieldType(value) {
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
  }
}

module.exports = Model;
