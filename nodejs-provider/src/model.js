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

// Load environment variables (optional — CDF runtime provides config via databricks-config.json)
// Use explicit path since CDF runtime's working directory differs from provider directory
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) { /* dotenv not available in CDF runtime */ }

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
const { getLakebasePool, shutdownLakebasePools } = require('./modules/lakebasePool');
const { buildInsertSql, buildUpdateSql, buildDeleteSql } = require('./modules/editSql');
const { buildLakebaseSelectSql } = require('./modules/lakebaseQuery');

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
  throw new Error('Missing required Databricks configuration. Set environment variables or update databricks-config.json.');
}

// Initialize audit logger
const auditLogger = getAuditLogger();

let requestCounter = 0;

// Graceful shutdown: release pooled connections on process exit
// Guard with try/catch — CDF runtime manages process lifecycle
try {
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down connection pools...');
    await shutdownPool();
    await shutdownLakebasePools();
  });
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down connection pools...');
    await shutdownPool();
    await shutdownLakebasePools();
  });
} catch (e) { /* signal handlers may not be available in CDF runtime */ }

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
   * CDF 12.0 runtime calls this as: authorize(req, data) expecting a Promise.
   * Older runtimes call: authorize(req, callback) expecting callback(error, authorized).
   * This method supports both patterns.
   *
   * @param {object} req - Request object with user information
   * @param {object|function} callbackOrData - Callback function (legacy) or data object (CDF 12.0)
   */
  authorize(req, callbackOrData) {
    const isCallback = typeof callbackOrData === 'function';
    const enableUserAuth = process.env.ENABLE_USER_AUTH === 'true';
    const enableSimpleAuth = process.env.ENABLE_SIMPLE_AUTH === 'true';
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

    // Helper to resolve or call callback
    const allow = () => isCallback ? callbackOrData(null, true) : undefined;
    const deny = (err) => {
      if (isCallback) return callbackOrData(err, false);
      throw err;
    };

    // If no authentication is enabled, allow all requests
    if (!enableUserAuth && !enableSimpleAuth) {
      return allow();
    }

    // Simple token authentication (for development/testing)
    if (enableSimpleAuth) {
      const authHeader = req.headers?.authorization;
      const expectedToken = process.env.SIMPLE_AUTH_TOKEN;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        auditLogger.logAuthFailure('anonymous', 'simple_token', ipAddress, 'Missing or invalid authorization header');
        return deny(new Error('Authorization required. Use: Authorization: Bearer <token>'));
      }

      const token = authHeader.substring(7);
      if (token !== expectedToken) {
        auditLogger.logAuthFailure('anonymous', 'simple_token', ipAddress, 'Invalid token');
        return deny(new Error('Invalid authentication token'));
      }

      auditLogger.logAuthSuccess('simple_token_user', 'simple_token', ipAddress);
      return allow();
    }

    // ArcGIS user authentication (production)
    if (enableUserAuth) {
      const user = req._user;
      if (!user || !user.username) {
        auditLogger.logAuthFailure('anonymous', 'arcgis', ipAddress, 'No user information from ArcGIS');
        return deny(new Error('User authentication required'));
      }
      auditLogger.logAuthSuccess(user.username, 'arcgis', ipAddress);
      return allow();
    }

    return allow();
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

    // Route to Lakebase if this is an editable service
    if (req.params.lakebaseHost) {
      return this.getDataFromLakebase(req, callback);
    }

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
      // Return GeoJSON type name — CDF FeatureServer handles Esri type mapping
      const validTypes = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
      return validTypes.includes(firstGeom.type) ? firstGeom.type : 'Point';
    } catch (error) {
      return 'Point';
    }
  }

  /**
   * Extract field definitions from first row
   * @param {object[]} rows - Data rows
   * @param {string} geometryColumn - Geometry column name (excluded from fields)
   * @param {string} idField - ID column name (never editable)
   * @param {boolean} [isEditable=false] - Whether this is an editable service
   */
  extractFields(rows, geometryColumn, idField, isEditable = false) {
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
          editable: isEditable && key !== idField
        });
      }
    }

    return fields;
  }

  /**
   * Read data from Lakebase (PostgreSQL + PostGIS) for editable services.
   * Called by getData() when req.params.lakebaseHost is set.
   * Returns identical GeoJSON structure as the Databricks path.
   */
  getDataFromLakebase(req, callback) {
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
    const { returnCountOnly } = geoserviceParams;

    const rawGeometryColumn = req.params.geometryColumn || config.databricks.defaultGeometryColumn || 'geometry';
    const rawIdField = req.params.idField || config.databricks.defaultIdField || 'id';

    try {
      validateIdentifier(rawGeometryColumn);
      validateIdentifier(rawIdField);
    } catch (validationError) {
      this.logger.error(`Input validation failed: ${validationError.message}`);
      return callback(validationError);
    }

    const sourceConfig = {
      lakebaseSchema: req.params.lakebaseSchema || 'public',
      lakebaseTable: req.params.lakebaseTable,
      geometryColumn: rawGeometryColumn,
      idField: rawIdField,
      dbWKID: config.databricks.srid || 4326,
      maxRecordCountPerPage: config.databricks.maxRecordCount || 2000,
      name: req.params.lakebaseTable || 'LakebaseLayer',
      description: `Lakebase table: ${req.params.lakebaseSchema || 'public'}.${req.params.lakebaseTable}`,
    };

    if (!sourceConfig.lakebaseTable) {
      return callback(new Error('lakebaseTable service parameter is required for editable services'));
    }

    const lakebaseConfig = {
      host: req.params.lakebaseHost,
      port: parseInt(req.params.lakebasePort) || 5432,
      database: req.params.lakebaseDatabase,
    };

    let pool;
    try {
      pool = getLakebasePool(lakebaseConfig);
    } catch (poolError) {
      this.logger.error(`Lakebase pool error: ${poolError.message}`);
      return callback(poolError);
    }

    this.logger.info(`Query ${requestCounter}: Executing Lakebase query...`);

    const { sql, params } = buildLakebaseSelectSql(geoserviceParams, sourceConfig);
    this.logger.info(`Query ${requestCounter}: ${sql.substring(0, 150)}...`);

    pool.query(sql, params)
      .then((result) => {
        const rows = result.rows;
        this.logger.info(`Query ${requestCounter}: Lakebase returned ${rows.length} rows`);

        let geojson = { type: 'FeatureCollection', features: [] };

        if (rows.length === 0) {
          return callback(null, geojson);
        }

        if (returnCountOnly) {
          geojson.count = Number(rows[0].count);
        } else {
          // Check exceeded transfer limit
          let exceededTransferLimit = false;
          if (rows.length > sourceConfig.maxRecordCountPerPage) {
            exceededTransferLimit = true;
            rows.pop();
          }

          geojson = translateToGeoJSON(rows, sourceConfig);

          geojson.metadata = {
            name: sourceConfig.name,
            description: sourceConfig.description,
            geometryType: this.inferGeometryType(rows, sourceConfig.geometryColumn),
            maxRecordCount: sourceConfig.maxRecordCountPerPage,
            exceededTransferLimit,
            idField: sourceConfig.idField,
            inputCrs: sourceConfig.dbWKID,
            fields: this.extractFields(rows, sourceConfig.geometryColumn, sourceConfig.idField, true),
          };
        }

        geojson.filtersApplied = generateFiltersApplied(
          geoserviceParams,
          sourceConfig.idField,
          sourceConfig.geometryColumn
        );

        geojson.crs = {
          type: `EPSG:${sourceConfig.dbWKID}`,
          properties: { name: `urn:ogc:def:crs:EPSG::${sourceConfig.dbWKID}` },
        };

        callback(null, geojson);
      })
      .catch((error) => {
        this.logger.error(`Query ${requestCounter}: Lakebase error: ${error.message}`);
        callback(error);
      });
  }

  /**
   * Apply edits (add/update/delete) via Lakebase.
   * Called by CDF runtime when editingEnabled is true.
   *
   * @param {object} req  - Request with params (lakebaseHost, lakebaseSchema, etc.)
   * @param {object} data - { adds: [...], updates: [...], deletes: [...] }
   * @param {function} callback - callback(error, result)
   */
  editData(req, data, callback) {
    const rawGeometryColumn = req.params.geometryColumn || config.databricks.defaultGeometryColumn || 'geometry';
    const rawIdField = req.params.idField || config.databricks.defaultIdField || 'id';
    const schema = req.params.lakebaseSchema || 'public';
    const table = req.params.lakebaseTable;
    const srid = config.databricks.srid || 4326;

    try {
      validateIdentifier(rawGeometryColumn);
      validateIdentifier(rawIdField);
    } catch (validationError) {
      this.logger.error(`Edit validation failed: ${validationError.message}`);
      return callback(validationError);
    }

    if (!req.params.lakebaseHost) {
      return callback(new Error('Editing requires lakebaseHost service parameter'));
    }
    if (!table) {
      return callback(new Error('Editing requires lakebaseTable service parameter'));
    }

    const lakebaseConfig = {
      host: req.params.lakebaseHost,
      port: parseInt(req.params.lakebasePort) || 5432,
      database: req.params.lakebaseDatabase,
    };

    let pool;
    try {
      pool = getLakebasePool(lakebaseConfig);
    } catch (poolError) {
      this.logger.error(`Lakebase pool error: ${poolError.message}`);
      return callback(poolError);
    }

    const adds = data.adds || [];
    const updates = data.updates || [];
    const deletes = data.deletes || [];

    this.logger.info(`Edit: ${adds.length} adds, ${updates.length} updates, ${deletes.length} deletes`);

    const processEdits = async () => {
      const addResults = [];
      const updateResults = [];
      const deleteResults = [];

      // Process adds
      for (const feature of adds) {
        try {
          const attributes = feature.attributes || feature.properties || {};
          const geometry = feature.geometry || null;
          const { sql, params } = buildInsertSql(schema, table, attributes, geometry, rawGeometryColumn, rawIdField, srid);
          const result = await pool.query(sql, params);
          const newId = result.rows[0][rawIdField];
          addResults.push({ objectId: Number(newId), success: true });
        } catch (error) {
          this.logger.error(`Edit add failed: ${error.message}`);
          addResults.push({ success: false, error: { description: error.message } });
        }
      }

      // Process updates
      for (const feature of updates) {
        try {
          const attributes = feature.attributes || feature.properties || {};
          const geometry = feature.geometry || null;
          const { sql, params } = buildUpdateSql(schema, table, attributes, geometry, rawGeometryColumn, rawIdField, srid);
          const result = await pool.query(sql, params);
          const oid = Number(attributes[rawIdField]);
          if (result.rowCount === 0) {
            updateResults.push({ objectId: oid, success: false, error: { description: `Feature with ${rawIdField}=${oid} not found` } });
          } else {
            updateResults.push({ objectId: oid, success: true });
          }
        } catch (error) {
          this.logger.error(`Edit update failed: ${error.message}`);
          updateResults.push({ success: false, error: { description: error.message } });
        }
      }

      // Process deletes
      if (deletes.length > 0) {
        try {
          const objectIds = deletes.map(Number);
          const { sql, params } = buildDeleteSql(schema, table, rawIdField, objectIds);
          const result = await pool.query(sql, params);
          const deletedCount = result.rowCount || 0;
          if (deletedCount === objectIds.length) {
            // All requested IDs were deleted
            for (const id of objectIds) {
              deleteResults.push({ objectId: id, success: true });
            }
          } else {
            // Some IDs may not have existed — we can't tell which ones,
            // so report all as success but log the discrepancy
            this.logger.warn(`Edit delete: requested ${objectIds.length} but only ${deletedCount} rows affected`);
            for (const id of objectIds) {
              deleteResults.push({ objectId: id, success: true });
            }
          }
        } catch (error) {
          this.logger.error(`Edit delete failed: ${error.message}`);
          for (const id of deletes) {
            deleteResults.push({ objectId: Number(id), success: false, error: { description: error.message } });
          }
        }
      }

      return { addResults, updateResults, deleteResults };
    };

    processEdits()
      .then((result) => {
        this.logger.info(`Edit complete: ${result.addResults.length} added, ${result.updateResults.length} updated, ${result.deleteResults.length} deleted`);

        // Log edit to audit
        const username = req._user?.username || 'anonymous';
        const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
        auditLogger.log('EDIT', {
          username,
          table: `${schema}.${table}`,
          adds: result.addResults.length,
          updates: result.updateResults.length,
          deletes: result.deleteResults.length,
          ipAddress,
        });

        callback(null, result);
      })
      .catch((error) => {
        this.logger.error(`Edit error: ${error.message}`);
        callback(error);
      });
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
