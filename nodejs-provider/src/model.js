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
  validateFieldName,
  parseMinScale,
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
    queryTimeout: parseInt(process.env.DATABRICKS_QUERY_TIMEOUT) || 120000, // 2 minutes default
    // CloudFetch downloads large results from presigned cloud-storage URLs, which ArcGIS hosts often can't reach.
    // In @databricks/sql 1.12.0 a failed download (e.g. 403) is caught for the request, but the driver's other
    // concurrent downloads reject unhandled and Node exits the whole CDF process. Off by default: results come back
    // inline over the warehouse connection. Set DATABRICKS_USE_CLOUDFETCH=true only where the host can reach storage.
    useCloudFetch: /^(1|true|yes)$/i.test(process.env.DATABRICKS_USE_CLOUDFETCH || ''),
    // Feature-tile queries (resultType=tile) are cancelled after this many ms; 0 disables. ArcGIS Server doesn't pass a
    // browser's abort through to the CDF, so an abandoned tile otherwise runs to the session STATEMENT_TIMEOUT (default
    // 2 min) while holding a pool connection. Tiles are a drawing sample, so failing one fast is the better trade.
    tileQueryTimeout: parseInt(process.env.DATABRICKS_TILE_QUERY_TIMEOUT ?? '30000', 10)
  }
};

// Options for every executeStatement call, so none of them can fall back to the driver's CloudFetch default.
// Per statement on purpose: in 1.12.0 the DBSQLClient constructor ignores a config argument.
function statementOptions() {
  return {
    runAsync: true,
    queryTimeout: config.databricks.queryTimeout,
    useCloudFetch: config.databricks.useCloudFetch
  };
}

// The ArcGIS CDF publish wizard makes EVERY declared service parameter required, so a
// Lakehouse service still has to put something in the Lakebase-only fields (and vice-versa).
// Publishers type a placeholder to get past the form; treat these as "not provided" so the
// value is ignored. Crucially, a placeholder in lakebaseHost must NOT flip routing to Lakebase.
// Sentinels (case-insensitive, after trimming): empty/whitespace, a run of dashes (-, --, ---),
// na, n/a, none.
const PARAM_SENTINEL_RE = /^(?:[\s-]*|na|n\/a|none)$/i;
function cleanParam(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return PARAM_SENTINEL_RE.test(trimmed) ? undefined : trimmed;
}

// Service parameters that may legitimately be "not applicable" for the chosen backend.
const SERVICE_PARAM_KEYS = [
  'workspace', 'warehouseHttpPath', 'tableName', 'geometryColumn', 'idField',
  'geometryFormat', 'timeColumn', 'lakebaseHost', 'lakebasePort', 'lakebaseDatabase',
  'lakebaseSchema', 'lakebaseTable', 'maxRecordCount', 'srid', 'editingEnabled', 'minScale',
];

// supportedQueryFormats is deliberately never set: the runtime default 'JSON,geojson,PBF' applies, so clients get PBF
// feature tiles. Verified on the 12.1.0 CDF runtime: quantized PBF tiles carry a correct transform and render the same
// features as JSON in Map Viewer and the JS SDK, at roughly 3-9x smaller payloads. (v1.1.3-1.1.4 dropped PBF after
// large layers drew blank in Map Viewer; that was the provider's own Web Mercator tile-geometry bug, fixed in v1.1.3,
// not the runtime.) If it's ever needed again: the runtime's joi allow-list only accepts 'JSON' or 'JSON,geojson' —
// a string containing PBF fails validation and 500s the metadata request.

// Normalize sentinel placeholders to "absent" on req.params, so a '-' typed into an
// inapplicable-but-required publish field behaves exactly like leaving it blank would.
// minScale is a display hint: a malformed value is logged once and ignored rather than failing the service.
const warnedMinScale = new Set();
function minScaleFor(req, logger) {
  try {
    return parseMinScale(req.params.minScale);
  } catch (e) {
    const key = `${req.params.tableName}|${req.params.minScale}`;
    if (!warnedMinScale.has(key)) { warnedMinScale.add(key); logger.warn(`${req.params.tableName}: ${e.message}; ignoring it`); }
    return null;
  }
}

