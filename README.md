# ArcGIS Custom Data Feed Provider for Databricks

A Node.js Custom Data Provider that connects Databricks tables to ArcGIS Server as Feature Services. Supports two backends:

| Backend | Engine | Best for | Capabilities |
|---------|--------|----------|-------------|
| **Lakehouse** | Databricks SQL Warehouse | Large-scale analytics, complex queries across massive tables | Query |
| **Lakebase** | Databricks Managed PostgreSQL + PostGIS | Low-latency serving (14–16ms), interactive maps, feature editing | Query + Editing |

Choose **Lakehouse** when you need to query large Delta Lake tables directly with full Databricks SQL power. Choose **Lakebase** when you need fast, interactive map performance or feature editing — Lakebase serves data at PostgreSQL speeds with native PostGIS spatial indexing.

One provider is registered once. Each Feature Service chooses its backend via service parameters.

## Overview

![CDF Overview — Direct Integration with ArcGIS Enterprise](cdf-overview.png)

## Architecture

![CDF Architecture — Databricks + Lakebase](cdf-architecture.png)

![Cell Towers served from Databricks Lakebase via ArcGIS Feature Service](screenshots/03-celltowers-editable-map.png)

## Project Structure

```
nodejs-provider/
  cdconfig.json               # CDF provider manifest (registered with ArcGIS Server)
  package.json
  .env.example                # Environment config template
  src/
    index.js                  # Provider entry point
    model.js                  # getData/editData/authorize — routes between backends
    modules/
      # --- Shared ---
      sanitize.js             # SQL injection prevention
      translate.js            # Row-to-GeoJSON conversion
      filters.js              # filtersApplied metadata
      auditLog.js             # Query audit logging
      # --- Lakehouse backend ---
      connectionPool.js       # Databricks SQL connection pooling
      sql.js                  # Databricks SQL query builder
      geometry.js             # Spatial filter construction (with DE-9IM workarounds)
      geometryFormat.js       # WKT/WKB/GeoJSON format handling
      # --- Lakebase backend ---
      lakebasePool.js         # PostgreSQL connection pooling (pg module)
      lakebaseQuery.js        # PostGIS SELECT query builder
      editSql.js              # INSERT/UPDATE/DELETE SQL builders
  test/                       # 309 unit tests (mocha + chai)
```

## Setup

