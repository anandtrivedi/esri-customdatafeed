# Multi-Workspace + Multi-Warehouse Support — Implementation Plan

> Branch: `multi-workspace` (renamed from `multi-warehouse`)
> Status: **Steps 1–4 implemented and tested locally**; Step 5 (live two-workspace deploy) is the next thing to do
> Last updated: 2026-05-07

## Goal

Allow a single CDF provider deployment to serve Feature Services backed by:
- **Multiple Databricks SQL warehouses** in the same workspace, AND
- **Multiple Databricks workspaces** entirely (different `serverHostname`, different credentials)

…with **both backends** (Lakehouse + Lakebase) covered consistently.

A customer can have:
- Layer A → workspace A, warehouse A1 (Lakehouse, read-only)
- Layer B → workspace B, warehouse B1 (Lakehouse, read-only)
- Layer C → workspace A, Lakebase instance A2 (editable)
- Layer D → workspace B, Lakebase instance B2 (editable)

…all live concurrently in one ArcGIS Server. No federation across workspaces — each Feature Service hits exactly one workspace. Cross-workspace joins are a Databricks problem (Unity Catalog federation, Delta Sharing, dbt model), not a CDF problem.

## Backward compatibility

- Existing services with no `workspace` and no `warehouseHttpPath` params keep working unchanged. They use the implicit "default" profile resolved from env vars.
- `.env` format unchanged; existing `DATABRICKS_*` env vars still honored.
- Existing test suite (285 tests) should continue to pass without modification by design — the resolver returns env-derived config when no profile is specified.

## Authentication model — PAT and OAuth M2M, both supported

Each workspace profile defines its auth mode independently:

**PAT-based profile:**
```ini
[WORKSPACE_A]
host  = workspace-a.cloud.databricks.com
token = dapiXXXXXX...
```

**OAuth M2M profile (recommended for new deployments):**
```ini
[WORKSPACE_B]
host          = workspace-b.cloud.databricks.com
client_id     = <service-principal-client-id>
client_secret = <service-principal-secret>
```

The Node SQL driver (`@databricks/sql` ≥1.5) handles OAuth token refresh internally when given `authType: 'databricks-oauth'`, so we don't manage those tokens ourselves for SQL connections. For Lakebase, we still mint our own PostgreSQL OAuth tokens via `/api/2.0/database/credentials` — the difference is whether we authenticate that API call with a PAT or with a workspace OAuth token (minted via OAuth M2M client credentials grant against `/oidc/v1/token`).

## Configuration — `.databrickscfg` profiles + service param alias

Customers reference workspaces by alias from a service parameter. Provider resolves the alias against:
1. `~/.databrickscfg` (or path from `DATABRICKS_CONFIG_FILE` env var)
2. Falls back to env vars (`DATABRICKS_SERVER_HOSTNAME`/`DATABRICKS_ACCESS_TOKEN`) for the implicit default profile

This matches the standard Databricks unified-auth pattern. Customers already running Asset Bundles, the CLI, or dbt against multiple workspaces will already have `.databrickscfg` set up.

### Resolution order

1. `req.params.workspace` is set → look up that profile in `.databrickscfg`. Error if not found.
2. `req.params.workspace` is `"default"` or unset:
   a. If `[DEFAULT]` profile exists in `.databrickscfg` → use it.
   b. Else if `DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN` env vars set → synthesize a PAT-style default profile.
   c. Else error: "No default workspace configured."

This gives single-workspace deployments a zero-config path (env vars only, no `.databrickscfg` required) while letting multi-workspace deployments use the standard config file.

## File-by-file changes

### 1. `src/modules/workspaceResolver.js` (NEW — ~120 lines)

Public API:
```js
// Returns { hostname, authType: 'pat' | 'oauth-m2m', token?, clientId?, clientSecret?, workspaceAlias }
function resolveWorkspace(alias = 'default') { ... }

// For tests: clear cached profiles
function clearProfileCache() { ... }
```

Internal:
- `loadProfiles()` — read INI file, parse sections, cache result. Hand-roll INI parser (~30 lines) — no new npm dependency. Format is simple enough.
- `getDefaultProfile()` — synthesize `{ hostname: env.DATABRICKS_SERVER_HOSTNAME, token: env.DATABRICKS_ACCESS_TOKEN, authType: 'pat' }` when env vars are set.
- File location: `process.env.DATABRICKS_CONFIG_FILE || path.join(os.homedir(), '.databrickscfg')`.
- Cache profiles on first read (immutable until process restart). If file is missing, that's fine — env-default still works.