function normalizeServiceParams(req) {
  if (!req || !req.params) return;
  for (const key of SERVICE_PARAM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(req.params, key)) {
      const cleaned = cleanParam(req.params[key]);
      if (cleaned === undefined) delete req.params[key];
      else req.params[key] = cleaned;
    }
  }
}

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

// Sequence for request ids in log lines. Each request copies its own id: reading the shared counter after an await
// labelled lines with whichever request arrived last (seen live: one 'Query N' mixing several requests' lines).
let requestSeq = 0;

// Layer extent for metadata responses, per table. ST_Envelope_Agg is a full-table aggregate, so on a multi-billion-row
// table it runs for minutes and every metadata request (ArcGIS asks after each restart) piled one more onto the
// warehouse and onto the connection pool. Computed once, cached; if it doesn't finish inside the wait budget it's
// cancelled, the metadata goes out without an extent (clients fall back to the data's own bounds), and the table is
// remembered as too big to try again for a while. Concurrent cold-cache callers share one in-flight query (see
// getLayerExtent) so a burst of metadata requests doesn't fire N full scans.
const EXTENT_CACHE_MS = parseInt(process.env.CDF_EXTENT_CACHE_MS) || 24 * 3600 * 1000;
const EXTENT_WAIT_MS = parseInt(process.env.CDF_EXTENT_WAIT_MS) || 10000;
const EXTENT_RETRY_MS = parseInt(process.env.CDF_EXTENT_RETRY_MS) || 3600 * 1000;
const EXTENT_ERROR_RETRY_MS = parseInt(process.env.CDF_EXTENT_ERROR_RETRY_MS) || 60 * 1000;
const EXTENT_TIMED_OUT = Symbol("extent-timed-out");
// The time extent (min/max of the time column) is usually answered from file statistics in a few seconds, but on a
// very large table it can take longer than the metadata wait. Then the metadata goes out without it and the query keeps
// running in the background (capped here), filling the cache for the next metadata request.
const TIME_EXTENT_BG_MS = parseInt(process.env.CDF_TIME_EXTENT_BG_MS) || 120 * 1000;
const extentCache = new Map();    // key -> { extent: object|null, at: ms, ttl: ms }
const extentInFlight = new Map(); // key -> Promise<object|null> — in-flight compute, de-dupes concurrent callers
const warnedNoTimeColumn = new Set(); // tables already warned about having no timeColumn (once per process)

