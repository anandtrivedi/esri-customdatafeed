# ArcGIS Custom Data Feed Provider for Databricks

Professional ArcGIS Enterprise SDK Custom Data Feed Provider for connecting Databricks SQL Warehouse with geospatial data to ArcGIS Server.

## What This Is

A **Node.js Custom Data Provider** built with Esri's best practices:

- ✅ **Modular Architecture** - Helper modules for translate, sql, filters, and geometry operations
- ✅ **Full Query Support** - All ArcGIS REST API query parameters (where, objectIds, spatial queries, pagination, sorting, etc.)
- ✅ **Native Databricks ST_* Functions** - ST_AsGeoJSON, ST_Intersects, ST_Contains, ST_Transform, ST_Union_Agg, etc.
- ✅ **All Geometry Types** - Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
- ✅ **Automatic Extent Calculation** - Using ST_Envelope and ST_Union_Agg
- ✅ **CRS Transformation Support** - Handle different spatial reference systems
- ✅ **Proper Pagination** - Exceeded transfer limit detection
- ✅ **Registers with ArcGIS Server** via `.cdpk` package
- ✅ **No Data Export** - Queries Databricks directly

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

## 📖 Documentation

**Getting Started:**
- **[QUICK_SETUP_GUIDE.md](QUICK_SETUP_GUIDE.md)** - ⚡ **Start here!** 5-minute setup for common scenarios
- **[GEOMETRY_PATTERNS.md](GEOMETRY_PATTERNS.md)** - Complete guide for all geometry types (Points, Lines, Polygons)

**Examples & Testing:**
- **[testing/setup-vessel-tracking.sql](testing/setup-vessel-tracking.sql)** - Real-world examples for vessel tracking data
- **[testing/TEST_WITH_DATABRICKS.md](testing/TEST_WITH_DATABRICKS.md)** - Testing guide with real Databricks data

**Advanced:**
- **[PERFORMANCE.md](PERFORMANCE.md)** - Performance optimization strategies
- **[nodejs-provider/README.md](nodejs-provider/README.md)** - Provider implementation details

## Quick Start

### Option 1: Test Locally First (Recommended)

**No ArcGIS Server required - test with mock data:**

```bash
cd testing
npm install
node test-server.js
# Server starts at http://localhost:3000
# Open http://localhost:3000/viewer.html in browser
```

### Option 2: Deploy to ArcGIS Server

**Prerequisites:**
- ArcGIS Server 11.4+
- ArcGIS Enterprise SDK CLI: `npm install -g @esri/arcgis-enterprise-sdk-cli`
- Node.js 16+
- Databricks SQL Warehouse with ST_* functions

**1. Configure:**
Edit `nodejs-provider/src/databricks-config.json`:
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

**2. Package and Deploy:**
```bash
cd nodejs-provider
npm install
cdf export databricks-geospatial-provider
cdf register databricks-geospatial-provider https://your-server/arcgis/admin YOUR_TOKEN
```

**3. Create Feature Service:**
```bash
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "RestaurantsService" \
  --service-parameters "tableName:catalog.schema.restaurants,geometryColumn:location,idField:restaurant_id"
```

**4. Access:**
- **ArcGIS Pro**: Add Data → Data from Path → `https://your-server/arcgis/rest/services/RestaurantsService/FeatureServer`
- **REST API**: `https://your-server/arcgis/rest/services/RestaurantsService/FeatureServer/0/query?where=1=1&f=geojson`
- **JavaScript API**: Use the Feature Service URL in your web map

## Features

### Query Operations
- ✅ **WHERE clause filtering** - Full SQL support
- ✅ **ObjectIDs filtering** - Query specific features by ID
- ✅ **Spatial queries** - Intersects, Contains, Within, Crosses, Overlaps, Touches
- ✅ **Pagination** - resultRecordCount + resultOffset with exceeded transfer limit detection
- ✅ **Sorting** - ORDER BY via orderByFields
- ✅ **Field selection** - outFields parameter
- ✅ **Count queries** - returnCountOnly
- ✅ **ID queries** - returnIdsOnly
- ✅ **Distinct values** - returnDistinctValues

### Geospatial
- ✅ **All geometry types** - Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
- ✅ **Native ST_* functions** - ST_AsGeoJSON, ST_Intersects, ST_Contains, ST_Within, ST_Transform, etc.
- ✅ **Extent calculation** - Automatic via ST_Envelope and ST_Union_Agg
- ✅ **CRS transformation** - Support for different spatial reference systems