Validation:
- A profile with both `token` AND (`client_id` + `client_secret`) → error (ambiguous).
- A profile with `client_id` but no `client_secret` (or vice versa) → error.
- A profile with no `host` → error.

### 2. `cdconfig.json` — add 2 service parameters

```json
{
  "key": "workspace",
  "label": "Databricks Workspace Profile",
  "description": "Profile name from .databrickscfg (e.g. 'WORKSPACE_A'). Optional — falls back to env-var-based default. Determines which Databricks workspace this service connects to."
},
{
  "key": "warehouseHttpPath",
  "label": "SQL Warehouse HTTP Path",
  "description": "Databricks SQL Warehouse HTTP path (e.g. /sql/1.0/warehouses/abc123). Lakehouse services only. Optional — defaults to DATABRICKS_HTTP_PATH env var."
}
```

Service parameter count grows from 13 → 15.

### 3. `src/modules/connectionPool.js` — refactor singleton → keyed map

Mirror `lakebasePool.js` pattern, but with workspace + warehouse keying:

```js
const pools = {};

function poolKey(workspaceConfig, httpPath) {
  return `${workspaceConfig.workspaceAlias}|${httpPath}`;
}

function getPool(workspaceConfig, httpPath, options) {
  const key = poolKey(workspaceConfig, httpPath);
  if (pools[key]) return pools[key];
  pools[key] = new DatabricksConnectionPool(workspaceConfig, httpPath, options);
  return pools[key];
}

async function shutdownPool() {
  await Promise.all(Object.values(pools).map(p => p.shutdown()));
  Object.keys(pools).forEach(k => delete pools[k]);
}
```

`DatabricksConnectionPool.createConnection()` branches on `authType`:

```js
async createConnection() {
  const client = new DBSQLClient();
  const baseOptions = {
    host: this.workspaceConfig.hostname,
    path: this.httpPath,
    userAgentEntry: `esri_databricks-customdatafeed/${pkg.version}`,
  };

  let connectOptions;
  if (this.workspaceConfig.authType === 'oauth-m2m') {
    connectOptions = {
      ...baseOptions,
      authType: 'databricks-oauth',
      oauthClientId: this.workspaceConfig.clientId,
      oauthClientSecret: this.workspaceConfig.clientSecret,
    };
  } else {
    connectOptions = {
      ...baseOptions,
      token: this.workspaceConfig.token,
    };
  }

  await client.connect(connectOptions);
  // ... rest unchanged
}
```

- Drop `initializePool` entirely.
- Pre-warming behavior: keep eager — `warmUp()` runs in the constructor, so first `getPool(config)` call for a new key warms its `min` connections in parallel. Per-pool, not global.
- Pool stats becomes per-key. Fine for now; aggregate later if needed.

### 4. `src/modules/lakebasePool.js` — pass workspace config through, add OAuth M2M auth path

Changes:
- `databricksApiRequest(method, path, body, workspaceConfig)` — takes workspace config instead of reading globals. Builds Authorization header based on `authType`:
  - PAT: `Authorization: Bearer ${workspaceConfig.token}`
  - OAuth M2M: mint a workspace OAuth token first via `/oidc/v1/token` with client credentials grant, cache it per workspace (1hr expiry, refresh with 5min buffer), use as Bearer.
- New helper: `getWorkspaceOAuthToken(workspaceConfig)` — caches workspace API tokens keyed by `workspaceAlias`. Refreshes 5min before expiry. Only used when `authType === 'oauth-m2m'`.
- `getLakebasePool(config)` — `config` now includes `workspaceConfig`. Pool key becomes `${workspaceAlias}|${host}:${port}/${database}` (workspace alias added so the same Lakebase host theoretically reachable from multiple workspaces — extreme edge case — gets distinct pools).
- `resolveInstanceName` and `generateDatabaseCredential` accept `workspaceConfig` and pass to `databricksApiRequest`.
- `instanceNameCache` becomes keyed by `${workspaceAlias}|${host}` (multi-workspace safety).

### 5. `src/model.js` — plumb workspace config through both backends

