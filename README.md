# ArcGIS Custom Data Feed Provider for Databricks

A Node.js Custom Data Provider that connects Databricks SQL Warehouse tables to ArcGIS Server as Feature Services. Queries Databricks directly using native `ST_*` geospatial functions — no data export or ETL required.

## Architecture

```
ArcGIS Pro / Portal / JS API
        |
ArcGIS Server Feature Service
        |
Custom Data Provider (this repo)
        |
Databricks SQL Warehouse (ST_* functions)
        |
Delta Lake Tables
```

One provider is registered once. Multiple Feature Services are created from it, each pointing to a different Databricks table.

## Project Structure

```
nodejs-provider/
  src/
    index.js              # Provider entry point
    model.js              # Main getData/authorize implementation
    databricks-config.json  # Databricks connection settings
    modules/
      sql.js              # SQL query builder
      translate.js        # Row-to-GeoJSON conversion
      geometry.js         # Spatial filter construction
      geometryFormat.js   # WKT/WKB/GeoJSON format handling
      filters.js          # filtersApplied metadata
      connectionPool.js   # Databricks connection pooling
      sanitize.js         # SQL injection prevention
      auditLog.js         # Query audit logging
  test/                   # 175 unit tests (mocha + chai)
  cdconfig.json           # CDF provider manifest
  package.json
```

## Setup

### Prerequisites

- ArcGIS Server 11.4+ with Custom Data Feeds
- Node.js 16+
- Databricks SQL Warehouse with geospatial functions enabled

### 1. Configure Databricks Connection

```bash
cd nodejs-provider/src
cp databricks-config.json.example databricks-config.json
```

Edit `databricks-config.json` with your workspace credentials:

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

### 2. Package and Register Provider

```bash
cd nodejs-provider
npm install
cdf export databricks-geospatial-provider
cdf register databricks-geospatial-provider https://your-server/arcgis/admin TOKEN
```

### 3. Create Feature Services

Each Databricks table gets its own Feature Service with table-specific parameters:

```bash
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin TOKEN \
  -s "MyService" \
  --service-parameters "tableName:catalog.schema.my_table,geometryColumn:geometry,idField:id,geometryFormat:WKT"
```

#### Service Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `tableName` | Yes | - | Fully qualified table name (`catalog.schema.table`) |
| `geometryColumn` | No | `geometry` | Name of the geometry column |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `geometryFormat` | No | auto-detect | `WKT`, `WKB`, `GEOJSON`, or `GEOMETRY` (native) |
| `timeColumn` | No | - | Timestamp column for time-aware queries |

#### Alternative: Admin REST API Registration

If the `cdf` CLI isn't available, you can register services directly via the ArcGIS Server Admin REST API:

```bash
# 1. Get an admin token
curl -k "https://your-server:6443/arcgis/admin/generateToken" \
  -d "username=siteadmin&password=YOUR_PASSWORD&client=referer&referer=https://your-server:6443&f=json"

# 2. Create a Feature Service
curl -k "https://your-server:6443/arcgis/admin/services/createService?token=TOKEN&f=json" \
  -H "Referer: https://your-server:6443" \
  --data-urlencode 'service={
    "serviceName": "MyService",
    "type": "FeatureServer",
    "description": "My Databricks table",
    "capabilities": "Query",
    "provider": "CUSTOMDATA",
    "clusterName": "default",
    "minInstancesPerNode": 0,
    "maxInstancesPerNode": 0,
    "instancesPerContainer": 1,
    "maxWaitTime": 60,
    "maxStartupTime": 300,
    "maxIdleTime": 1800,
    "maxUsageTime": 600,
    "loadBalancing": "ROUND_ROBIN",
    "isolationLevel": "HIGH",
    "configuredState": "STARTED",
    "recycleInterval": 24,
    "recycleStartTime": "00:00",
    "keepAliveInterval": 1800,
    "private": false,
    "isDefault": false,
    "properties": {"disableCaching": "true"},
    "jsonProperties": {
      "customDataProviderInfo": {
        "forwardUserIdentity": false,
        "dataProviderName": "databricks-geospatial-provider",
        "serviceParameters": {
          "idField": "id",
          "geometryColumn": "geometry",
          "geometryFormat": "WKT",
          "tableName": "catalog.schema.my_table"
        }
      }
    },
    "extensions": [],
    "datasets": []
  }'
```

## Supported Query Operations

Standard ArcGIS REST API query parameters:

- `where` — SQL WHERE clause filtering
- `objectIds` — Query specific features by ID
- `geometry` + `spatialRel` — Spatial queries (intersects, contains, within, crosses, overlaps, touches)
- `outFields` — Field selection
- `resultRecordCount` + `resultOffset` — Pagination
- `orderByFields` — Sorting (e.g. `name ASC, speed DESC`)
- `returnCountOnly` — Count queries
- `returnDistinctValues` — Unique values
- `returnGeometry` — Include/exclude geometry
- `time` — Time range filter (Unix milliseconds)

## Geometry Support

All geometry types work: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.

Input formats supported via `geometryFormat` service parameter:

| Format | Storage | Performance | Notes |
|--------|---------|-------------|-------|
| `WKT` | STRING column | Good | `POINT(-77.03 38.90)` — easiest to generate |
| `WKB` | BINARY column | Good | Compact binary format |
| `GEOJSON` | STRING column | Good | JSON geometry objects |
| `GEOMETRY` | GEOMETRY column | Best | Native Databricks type, supports Z-ordering |

