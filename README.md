# ArcGIS Custom Data Feed Provider for Databricks

A Node.js Custom Data Provider that connects Databricks tables to ArcGIS Server as Feature Services. Supports two backends:

| Backend | Engine | Best for | Capabilities |
|---------|--------|----------|-------------|
| **Lakehouse** | Databricks SQL Warehouse | Large-scale analytics, complex queries across massive tables | Query |
| **Lakebase** | Databricks Managed PostgreSQL + PostGIS | Low-latency serving (14–16ms), interactive maps, feature editing | Query + Editing |

Choose **Lakehouse** when you need to query large Delta Lake tables directly with full Databricks SQL power. Choose **Lakebase** when you need fast, interactive map performance or feature editing — Lakebase serves data at PostgreSQL speeds with native PostGIS spatial indexing.

One provider is registered once. Each Feature Service chooses its backend via service parameters.

## Architecture

![CDF Architecture — Databricks + Lakebase](cdf-architecture.png)

![Cell Towers served from Databricks Lakebase via ArcGIS Feature Service](screenshots/03-celltowers-editable-map.png)

## Project Structure

```
nodejs-provider/
  src/
    index.js                  # Provider entry point
    model.js                  # getData/editData/authorize — routes between backends
    databricks-config.json    # Databricks connection defaults
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
  test/                       # 285 unit tests (mocha + chai)
  cdconfig.json               # CDF provider manifest
  package.json
```

## Setup

Everything below runs on the **ArcGIS Server machine** (the provider is a Node.js plugin that runs inside ArcGIS Server's CDF runtime).

### Prerequisites

- ArcGIS Server 11.4+ with Custom Data Feeds (12.0+ for editing) — includes Node.js
- Databricks SQL Warehouse with geospatial functions enabled
- **Optional**: Databricks Lakebase instance — needed for low-latency serving or feature editing

### 1. Install dependencies

```bash
cd nodejs-provider
npm install    # Installs both @databricks/sql and pg drivers
```

### 2. Configure Databricks Connection (Lakehouse)

```bash
cp src/databricks-config.json.example src/databricks-config.json
```

Edit `databricks-config.json`:

```json
{
  "databricks": {
    "serverHostname": "your-workspace.cloud.databricks.com",
    "httpPath": "/sql/1.0/warehouses/your-warehouse-id",
    "accessToken": "dapi...",
    "srid": 4326,
    "maxRecordCount": 2000
  }
}
```

### 3. Configure Lakebase (optional)

Set the Lakebase password as an environment variable (OAuth token or role-based password):

```bash
export LAKEBASE_PASSWORD="your-oauth-token-or-password"
```

Lakebase connection details are set per-service (host, port, database) — see Service Parameters below.

### 4. Package and Register Provider

```bash
cdf export databricks-geospatial-provider
cdf register databricks-geospatial-provider https://your-server/arcgis/admin TOKEN
```

---

## Creating Feature Services

You register the provider once, then create individual Feature Services. Each service points at one table via service parameters, and the presence of `lakebaseHost` determines which backend is used.

There are two ways to create a service (pick either one):
- **CDF CLI** (`cdf create-service`) — simpler, recommended
- **Admin REST API** (`createService` endpoint) — useful for automation or when CDF CLI isn't available

### Lakehouse Service Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `tableName` | Yes | - | Fully qualified table name (`catalog.schema.table`) |
| `geometryColumn` | No | `geometry` | Name of the geometry column |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `geometryFormat` | No | auto-detect | `WKT`, `WKB`, `GEOJSON`, or `GEOMETRY` (native) |
| `timeColumn` | No | - | Timestamp column for time-aware queries |

### Lakebase Service Parameters

Setting `lakebaseHost` routes a service to Lakebase instead of Lakehouse.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `lakebaseHost` | Yes | - | Lakebase instance hostname |
| `lakebasePort` | No | `5432` | PostgreSQL port |
| `lakebaseDatabase` | Yes | - | Database name |
| `lakebaseSchema` | No | `public` | PostgreSQL schema |
| `lakebaseTable` | Yes | - | Table name |
| `geometryColumn` | No | `geometry` | Geometry column (PostGIS native) |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `editingEnabled` | No | `false` | Set to `true` to enable add/update/delete |

Lakebase services work for read-only use cases too — omit `editingEnabled` if you only need fast reads.

### Examples

#### Lakehouse service (CDF CLI)

```bash
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin TOKEN \
  -s "MyCellTowers" \
  --service-parameters "tableName:catalog.schema.us_cell_towers,geometryColumn:geometry,idField:id"
```

#### Lakebase service (CDF CLI)

```bash
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin TOKEN \
  -s "CellTowersEditable" \
  --capabilities "Query,Editing" \
  --service-parameters "lakebaseHost:instance-xxx.database.cloud.databricks.com,lakebaseDatabase:geospatial,lakebaseTable:cell_towers,idField:id,editingEnabled:true"
```

<details>
<summary>Same examples via Admin REST API (click to expand)</summary>

**Lakehouse:**
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
          "tableName": "catalog.schema.us_cell_towers",
          "geometryColumn": "geometry",
          "idField": "id",
          "geometryFormat": "GEOMETRY"
        }
      }
    }
  }'