In `getData()` (Lakehouse path):
```js
const { resolveWorkspace } = require('./modules/workspaceResolver');
const workspaceConfig = resolveWorkspace(req.params.workspace);
const httpPath = req.params.warehouseHttpPath || process.env.DATABRICKS_HTTP_PATH;
if (!httpPath) {
  return callback(new Error('No SQL warehouse configured...'));
}
const pool = getPool(workspaceConfig, httpPath, poolOptions);
```

In `getDataFromLakebase()` and `editData()` (Lakebase path):
```js
const workspaceConfig = resolveWorkspace(req.params.workspace);
const lakebaseConfig = {
  workspaceConfig,
  host: req.params.lakebaseHost,
  port: req.params.lakebasePort,
  database: req.params.lakebaseDatabase,
  // ... existing params
};
const pool = await getLakebasePool(lakebaseConfig);
```

- Remove `Model.poolInitialized` static — pool creation is fully lazy now.
- Remove the constructor's eager pool init.
- Remove `assertLakehouseConfig` in its current shape; the resolver throws clear errors if no profile resolves.

### 6. Tests

**New: `test/workspaceResolver.test.js` (~80 lines)**
- INI parsing: simple, with comments, with whitespace, with `[DEFAULT]`
- Profile lookup: existing alias, missing alias (error), case sensitivity
- Env-var fallback: when no `.databrickscfg` and env vars set, returns synthesized default profile
- Validation: ambiguous profile (both PAT and OAuth fields) → error
- Validation: incomplete OAuth profile (missing client_secret) → error
- File-not-found: handled gracefully if env vars are set

**New: `test/connectionPool.test.js` (~50 lines)**
- `getPool(configA, pathA)` and `getPool(configB, pathB)` return different instances
- `getPool(configA, pathA)` called twice returns the same instance
- Pool config drives `client.connect()` options correctly (PAT vs OAuth M2M args)
- `shutdownPool()` clears all pools

**Update: `test/model.test.js` (~50 lines added)**
- Two services with different `workspace` params route to different pools
- Service with no `workspace` param uses env-default
- Both Lakehouse and Lakebase paths correctly receive workspace config
- Lakebase OAuth M2M path: stub `/oidc/v1/token` response, assert workspace OAuth token used in subsequent API call

**Update: existing model.test.js stubs**
- Stub `workspaceResolver.resolveWorkspace` to return a fixed config
- Stub `getPool` to accept the new signature `(workspaceConfig, httpPath, options)`
- Old `initializePool` stub line removed

### 7. Documentation

- **New: `docs/MULTI_WORKSPACE.md`** — customer-facing guide:
  - Why use it
  - `.databrickscfg` setup with both auth types
  - Service principal creation steps (link to Databricks docs)
  - Service registration JSON example with `workspace` and `warehouseHttpPath` params
  - Troubleshooting (file location, permissions, profile not found)
- **`CLAUDE.md`** update:
  - Service parameter count: 13 → 15
  - Mention `workspaceResolver.js` in the module organization table
  - Note that auth supports both PAT and OAuth M2M
- **`README.md`** — short "Multiple Workspaces" section linking to MULTI_WORKSPACE.md
- **`.env.example`** — note that `DATABRICKS_HTTP_PATH` is now a default, overridable per-service; mention `DATABRICKS_CONFIG_FILE` env var

## Implementation order (each step keeps existing tests green)

**Step 1 — `workspaceResolver.js` + tests** (zero impact on existing code)
- New module, new test file, no other changes
- Run: `npm test` should still pass 285 + new resolver tests

**Step 2 — Wire resolver into `connectionPool.js`** (Lakehouse multi-workspace)
- Refactor pool to keyed map, add OAuth M2M branch in createConnection
- Update model.js Lakehouse path to call `resolveWorkspace` and new `getPool` signature
- Update model.test.js stub
- Run: existing model tests pass via stub; new connectionPool tests pass

**Step 3 — Wire resolver into `lakebasePool.js`** (Lakebase multi-workspace)
- Refactor `databricksApiRequest` to accept workspace config
- Add OAuth M2M token-minting path with caching
- Update model.js Lakebase paths
- Run: existing tests still pass; add new integration tests

**Step 4 — `cdconfig.json` + docs**
- Add new service parameters
- Write MULTI_WORKSPACE.md
- Update CLAUDE.md, README, .env.example

**Step 5 — Manual deploy + verification**
- Deploy to staging EC2 (instance `i-099fa2d69b5a03312` at `18.234.193.124`)
- Test single-workspace scenario (existing services unchanged)
- Test multi-workspace scenario (two services, two workspaces)