Everything below runs on the **ArcGIS Server machine** (the provider is a Node.js plugin that runs inside ArcGIS Server's CDF runtime).

### Prerequisites

- ArcGIS Server 11.4+ with Custom Data Feeds (11.4 added editing via `applyEdits`, 12.0 added `editingEnabled` property) — includes Node.js
- Databricks SQL Warehouse with geospatial functions enabled
- **Optional**: Databricks Lakebase instance — needed for low-latency serving or feature editing

### 1. Install dependencies

Run this **on the ArcGIS Server machine** — native modules (`@databricks/sql` uses Apache Arrow C++ bindings) must be compiled for the target OS. Installing on macOS and copying to Linux (or vice versa) will fail.

```bash
cd nodejs-provider
npm install    # Installs both @databricks/sql and pg drivers
```

### 2. Configure Databricks Connection

Create a `.env` file with your Databricks credentials — this is the only config file you need:

```bash
cp .env.example .env
```

Edit `.env` — only 3 values are required:

```bash
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi_your_pat_here   # Personal Access Token (PAT)
```

Per-table settings (table name, geometry column, etc.) are configured per-service when you create each Feature Service — not in `.env`. See [Service Parameters](#creating-feature-services) below.

### 3. Configure Lakebase (optional)

Lakebase connection details (host, port, database) are set per-service — see Service Parameters below.

Authentication is automatic: the provider generates short-lived OAuth tokens using your `DATABRICKS_ACCESS_TOKEN` (PAT) via the Databricks `/api/2.0/database/credentials` endpoint. No additional configuration needed.

To use a static password instead of auto-generated tokens:

```bash
export LAKEBASE_PASSWORD="your-oauth-token-or-password"
```

### 4. Package and Register Provider

**Option A: CDF CLI** (requires [ArcGIS Enterprise SDK](https://developers.arcgis.com/enterprise-sdk/))

```bash
# From the CDF app directory (created via `cdf createapp`)
cdf export databricks-geospatial-provider
cdf register databricks-geospatial-provider https://your-server/arcgis/admin TOKEN
```

> **Self-signed certs:** If ArcGIS Server uses a self-signed certificate, set `export NODE_TLS_REJECT_UNAUTHORIZED=0` or `export NODE_EXTRA_CA_CERTS=/path/to/cert.pem` ([Esri docs](https://developers.arcgis.com/enterprise-sdk/guide/custom-data-feeds/custom-data-feeds-troubleshooting/)). If you still get "Invalid token, ClientID does not match", use Option B — the CDF CLI sends tokens as `Authorization: Bearer` which can conflict with ArcGIS referer-based token validation.

**Option B: Admin REST API** (works with any ArcGIS Server)

```bash
# 1. Build the .cdpk — must include node_modules compiled on the target OS
#    (zip the provider directory on the ArcGIS Server machine after running npm install there)
cd nodejs-provider
zip -r databricks-geospatial-provider.cdpk \
  cdconfig.json package.json package-lock.json src/ node_modules/ \
  -x '*.env*' 'test/*' '*.md'

# 2. Upload the .cdpk
curl -k "https://your-server:6443/arcgis/admin/uploads/upload?token=TOKEN&f=json" \
  -H "Referer: https://your-server:6443" \
  -F "itemFile=@databricks-geospatial-provider.cdpk"
# Returns: {"status":"success","item":{"itemID":"i..."}}

# 3. Register using the itemID from step 2
curl -k "https://your-server:6443/arcgis/admin/services/types/customdataproviders/register?token=TOKEN&f=json" \
  -H "Referer: https://your-server:6443" \
  --data-urlencode "id=ITEM_ID_FROM_STEP_2"
```

> **After registration:** The `.cdpk` extraction replaces the provider directory contents. If you use a `.env` file for credentials, re-create it in the provider directory after registration.

---

## Creating Feature Services

You register the provider once, then create individual Feature Services. Each service points at one table via service parameters, and the presence of `lakebaseHost` determines which backend is used.

### Lakehouse Service Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `workspace` | No | env-default | Profile name from `.databrickscfg` (see [Multiple Databricks Workspaces](#multiple-databricks-workspaces)). If empty, uses `DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN` env vars. |
| `warehouseHttpPath` | No | `DATABRICKS_HTTP_PATH` env | SQL warehouse HTTP path (e.g. `/sql/1.0/warehouses/abc123`). Override per-service if you have multiple warehouses. |
| `tableName` | Yes | - | Fully qualified table name (`catalog.schema.table`) |
| `geometryColumn` | No | `geometry` | Name of the geometry column |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `geometryFormat` | No | auto-detect | `WKT`, `WKB`, `GEOJSON`, or `GEOMETRY` (native). Leave empty for auto-detect — set explicitly if the column is named `geometry` but stores WKT strings |
| `timeColumn` | No | - | Timestamp column for time-aware queries |
| `maxRecordCount` | No | `2000` | Max features returned per page (clients can request fewer) |
| `srid` | No | `4326` | EPSG SRID of the geometry column |

### Lakebase Service Parameters

Setting `lakebaseHost` routes a service to Lakebase instead of Lakehouse.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `workspace` | No | env-default | Profile name from `.databrickscfg` — see [Multiple Databricks Workspaces](#multiple-databricks-workspaces). Determines which workspace mints Lakebase OAuth tokens. |
| `lakebaseHost` | Yes | - | Lakebase instance hostname |
| `lakebasePort` | No | `5432` | PostgreSQL port |
| `lakebaseDatabase` | Yes | - | Database name |
| `lakebaseSchema` | No | `public` | PostgreSQL schema |
| `lakebaseTable` | Yes | - | Table name |
| `geometryColumn` | No | `geometry` | Geometry column (PostGIS native) |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `maxRecordCount` | No | `2000` | Max features returned per page (clients can request fewer) |
| `srid` | No | `4326` | EPSG SRID of the geometry column |
| `editingEnabled` | No | `false` | Set to `true` to enable applyEdits (also requires `capabilities: "Query,Editing"`) |

Editing is enabled at the provider level (`editingEnabled: true` in `cdconfig.json`). To actually expose editing on a service, set `"capabilities": "Query,Editing"` and `"editingEnabled": "true"` in the `createService` call. Lakebase services work for read-only use cases too — just set `"capabilities": "Query"`.

### Examples

Create services via the **Admin REST API** (`createService` endpoint). All service parameters from `cdconfig.json` must be included — use empty strings for parameters that don't apply.

> **Note:** There is no `cdf create-service` CLI command. Services are created through the Admin REST API or the ArcGIS Server Admin Directory UI. Services may be created in a STOPPED state — start them via the Admin API (`services/<name>.FeatureServer/start`) or the ArcGIS Server Manager UI.

#### Lakehouse service (read-only)

```bash
curl -k "https://your-server:6443/arcgis/admin/services/createService?token=TOKEN&f=json" \
  -H "Referer: https://your-server:6443" \
  --data-urlencode 'service={
    "serviceName": "MyCellTowers",
    "type": "FeatureServer",
    "capabilities": "Query",
    "provider": "CUSTOMDATA",
    "clusterName": "default",
    "minInstancesPerNode": 0, "maxInstancesPerNode": 0,
    "instancesPerContainer": 1,
    "configuredState": "STARTED",
    "properties": {"disableCaching": "true"},
    "jsonProperties": {
      "customDataProviderInfo": {
        "dataProviderName": "databricks-geospatial-provider",
        "serviceParameters": {
          "workspace": "",
          "warehouseHttpPath": "",
          "tableName": "catalog.schema.us_cell_towers",
          "geometryColumn": "geometry",
          "idField": "id",
          "geometryFormat": "WKT",
          "timeColumn": "",
          "lakebaseHost": "",
          "lakebasePort": "",
          "lakebaseDatabase": "",
          "lakebaseSchema": "",
          "lakebaseTable": "",
          "maxRecordCount": "2000",
          "srid": "4326",
          "editingEnabled": ""
        }
      }
    }
  }'
```

#### Lakebase service (read + write)

```bash
curl -k "https://your-server:6443/arcgis/admin/services/createService?token=TOKEN&f=json" \
  -H "Referer: https://your-server:6443" \
  --data-urlencode 'service={
    "serviceName": "CellTowersEditable",
    "type": "FeatureServer",
    "capabilities": "Query,Editing",
    "provider": "CUSTOMDATA",
    "clusterName": "default",
    "minInstancesPerNode": 0, "maxInstancesPerNode": 0,
    "instancesPerContainer": 1,
    "configuredState": "STARTED",
    "properties": {"disableCaching": "true"},
    "jsonProperties": {
      "customDataProviderInfo": {
        "dataProviderName": "databricks-geospatial-provider",
        "serviceParameters": {
          "workspace": "",
          "warehouseHttpPath": "",
          "tableName": "",
          "geometryColumn": "geometry",
          "idField": "id",
          "geometryFormat": "",
          "timeColumn": "",
          "lakebaseHost": "instance-xxx.database.cloud.databricks.com",
          "lakebasePort": "5432",
          "lakebaseDatabase": "geospatial",
          "lakebaseSchema": "public",
          "lakebaseTable": "cell_towers",
          "maxRecordCount": "2000",
          "srid": "4326",
          "editingEnabled": "true"
        }
      }
    }
  }'
```

### How Routing Works

The provider routes automatically — no configuration needed beyond service parameters:

```
getData(req) → lakebaseHost set? → YES: PostgreSQL path / NO: Databricks SQL path
editData(req) → Always Lakebase (Lakehouse is read-only)
```

---

## Multiple Databricks Workspaces

One CDF provider deployment can serve Feature Services from **multiple Databricks workspaces concurrently**. Each Feature Service registers a `workspace` service parameter naming a profile in `.databrickscfg`; the provider creates an independent connection pool per workspace and routes each request accordingly. Works for both Lakehouse and Lakebase.

> Each Feature Service hits exactly one workspace. Cross-workspace data federation (joining tables across workspaces in a single layer) is a Databricks-side problem — solve it via Unity Catalog federation or Delta Sharing, then point the service at the resulting view.

**You can skip this section** if you only have one Databricks workspace — env vars (`DATABRICKS_SERVER_HOSTNAME`, `DATABRICKS_HTTP_PATH`, `DATABRICKS_ACCESS_TOKEN`) define an implicit default profile and existing services keep working unchanged.

### `.databrickscfg` profiles

The provider reads `~/.databrickscfg` (or the path in `DATABRICKS_CONFIG_FILE`). Same format used by the Databricks CLI / Asset Bundles / dbt.

**PAT (Personal Access Token):**
```ini
[WORKSPACE_A]
host  = workspace-a.cloud.databricks.com
token = dapiXXXXXXXXXXXXXXXXX
```

**OAuth M2M (Service Principal — recommended for production):**
```ini
[WORKSPACE_B]
host          = workspace-b.cloud.databricks.com
client_id     = <service-principal-client-id>
client_secret = <service-principal-secret>
```

A profile must use one auth mode per workspace, not both. Mixing PAT and OAuth fields in the same profile errors at request time.

### Default profile resolution

When a service is created **without** a `workspace` parameter:

1. If a `[DEFAULT]` profile exists in `.databrickscfg`, it's used.
2. Otherwise, env vars (`DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN`) form a synthesized default.
3. If neither is set, the service errors at request time.

This keeps single-workspace deployments zero-config — env vars alone work, no `.databrickscfg` required.

### Two-workspace example

`.databrickscfg`:
```ini
[WORKSPACE_A]
host  = workspace-a.cloud.databricks.com
token = dapiXXXXXX

[WORKSPACE_B]
host          = workspace-b.cloud.databricks.com
client_id     = <sp-client-id>
client_secret = <sp-secret>
```

Two Feature Services on the same ArcGIS Server, one pointing at each workspace:

```json
// Service A → workspace A
"serviceParameters": {
  "workspace": "WORKSPACE_A",
  "warehouseHttpPath": "/sql/1.0/warehouses/abc123",
  "tableName": "catalog_a.geo.cells",
  "geometryColumn": "geometry",
  "idField": "id"
}

// Service B → workspace B (Lakebase)
"serviceParameters": {
  "workspace": "WORKSPACE_B",
  "lakebaseHost": "instance-bbb.database.cloud.databricks.com",
  "lakebasePort": "5432",
  "lakebaseDatabase": "geospatial",
  "lakebaseTable": "parcels",
  "geometryColumn": "geometry",
  "idField": "id"
}
```

For OAuth M2M Lakebase services, the provider exchanges `client_id`/`client_secret` at the workspace's `/oidc/v1/token` endpoint, then uses that token to call `/api/2.0/database/credentials` for the Lakebase OAuth token. Auto-refreshes ~5 minutes before expiry.

### Service principal setup (OAuth M2M)

Per workspace, in the Databricks account console:

1. Create a service principal (or reuse an existing one).
2. Assign the SP to the workspace.
3. Generate an OAuth secret — save the `client_id` and `client_secret`.
4. Grant the SP `CAN_USE` on the SQL warehouse.
5. For Lakebase: grant the SP database-level access on the Lakebase instance.

Reference: [Authorize service principal access with OAuth M2M](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m).

### `.databrickscfg` location on ArcGIS Server

ArcGIS Server runs as the `arcgis` OS user — `~/.databrickscfg` resolves to its home directory, which may not be set up. **Set `DATABRICKS_CONFIG_FILE` explicitly** in the init script:

```bash
# /opt/arcgis/server/usr/init_user_param.sh
export DATABRICKS_CONFIG_FILE=/opt/arcgis/server/usr/.databrickscfg
```

Then `chmod 600` and `chown arcgis:arcgis` the file. Restart ArcGIS Server.

### Verifying it works

Provider logs (append `/logz` to the app URL, or tail `/opt/arcgis/server/usr/logs/*/server/server-*.log`) will show distinct connection pools per workspace:

```
[Pool WORKSPACE_A|/sql/1.0/warehouses/abc123] Initialized (min: 2, max: 10)
[Pool WORKSPACE_B|/sql/1.0/warehouses/xyz789] Initialized (min: 2, max: 10)
```

### Multi-workspace troubleshooting

| Symptom | Likely cause |
|---|---|
| `Databricks workspace profile "X" not found` | Profile name typo (case-sensitive), wrong `DATABRICKS_CONFIG_FILE`, or file isn't readable by the `arcgis` user |
| `Profile [X] is ambiguous: defines both PAT and OAuth M2M` | Pick one — comment out either `token` OR `client_id`+`client_secret` |
| `OAuth M2M token endpoint returned 401` | SP `client_id`/`client_secret` is wrong/revoked, or SP isn't assigned to the workspace |
| `No Lakebase instance found with hostname X in workspace Y` | The `lakebaseHost` belongs to a different workspace than the `workspace` profile points at |
| `Source IP address X is blocked by Databricks IP ACL` | The ArcGIS Server's outbound IP isn't on that workspace's IP allowlist (workspace-level setting in Databricks, separate from CDF) |
| Single-workspace deployment regressed after upgrade | Env vars `DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN` missing from init script |

---

## Supported Operations

### Query (both backends)

Standard ArcGIS REST API query parameters:

- `where` — SQL WHERE clause filtering
- `objectIds` — Query specific features by ID
- `geometry` + `spatialRel` — Spatial queries (intersects, contains, within, crosses, overlaps, touches)
- `outFields` — Field selection
- `resultRecordCount` + `resultOffset` — Pagination
- `orderByFields` — Sorting
- `returnCountOnly` — Count queries
- `returnGeometry` — Include/exclude geometry

#### Lakehouse-only query features

- `returnDistinctValues` — Unique values
- `time` — Time range filter (requires `timeColumn` service parameter)
- Multiple geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)

### Editing (Lakebase only)

Full `applyEdits` support:

| Operation | Description |
|-----------|-------------|
| **Add** | Insert features with auto-generated IDs (`RETURNING id`) |
| **Update** | Modify attributes and/or geometry by OBJECTID |
| **Delete** | Remove features by OBJECTID (with per-row failure reporting) |

Transaction support: set `rollbackOnFailure=true` to wrap all operations in a single PostgreSQL transaction.

---

## Performance: Lakebase vs Lakehouse

Benchmark on 17M Overture Maps Places (Point features), warm averages (2 warm runs after 1 cold), measured end-to-end through ArcGIS Server REST API:

| Query Type | Lakebase | Lakehouse | Speedup |
|---|---|---|---|
| Spatial: city block (~1k features) | **120 ms** | 3,566 ms | **29.7x** |
| Spatial: DC metro (~2k features) | **152 ms** | 4,466 ms | **29.4x** |
| Spatial: LA metro (~2k features) | **130 ms** | 2,643 ms | **20.3x** |
| Spatial count (DC metro) | **185 ms** | 2,197 ms | **11.9x** |
| objectIds lookup (5 features) | **32 ms** | 357 ms | **11.2x** |
| Attribute: name LIKE '%Starbucks%' | **47 ms** | 499 ms | **10.6x** |
| Spatial + WHERE filter | **112 ms** | 928 ms | **8.3x** |
| COUNT (full table) | 636 ms | **150 ms** | Lakehouse 4.2x faster |

**Key takeaways:**
- **Lakebase is 8-30x faster** for spatial queries thanks to PostGIS GIST indexes (row-level R-tree pruning vs Lakehouse file-level scanning).
- **All Lakebase queries are sub-200ms** (32-185 ms), making the service fully interactive for map rendering and pan/zoom.
- **COUNT is the one case Lakehouse wins** — columnar statistics enable instant aggregation without scanning rows.

Config: Lakebase CU_4 with GIST index, Lakehouse Large Serverless SQL Warehouse (Z-ordered), ArcGIS Server 12.0 on m5.xlarge (us-east-1).

---

## Spatial Functions — Backend Differences

| Spatial Relation | Lakehouse (Databricks SQL) | Lakebase (PostGIS) |
|-----------------|----------------------------|---------------------|
| Intersects | `ST_Intersects` | `ST_Intersects` |
| Contains | `ST_Contains` | `ST_Contains` |
| Within | `ST_Within` | `ST_Within` |
| Touches | `ST_Touches` | `ST_Touches` |
| Overlaps | DE-9IM workaround (5 functions) | `ST_Overlaps` (native) |
| Crosses | DE-9IM workaround (7 functions) | `ST_Crosses` (native) |

Lakebase/PostGIS has all 6 spatial predicates natively with GIST index support. Databricks SQL lacks native `ST_Overlaps` and `ST_Crosses`, so the provider implements DE-9IM equivalents. See `geometry.js` for details.

---

## Geometry Support

All geometry types work: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.

**Lakehouse** supports multiple storage formats via `geometryFormat`:

| Format | Storage | Notes |
|--------|---------|-------|
| `WKT` | STRING column | `POINT(-77.03 38.90)` |
| `WKB` | BINARY column | Compact binary |
| `GEOJSON` | STRING column | JSON geometry objects |
| `GEOMETRY` | GEOMETRY column | Native Databricks type, best performance |

**Lakebase** uses native PostGIS geometry only — no format configuration needed.

---

## Environment Variables

Set these in your `.env` file, or in `init_user_param.sh` on ArcGIS Server. Per-table settings (`tableName`, `geometryColumn`, `idField`, etc.) are NOT set here — they're configured per-service via `createService`.

| Variable | Description |
|----------|-------------|
| **Databricks Connection (required for Lakehouse)** | |
| `DATABRICKS_SERVER_HOSTNAME` | Workspace hostname |
| `DATABRICKS_HTTP_PATH` | SQL Warehouse HTTP path |
| `DATABRICKS_ACCESS_TOKEN` | Personal Access Token (PAT) — generate at Settings > Developer > Access tokens |
| **Lakebase Connection (optional)** | |
| `LAKEBASE_PASSWORD` | OAuth token or password (auto-generated from PAT if omitted) |
| `LAKEBASE_USER` | Username (default: `databricks`) |
| `LAKEBASE_INSTANCE_NAME` | Instance name override (skips hostname→name lookup) |
| **Query Defaults** | |
| `DATABRICKS_MAX_RECORD_COUNT` | Max features per page (default: `2000`) |
| `DATABRICKS_QUERY_TIMEOUT` | Query timeout in ms (default: `120000`) |
| **Connection Pool Tuning** | |
| `DATABRICKS_POOL_MIN` / `DATABRICKS_POOL_MAX` | Lakehouse pool size (default: `2` / `10`) |
| `LAKEBASE_POOL_MIN` / `LAKEBASE_POOL_MAX` | Lakebase pool size (default: `2` / `10`) |
| `LAKEBASE_SSL_VERIFY` | Set to `true` to verify Lakebase SSL certs (default: `false`) |
| **Security** | |
| `ENABLE_USER_AUTH` | Set to `true` to require ArcGIS user authentication |
| `ENABLE_AUDIT_LOG` | Set to `true` to enable query audit logging |

---

## Working with Existing Tables

**Table already has a geometry column** — use it directly.

**Table has lat/lon columns** — create a view:
```sql
-- Lakehouse
CREATE VIEW catalog.schema.my_table_geo AS
SELECT *, ST_Point(longitude, latitude) AS geometry
FROM catalog.schema.my_table
WHERE latitude IS NOT NULL;

-- Lakebase
CREATE VIEW public.my_table_geo AS
SELECT *, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) AS geometry
FROM public.my_table
WHERE latitude IS NOT NULL;
```

---

## Tests

```bash
cd nodejs-provider
npm test
# 309 passing
```

## Table Requirements

**Lakehouse:**
- `idField` must be INT or BIGINT — ArcGIS uses it as OBJECTID
- Table name must be fully qualified: `catalog.schema.table`
- SQL Warehouse must be running (serverless adds 5–15s cold-start)
- Geometry must use `lon lat` order for WKT

**Lakebase:**
- `idField` must be an integer type with unique values
- Table must have a PostGIS geometry column
- Authentication: auto-generated from `DATABRICKS_ACCESS_TOKEN` (PAT), or set `LAKEBASE_PASSWORD` manually

**Both:**
- `idField` values must be unique and in range 0–2,147,483,647
- Network: if workspace has IP ACLs, ArcGIS Server IP must be allowlisted

## Troubleshooting

**Service won't start / "Provider not found" / "UNABLE_TO_GET_JNDI_NAME"**
- Verify the `.cdpk` was registered: check ArcGIS Server Manager > Site > Extensions
- Confirm `dataProviderName` matches the registered provider name exactly
- **Native module mismatch**: if you built `node_modules` on a different OS (e.g., macOS) than the ArcGIS Server (e.g., Linux/Windows), the provider will fail to load. Run `npm install` on the ArcGIS Server machine itself.
- Check ArcGIS Server logs: `<install>/server/usr/logs/`

**No data returned (empty features array)**
- Lakehouse: test the SQL Warehouse connection independently
- Lakebase: verify authentication works (auto-generated token via PAT, or check `LAKEBASE_PASSWORD` if set manually)
- Verify table name and schema are correct

**OBJECTID issues**
- The `idField` column must be an integer type
- Databricks BIGINT returns as string — provider casts via `Number()`

**Editing fails (Lakebase)**
- Verify `capabilities: "Query,Editing"` on the service (set during `createService`)
- Verify `lakebaseHost` is set in service parameters (editing only works via Lakebase)
- Check Lakebase auth: if using manual token, ensure `LAKEBASE_PASSWORD` is not expired
- ArcGIS Server 12.0+ required for `editData()` support

**Query is slow**
- Lakehouse: first query is slow due to warehouse cold-start
- Lakehouse: add Z-ordering: `OPTIMIZE table ZORDER BY (geometry_column)`
- Lakebase: add a GIST index: `CREATE INDEX ON table USING GIST (geometry)`

## Known Limitations

### Lakebase Synced Tables: GEOMETRY/GEOGRAPHY types not supported

Databricks [Synced Tables](https://docs.databricks.com/aws/en/oltp/instances/sync-data/sync-table) (reverse ETL from Unity Catalog to Lakebase) do not support GEOMETRY or GEOGRAPHY column types. The sync will fail if the source table contains these types.

**Workaround:** Store geometry as WKT strings (type STRING) in your source Delta Lake table. STRING maps to TEXT in PostgreSQL and syncs without issues. Once in Lakebase, convert to native PostGIS geometry at query time or via a generated column:

```sql
-- Option A: Convert at query time
SELECT *, ST_GeomFromText(geometry_wkt, 4326) AS geom FROM my_table;

-- Option B: Add a generated column after sync (requires a separate editable table)
ALTER TABLE my_table ADD COLUMN geom GEOMETRY(Point, 4326)
  GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt, 4326)) STORED;
CREATE INDEX ON my_table USING GIST (geom);
```

This limitation only affects Synced Tables (Databricks → Lakebase sync). Tables created directly in Lakebase with PostGIS geometry columns work fine — the provider's Lakebase backend uses native PostGIS geometry for all queries and editing.

**Full supported type mapping:** [Lakebase Instances docs](https://docs.databricks.com/aws/en/oltp/instances/sync-data/sync-table) | [Lakebase Projects docs](https://docs.databricks.com/aws/en/oltp/projects/reverse-etl)

## License

MIT
