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

## Performance: Lakebase vs Lakehouse (with Z-ordering)

Benchmark on 17M Overture Maps Places (Point features), second pass (warm), measured end-to-end through ArcGIS Server REST API. Lakehouse tested before and after `OPTIMIZE ... ZORDER BY (geometry)`:

| Query Type | Lakebase | Lakehouse | Lakehouse + Z-order | Z-order gain | LB vs best Lakehouse |
|---|---|---|---|---|---|
| Spatial: city block (1.1k features) | **364 ms** | 6,976 ms | 4,232 ms | 39% faster | **11.6x** |
| Map Viewer PBF tile (DC metro) | **417 ms** | 4,393 ms | 3,604 ms | 18% faster | **8.6x** |
| Spatial: DC metro (2k features) | **547 ms** | 5,999 ms | 3,972 ms | 34% faster | **7.3x** |
| Spatial: wide region 10x10° | **432 ms** | 969 ms | 2,624 ms | slower | **6.1x** |
| Spatial: LA metro (2k features) | **574 ms** | 5,784 ms | 2,961 ms | 49% faster | **5.2x** |
| Spatial count only (DC metro) | **303 ms** | 2,155 ms | 1,541 ms | 28% faster | **5.1x** |
| objectIds lookup (5 features) | **160 ms** | 520 ms | 531 ms | — | **3.3x** |
| Attribute: name LIKE '%Starbucks%' | **169 ms** | 423 ms | 428 ms | — | **2.5x** |
| Spatial + WHERE filter | **526 ms** | 1,853 ms | 1,199 ms | 35% faster | **2.3x** |
| COUNT (full table) | 829 ms | 289 ms | 305 ms | — | Lakehouse faster |

**Key findings:**

- **Z-ordering helps Lakehouse 18-49% on focused spatial queries** by clustering nearby features in the same Parquet files, enabling file-level data skipping. It's a free optimization (no infrastructure change).
- **Z-ordering hurts wide-region queries** (969 ms → 2,624 ms) because spreading data across 15 Z-ordered files increases I/O without pruning benefit when most files match.
- **Lakebase is still 2.3-11.6x faster than Z-ordered Lakehouse.** The gap is architectural: Z-ordering provides file-level pruning (skip Parquet files), while PostGIS GIST indexes provide row-level pruning via R-tree (jump directly to matching rows).
- **All Lakebase queries are sub-second** (160-829 ms), making the service fully interactive for map rendering and user interaction. Z-ordered Lakehouse still exceeds 1s on most spatial queries.
- **COUNT is the one case Lakehouse wins** — columnar statistics enable instant aggregation without scanning rows.

**Configuration:**
- Lakebase: CU_4, PostGIS 3.3, GIST spatial index on geometry column
- Lakehouse: Large Serverless SQL Warehouse, Delta table with ZORDER BY (geometry)
- ArcGIS Server: 12.0 on EC2 t3.xlarge (us-east-1)

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