## Manual test plan (after unit tests pass)

1. **Single workspace, single warehouse (regression)** — existing services with no `workspace` param keep working as today.
2. **Single workspace, multiple warehouses** — create two services with same workspace alias but different `warehouseHttpPath`. Confirm two pools created in logs.
3. **Multi-workspace, multi-warehouse, PAT auth** — `.databrickscfg` with two PAT profiles. Two services, one per workspace. Confirm both queryable concurrently.
4. **Multi-workspace, OAuth M2M auth** — `.databrickscfg` with one OAuth M2M profile. Service principal created with CAN_USE on warehouse. Service queries succeed.
5. **Multi-workspace Lakebase** — two Lakebase instances in different workspaces. Two editable services. Confirm independent token minting.
6. **Profile not found** — service param `workspace: "NONEXISTENT"`. Confirm clean error message.
7. **Workspace stop** — stop one workspace's warehouse. Confirm queries against the other workspace still succeed.
8. **Token refresh** — let an OAuth M2M workspace token approach expiry (~55min). Confirm refresh happens transparently.

## Open decisions (resolved)

1. ✅ **Drop `initializePool`** outright (decided: yes).
2. ✅ **Eager warm-up per pool** (decided: yes — preserves first-request latency for active warehouses).
3. ✅ **Both PAT and OAuth M2M supported per profile** (decided: yes — no forced migration).
4. ✅ **Defer cross-workspace data federation** — out of scope, lives at data layer in Databricks.

## Open decisions (still TBD — flag during implementation)

1. **INI parser**: hand-roll (~30 lines, no dep) vs. `ini` npm package (1 dep, battle-tested). Lean: hand-roll. `.databrickscfg` format is intentionally simple.
2. **`.databrickscfg` location on ArcGIS Server**: default `~/.databrickscfg` resolves to whatever OS user runs ArcGIS Server. May need to document setting `DATABRICKS_CONFIG_FILE` explicitly. Verify on the staging EC2 (instance `i-099fa2d69b5a03312`) which user ArcGIS runs as and whether that user has a home directory.
3. **Pool stats endpoint**: today we have `getPool().getStats()` for one pool. With multiple pools, is there value in an aggregate stats helper? Defer until someone asks.
4. **OAuth M2M token endpoint URL**: `/oidc/v1/token` is the workspace endpoint. Verify with first integration test that this works for the AWS-hosted workspaces (Azure is different but customer is on AWS).

## Estimated scope

| File | Net LOC |
|---|---|
| `workspaceResolver.js` (new) | ~120 |
| `workspaceResolver.test.js` (new) | ~80 |
| `connectionPool.js` | ~50 net |
| `connectionPool.test.js` (new) | ~50 |
| `lakebasePool.js` | ~80 net |
| `model.js` | ~30 net |
| `model.test.js` | ~50 added |
| `cdconfig.json` | ~12 |
| `MULTI_WORKSPACE.md` (new) | ~150 |
| `CLAUDE.md`, `README.md`, `.env.example` | ~30 |
| **Total** | **~650 LOC** |

Larger than the original `multi-warehouse` estimate (~150 LOC) but covers both backends and both auth modes in one consistent change.

Estimated time: 4-6 focused hours.

## Status checklist

- [x] Step 1 — workspaceResolver.js + 20 unit tests
- [x] Step 2 — connectionPool.js refactor (keyed map, drops initializePool, supports OAuth M2M) + 9 unit tests + model.js Lakehouse plumbing
- [x] Step 3 — lakebasePool.js refactor (workspace-aware token minting, OAuth M2M support) + model.js Lakebase plumbing
- [x] Step 4 — cdconfig.json service params, MULTI_WORKSPACE.md customer guide, .databrickscfg.example, .env.example, .gitignore
- [ ] Step 5 — live two-workspace deploy on EC2 (see "Two-workspace test recipe" below)

339 tests passing locally as of last commit.

## Two-workspace test recipe (for Step 5)

Goal: prove that one ArcGIS Server can expose `atrivedi` data from **aws-e2** and **dod-fe** workspaces concurrently via two Feature Services.

### 1. Inventory data (do this first, in browser)

