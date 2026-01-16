# Databricks Geospatial Provider for ArcGIS Custom Data Feeds

This is a **proper ArcGIS Enterprise SDK Custom Data Provider** implemented in Node.js that connects Databricks tables with geospatial data to ArcGIS Server.

## What This Is

This is a **Custom Data Feed Provider** that:
- Runs as a Node.js service
- Gets **registered with ArcGIS Server** via `.cdpk` package file
- ArcGIS Server creates **Feature Services** that proxy to this provider
- Clients access data through **ArcGIS Server**, not directly

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

1. **ArcGIS Server 11.4+** installed and configured
2. **ArcGIS Enterprise SDK** installed on your development machine
3. **Node.js** (version compatible with your ArcGIS version - see [ArcGIS docs](https://developers.arcgis.com/enterprise-sdk/))
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

Edit `src/databricks-config.json`:

```json
{
  "databricks": {
    "serverHostname": "your-workspace.cloud.databricks.com",
    "httpPath": "/sql/1.0/warehouses/your-warehouse-id",
    "accessToken": "dapi..."
  }
}
```

**Security Note:** For production, use environment variables instead of storing tokens in the config file.

## Usage

### Testing Locally (Without ArcGIS Server)

You can test the provider logic locally before deploying to ArcGIS Server:

```bash
# Create a test script
node test-local.js
```

See `test-local.js` for an example of how to test the Model class directly.

### Deploy to ArcGIS Server

#### Step 1: Package the Provider

Using the CDF CLI tool:

```bash
# From parent directory containing this provider
cdf export databricks-geospatial-provider
```

This creates `databricks-geospatial-provider.cdpk`.

#### Step 2: Upload to ArcGIS Server

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

#### Step 3: Register the Provider

1. In ArcGIS Server Admin, go to: **services** → **types** → **customdataproviders**
2. Click **register**
3. Paste the item ID
4. Click **Register**

#### Step 4: Create a Feature Service

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

## Supported Query Parameters

The provider supports standard ArcGIS REST API query parameters:

- `where` - SQL WHERE clause for filtering
- `resultRecordCount` - Maximum records to return (default: 2000)
- `resultOffset` - Offset for pagination
- `outFields` - Fields to return (handled by framework)
- `returnGeometry` - Include geometry (handled by framework)

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

## File Structure

```
nodejs-provider/
├── src/
│   ├── index.js                    # Provider registration
│   ├── model.js                    # Main getData() implementation
│   └── databricks-config.json      # Databricks connection config
├── package.json                    # Node.js dependencies
├── cdconfig.json                   # Provider configuration
└── README.md                       # This file
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

## Differences from Flask Implementation

This repository also contains a **Flask REST API** implementation (`src/data_feed_provider.py`) which was an initial approach. Key differences:

| Aspect | Flask App | Node.js Provider (This) |
|--------|-----------|-------------------------|
| **Integration** | Standalone service | Registered with ArcGIS Server |
| **Access** | Clients access directly | Clients access via ArcGIS Server |
| **Management** | Separate deployment | Managed by ArcGIS Server |
| **Authentication** | Custom | ArcGIS authentication |
| **Deployment** | AWS/Docker/etc | Via ArcGIS Server |

**The Node.js provider is the proper ArcGIS Enterprise SDK approach.**

## Advanced Configuration

### Environment Variables

For production, use environment variables instead of config file:

```javascript
// In src/model.js
const connectOptions = {
  host: process.env.DATABRICKS_HOSTNAME || config.databricks.serverHostname,
  path: process.env.DATABRICKS_HTTP_PATH || config.databricks.httpPath,
  token: process.env.DATABRICKS_TOKEN || config.databricks.accessToken
};
```

### Connection Pooling

For better performance with multiple requests, implement connection pooling in the Model class.

### Custom Metadata

Enhance the `buildMetadata()` method to include:
- Custom symbology (`renderer`)
- Label definitions (`labelingInfo`)
- Field domains
- Templates for editing

## Support

- **ArcGIS Enterprise SDK Docs**: https://developers.arcgis.com/enterprise-sdk/
- **Databricks SQL Connector**: https://docs.databricks.com/dev-tools/node-sql.html
- **ArcGIS REST API**: https://developers.arcgis.com/rest/

## License

MIT License
