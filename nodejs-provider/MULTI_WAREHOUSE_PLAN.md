# Multi-Warehouse Support — Implementation Plan

## Goal

Allow a single CDF provider deployment to serve Feature Services backed by **different Databricks SQL warehouses**. Today the provider holds one warehouse globally (env-driven singleton in `connectionPool.js`); after this change, each Feature Service can specify its own `httpPath` via a service parameter, and the provider keeps a pool per warehouse — mirroring how `lakebasePool.js` already keys pools by `host:port/database`.

**Out of scope (explicitly):**
- Cross-Databricks-workspace support (different `serverHostname` and PAT per service). Same workspace only for v1 — the global `DATABRICKS_SERVER_HOSTNAME` and `DATABRICKS_ACCESS_TOKEN` still apply.
- Lakebase changes — Lakebase is already multi-instance.

## Backward compatibility

- Existing services that don't pass `warehouseHttpPath` fall back to `DATABRICKS_HTTP_PATH` env var. Single-warehouse deployments work unchanged.
- `.env` format unchanged. No migration step.
- No new required service parameters — `warehouseHttpPath` is optional.

## File-by-file changes

### 1. `cdconfig.json` — add service parameter

Add to `properties.serviceParameters`:

```json
{
  "key": "warehouseHttpPath",
  "label": "Warehouse HTTP Path",
  "description": "Databricks SQL Warehouse HTTP path (e.g. /sql/1.0/warehouses/abc123). Optional — defaults to DATABRICKS_HTTP_PATH env var. Lakehouse services only."
}
```

Why `warehouseHttpPath` and not `httpPath`: Esri reserves `host` and `id` and discourages collisions; `httpPath` is generic and could clash with other CDF conventions. `warehouseHttpPath` is unambiguous.

### 2. `src/modules/connectionPool.js` — refactor singleton → keyed map

Mirror the `lakebasePool.js` pattern:

```js
// Map of warehouseKey -> DatabricksConnectionPool instance
const pools = {};

function poolKey(config) {
  return `${config.serverHostname}|${config.httpPath}`;
}

function getPool(config, options) {
  const key = poolKey(config);
  if (pools[key]) return pools[key];
  pools[key] = new DatabricksConnectionPool(config, options);
  return pools[key];
}

async function shutdownPool() {
  await Promise.all(Object.values(pools).map(p => p.shutdown()));
  Object.keys(pools).forEach(k => delete pools[k]);
}
```

- Drop `initializePool` (or keep it as a no-op alias for back-compat; cleaner to drop).
- The `DatabricksConnectionPool` class itself doesn't change — same `acquire`/`release`/`shutdown` API.
- Pre-warming: stop pre-warming at process start. Warm up lazily on first `getPool(config)` call. Otherwise we'd warm up the env-default warehouse even if no service uses it.

### 3. `src/model.js` — plumb per-service warehouse config

- Remove `Model.poolInitialized` static — pool is now lazy-created per service.
- Remove the constructor's eager `initializePool` call.
- In `getData()`, build the per-request warehouse config:

```js
const warehouseConfig = {
  serverHostname: config.databricks.serverHostname,         // global
  accessToken: config.databricks.accessToken,               // global (same-workspace assumption)
  httpPath: req.params.warehouseHttpPath || config.databricks.httpPath,
};
```

- Pass `warehouseConfig` into `getPool(warehouseConfig, options)` and `pool.acquire()` as today.
- Update `assertLakehouseConfig()` to validate the resolved config (must have `httpPath` after fallback, must have `serverHostname` and `accessToken`).
- Service param plumbing: add `warehouseHttpPath` to `sourceConfig` so it's logged/audited alongside `tableName`.

### 4. Tests — `test/connectionPool.test.js` (new) and `test/model.test.js`

New tests:
- `getPool(configA)` and `getPool(configB)` with different `httpPath` return different pool instances.
- `getPool(configA)` called twice returns the same pool.
- `shutdownPool()` shuts down all pools and clears the map.

Update `model.test.js`:
- Existing stub already returns a fake pool — extend it to track which `httpPath` was requested.
- Add a test: two services with different `warehouseHttpPath` route to different stub pools.
- Add a test: service with no `warehouseHttpPath` falls back to `DATABRICKS_HTTP_PATH` env var.

Existing 285 tests should continue to pass — the singleton-shaped stub still works because most tests only exercise one service.

### 5. Documentation

- `CLAUDE.md` — update the "Service parameters" section, note that `warehouseHttpPath` joins the existing 13 params (becomes 14).
- `README.md` — add a short "Multiple warehouses" section with an example service-creation payload using `warehouseHttpPath`.
- `.env.example` — comment that `DATABRICKS_HTTP_PATH` is now a default, overridable per-service.

## Open questions / decisions to make as we go

1. **Drop `initializePool` outright, or keep as deprecated alias?** Lean toward dropping — it's an internal API, no external consumers.
2. **Per-service `accessToken`?** Defer. Same-workspace covers the immediate ask. If a customer later wants cross-workspace, we add `warehouseHostname` + per-service token resolution.
3. **Warm-up behavior** — current pool eagerly creates `min` connections on init. With many pools that's wasteful. Switch to lazy warm-up (warm up on first `acquire`) or keep eager but only when `getPool` is first called for that key. Lean toward the latter — preserves first-request latency for active services.
4. **Pool stats / observability** — `getPool().getStats()` becomes per-key. Probably fine; if we have a stats endpoint later, aggregate across pools.

## Estimated scope

- `cdconfig.json`: ~10 lines
- `connectionPool.js`: ~30 lines net change (delete singleton globals, add map + key fn)
- `model.js`: ~20 lines (build warehouseConfig, replace `getPool()` call sites)
- New tests: ~80 lines
- Docs: ~30 lines

Total: small. One sitting.

## Test plan (manual, after unit tests pass)

1. Provision a second Databricks SQL Warehouse in the same workspace.
2. On the deployed ArcGIS Server, create two services:
   - `WarehouseA_Cities` — `warehouseHttpPath` pointing at warehouse A
   - `WarehouseB_Highways` — `warehouseHttpPath` pointing at warehouse B
3. Query both. Confirm `[Pool]` log lines show two distinct pools created.
4. Stop warehouse A. Confirm queries against `WarehouseB_Highways` still succeed.
5. Restart warehouse A. Confirm queries resume.
6. Existing service `Cities` (no `warehouseHttpPath`) — confirm it still uses env-default warehouse.