In each workspace, find a geospatial table in the `atrivedi` catalog and note:
- table name (`atrivedi.<schema>.<table>`)
- geometry column + format (WKT/WKB/GeoJSON/native GEOMETRY)
- id column
- SRID
- a sample query you know returns rows (for sanity-check after deploy)

Write these into a quick scratch file before SSH'ing.

### 2. Create credentials per workspace

Choose one path per workspace:
- **PAT (quickest):** Settings → Developer → Access tokens. Create one with reasonable lifetime.
- **OAuth M2M (recommended):** Account console → Service principals → create SP, generate OAuth secret, assign SP to workspace, grant `CAN_USE` on the SQL warehouse.

### 3. Build `.databrickscfg` for the ArcGIS Server box

Copy `nodejs-provider/.databrickscfg.example` into the format below and fill in:

```ini
[DEFAULT]
host  = <existing-default-workspace>.cloud.databricks.com
token = <existing-pat>

[AWS_E2]
host  = <aws-e2-host>.cloud.databricks.com
token = dapi...
# OR for OAuth M2M:
# client_id     = ...
# client_secret = ...

[DOD_FE]
host  = <dod-fe-host>.cloud.databricks.com
token = dapi...
```

### 4. Deploy the new .cdpk to the EC2 instance

EC2: `i-099fa2d69b5a03312` at `18.234.193.124`. SSH per memory note.

```bash
# 1. Sync the branch to the box
ssh -i ~/.ssh/AnandTrivediRSAPEM.pem ubuntu@18.234.193.124
cd ~/esri-customdatafeed
git fetch
git checkout multi-workspace
git pull

# 2. Place .databrickscfg
sudo cp /tmp/.databrickscfg /opt/arcgis/server/usr/.databrickscfg
sudo chown arcgis:arcgis /opt/arcgis/server/usr/.databrickscfg
sudo chmod 600 /opt/arcgis/server/usr/.databrickscfg

# 3. Add DATABRICKS_CONFIG_FILE to init script
sudo nano /opt/arcgis/server/usr/init_user_param.sh
# Add: export DATABRICKS_CONFIG_FILE=/opt/arcgis/server/usr/.databrickscfg

# 4. Build .cdpk on the server (Linux node_modules — see memory)
cd nodejs-provider
/opt/arcgis/server/framework/runtime/node/bin/node \
  /opt/arcgis/server/framework/runtime/node/lib/node_modules/npm/bin/npm-cli.js install
# package as .cdpk per existing build instructions

# 5. Re-register the provider via Admin REST or CLI
# 6. Restart ArcGIS Server
sudo /opt/arcgis/server/startserver.sh   # or systemd equivalent

# 7. Re-create .env in the registered provider directory (cdpk extraction wipes it)
```

### 5. Create two Feature Services

Use the existing CDF service-creation pattern from memory. Key params:

```json
"serviceParameters": {
  "workspace":         "AWS_E2",
  "warehouseHttpPath": "/sql/1.0/warehouses/<aws-e2-warehouse-id>",
  "tableName":         "atrivedi.<schema>.<table>",
  "geometryColumn":    "geometry",
  "idField":           "id",
  "srid":              "4326"
}
```

Same JSON for DOD_FE service with that workspace's warehouse path and table.

### 6. Smoke test

Hit each service:
```bash
curl -k 'https://18.234.193.124:6443/arcgis/rest/services/AwsE2_Layer/FeatureServer/0/query?where=1=1&outFields=*&returnCountOnly=true&f=json'
curl -k 'https://18.234.193.124:6443/arcgis/rest/services/DodFe_Layer/FeatureServer/0/query?where=1=1&outFields=*&returnCountOnly=true&f=json'
```

Both should return non-zero counts. Tail logs and confirm two distinct pool init lines:
```
[Pool AWS_E2|/sql/1.0/warehouses/...] Initialized
[Pool DOD_FE|/sql/1.0/warehouses/...] Initialized
```

### 7. Negative test

Create a service with `workspace: "NONEXISTENT"`. Expect a clear error from the resolver.

### 8. Regression check

Confirm an existing service (no `workspace` param) still works — should fall back to env-default.

## When resuming this branch

1. Verify branch: `git branch --show-current` should be `multi-workspace`.
2. Read this document end-to-end (especially Status + Test recipe).
3. Run `cd nodejs-provider && npm test` — should be 339 passing.
4. If implementing Step 5, follow the test recipe above.
5. Don't push to GitHub until explicitly asked (per project memory).