### Configuration
- ✅ **Service parameters** - Configurable table, geometry column, and ID field per Feature Service
- ✅ **Multiple tables** - Create multiple Feature Services from different tables
- ✅ **Automatic field inference** - Field types detected from data

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
│   │   ├── databricks-config.json # Databricks connection config
│   │   └── modules/              # Helper modules (Esri pattern)
│   │       ├── index.js          # Module exports
│   │       ├── translate.js      # GeoJSON conversion
│   │       ├── sql.js            # SQL query builder
│   │       ├── filters.js        # filtersApplied generator
│   │       └── geometry.js       # Geometry queries and transformations
│   ├── package.json              # Node.js dependencies
│   ├── cdconfig.json             # Provider configuration
│   ├── test-local.js             # Local testing script
│   └── README.md                 # Complete documentation
├── IMPLEMENTATION_SUMMARY.md     # Technical overview
└── README.md                     # This file
```

## Deployment Options

### ArcGIS Server (Production)

**Best for:** Enterprise ArcGIS environments with ArcGIS Server

1. Package provider as `.cdpk` file
2. Register with ArcGIS Server
3. Create Feature Services via ArcGIS Server Manager
4. Clients access through ArcGIS Server URLs
5. Integrated with ArcGIS authentication and permissions

See Quick Start above for deployment commands.

### Docker Container (Alternative)

**Best for:** Containerized deployments, cloud platforms

While the provider is designed for ArcGIS Server integration, you can run the test server in Docker for development/testing:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY testing/ ./testing/
COPY nodejs-provider/ ./nodejs-provider/
WORKDIR /app/testing
RUN npm install
EXPOSE 3000
CMD ["node", "test-server.js"]
```

```bash
docker build -t databricks-provider-test .
docker run -p 3000:3000 databricks-provider-test
```

**Note:** Docker deployment is for testing only. Production deployments should use ArcGIS Server integration.

### Kubernetes (For ArcGIS Server Pods)

If running ArcGIS Server in Kubernetes, the provider runs as part of the ArcGIS Server pod after registration. No separate deployment needed.

---

## Documentation

- **[nodejs-provider/README.md](nodejs-provider/README.md)** - Detailed provider documentation
- **[testing/README.md](testing/README.md)** - Testing and demo setup
- **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** - Technical implementation details
- **[PERFORMANCE.md](PERFORMANCE.md)** - Format requirements and performance optimization
- **[ArcGIS Enterprise SDK Docs](https://developers.arcgis.com/enterprise-sdk/)** - Official SDK documentation

## Testing

The `testing/` directory provides a complete test environment separate from the production provider.

### Quick Start (No Databricks Required)

```bash
cd testing
npm install
node test-server.js
```

Server starts at `http://localhost:3000` with mock data enabled.

**Test via URL:**
```bash
curl "http://localhost:3000/query?f=geojson"
```

**View on Map:**
Open `http://localhost:3000/viewer.html` in your browser

**Run Test Suite:**
```bash
sh test-requests.sh
```

### With Real Databricks Data

1. Create sample tables in Databricks (run `sample-data.sql`)
2. Configure Databricks connection in `nodejs-provider/src/databricks-config.json`
3. Set `USE_MOCK_DATA = false` in `test-server.js`
4. Restart test server

### Test with ArcGIS Server

After testing locally, deploy to ArcGIS Server for production use (see Deployment section below)

## Databricks Geospatial Functions

This provider leverages Databricks' extensive ST_* geospatial functions:

### Supported Functions
- **Geometry Creation**: ST_Point, ST_LineString, ST_Polygon, ST_GeomFromText, ST_GeomFromWKB, ST_GeomFromGeoJSON
- **Format Conversion**: ST_AsText, ST_AsGeoJSON, ST_AsBinary
- **Spatial Relationships**: ST_Intersects, ST_Contains, ST_Within, ST_Crosses, ST_Overlaps, ST_Touches
- **Spatial Operations**: ST_Buffer, ST_Envelope, ST_Union, ST_Union_Agg, ST_Intersection, ST_Difference
- **Measurements**: ST_Distance, ST_Area, ST_Length
- **Transformations**: ST_Transform (CRS conversion)
- **H3 Support**: H3_LatLngToCell, H3_CellToLatLng, H3_CellToPolygon (for hexagonal binning)

Full reference: https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-st-geospatial-functions

### H3 Integration Example

```sql
-- Create H3 binned aggregation table
CREATE TABLE catalog.schema.taxi_h3_bins AS
SELECT
  H3_LatLngToCell(latitude, longitude, 8) as h3_cell,
  COUNT(*) as trip_count,
  AVG(fare_amount) as avg_fare,
  H3_CellToPolygon(H3_LatLngToCell(latitude, longitude, 8)) as cell_geometry
FROM catalog.schema.taxi_trips
GROUP BY H3_LatLngToCell(latitude, longitude, 8);

-- Use as Feature Service with cell_geometry column
```

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
- **Databricks Geospatial Functions**: https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-st-geospatial-functions

## License

MIT License

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Test your changes
4. Submit a pull request
