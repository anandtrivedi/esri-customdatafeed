/**
 * model.js
 * Databricks Custom Data Provider Model
 *
 * Implements ArcGIS Custom Data Feed (CDF 12.0) interface for Databricks:
 *   getData(req, callback) — query features
 *   editData(req, editData) — add/update/delete features (async, Lakebase only)
 *   authorize(req) — user authentication (async)
 *   getMetadata() — idField + inputCrs for the CDF runtime
 *
 * Two backends:
 *   Lakehouse (Databricks SQL) — read-only, large-scale
 *   Lakebase (PostgreSQL + PostGIS) — read+write, low-latency
 *
 * Routing: if req.params.lakebaseHost is set → Lakebase, otherwise → Lakehouse.
 */

// Load environment variables from .env file
// Use explicit path since CDF runtime's working directory differs from provider directory
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) { /* dotenv not available in CDF runtime */ }

const {
  translateToGeoJSON,
  buildSqlQuery,
  generateFiltersApplied,
  getExtentFromGeoJson,
  getAuditLogger,
  getGeometryFieldExpression,
  resolveGeometryFormat,
  validateIdentifier,
} = require('./modules');
const { getPool, shutdownPool } = require('./modules/connectionPool');
const { getLakebasePool, shutdownLakebasePools } = require('./modules/lakebasePool');
const { buildInsertSql, buildUpdateSql, buildDeleteSql } = require('./modules/editSql');
const { buildLakebaseSelectSql } = require('./modules/lakebaseQuery');
const { resolveWorkspace } = require('./modules/workspaceResolver');

// Table name validation: must be catalog.schema.table or just a table name
const TABLE_NAME_PATTERN = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){0,2}$/;

// Configuration from environment variables
// Per-table settings (tableName, geometryColumn, idField, srid, maxRecordCount)
// are configured per-service via createService, not here.
const config = {
  databricks: {
    serverHostname: process.env.DATABRICKS_SERVER_HOSTNAME,
    httpPath: process.env.DATABRICKS_HTTP_PATH,
    accessToken: process.env.DATABRICKS_ACCESS_TOKEN,
    srid: parseInt(process.env.DATABRICKS_SRID) || 4326,
    maxRecordCount: parseInt(process.env.DATABRICKS_MAX_RECORD_COUNT) || 2000,
    queryTimeout: parseInt(process.env.DATABRICKS_QUERY_TIMEOUT) || 120000 // 2 minutes default
  }
};

