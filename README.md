# ArcGIS Custom Data Feed Provider for Databricks

Official ArcGIS Enterprise SDK Custom Data Feed implementation for connecting Databricks tables with geospatial data to ArcGIS Server.

## What This Is

A **Node.js Custom Data Provider** that integrates Databricks with ArcGIS Server:

- ✅ Implements ArcGIS Enterprise SDK Custom Data Feed framework
- ✅ Registers with ArcGIS Server via `.cdpk` package
- ✅ Creates Feature Services managed by ArcGIS Server
- ✅ Uses native Databricks ST_* geospatial functions
- ✅ Supports all geometry types (Point, Polygon, LineString, Multi*)
- ✅ No data export needed - queries Databricks directly

## Architecture

```
ArcGIS Pro/Portal/JavaScript API Client
                ↓
    ArcGIS Server Feature Service
    (https://your-server/arcgis/rest/services/MyData/FeatureServer)
                ↓
    Custom Data Provider (Node.js - this application)
                ↓
    Databricks SQL Warehouse (with ST_* functions)
                ↓
           Delta Lake Tables
```

## How It Works

1. **You register this provider with ArcGIS Server**
2. **ArcGIS Server creates Feature Services** that use the provider
3. **Clients access through ArcGIS Server** (not directly to the provider)
4. **Provider queries Databricks** using ST_AsGeoJSON for geometry
5. **Returns GeoJSON** with ArcGIS metadata to the server
6. **ArcGIS Server serves** the data to clients

## Quick Start

See the **[nodejs-provider/README.md](nodejs-provider/README.md)** for complete documentation.

### Prerequisites

1. **ArcGIS Server 11.4+** installed
2. **ArcGIS Enterprise SDK** installed
3. **Node.js** (compatible version with your ArcGIS)
4. **Databricks SQL Warehouse** with geospatial functions

### Installation

```bash
cd nodejs-provider
npm install
```

### Configuration

Edit `nodejs-provider/src/databricks-config.json`:

```json
{
  "databricks": {
    "serverHostname": "your-workspace.cloud.databricks.com",
    "httpPath": "/sql/1.0/warehouses/your-warehouse-id",
    "accessToken": "dapi..."
  }
}
```

### Deploy to ArcGIS Server

```bash
# 1. Package the provider
cdf export databricks-geospatial-provider

# 2. Register with ArcGIS Server (via CLI or Admin UI)
cdf register databricks-geospatial-provider \
  https://your-server/arcgis/admin \
  YOUR_TOKEN \
  -s "MyDatabricksData" \
  --service-parameters "tableName:catalog.schema.restaurants,geometryColumn:location,idField:id"
```

### Access in ArcGIS Pro

1. **Add Data** → **Data from Path**
2. Enter: `https://your-server/arcgis/rest/services/MyDatabricksData/FeatureServer`
3. Layer appears on your map!

## Features

- ✅ All geometry types supported (Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon)
- ✅ Native Databricks ST_* functions (ST_Point, ST_AsGeoJSON, ST_Intersects, etc.)
- ✅ Service parameters for flexible configuration
- ✅ Query filtering via WHERE clauses
- ✅ Pagination support (resultOffset, resultRecordCount)
- ✅ Automatic field type inference
- ✅ GeoJSON with ArcGIS metadata

## Databricks Table Requirements

Tables must have:

1. **Geometry column** (GEOMETRY type)
2. **Unique ID field** (BIGINT recommended)

### Example Table Setup

```sql
-- Point geometry from lat/lon
CREATE TABLE catalog.schema.restaurants (
  restaurant_id BIGINT,
  name STRING,
  category STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
);

-- Polygon from WKT
CREATE TABLE catalog.schema.zones (
  zone_id BIGINT,
  zone_name STRING,
  boundary_wkt STRING,
  boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt))
);
```

## Service Parameters

When creating a Feature Service in ArcGIS Server, configure:

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `tableName` | Yes | Fully qualified table name | `catalog.schema.restaurants` |
| `geometryColumn` | No | Geometry column name (default: `geometry`) | `location` |
| `idField` | No | Unique ID field (default: `id`) | `restaurant_id` |

## Supported Query Parameters

The provider supports standard ArcGIS REST API query parameters:

- `where` - SQL WHERE clause for filtering
- `resultRecordCount` - Max records to return (default: 2000)
- `resultOffset` - Offset for pagination
- `outFields` - Fields to return
- `returnGeometry` - Include geometry

## Project Structure

```
esri-customdatafeed/
├── nodejs-provider/
│   ├── src/
│   │   ├── index.js              # Provider registration
│   │   ├── model.js              # Main getData() implementation
│   │   └── databricks-config.json # Databricks connection config
│   ├── package.json              # Node.js dependencies
│   ├── cdconfig.json             # Provider configuration
│   ├── test-local.js             # Local testing script
│   └── README.md                 # Complete documentation
├── docs/                         # Additional documentation
├── IMPLEMENTATION_SUMMARY.md     # Technical overview
└── README.md                     # This file
```

## Documentation

- **[nodejs-provider/README.md](nodejs-provider/README.md)** - Complete deployment guide
- **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** - Technical implementation details
- **[ArcGIS Enterprise SDK Docs](https://developers.arcgis.com/enterprise-sdk/)** - Official SDK documentation

## Testing

### Local Testing (Without ArcGIS Server)

```bash
cd nodejs-provider
node test-local.js
```

This tests the provider logic and Databricks connection without deploying to ArcGIS Server.

### With ArcGIS Server

1. Package and register the provider
2. Create a Feature Service
3. Test in ArcGIS Pro or via REST API

## Troubleshooting

### Provider Registration Fails
- Check Node.js version matches ArcGIS requirements
- Verify `.cdpk` file was created successfully

### No Data Returned
- Test Databricks connection manually
- Verify table name is fully qualified
- Check geometry column contains valid data:
  ```sql
  SELECT ST_AsText(location) FROM table LIMIT 1;
  ```

### Feature Service Fails to Start
- Verify service parameters are correct
- Check Databricks access token is valid
- Review ArcGIS Server logs

## Advanced Topics

### Connection Pooling
Implement connection pooling in the Model class for better performance with concurrent requests.

### Custom Symbology
Add `renderer` to the metadata in `buildMetadata()` method.

### Label Configuration
Add `labelingInfo` to the metadata for custom labels.

### Environment Variables
For production, use environment variables instead of config file:

```javascript
const connectOptions = {
  host: process.env.DATABRICKS_HOSTNAME,
  path: process.env.DATABRICKS_HTTP_PATH,
  token: process.env.DATABRICKS_TOKEN
};
```

## Support

- **GitHub Issues**: https://github.com/anandtrivedi/esri-customdatafeed/issues
- **ArcGIS Enterprise SDK**: https://developers.arcgis.com/enterprise-sdk/
- **Databricks SQL Connector**: https://docs.databricks.com/dev-tools/node-sql.html

## License

MIT License

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Test your changes
4. Submit a pull request

---

**For PDF documentation:** If you need to share ArcGIS documentation, save pages as PDFs and place them in the `docs/` directory. PDFs can be read and analyzed.