// [min,max] epoch-ms from the time-extent query rows, or null if the table is empty / the column is all-NULL /
// values are non-finite. Guard against SQL NULL first: an empty table or all-NULL column makes min/max return NULL,
// and Number(null) === 0 would otherwise surface as a bogus [0, 0] (1970) time extent.
function timeRowsToRange(rows) {
  if (!rows || !rows.length) return null;
  const { t0, t1 } = rows[0];
  if (t0 == null || t1 == null) return null;
  const n0 = Number(t0), n1 = Number(t1);
  return Number.isFinite(n0) && Number.isFinite(n1) ? [n0, n1] : null;
}

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
   * Resolve the layer extent for a metadata request: serve a fresh value from the cache if one is valid, otherwise
   * compute it (de-duping concurrent cold-cache callers so a burst of metadata requests shares a single query).
   * Always resolves to an extent object or null — never rejects — so callers can serve metadata either way.
   */
  async getLayerExtent(connection, cacheKey, geomExpression, sourceConfig, requestCounter) {
    const cached = extentCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cached.ttl) {
      return cached.extent;
    }
    let inflight = extentInFlight.get(cacheKey);
    if (!inflight) {
      inflight = this._computeLayerExtent(connection, cacheKey, geomExpression, sourceConfig, requestCounter)
        .finally(() => extentInFlight.delete(cacheKey));
      extentInFlight.set(cacheKey, inflight);
    }
    return inflight;
  }

  /**
   * Resolve the layer's time extent ([startMs, endMs] of the time column) for timeInfo.timeExtent. Without it, clients
   * like Map Viewer have no range for a time slider and request every time at once — on a multi-year table each tile
   * then pulls every year, which is slow and saturates the CDF runtime. Same cache / de-dupe / time box as the spatial
   * extent; resolves to [start, end] or null, never rejects.
   */
  async getLayerTimeExtent(pool, connection, cacheKey, sourceConfig, requestCounter) {
    const cached = extentCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cached.ttl) {
      return cached.extent;
    }
    let inflight = extentInFlight.get(cacheKey);
    if (!inflight) {
      inflight = this._computeLayerTimeExtent(pool, connection, cacheKey, sourceConfig, requestCounter)
        .finally(() => extentInFlight.delete(cacheKey));
      extentInFlight.set(cacheKey, inflight);
    }
    return inflight;
  }

  // SQL for [min,max] of the time column as epoch-ms BIGINTs. CAST to TIMESTAMP so DATE and TIMESTAMP both work;
  // min/max is usually answered from Delta file statistics, so it's cheap even on huge tables.
  _timeExtentQuery(sourceConfig) {
    const col = validateFieldName(sourceConfig.timeColumn);
    return `
      SELECT CAST(unix_millis(CAST(min(${col}) AS TIMESTAMP)) AS BIGINT) AS t0,
             CAST(unix_millis(CAST(max(${col}) AS TIMESTAMP)) AS BIGINT) AS t1
      FROM ${sourceConfig.tableName}
    `;
  }

  async _computeLayerTimeExtent(pool, connection, cacheKey, sourceConfig, requestCounter) {
    const now = Date.now();
    let op;
    let timer;
    try {
      // Build the query (validateFieldName) inside the try: a bad timeColumn should degrade to a negative cache + null
      // like a SQL error, not throw out of this "never rejects" method and 500 every metadata request forever.
      const timeQuery = this._timeExtentQuery(sourceConfig);
      op = await connection.session.executeStatement(timeQuery, statementOptions());
      const fetchP = op.fetchAll();
      fetchP.catch(() => {}); // see _computeLayerExtent: a cancelled op's pending fetch rejects later
      const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(EXTENT_TIMED_OUT), EXTENT_WAIT_MS); });
      const rows = await Promise.race([fetchP, timedOut]);
      if (rows === EXTENT_TIMED_OUT) {
        // Too slow for the metadata budget. Cancel it on THIS request's connection so that connection returns to the
        // pool clean — never released with a live operation, never shared with the next request. Then recompute in the
        // background on a SEPARATE borrowed connection (see _backgroundTimeExtent). The negative cache entry keeps
        // concurrent/follow-up metadata requests from each spawning their own background recompute — stamped NOW (not
        // function entry) and given the full background cap, so it stays valid for the entire background window (the
        // background can run until ~now+EXTENT_WAIT_MS+TIME_EXTENT_BG_MS; anchoring at entry would expire it early and
        // let a second request start a duplicate query / clobber a fresh result).
        this.logger.warn(`Query ${requestCounter}: time extent of ${sourceConfig.tableName} not ready in ${EXTENT_WAIT_MS} ms — recomputing in the background on its own connection (cap ${Math.round(TIME_EXTENT_BG_MS / 1000)} s)`);
        try { await op.cancel(); } catch (e) { /* may already be finished */ }
        extentCache.set(cacheKey, { extent: null, at: Date.now(), ttl: TIME_EXTENT_BG_MS + EXTENT_WAIT_MS });
        this._backgroundTimeExtent(pool, cacheKey, timeQuery, sourceConfig);
        return null;
      }
      const range = timeRowsToRange(rows);
      extentCache.set(cacheKey, { extent: range, at: now, ttl: EXTENT_CACHE_MS });
      return range;
    } catch (error) {
      this.logger.warn(`Query ${requestCounter}: Failed to calculate time extent for ${sourceConfig.tableName}: ${error.message}`);
      extentCache.set(cacheKey, { extent: null, at: now, ttl: EXTENT_ERROR_RETRY_MS });
      return null;
    } finally {
      clearTimeout(timer);
      if (op) {
        try { await op.close(); } catch (e) { /* best-effort */ }
      }
    }
  }

  // Fire-and-forget background recompute of a slow time extent, on its OWN pooled connection — never the request's, so
  // no live operation ever rides a connection that getData has released, and no two statements share one session.
  // Borrows a connection, runs the min/max capped at TIME_EXTENT_BG_MS, writes the cache, and always releases.
  _backgroundTimeExtent(pool, cacheKey, timeQuery, sourceConfig) {
    (async () => {
      let conn, op, timer;
      try {
        conn = await pool.acquire();
        op = await conn.session.executeStatement(timeQuery, statementOptions());
        const fetchP = op.fetchAll();
        fetchP.catch(() => {}); // a cancelled op's pending fetch rejects later
        const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(EXTENT_TIMED_OUT), TIME_EXTENT_BG_MS); });
        const rows = await Promise.race([fetchP, cap]);
        if (rows === EXTENT_TIMED_OUT) {
          try { await op.cancel(); } catch (e) { /* already finished */ }
          extentCache.set(cacheKey, { extent: null, at: Date.now(), ttl: EXTENT_RETRY_MS });
          this.logger.warn(`time extent of ${sourceConfig.tableName} gave up after ${Math.round(TIME_EXTENT_BG_MS / 1000)} s; retry in ${Math.round(EXTENT_RETRY_MS / 60000)} min`);
        } else {
          extentCache.set(cacheKey, { extent: timeRowsToRange(rows), at: Date.now(), ttl: EXTENT_CACHE_MS });
        }
      } catch (e) {
        extentCache.set(cacheKey, { extent: null, at: Date.now(), ttl: EXTENT_ERROR_RETRY_MS });
        this.logger.warn(`background time extent of ${sourceConfig.tableName} failed: ${e.message}`);
      } finally {
        if (timer) clearTimeout(timer);
        if (op) { try { await op.close(); } catch (e) { /* best-effort */ } }
        if (conn) { try { pool.release(conn); } catch (e) { /* best-effort */ } }
      }
    })();
  }

  /**
   * Run the full-table ST_Envelope_Agg, time-boxed by EXTENT_WAIT_MS. Caches the result (long TTL), a timeout
   * (medium TTL — "too big"), or an error (short TTL — often transient) so none re-runs on every metadata request.
   */
  async _computeLayerExtent(connection, cacheKey, geomExpression, sourceConfig, requestCounter) {
    const now = Date.now();
    // ST_Envelope_Agg computes the bounding box in a single aggregate pass
    const extentQuery = `
      SELECT ST_AsGeoJSON(ST_Envelope_Agg(${geomExpression})) AS extent
      FROM ${sourceConfig.tableName}
    `;
    let op;
    let timer;
    try {
      op = await connection.session.executeStatement(extentQuery, statementOptions());
      // Promise.race doesn't cancel the loser. Once we cancel() a timed-out operation, the still-pending fetchAll()
      // rejects in the real @databricks/sql driver — attach a sink so that rejection isn't unhandled (which would
      // crash the process on Node >= 15). The test stub resolves it artificially, so this guard is only exercised live.
      const fetchP = op.fetchAll();
      fetchP.catch(() => {});
      const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(EXTENT_TIMED_OUT), EXTENT_WAIT_MS); });
      const extentRows = await Promise.race([fetchP, timedOut]);
      if (extentRows === EXTENT_TIMED_OUT) {
        this.logger.warn(`Query ${requestCounter}: extent of ${sourceConfig.tableName} not ready in ${EXTENT_WAIT_MS} ms — cancelled; serving metadata without it (retry in ${Math.round(EXTENT_RETRY_MS / 60000)} min)`);
        try { await op.cancel(); } catch (e) { /* already finished */ }
        extentCache.set(cacheKey, { extent: null, at: now, ttl: EXTENT_RETRY_MS });
        return null;
      }
      let extent = null;
      if (extentRows.length > 0 && extentRows[0].extent) {
        extent = getExtentFromGeoJson(JSON.parse(extentRows[0].extent), sourceConfig.dbWKID);
      }
      extentCache.set(cacheKey, { extent, at: now, ttl: EXTENT_CACHE_MS });
      return extent;
    } catch (error) {
      this.logger.warn(`Query ${requestCounter}: Failed to calculate extent for ${sourceConfig.tableName}: ${error.message}`);
      // Negatively cache non-timeout failures too (short TTL — they're often transient) so a persistent error doesn't
      // re-run the full-table scan on every metadata request.
      extentCache.set(cacheKey, { extent: null, at: now, ttl: EXTENT_ERROR_RETRY_MS });
      return null;
    } finally {
      clearTimeout(timer); // always clear — the success path and the reject path both land here
      if (op) {
        try { await op.close(); } catch (e) { /* best-effort; op may already be closed/cancelled */ }
      }
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
    const requestCounter = ++requestSeq;
    req._cdfRequestId = requestCounter;
    normalizeServiceParams(req); // '-', 'na', blanks etc. (publish-form placeholders) => unset

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
      minScale: minScaleFor(req, this.logger),
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

    // A client that gives up (Map Viewer drops tiles on every pan and zoom) closes the response. Cancel its SQL and
    // free the connection instead of finishing work nobody will read, and skip queued requests whose client is gone.
    // `close` also fires after a normal response, hence the writableEnded check.
    const res = req.res;
    let clientGone = false;
    let onClientGone = null;
    const markClientGone = () => {
      if (clientGone || !res || res.writableEnded) return;
      clientGone = true;
      this.logger.info(`Query ${requestCounter}: client went away`);
      if (onClientGone) onClientGone();
    };
    if (res && typeof res.once === 'function') res.once('close', markClientGone);
    const stopWatchingClient = () => { if (res && typeof res.off === 'function') res.off('close', markClientGone); };
    // Answer exactly once: a callback that throws (e.g. writing to a dead socket) must not trigger a second callback
    // from the catch below.
    let responded = false;
    const respond = (err, data) => {
      if (responded) return;
      responded = true;
      try { callback(err, data); } catch (e) { this.logger.error(`Query ${requestCounter}: response callback threw: ${e.message}`); }
    };
    const isTile = String(geoserviceParams.resultType || '').toLowerCase() === 'tile';

    // Acquire connection and execute query
    pool.acquire()
      .then(async (conn) => {
        connection = conn;
        let queryOperation;
        let queryFailed = false;
        let cancelReason = null; // set when we cancel the statement ourselves (client gone, tile timeout)
        let cancelP = null;      // resolves true if that cancel succeeded

        if (clientGone) {
          stopWatchingClient();
          pool.release(connection);
          this.logger.info(`Query ${requestCounter}: client went away while queued; not running it`);
          return respond(new Error('Client closed the request'));
        }

        try {
          this.logger.info(`Query ${requestCounter}: Using pooled connection ${connection.id}`);

          // Resolve geometry format: uses explicit config, name hints, or
          // probes DESCRIBE TABLE once and caches for the process lifetime.
          const resolvedFormat = await resolveGeometryFormat(
            sourceConfig.tableName,
            sourceConfig.geometryColumn,
            sourceConfig.geometryFormat,
            async (sql) => {
              const op = await connection.session.executeStatement(sql, statementOptions());
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

          // Calculate extent for metadata requests (cached, time-boxed, de-duped — see getLayerExtent)
          if (isMetadataRequest && !sourceConfig.timeColumn && !warnedNoTimeColumn.has(sourceConfig.tableName)) {
            warnedNoTimeColumn.add(sourceConfig.tableName);
            this.logger.warn(`${sourceConfig.tableName}: no timeColumn configured — the layer isn't time-enabled, so clients (Map Viewer) request every date in each tile. Set timeColumn for any table with more than one record per place over time.`);
          }
          let dbExtent = null;
          // timeInfo goes out on every response; outside metadata requests use whatever is cached, never compute
          const timeKey = `${pool.poolLabel()}|${sourceConfig.tableName}|time|${sourceConfig.timeColumn}`;
          const cachedTime = sourceConfig.timeColumn ? extentCache.get(timeKey) : null;
          let dbTimeExtent = cachedTime && Date.now() - cachedTime.at < cachedTime.ttl ? cachedTime.extent : null;
          if (isMetadataRequest) {
            // Handle all geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)
            const geomExpression = getGeometryFieldExpression(sourceConfig.geometryColumn, sourceConfig.dbWKID, resolvedFormat);
            // Key by connection identity (workspace|warehouse) so a same-named table in another workspace sharing this
            // process can't collide and serve the wrong extent (or inherit the wrong negative cache).
            const cacheKey = `${pool.poolLabel()}|${sourceConfig.tableName}|${geomExpression}|${sourceConfig.dbWKID}`;
            dbExtent = await this.getLayerExtent(connection, cacheKey, geomExpression, sourceConfig, requestCounter);
            if (sourceConfig.timeColumn) {
              dbTimeExtent = await this.getLayerTimeExtent(pool, connection, timeKey, sourceConfig, requestCounter);
            }
          }

          // Execute main query
          queryOperation = await connection.session.executeStatement(sqlQuery, statementOptions());
          const op = queryOperation;
          const cancelQuery = (reason) => {
            if (cancelP) return;
            cancelReason = reason;
            this.logger.info(`Query ${requestCounter}: cancelling its SQL (${reason})`);
            cancelP = op.cancel().then(() => true, (e) => {
              this.logger.warn(`Query ${requestCounter}: cancel failed: ${e.message}`);
              return false;
            });
          };
          onClientGone = () => cancelQuery('client went away');
          if (clientGone) onClientGone();
          const tileMs = config.databricks.tileQueryTimeout;
          const tileTimer = isTile && tileMs > 0
            ? setTimeout(() => cancelQuery(`tile query over ${Math.round(tileMs / 1000)} s`), tileMs)
            : null;
          let rows;
          try { rows = await queryOperation.fetchAll(); } finally { clearTimeout(tileTimer); }
          if (cancelReason) {
            // fetchAll finished before the cancel took effect; don't build a response for a client that's gone
            throw new Error(`Query cancelled: ${cancelReason}`);
          }
          await queryOperation.close();
          queryOperation = null;

          this.logger.info(`Query ${requestCounter}: Received ${rows.length} rows`);

          // Initialize GeoJSON response
          let geojson = { type: "FeatureCollection", features: [] };

          if (rows.length === 0) {
            return respond(null, geojson);
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
            ...(sourceConfig.minScale && { minScale: sourceConfig.minScale }),
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
                timeExtent: dbTimeExtent,
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

          respond(null, geojson);

        } catch (error) {
          if (cancelReason) {
            // our own cancel: the session is fine (destroyed below only if the cancel itself failed)
            this.logger.info(`Query ${requestCounter}: cancelled (${cancelReason})`);
            if (!clientGone) error = new Error(`Tile query cancelled: ${cancelReason}`);
          } else if (clientGone) {
            this.logger.info(`Query ${requestCounter}: ended after the client went away`);
          } else {
            queryFailed = true;
            this.logger.error(`Query ${requestCounter}: Error executing query: ${error.message}`);
          }
          respond(error);
        } finally {
          stopWatchingClient();
          onClientGone = null;
          // wait for our cancel to settle before closing/reusing the session; an uncertain cancel isn't reusable
          if (cancelP && !(await cancelP)) queryFailed = true;
          // Clean up operations independently (not connection - it goes back to pool).
          // The extent operation is opened and closed entirely within getLayerExtent, so it's not handled here.
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
        stopWatchingClient();
        this.logger.error(`Query ${requestCounter}: Error acquiring connection: ${error.message}`);
        respond(error);

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
    const requestCounter = req._cdfRequestId ?? ++requestSeq;
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
      minScale: minScaleFor(req, this.logger),
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
            ...(sourceConfig.minScale && { minScale: sourceConfig.minScale }),
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
      normalizeServiceParams(req); // '-', 'na', blanks etc. (publish-form placeholders) => unset
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
module.exports._extentCache = extentCache; // tests reset it between cases
