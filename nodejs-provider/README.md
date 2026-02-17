# Databricks Custom Data Provider for ArcGIS

Node.js Custom Data Provider for ArcGIS Enterprise SDK that connects Databricks to ArcGIS Server as Feature Services. Supports two backends:

| Backend | Engine | Best for | Capabilities |
|---------|--------|----------|-------------|
| **Lakehouse** | Databricks SQL Warehouse | Large-scale analytics, complex queries across massive tables | Query |
| **Lakebase** | Databricks Managed PostgreSQL + PostGIS | Low-latency serving (14-16ms), interactive maps, feature editing | Query + Editing |

See the [root README](../README.md) for full architecture details, service creation examples, and backend comparison.

## Prerequisites

- ArcGIS Server 11.4+ with Custom Data Feeds (12.0+ for editing)
- Node.js 16+
- **Lakehouse**: Databricks SQL Warehouse with geospatial functions enabled
- **Lakebase**: Databricks Lakebase instance with PostGIS

## Installation

```bash
cd nodejs-provider
npm install    # Installs both @databricks/sql and pg drivers
```

## Configuration

### Lakehouse (Databricks SQL)

Create a `.env` file or edit `src/databricks-config.json`:

```bash
# .env
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi...
```

### Lakebase (PostgreSQL + PostGIS)

Set the Lakebase password as an environment variable:

```bash
export LAKEBASE_PASSWORD="your-oauth-token-or-password"
```

Lakebase connection details (host, port, database) are set per-service via service parameters.

## Deploy to ArcGIS Server

### Step 1: Package the Provider

```bash
cdf export databricks-geospatial-provider
```

### Step 2: Register

**Via CDF CLI** (ArcGIS 11.3+):

```bash
cdf register databricks-geospatial-provider \
  https://your-server/arcgis/admin \
  YOUR_TOKEN
```

**Via Admin Directory:**

1. Navigate to: `https://your-server/arcgis/admin`
2. Click **uploads** > **upload**, upload the `.cdpk` file
3. Go to **services** > **types** > **customdataproviders** > **register**
4. Paste the item ID and click **Register**

### Step 3: Create Feature Services

See the [root README](../README.md#creating-feature-services) for Lakehouse and Lakebase service creation examples with full parameter tables.

## Project Structure

```
nodejs-provider/
  src/
    index.js                  # Provider entry point
    model.js                  # getData/editData/authorize - routes between backends
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
  test/                       # 275 unit tests (mocha + chai)
  cdconfig.json               # CDF provider manifest
  package.json
```

## Supported Operations

### Query (both backends)

| Operation | Supported | Notes |
|-----------|-----------|-------|
| Query with WHERE | Yes | Full SQL WHERE clause support |
| Query by ObjectIDs | Yes | Filter by specific IDs |
| Spatial Query | Yes | Intersects, Contains, Within, Crosses, Overlaps, Touches |
| Pagination | Yes | resultRecordCount + resultOffset |
| Sorting | Yes | ORDER BY support via orderByFields |
| Field Selection | Yes | outFields parameter |
| Count Only | Yes | returnCountOnly |
| IDs Only | Yes | returnIdsOnly |
| Distinct Values | Yes | Lakehouse only |
| Time Filter | Yes | Lakehouse only (requires `timeColumn` service parameter) |
| Extent | Yes | Automatic calculation via ST_Union_Agg (Lakehouse) |
| CRS Transformation | Yes | Via ST_Transform (Lakehouse) |

### Editing (Lakebase only)

| Operation | Description |
|-----------|-------------|
| **Add** | Insert features with auto-generated IDs (`RETURNING id`) |
| **Update** | Modify attributes and/or geometry by OBJECTID |
| **Delete** | Remove features by OBJECTID (with per-row failure reporting) |

Transaction support: set `rollbackOnFailure=true` to wrap all operations in a single PostgreSQL transaction.

## Performance: Lakebase vs Lakehouse

Benchmark on 17M Overture Maps Places (Point features), second pass (warm), measured end-to-end through ArcGIS Server REST API:

| Query Type | Lakebase | Lakehouse | Speedup |
|---|---|---|---|
| Spatial: city block (1.1k features) | **348 ms** | 6,976 ms | **20x** |
| Map Viewer PBF tile | **367 ms** | 4,393 ms | **12x** |
| Spatial: DC metro (2k features) | **521 ms** | 5,999 ms | **11.5x** |
| Spatial: LA metro (2k features) | **634 ms** | 5,784 ms | **9.1x** |
| Spatial count only (DC metro) | **304 ms** | 2,155 ms | **7x** |
| Spatial + WHERE filter (restaurants in DC) | **478 ms** | 1,853 ms | **3.9x** |
| objectIds lookup (5 features) | **176 ms** | 520 ms | **3x** |
| Spatial: wide region 10x10 degrees (2k features) | **344 ms** | 969 ms | **2.8x** |
| Attribute: name LIKE '%Starbucks%' | **163 ms** | 423 ms | **2.6x** |
| COUNT (full table) | 848 ms | 289 ms | Lakehouse faster |

All Lakebase queries are sub-second (163-848 ms), making the service fully interactive for map rendering. Spatial queries benefit from PostGIS GIST indexes — Lakehouse performs a full table scan with `ST_Intersects` on 17M rows for every spatial query. COUNT is the one case Lakehouse wins, leveraging columnar statistics.

Config: Lakebase CU_4 with GIST index, Lakehouse Large Serverless, ArcGIS Server 12.0 on EC2.

## Environment Variables

| Variable | Backend | Required | Description |
|----------|---------|----------|-------------|
| `DATABRICKS_SERVER_HOSTNAME` | Lakehouse | Yes | Workspace hostname |
| `DATABRICKS_HTTP_PATH` | Lakehouse | Yes | SQL Warehouse HTTP path |
| `DATABRICKS_ACCESS_TOKEN` | Lakehouse | Yes | Personal access token |
| `LAKEBASE_PASSWORD` | Lakebase | Yes | OAuth token or role-based password |
| `LAKEBASE_USER` | Lakebase | No | Username (default: `databricks`) |
| `DATABRICKS_SRID` | Both | No | Coordinate system (default: `4326`) |
| `DATABRICKS_MAX_RECORD_COUNT` | Both | No | Max features per page (default: `2000`) |
| `ENABLE_AUDIT_LOG` | Both | No | Enable query audit logging |
| `ENABLE_USER_AUTH` | Both | No | Require ArcGIS user authentication |

## Testing

```bash
# 275 unit tests (175 Lakehouse + 100 Lakebase)
npm test
```

## License

MIT