```

**Lakebase:**
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
          "lakebaseHost": "instance-xxx.database.cloud.databricks.com",
          "lakebasePort": "5432",
          "lakebaseDatabase": "geospatial",
          "lakebaseSchema": "public",
          "lakebaseTable": "cell_towers",
          "geometryColumn": "geometry",
          "idField": "id",
          "editingEnabled": "true"
        }
      }
    }
  }'
```
</details>

### How Routing Works

The provider routes automatically — no configuration needed beyond service parameters:

```
getData(req) → lakebaseHost set? → YES: PostgreSQL path / NO: Databricks SQL path
editData(req) → Always Lakebase (Lakehouse is read-only)
```

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

Lakehouse connection can be configured via `databricks-config.json` (Step 2 above) **or** environment variables — env vars take precedence. On ArcGIS Server, env vars are typically set in `init_user_param.sh`. Lakebase credentials are env-var only.

| Variable | Description |
|----------|-------------|
| `DATABRICKS_SERVER_HOSTNAME` | Workspace hostname (overrides config file) |
| `DATABRICKS_HTTP_PATH` | SQL Warehouse HTTP path (overrides config file) |
| `DATABRICKS_ACCESS_TOKEN` | Personal access token (overrides config file) |
| `LAKEBASE_PASSWORD` | Lakebase OAuth token or password (required for Lakebase) |
| `LAKEBASE_USER` | Lakebase username (default: `databricks`) |
| `DATABRICKS_MAX_RECORD_COUNT` | Max features per page (default: `2000`) |
| `ENABLE_AUDIT_LOG` | Set to `true` to enable query audit logging |
| `ENABLE_USER_AUTH` | Set to `true` to require ArcGIS user authentication |

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
# 285 passing (175 Lakehouse + 110 Lakebase)
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
- `LAKEBASE_PASSWORD` must be set (OAuth token expires ~1hr — refresh via CLI)

**Both:**
- `idField` values must be unique and in range 0–2,147,483,647
- Network: if workspace has IP ACLs, ArcGIS Server IP must be allowlisted

## Troubleshooting

**Service won't start / "Provider not found"**
- Verify the `.cdpk` was registered: check ArcGIS Server Manager > Site > Extensions
- Confirm `dataProviderName` matches the registered provider name exactly
- Check ArcGIS Server logs: `<install>/server/usr/logs/`

**No data returned (empty features array)**
- Lakehouse: test the SQL Warehouse connection independently
- Lakebase: verify `LAKEBASE_PASSWORD` is set and not expired
- Verify table name and schema are correct

**OBJECTID issues**
- The `idField` column must be an integer type
- Databricks BIGINT returns as string — provider casts via `Number()`

**Editing fails (Lakebase)**
- Verify `editingEnabled: true` in service parameters
- Verify `capabilities: "Query,Editing"` on the service
- Check `LAKEBASE_PASSWORD` is valid (refresh: `databricks database generate-database-credential`)
- ArcGIS Server 12.0+ required for `editData()` support

**Query is slow**
- Lakehouse: first query is slow due to warehouse cold-start
- Lakehouse: add Z-ordering: `OPTIMIZE table ZORDER BY (geometry_column)`
- Lakebase: add a GIST index: `CREATE INDEX ON table USING GIST (geometry)`

## License

MIT
