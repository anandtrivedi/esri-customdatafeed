# Databricks Custom Data Provider for ArcGIS

Professional Node.js Custom Data Provider for ArcGIS Enterprise SDK that connects Databricks SQL Warehouse with geospatial data to ArcGIS Server.

## Overview

This provider follows official ArcGIS Enterprise SDK patterns and implements sophisticated query handling inspired by Esri reference implementations.

### Key Features

- ✅ **Modular Architecture** - Organized helper modules for translate, sql, filters, and geometry operations
- ✅ **Full Query Support** - Handles all ArcGIS REST API query parameters (where, objectIds, geometry, spatial relations, pagination, sorting, etc.)
- ✅ **Native Databricks ST_* Functions** - Uses ST_AsGeoJSON, ST_Intersects, ST_Contains, ST_Within, ST_Transform, ST_Union_Agg, etc.
- ✅ **All Geometry Types** - Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
- ✅ **Extent Calculation** - Automatic extent calculation for metadata using ST_Envelope and ST_Union_Agg
- ✅ **Spatial Reference Support** - Handles CRS transformation between different SRID values
- ✅ **Exceeded Transfer Limit Detection** - Properly handles pagination limits
- ✅ **Service Parameters** - Configurable table name, geometry column, and ID field per Feature Service
- ✅ **Connection Pooling** - Reusable Databricks connections with configurable pool size
- ✅ **Security** - SQL injection protection, optional user auth, and audit logging
- ✅ **Multiple Geometry Formats** - WKT, WKB, GeoJSON, and native GEOMETRY columns

## Architecture

```
ArcGIS Pro/Portal Client
         ↓
ArcGIS Server Feature Service
  (https://your-server/arcgis/rest/services/MyDatabricksData/FeatureServer)
         ↓
Custom Data Provider (Node.js - this application)
         ↓
Databricks SQL Warehouse
```

## Prerequisites

1. **ArcGIS Server 11.1+** (11.4+ for editing support)
2. **ArcGIS Enterprise SDK** installed on your development machine
3. **Node.js 20.17.0** (ships with ArcGIS Server 11.4)
4. **Databricks SQL Warehouse** with:
   - Tables containing geometry columns
   - Personal access token with SELECT permissions
   - ST_* geospatial functions enabled

## Installation

### 1. Install Dependencies

```bash
cd nodejs-provider
npm install
```

### 2. Configure Databricks Connection

Create a `.env` file (recommended) or edit `src/databricks-config.json`:

```bash
# .env
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi...
```