The provider converts all formats to GeoJSON via Databricks `ST_*` functions at query time.

`ST_Overlaps` and `ST_Crosses` are not natively available in Databricks SQL. The provider implements these using DE-9IM equivalent expressions built from available functions (`ST_Intersects`, `ST_Covers`, `ST_Touches`, `ST_Dimension`, etc.). See `geometry.js` for details.

## Working with Existing Tables

**Table already has a geometry column** — use it directly.

**Table has lat/lon columns** — create a view:
```sql
CREATE VIEW catalog.schema.my_table_geo AS
SELECT *, ST_Point(longitude, latitude) AS geometry
FROM catalog.schema.my_table
WHERE latitude IS NOT NULL;
```

**Large tables (>1M rows)** — use a materialized view + Z-ordering:
```sql
CREATE MATERIALIZED VIEW catalog.schema.my_table_geo AS
SELECT *, ST_Point(longitude, latitude) AS geometry
FROM catalog.schema.my_table;

OPTIMIZE catalog.schema.my_table_geo ZORDER BY (geometry);
```

## Tests

```bash
cd nodejs-provider
npm test
# 175 passing
```

## Live Demo Services

Deployed on ArcGIS Server 12.0 with Databricks (Pubsec-FE workspace):

| Service | Geometry | Rows | URL |
|---------|----------|------|-----|
| CellTowers | Point | 50,000 | `.../CellTowers/FeatureServer/0` |
| USHighways | Polyline | 10,000 | `.../USHighways/FeatureServer/0` |
| LandParcels | Polygon | 5,000 | `.../LandParcels/FeatureServer/0` |
| DISACandidates | Point | 14,327 | `.../DISACandidates/FeatureServer/0` |

Example queries against the live services:

```bash
# Basic query with fields
curl "https://SERVER/arcgis/rest/services/CellTowers/FeatureServer/0/query?\
where=carrier='Verizon'&outFields=id,tower_name,city,state&resultRecordCount=10&f=json"

# Count
curl "https://SERVER/arcgis/rest/services/USHighways/FeatureServer/0/query?\
where=route_type='Interstate'&returnCountOnly=true&f=json"

# Spatial query (envelope around DC)
curl "https://SERVER/arcgis/rest/services/LandParcels/FeatureServer/0/query?\
geometry={\"xmin\":-78,\"ymin\":38,\"xmax\":-76,\"ymax\":40}\
&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects\
&outFields=*&resultRecordCount=10&f=json"
```

## Table Requirements

Your Databricks table must meet these requirements or the provider will fail silently:

- **`idField` must be an integer** (INT or BIGINT). ArcGIS uses it as the OBJECTID. String IDs won't be recognized — features will appear but without a working OBJECTID, and queries like `objectIds=1,2,3` will fail.
- **`idField` values must be unique** and in the range 0–2,147,483,647.
- **Geometry must use `lon lat` order** for WKT (e.g. `POINT(-77.03 38.90)`, not `POINT(38.90 -77.03)`).
- **Table name must be fully qualified**: `catalog.schema.table` (3-part name).
- **SQL Warehouse must be running** — serverless warehouses auto-start but add 5–15s cold-start latency on first query.
- **Network access** — If the Databricks workspace has IP ACLs enabled, the ArcGIS Server's public IP must be allowlisted.

## Troubleshooting

**Service won't start / "Provider not found"**
- Verify the `.cdpk` was registered: check ArcGIS Server Manager > Site > Extensions
- Confirm `dataProviderName` in the service JSON matches the registered provider name exactly
- Check ArcGIS Server logs: `<install>/server/usr/logs/`

**No data returned (empty features array)**
- Test the Databricks connection independently — run a query in the SQL Warehouse console
- Verify `tableName` is fully qualified (`catalog.schema.table`, not just `table`)
- Check that the geometry column has non-null values: `SELECT COUNT(*) FROM table WHERE geometry IS NOT NULL`

**Geometry not rendering / missing from response**
- Verify `geometryFormat` matches the actual column type (WKT string vs native GEOMETRY)
- For WKT, check coordinate order is `lon lat`: `SELECT geometry FROM table LIMIT 1`
- Ensure WKT is valid: `SELECT ST_IsValid(ST_GeomFromText(geometry)) FROM table LIMIT 1`

**OBJECTID issues (features show but can't be selected/queried by ID)**
- The `idField` column must be INT or BIGINT — check with `DESCRIBE table`
- Databricks returns BIGINT as strings; the provider casts via `Number()` but values above 2^53 will lose precision

**Query is slow**
- First query is slow due to warehouse cold-start — subsequent queries will be faster
- Add Z-ordering: `OPTIMIZE table ZORDER BY (geometry_column)`
- Use a materialized view instead of a regular view for computed geometry
- Reduce `resultRecordCount` — default 2000 is reasonable, 10K+ will be slow

**Spatial queries return nothing**
- Verify `inSR` matches your geometry's CRS (default: 4326/WGS84)
- Check the envelope coordinates make sense for your data's extent
- Test the extent via the service metadata: `https://server/arcgis/rest/services/MyService/FeatureServer/0?f=json` — look at the `extent` field

## License

MIT