// Resolve the workspace + warehouse for a given service request.
// Throws with a clear message if neither a profile nor env-default is configured.
function resolveLakehouseTarget(req) {
  const workspaceConfig = resolveWorkspace(req.params.workspace);
  const httpPath = req.params.warehouseHttpPath || process.env.DATABRICKS_HTTP_PATH;
  if (!httpPath) {
    throw new Error(
      'No SQL warehouse configured. Set req.params.warehouseHttpPath on the service or DATABRICKS_HTTP_PATH env var.'
    );
  }
  return { workspaceConfig, httpPath };
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
  constructor({ logger } = {}) {
    this.logger = logger || console;

    this.logger.info('Databricks Custom Data Provider initialized');
    this.logger.info(`  User auth: ${process.env.ENABLE_USER_AUTH === 'true' ? 'ENABLED' : 'disabled'}`);
    this.logger.info(`  Simple auth: ${process.env.ENABLE_SIMPLE_AUTH === 'true' ? 'ENABLED (testing only)' : 'disabled'}`);
    this.logger.info(`  Audit log: ${process.env.ENABLE_AUDIT_LOG === 'true' ? 'ENABLED' : 'disabled'}`);
    this.logger.info('  Lakehouse pools: lazily created per (workspace, warehouse) on first use');
  }

  /**
   * authorize() — Called by CDF runtime before getData() and editData().
   * Supports both calling conventions:
   *   11.4: authorize(req, callback) — callback(err, authorized)
   *   12.0: async authorize(req) — return to allow, throw to deny
   *
   * @param {object} req - Request object with user information
   * @param {function} [callback] - Optional callback for 11.4 compat
   */
  async authorize(req, callback) {
    try {
      const enableUserAuth = process.env.ENABLE_USER_AUTH === 'true';
      const enableSimpleAuth = process.env.ENABLE_SIMPLE_AUTH === 'true';
      const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

      // If no authentication is enabled, allow all requests
      if (!enableUserAuth && !enableSimpleAuth) {
        if (typeof callback === 'function') return callback(null, true);
        return;
      }

      // Simple token authentication (for development/testing)
      if (enableSimpleAuth) {
        const authHeader = req.headers?.authorization;
        const expectedToken = process.env.SIMPLE_AUTH_TOKEN;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          auditLogger.logAuthFailure('anonymous', 'simple_token', ipAddress, 'Missing or invalid authorization header');
          const err = new Error('Authorization required. Use: Authorization: Bearer <token>');
          if (typeof callback === 'function') return callback(err, false);
          throw err;
        }

        const token = authHeader.substring(7);
        if (token !== expectedToken) {
          auditLogger.logAuthFailure('anonymous', 'simple_token', ipAddress, 'Invalid token');
          const err = new Error('Invalid authentication token');
          if (typeof callback === 'function') return callback(err, false);
          throw err;
        }

        auditLogger.logAuthSuccess('simple_token_user', 'simple_token', ipAddress);
        if (typeof callback === 'function') return callback(null, true);
        return;
      }

      // ArcGIS user authentication (production)
      if (enableUserAuth) {
        const user = req._user;
        if (!user || !user.username) {
          auditLogger.logAuthFailure('anonymous', 'arcgis', ipAddress, 'No user information from ArcGIS');
          const err = new Error('User authentication required');
          if (typeof callback === 'function') return callback(err, false);
          throw err;
        }
        auditLogger.logAuthSuccess(user.username, 'arcgis', ipAddress);
        if (typeof callback === 'function') return callback(null, true);
        return;
      }
    } catch (err) {
      if (typeof callback === 'function') return callback(err, false);
      throw err;
    }
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

    // Resolve the workspace + warehouse for this service request.
    // Pool is created lazily on the first call per (workspace, warehouse) pair.
    let lakehouseTarget;
    try {
      lakehouseTarget = resolveLakehouseTarget(req);
    } catch (configError) {
      return callback(configError);
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
    const rawGeometryColumn = req.params.geometryColumn || 'geometry';
    const rawIdField = req.params.idField || 'id';

    try {
      if (req.params.geometryColumn) validateIdentifier(rawGeometryColumn);
      if (req.params.idField) validateIdentifier(rawIdField);
    } catch (validationError) {
      this.logger.error(`Input validation failed: ${validationError.message}`);
      return callback(validationError);
    }

    const sourceConfig = {
      tableName: req.params.tableName,
      geometryColumn: rawGeometryColumn,
      geometryFormat: req.params.geometryFormat || null, // Optional: 'WKT' | 'WKB' | 'GEOJSON' | 'GEOMETRY'
      idField: rawIdField,
      timeColumn: req.params.timeColumn || null,
      dbWKID: parseInt(req.params.srid) || config.databricks.srid || 4326,
      maxRecordCountPerPage: parseInt(req.params.maxRecordCount) || config.databricks.maxRecordCount || 2000,
      name: req.params.tableName ? req.params.tableName.split('.').pop() : 'DatabricksLayer',
      description: `Databricks table: ${req.params.tableName}`
    };

    // Validate table name format to prevent SQL injection via misconfiguration
    if (!sourceConfig.tableName || !TABLE_NAME_PATTERN.test(sourceConfig.tableName)) {
      this.logger.error(`Invalid table name format: ${sourceConfig.tableName}`);
      return callback(new Error(`Invalid table name format: expected catalog.schema.table`));
    }

    // Check if this is a metadata-only request
    const isMetadataRequest =
      (Object.keys(geoserviceParams).length === 1 &&
        geoserviceParams.hasOwnProperty("f")) ||
      Object.keys(geoserviceParams).length === 0;

    // Set fetch size (1 for metadata, capped to configured max for data)
    const fetchSize = isMetadataRequest
      ? 1
      : Math.min(
          parseInt(resultRecordCount) || sourceConfig.maxRecordCountPerPage,
          sourceConfig.maxRecordCountPerPage
        );

    // Use connection pool (works with serverless and classic SQL warehouses)
    const pool = getPool(lakehouseTarget.workspaceConfig, lakehouseTarget.httpPath, {
      min: parseInt(process.env.DATABRICKS_POOL_MIN) || 2,
      max: parseInt(process.env.DATABRICKS_POOL_MAX) || 10,
      idleTimeout: 60000,
      connectionTimeout: 30000,
    });
    let connection = null;

    this.logger.info(`Query ${requestCounter}: Acquiring connection from pool ${pool.poolLabel()}...`);

    // Acquire connection and execute query
    pool.acquire()
      .then(async (conn) => {
        connection = conn;
        let queryOperation;
        let extentOperation;
        let queryFailed = false;

        try {
          this.logger.info(`Query ${requestCounter}: Using pooled connection ${connection.id}`);

          // Resolve geometry format: uses explicit config, name hints, or
          // probes DESCRIBE TABLE once and caches for the process lifetime.
          const resolvedFormat = await resolveGeometryFormat(
            sourceConfig.tableName,
            sourceConfig.geometryColumn,
            sourceConfig.geometryFormat,
            async (sql) => {
              const op = await connection.session.executeStatement(sql, {
                runAsync: true,
                queryTimeout: config.databricks.queryTimeout
              });
              const rows = await op.fetchAll();
              await op.close();
              return rows;
            }
          );

          // Build SQL query using helper module
          const sqlQuery = buildSqlQuery(
            geoserviceParams,
            sourceConfig.idField,
            sourceConfig.geometryColumn,
            sourceConfig.tableName,
            sourceConfig.dbWKID,
            fetchSize,
            resolvedFormat,
            sourceConfig.timeColumn
          );

          this.logger.info(`Query ${requestCounter}: ${sqlQuery.substring(0, 150)}...`);

          // Calculate extent for metadata requests
          let dbExtent = null;
          if (isMetadataRequest) {
            try {
              // Handle all geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)
              const geomExpression = getGeometryFieldExpression(sourceConfig.geometryColumn, sourceConfig.dbWKID, resolvedFormat);

              // ST_Envelope_Agg computes the bounding box in a single aggregate pass
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

          // Check if we exceeded transfer limit.
          // SQL fetched fetchSize + 1 rows; the extra row only signals that more
          // pages exist. Compare against fetchSize, not maxRecordCountPerPage —
          // resultRecordCount can request a smaller page. No LIMIT is applied
          // for returnIdsOnly/returnDistinctValues, so skip the pop there.
          const limitApplied =
            !returnCountOnly &&
            !geoserviceParams.returnIdsOnly &&
            !geoserviceParams.returnDistinctValues;
          let exceededTransferLimit = false;
          if (limitApplied && rows.length > fetchSize) {
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
            ...(sourceConfig.timeColumn && {
              timeInfo: {
                startTimeField: sourceConfig.timeColumn,
                endTimeField: null,
                trackIdField: null,
                timeExtent: null,
                timeReference: null,
                exportOptions: {
                  useTime: true,
                  timeDataCumulative: false
                }
              }
            }),
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
          queryFailed = true;
          this.logger.error(`Query ${requestCounter}: Error executing query: ${error.message}`);
          callback(error);
        } finally {
          // Clean up operations independently (not connection - it goes back to pool)
          if (extentOperation) {
            try { await extentOperation.close(); } catch (e) {
              this.logger.error(`Query ${requestCounter}: Error closing extent operation: ${e.message}`);
            }
          }
          if (queryOperation) {
            try { await queryOperation.close(); } catch (e) {
              this.logger.error(`Query ${requestCounter}: Error closing query operation: ${e.message}`);
            }
          }

          // Release connection back to pool (reused for next request).
          // On query failure the session may be dead (warehouse restart, network
          // drop) — destroy it instead of recycling so the next request gets a
          // fresh connection.
          if (connection) {
            pool.release(connection, { destroy: queryFailed });
            this.logger.info(
              `Query ${requestCounter}: Connection ${connection.id} ${queryFailed ? 'destroyed after error' : 'released back to pool'}`
            );
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
   * getMetadata() — Required by CDF 12.0 for editable providers.
   * Returns idField and inputCrs so the runtime knows which field is the OBJECTID
   * and what CRS the data is in.
   *
   * Uses the PER-SERVICE idField/srid from req.params when the runtime passes a request,
   * so a service whose idField isn't 'id' (or SRID isn't 4326) is described correctly.
   * Falls back to the defaults when called without a request (older runtime hooks).
   */
  async getMetadata(req) {
    return {
      idField: req?.params?.idField || 'id',
      inputCrs: parseInt(req?.params?.srid) || config.databricks.srid || 4326,
    };
  }

  /**
   * Read data from Lakebase (PostgreSQL + PostGIS) for editable services.
   * Called by getData() when req.params.lakebaseHost is set.
   * Returns identical GeoJSON structure as the Databricks path.
   */
  async getDataFromLakebase(req, callback) {
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

    const rawGeometryColumn = req.params.geometryColumn || 'geometry';
    const rawIdField = req.params.idField || 'id';

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
      dbWKID: parseInt(req.params.srid) || config.databricks.srid || 4326,
      maxRecordCountPerPage: parseInt(req.params.maxRecordCount) || config.databricks.maxRecordCount || 2000,
      name: req.params.lakebaseTable || 'LakebaseLayer',
      description: `Lakebase table: ${req.params.lakebaseSchema || 'public'}.${req.params.lakebaseTable}`,
    };

    if (!sourceConfig.lakebaseTable) {
      return callback(new Error('lakebaseTable service parameter is required for editable services'));
    }
    if (!req.params.lakebaseDatabase) {
      return callback(new Error('lakebaseDatabase service parameter is required for editable services'));
    }

    let lakebaseConfig;
    try {
      lakebaseConfig = {
        workspaceConfig: resolveWorkspace(req.params.workspace),
        host: req.params.lakebaseHost,
        port: parseInt(req.params.lakebasePort) || 5432,
        database: req.params.lakebaseDatabase,
      };
    } catch (resolveError) {
      this.logger.error(`Workspace resolution failed: ${resolveError.message}`);
      return callback(resolveError);
    }

    let pool;
    try {
      pool = await getLakebasePool(lakebaseConfig);
    } catch (poolError) {
      this.logger.error(`Lakebase pool error: ${poolError.message}`);
      return callback(poolError);
    }

    this.logger.info(`Query ${requestCounter}: Executing Lakebase query...`);

    let sql, params, fetchSize;
    try {
      ({ sql, params, fetchSize } = buildLakebaseSelectSql(geoserviceParams, sourceConfig));
    } catch (validationError) {
      this.logger.error(`Query ${requestCounter}: Input validation failed: ${validationError.message}`);
      return callback(validationError);
    }
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
          // Check exceeded transfer limit — compare against fetchSize (the
          // requested page size), not maxRecordCountPerPage. No LIMIT is
          // applied for returnIdsOnly, so skip the pop there.
          let exceededTransferLimit = false;
          if (!geoserviceParams.returnIdsOnly && rows.length > fetchSize) {
            exceededTransferLimit = true;
            rows.pop();
          }

          geojson = translateToGeoJSON(rows, sourceConfig);

          const geometryType = this.inferGeometryType(rows, sourceConfig.geometryColumn);
          const fields = this.extractFields(rows, sourceConfig.geometryColumn, sourceConfig.idField, true);

          geojson.metadata = {
            name: sourceConfig.name,
            description: sourceConfig.description,
            geometryType,
            maxRecordCount: sourceConfig.maxRecordCountPerPage,
            exceededTransferLimit,
            idField: sourceConfig.idField,
            inputCrs: sourceConfig.dbWKID,
            fields,
            templates: [this.buildEditTemplate(geometryType, fields, sourceConfig.idField)],
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
   * Called by CDF 12.0 runtime when editingEnabled is true.
   *
   * CDF 12.0 async pattern: async editData(req, data) → returns result
   *
   * Error codes follow Esri convention:
   *   1003 = operation rolled back
   *   1017 = insert failure
   *   1018 = delete failure
   *   1019 = update failure
   *
   * @param {object} req  - Request with params (lakebaseHost, lakebaseSchema, etc.)
   * @param {object} data - { adds: [...], updates: [...], deletes: [...], rollbackOnFailure: bool }
   * @param {function} [callback] - Optional callback for 11.4 compat: callback(err, result)
   * @returns {Promise<{addResults, updateResults, deleteResults}>}
   */
  async editData(req, data, callback) {
    try {
      const rawGeometryColumn = req.params.geometryColumn || 'geometry';
      const rawIdField = req.params.idField || 'id';
      const schema = req.params.lakebaseSchema || 'public';
      const table = req.params.lakebaseTable;
      const srid = parseInt(req.params.srid) || config.databricks.srid || 4326;

      validateIdentifier(rawGeometryColumn);
      validateIdentifier(rawIdField);

      if (!req.params.lakebaseHost) {
        throw new Error('Editing requires lakebaseHost service parameter');
      }
      if (!table) {
        throw new Error('Editing requires lakebaseTable service parameter');
      }
      if (!req.params.lakebaseDatabase) {
        throw new Error('Editing requires lakebaseDatabase service parameter');
      }

      const lakebaseConfig = {
        workspaceConfig: resolveWorkspace(req.params.workspace),
        host: req.params.lakebaseHost,
        port: parseInt(req.params.lakebasePort) || 5432,
        database: req.params.lakebaseDatabase,
      };

      const pool = await getLakebasePool(lakebaseConfig);

      const adds = data.adds || [];
      const updates = data.updates || [];
      const deletes = data.deletes || [];
      const rollbackOnFailure = data.rollbackOnFailure === true ||
        data.rollbackOnFailure === 'true';

      this.logger.info(`Edit: ${adds.length} adds, ${updates.length} updates, ${deletes.length} deletes (rollback=${rollbackOnFailure})`);

      const addResults = [];
      const updateResults = [];
      const deleteResults = [];

      // Use a dedicated client for transaction support
      const client = rollbackOnFailure ? await pool.connect() : null;
      const query = client
        ? (sql, params) => client.query(sql, params)
        : (sql, params) => pool.query(sql, params);

      try {
        if (client) {
          await client.query('BEGIN');
        }

        // Process adds
        for (const feature of adds) {
          try {
            const attributes = feature.attributes || feature.properties || {};
            const geometry = feature.geometry || null;
            const { sql, params } = buildInsertSql(schema, table, attributes, geometry, rawGeometryColumn, rawIdField, srid);
            const result = await query(sql, params);
            const newId = result.rows[0][rawIdField];
            addResults.push({ objectId: Number(newId), success: true });
          } catch (error) {
            this.logger.error(`Edit add failed: ${error.message}`);
            addResults.push({ success: false, error: { code: 1017, description: error.message } });
          }
        }

        // Process updates
        for (const feature of updates) {
          try {
            const attributes = feature.attributes || feature.properties || {};
            const geometry = feature.geometry || null;
            const oid = Number(attributes[rawIdField]);
            const { sql, params } = buildUpdateSql(schema, table, attributes, geometry, rawGeometryColumn, rawIdField, srid);
            const result = await query(sql, params);
            if (result.rowCount === 0) {
              updateResults.push({ objectId: oid, success: false, error: { code: 1019, description: `Feature with ${rawIdField}=${oid} not found` } });
            } else {
              updateResults.push({ objectId: oid, success: true });
            }
          } catch (error) {
            this.logger.error(`Edit update failed: ${error.message}`);
            const oid = Number((feature.attributes || feature.properties || {})[rawIdField]);
            updateResults.push({ objectId: oid, success: false, error: { code: 1019, description: error.message } });
          }
        }

        // Process deletes — uses RETURNING to identify which rows were actually deleted
        if (deletes.length > 0) {
          try {
            const objectIds = deletes.map(Number);
            const { sql, params } = buildDeleteSql(schema, table, rawIdField, objectIds);
            const result = await query(sql, params);
            const deletedIds = new Set(result.rows.map(r => Number(r[rawIdField])));
            for (const id of objectIds) {
              if (deletedIds.has(id)) {
                deleteResults.push({ objectId: id, success: true });
              } else {
                deleteResults.push({ objectId: id, success: false, error: { code: 1018, description: `Feature with ${rawIdField}=${id} not found` } });
              }
            }
          } catch (error) {
            this.logger.error(`Edit delete failed: ${error.message}`);
            for (const id of deletes) {
              deleteResults.push({ objectId: Number(id), success: false, error: { code: 1018, description: error.message } });
            }
          }
        }

        // Handle rollbackOnFailure
        if (client) {
          const hasFailure = [...addResults, ...updateResults, ...deleteResults].some(r => !r.success);
          if (hasFailure) {
            await client.query('ROLLBACK');
            this.logger.warn('Edit rolled back due to failure(s)');
            const rollbackError = { code: 1003, description: 'Operation rolled back' };
            addResults.forEach((r, i) => { addResults[i] = { ...r, success: false, error: rollbackError }; });
            updateResults.forEach((r, i) => { updateResults[i] = { ...r, success: false, error: rollbackError }; });
            deleteResults.forEach((r, i) => { deleteResults[i] = { ...r, success: false, error: rollbackError }; });
          } else {
            await client.query('COMMIT');
          }
        }

        const result = { addResults, updateResults, deleteResults };

        this.logger.info(`Edit complete: ${addResults.length} added, ${updateResults.length} updated, ${deleteResults.length} deleted`);

        // Log edit to audit
        const username = req._user?.username || 'anonymous';
        const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
        auditLogger.log('EDIT', {
          username,
          table: `${schema}.${table}`,
          adds: addResults.length,
          updates: updateResults.length,
          deletes: deleteResults.length,
          ipAddress,
        });

        if (typeof callback === 'function') return callback(null, result);
        return result;
      } catch (error) {
        if (client) {
          try { await client.query('ROLLBACK'); } catch (e) { /* ignore rollback error */ }
        }
        this.logger.error(`Edit error: ${error.message}`);
        if (typeof callback === 'function') return callback(error);
        throw error;
      } finally {
        if (client) {
          client.release();
        }
      }
    } catch (err) {
      if (typeof callback === 'function') return callback(err);
      throw err;
    }
  }

  /**
   * Build an editing template for ArcGIS clients (Pro, JS API Editor widget).
   * Templates define the drawing tool and default attribute values.
   */
  buildEditTemplate(geometryType, fields, idField) {
    const drawingToolMap = {
      Point: 'esriFeatureEditToolPoint',
      MultiPoint: 'esriFeatureEditToolPoint',
      LineString: 'esriFeatureEditToolLine',
      MultiLineString: 'esriFeatureEditToolLine',
      Polygon: 'esriFeatureEditToolPolygon',
      MultiPolygon: 'esriFeatureEditToolPolygon',
    };

    const prototype = {};
    for (const field of fields) {
      if (field.name !== idField) {
        prototype[field.name] = null;
      }
    }

    return {
      name: 'New Feature',
      drawingTool: drawingToolMap[geometryType] || 'esriFeatureEditToolPoint',
      prototype: { attributes: prototype },
    };
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