See the [Environment Variables](#environment-variables) section for all options.

## Deploy to ArcGIS Server

### Step 1: Package the Provider

Using the CDF CLI tool:

```bash
# From parent directory containing this provider
cdf export databricks-geospatial-provider
```

This creates `databricks-geospatial-provider.cdpk`.

### Step 2: Upload to ArcGIS Server

**Option A: Via ArcGIS Server Administrator Directory**

1. Navigate to: `https://your-server/arcgis/admin`
2. Click **uploads** → **upload**
3. Upload the `.cdpk` file
4. Copy the returned **item ID**

**Option B: Via CDF CLI** (ArcGIS 11.3+)

```bash
cdf register databricks-geospatial-provider \
  https://your-server/arcgis/admin \
  YOUR_TOKEN
```

### Step 3: Register the Provider

1. In ArcGIS Server Admin, go to: **services** → **types** → **customdataproviders**
2. Click **register**
3. Paste the item ID
4. Click **Register**

### Step 4: Create a Feature Service

**Via ArcGIS Server Admin Directory:**

1. Go to: **services** → **createService**
2. Paste this JSON (customize the service parameters):

```json
{
  "serviceName": "DatabricksRestaurants",
  "type": "FeatureServer",
  "description": "Databricks restaurant locations",
  "capabilities": "Query",
  "provider": "CUSTOMDATA",
  "clusterName": "default",
  "minInstancesPerNode": 0,
  "maxInstancesPerNode": 0,
  "configuredState": "STARTED",
  "jsonProperties": {
    "customDataProviderInfo": {
      "forwardUserIdentity": false,
      "dataProviderName": "databricks-geospatial-provider",
      "serviceParameters": {
        "tableName": "catalog.schema.restaurants",
        "geometryColumn": "location",
        "idField": "restaurant_id"
      }
    }
  }
}
```

3. Click **Create**

**Via CDF CLI:**

```bash
cdf register databricks-geospatial-provider \
  https://your-server/arcgis/admin \
  YOUR_TOKEN \
  -s "DatabricksRestaurants" \
  --service-parameters "tableName:catalog.schema.restaurants,geometryColumn:location,idField:restaurant_id"
```

## Service Parameters

When creating a Feature Service, you configure these parameters:

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `tableName` | Yes | Fully qualified table name | `catalog.schema.restaurants` |
| `geometryColumn` | No | Name of geometry column | `location` (default: `geometry`) |
| `idField` | No | Unique ID field | `restaurant_id` (default: `id`) |

## Supported Query Operations

| Operation | Supported | Notes |
|-----------|-----------|-------|
| Query with WHERE | ✅ | Full SQL WHERE clause support |
| Query by ObjectIDs | ✅ | Filter by specific IDs |
| Spatial Query | ✅ | Intersects, Contains, Within, Crosses, Overlaps, Touches |
| Pagination | ✅ | resultRecordCount + resultOffset |
| Sorting | ✅ | ORDER BY support via orderByFields |
| Field Selection | ✅ | outFields parameter |
| Count Only | ✅ | returnCountOnly |
| IDs Only | ✅ | returnIdsOnly |
| Distinct Values | ✅ | returnDistinctValues |
| Extent | ✅ | Automatic calculation via ST_Union_Agg |
| CRS Transformation | ✅ | Via ST_Transform |

## Databricks Table Requirements

Your Databricks tables must have:

1. **Geometry Column**: A `GEOMETRY` type column with geospatial data
2. **ID Field**: A unique identifier field (preferably BIGINT)

### Example Table Setup

```sql
-- Option 1: Point geometry from lat/lon
CREATE TABLE catalog.schema.restaurants (
  restaurant_id BIGINT,
  name STRING,
  category STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
);

-- Option 2: Geometry from WKT
CREATE TABLE catalog.schema.zones (
  zone_id BIGINT,
  zone_name STRING,
  boundary_wkt STRING,
  boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt))
);
```

## Accessing the Feature Service

After deploying, your Feature Service URL will be:

```
https://your-server/arcgis/rest/services/DatabricksRestaurants/FeatureServer
```

### In ArcGIS Pro

1. **Add Data** → **Data from Path**
2. Enter the Feature Service URL
3. The layer appears on your map

### In ArcGIS JavaScript API

```javascript
const layer = new FeatureLayer({
  url: "https://your-server/arcgis/rest/services/DatabricksRestaurants/FeatureServer/0"
});
map.add(layer);
```

## Troubleshooting

### Provider Not Registering

- Check Node.js version matches ArcGIS requirements
- Verify `.cdpk` file was created successfully
- Check ArcGIS Server logs

### No Data Returned

- Test Databricks connection manually
- Verify `tableName` is fully qualified (`catalog.schema.table`)
- Check geometry column contains valid data:
  ```sql
  SELECT ST_AsText(location) FROM catalog.schema.restaurants LIMIT 1;
  ```

### Feature Service Fails to Start

- Check service parameters are correct
- Verify Databricks access token is valid
- Review ArcGIS Server logs at: `/arcgis/admin/logs`

## Project Structure

```
nodejs-provider/
├── src/
│   ├── index.js              # Provider registration
│   ├── model.js              # Main getData() implementation
│   ├── databricks-config.json # Databricks connection config
│   └── modules/              # Helper modules
│       ├── index.js          # Module exports
│       ├── translate.js      # GeoJSON conversion
│       ├── sql.js            # SQL query builder
│       ├── filters.js        # filtersApplied generator
│       ├── geometry.js       # Geometry queries and transformations
│       ├── geometryFormat.js # WKT/WKB/GeoJSON/GEOMETRY detection
│       ├── sanitize.js       # SQL injection prevention
│       ├── connectionPool.js # Databricks connection pool
│       └── auditLog.js       # Security audit logging
├── test/                     # Unit tests (mocha + chai)
│   ├── sanitize.test.js
│   ├── sql.test.js
│   ├── geometry.test.js
│   ├── geometryFormat.test.js
│   ├── filters.test.js
│   ├── translate.test.js
│   └── model.test.js
├── package.json
└── README.md
```

## Supported Geometry Types

All Databricks geometry types are supported:

| Databricks/GeoJSON | Esri Type |
|--------------------|-----------|
| Point | Point |
| MultiPoint | MultiPoint |
| LineString | Polyline |
| MultiLineString | Polyline |
| Polygon | Polygon |
| MultiPolygon | Polygon |

## Environment Variables

For production, use environment variables instead of the config file (`.env` or system env):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABRICKS_SERVER_HOSTNAME` | Yes | Workspace hostname |
| `DATABRICKS_HTTP_PATH` | Yes | SQL Warehouse HTTP path |
| `DATABRICKS_ACCESS_TOKEN` | Yes | Personal access token |
| `DATABRICKS_SRID` | No | Spatial reference (default: 4326) |
| `DATABRICKS_MAX_RECORD_COUNT` | No | Max records per page (default: 2000) |
| `DATABRICKS_DEFAULT_TABLE` | No | Default table name |
| `ENABLE_USER_AUTH` | No | ArcGIS user auth (`true`/`false`) |
| `ENABLE_SIMPLE_AUTH` | No | Bearer token auth (`true`/`false`) |
| `ENABLE_AUDIT_LOG` | No | Audit logging (`true`/`false`) |

## Testing

```bash
# Unit tests (175 tests)
npm test

# Local integration test (requires Databricks credentials)
cd ../testing && node test-server.js
# Then open http://localhost:3000/viewer.html
```

## Support

- **ArcGIS Enterprise SDK Docs**: https://developers.arcgis.com/enterprise-sdk/
- **Databricks SQL Connector**: https://docs.databricks.com/dev-tools/node-sql.html
- **ArcGIS REST API**: https://developers.arcgis.com/rest/

## License

MIT License
