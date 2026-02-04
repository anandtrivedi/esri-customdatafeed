# ArcGIS Custom Data Feed Provider for Databricks

Professional ArcGIS Enterprise SDK Custom Data Feed Provider for connecting Databricks SQL Warehouse with geospatial data to ArcGIS Server.

## What This Is

A **Node.js Custom Data Provider** built with Esri's best practices:

- ✅ **Modular Architecture** - Helper modules for translate, sql, filters, and geometry operations
- ✅ **Full Query Support** - All ArcGIS REST API query parameters (where, objectIds, spatial queries, pagination, sorting, etc.)
- ✅ **Native Databricks ST_* Functions** - ST_AsGeoJSON, ST_Intersects, ST_Contains, ST_Transform, ST_Union_Agg, etc.
- ✅ **All Geometry Types** - Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
- ✅ **Works with Existing Tables** - Create views/materialized views without modifying source tables
- ✅ **Performance Optimized** - Z-ordering, liquid clustering, H3 aggregation for large datasets
- ✅ **Connection Pooling** - Efficient connection management for serverless/classic warehouses
- ✅ **Security Features** - User authentication, authorization, audit logging
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
           Delta Lake Tables/Views
```

## 📖 Documentation

**⚡ Start Here:**
- **[README.md](README.md)** (this file) - Quick start, features overview, deployment options

**Working with Data:**
- **[WORKING_WITH_EXISTING_TABLES.md](WORKING_WITH_EXISTING_TABLES.md)** - How to use existing Databricks tables (views, materialized views, H3 aggregation, performance optimization)

**Implementation Details:**
- **[IMPLEMENTATION_VERIFICATION.md](IMPLEMENTATION_VERIFICATION.md)** - Verification that implementation follows official Esri ArcGIS Enterprise SDK patterns (includes detailed feature verification)
- **[nodejs-provider/README.md](nodejs-provider/README.md)** - Provider code details and API reference

**Security:**
- **[SECURITY_FEATURES.md](SECURITY_FEATURES.md)** - Authentication, authorization, and audit logging guide (NEW!)

**Future Enhancements:**
- **[OPTIONAL_FEATURES.md](OPTIONAL_FEATURES.md)** - Features NOT yet implemented but could be added in the future (groupByFields, time animation, editing)

**Testing:**
- **[testing/](testing/)** - Complete test environment with mock data, test scripts, and interactive map viewer

---

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

Copy the example config and edit with your Databricks connection info:
```bash
cd nodejs-provider/src
cp databricks-config.json.example databricks-config.json
# Edit databricks-config.json with your Databricks credentials
```

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

**Important:** This config contains ONLY connection info. You do NOT need to list all your tables here. Table names, geometry columns, and ID fields are specified per Feature Service (see step 3).

**2. Package and Deploy:**
```bash
cd nodejs-provider
npm install
cdf export databricks-geospatial-provider
cdf register databricks-geospatial-provider https://your-server/arcgis/admin YOUR_TOKEN
```

**3. Create Feature Services (One Per Table):**

Create a separate Feature Service for each Databricks table:

```bash
# Service 1: Restaurants (geometry column: location)
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "RestaurantsService" \
  --service-parameters "tableName:catalog.schema.restaurants,geometryColumn:location,idField:restaurant_id"

# Service 2: Vessels (geometry column: vessel_position)
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "VesselsService" \
  --service-parameters "tableName:catalog.schema.vessels,geometryColumn:vessel_position,idField:mmsi"

# Service 3: Zones (geometry column: boundary)
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "ZonesService" \
  --service-parameters "tableName:catalog.schema.zones,geometryColumn:boundary,idField:zone_id"
```

**Note:** Each table can have a different geometry column name. You specify the column name when creating the Feature Service.

**4. Access:**

Each Feature Service has its own URL:

- **Restaurants Service**: `https://your-server/arcgis/rest/services/RestaurantsService/FeatureServer`
- **Vessels Service**: `https://your-server/arcgis/rest/services/VesselsService/FeatureServer`
- **Zones Service**: `https://your-server/arcgis/rest/services/ZonesService/FeatureServer`

Use in ArcGIS Pro, REST API, or JavaScript API like any other Feature Service.

---

## Working With Your Existing Tables

Most use cases involve **existing Databricks tables**. You have several options depending on your table structure and performance needs:

### ✅ Table Already Has GEOMETRY Column
```bash
# Use directly - just configure the service parameters
table=catalog.schema.my_table
geometryColumn=location
idField=id
```

**Optimization:**
```sql
OPTIMIZE catalog.schema.my_table ZORDER BY (location);
```

### ✅ Table Has lat/lon Columns (No Geometry)

**Option 1: Regular View (Real-time, < 1M rows)**
```sql
CREATE OR REPLACE VIEW catalog.schema.my_table_spatial AS
SELECT *, ST_Point(longitude, latitude) as location
FROM catalog.schema.my_table
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
```

**Option 2: Materialized View (Best Performance, > 1M rows)**
```sql
CREATE MATERIALIZED VIEW catalog.schema.my_table_spatial_mv AS
SELECT *, ST_Point(longitude, latitude) as location
FROM catalog.schema.my_table
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

OPTIMIZE catalog.schema.my_table_spatial_mv ZORDER BY (location);
```

### ✅ Table Has WKT/WKB Geometry Strings

```sql
-- Create view with geometry conversion
CREATE MATERIALIZED VIEW catalog.schema.my_table_spatial AS
SELECT *, ST_GeomFromText(geometry_wkt) as geometry
FROM catalog.schema.my_table
WHERE geometry_wkt IS NOT NULL;

OPTIMIZE catalog.schema.my_table_spatial ZORDER BY (geometry);
```

### ✅ Large Table (> 10M rows) - Use H3 Aggregation

```sql
-- Aggregate millions of points into thousands of hexagons
CREATE TABLE catalog.schema.my_table_h3_hexagons AS
SELECT
  H3_LatLngToCell(latitude, longitude, 7) as h3_cell,
  COUNT(*) as point_count,
  H3_CellToPolygon(H3_LatLngToCell(latitude, longitude, 7)) as cell_polygon,
  -- Add aggregated metrics
  AVG(temperature) as avg_temperature
FROM catalog.schema.my_table
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
GROUP BY H3_LatLngToCell(latitude, longitude, 7);

OPTIMIZE catalog.schema.my_table_h3_hexagons ZORDER BY (cell_polygon);
```

**📖 For detailed guidance, see [WORKING_WITH_EXISTING_TABLES.md](WORKING_WITH_EXISTING_TABLES.md)**

---

## Features

### Query Operations
- ✅ **WHERE clause filtering** - Full SQL support
- ✅ **ObjectIDs filtering** - Query specific features by ID
- ✅ **Spatial queries** - Intersects, Contains, Within, Crosses, Overlaps, Touches
- ✅ **Pagination** - resultRecordCount + resultOffset with exceeded transfer limit detection
- ✅ **Sorting** - ORDER BY via orderByFields (e.g., `orderByFields=name ASC, speed DESC`)
- ✅ **Distinct values** - returnDistinctValues for unique field values (dropdown filters, legends)
- ✅ **Time filtering** - Query by time range with `time` parameter (Unix milliseconds)
- ✅ **Field selection** - outFields parameter
- ✅ **Count queries** - returnCountOnly

### Geospatial
- ✅ **All geometry types** - Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
- ✅ **Native ST_* functions** - ST_AsGeoJSON, ST_Intersects, ST_Contains, ST_Within, ST_Transform, etc.
- ✅ **Extent calculation** - Automatic via ST_Envelope and ST_Union_Agg
- ✅ **CRS transformation** - Support for different spatial reference systems
- ✅ **H3 hexagonal binning** - For large datasets (millions → thousands)

### Configuration
- ✅ **Service parameters** - Configurable table, geometry column, and ID field per Feature Service
- ✅ **Multiple tables** - Create multiple Feature Services from different tables
- ✅ **Different geometry column names** - Each table can have its own column name

---

## Configuration Model

### One Provider, Multiple Feature Services

**Key Concept:** You register the provider ONCE, then create MULTIPLE Feature Services (one per table).

```
┌─────────────────────────────────────────┐
│  databricks-config.json                 │
│  (Connection info only)                 │
│  - Workspace URL                        │
│  - Warehouse HTTP path                  │
│  - Access token                         │
└─────────────────────────────────────────┘
                    ↓
        One provider registered
                    ↓
    ┌───────────────┴───────────────┬───────────────┐
    ↓                               ↓               ↓
Feature Service 1            Feature Service 2   Feature Service 3
RestaurantsService           VesselsService      ZonesService
- table: restaurants         - table: vessels    - table: zones
- geom: location             - geom: vessel_pos  - geom: boundary
- id: restaurant_id          - id: mmsi          - id: zone_id
```

### What Goes Where

**In `databricks-config.json` (connection level):**
- ✅ Databricks workspace URL
- ✅ SQL warehouse HTTP path
- ✅ Access token
- ✅ Global settings (SRID, max record count)
- ❌ **NOT** table names
- ❌ **NOT** geometry column names
- ❌ **NOT** ID field names

**Per Feature Service (table level):**
- ✅ Table name (e.g., `catalog.schema.restaurants`)
- ✅ Geometry column name (e.g., `location`, `vessel_position`, `boundary`)
- ✅ ID field name (e.g., `restaurant_id`, `mmsi`, `zone_id`)

### Can Tables Have Different Geometry Column Names?

**YES!** Each Feature Service specifies its own geometry column:

| Feature Service | Table | Geometry Column | ID Field |
|----------------|-------|-----------------|----------|
| RestaurantsService | `catalog.schema.restaurants` | `location` | `restaurant_id` |
| VesselsService | `catalog.schema.vessels` | `vessel_position` | `mmsi` |
| ZonesService | `catalog.schema.zones` | `boundary` | `zone_id` |
| SensorsService | `catalog.schema.sensors` | `location` | `sensor_id` |

**Or they can all use the same name:**

| Feature Service | Table | Geometry Column | ID Field |
|----------------|-------|-----------------|----------|
| RestaurantsService | `catalog.schema.restaurants` | `geometry` | `id` |
| VesselsService | `catalog.schema.vessels` | `geometry` | `id` |
| ZonesService | `catalog.schema.zones` | `geometry` | `id` |

Both approaches work. You decide per table.

---

## Service Parameters

When creating each Feature Service, specify:

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `tableName` | Yes | Fully qualified table/view name | `catalog.schema.my_table_spatial` |
| `geometryColumn` | No | Geometry column name (default: `geometry`) | `location` |
| `idField` | No | Unique ID field (default: `id`) | `sensor_id` |

---

## Supported Query Parameters

Standard ArcGIS REST API query parameters:

- `where` - SQL WHERE clause for filtering (e.g., `where=vessel_type='cargo'`)
- `geometry` - Spatial filter (bbox, polygon) (e.g., `geometry=-125,32,-117,42`)
- `spatialRel` - Spatial relationship (intersects, contains, within)
- `resultRecordCount` - Max records to return (default: 2000)
- `resultOffset` - Offset for pagination
- `outFields` - Fields to return (e.g., `outFields=mmsi,vessel_name,sog`)
- `returnGeometry` - Include geometry (default: true)
- `returnCountOnly` - Return count instead of features
- `orderByFields` - Sort results (e.g., `orderByFields=vessel_name ASC, sog DESC`)
- `returnDistinctValues` - Return unique values (e.g., `returnDistinctValues=true&outFields=vessel_type`)
- `time` - Time range filter in Unix milliseconds (e.g., `time=1705489200000,1705492800000`)

---

## Project Structure

```
esri-customdatafeed/
├── README.md                               # This file
├── WORKING_WITH_EXISTING_TABLES.md         # Comprehensive guide for existing tables
├── nodejs-provider/
│   ├── src/
│   │   ├── index.js                        # Provider registration
│   │   ├── model.js                        # Main getData() implementation
│   │   ├── databricks-config.json.example  # Config template
│   │   └── modules/                        # Helper modules
│   │       ├── translate.js                # GeoJSON conversion
│   │       ├── sql.js                      # SQL query builder
│   │       ├── filters.js                  # filtersApplied generator
│   │       └── geometry.js                 # Geometry operations
│   ├── package.json
│   ├── cdconfig.json                       # Provider configuration
│   └── README.md                           # Provider documentation
└── testing/
    ├── test-server.js                      # Standalone test server
    ├── viewer.html                         # Interactive map viewer
    ├── test-requests.sh                    # Test suite
    └── setup-vessel-tracking.sql           # Real-world examples
```

---

## Deployment Options

### ArcGIS Server (Production)

**Best for:** Enterprise ArcGIS environments

1. Package provider as `.cdpk` file
2. Register with ArcGIS Server
3. Create Feature Services via ArcGIS Server Manager
4. Clients access through ArcGIS Server URLs
5. Integrated with ArcGIS authentication and permissions

See Quick Start above for deployment commands.

### Docker Container (Testing/Development)

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

---

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

---

## Performance Optimization

### For Small Tables (< 1M rows)
- Regular views work fine
- Add Z-ordering if needed: `OPTIMIZE table ZORDER BY (geometry_column)`

### For Medium Tables (1M - 10M rows)
- Use materialized views
- Add Z-ordering
- Update statistics: `ANALYZE TABLE table COMPUTE STATISTICS FOR ALL COLUMNS`

### For Large Tables (> 10M rows)
- Use H3 aggregation for visualization (reduces millions → thousands)
- Consider partitioning by date/region
- Use liquid clustering (Databricks Runtime 13.3+)

### Example Optimization
```sql
-- Create optimized materialized view
CREATE MATERIALIZED VIEW catalog.schema.optimized_view AS
SELECT sensor_id, ST_Point(lon, lat) as location, temperature
FROM catalog.schema.sensors
WHERE lat IS NOT NULL AND lon IS NOT NULL;

-- Z-order by geometry
OPTIMIZE catalog.schema.optimized_view ZORDER BY (location);

-- Update statistics
ANALYZE TABLE catalog.schema.optimized_view
COMPUTE STATISTICS FOR ALL COLUMNS;

-- Schedule refresh (hourly/daily)
REFRESH MATERIALIZED VIEW catalog.schema.optimized_view;
```

**📖 For complete optimization strategies, see [WORKING_WITH_EXISTING_TABLES.md](WORKING_WITH_EXISTING_TABLES.md)**

---

## Testing

### Quick Test (No Databricks Required)

```bash
cd testing
npm install
node test-server.js
# Open http://localhost:3000/viewer.html
```

### Test with Real Databricks Data

1. Configure Databricks connection in `nodejs-provider/src/databricks-config.json`
2. Set `USE_MOCK_DATA = false` in `test-server.js`
3. Restart test server

### Test Queries

```bash
# Basic query
curl "http://localhost:3000/query?\
table=catalog.schema.table_name&\
geometryColumn=location&\
idField=id&\
resultRecordCount=10&\
f=geojson"

# Count query
curl "http://localhost:3000/query?\
table=catalog.schema.table_name&\
geometryColumn=location&\
idField=id&\
returnCountOnly=true&\
f=json"

# Spatial filter
curl "http://localhost:3000/query?\
table=catalog.schema.table_name&\
geometryColumn=location&\
idField=id&\
geometry=-180,-90,180,90&\
spatialRel=esriSpatialRelIntersects&\
f=geojson"

# Sort by field (NEW)
curl "http://localhost:3000/query?\
table=catalog.schema.table_name&\
geometryColumn=location&\
idField=id&\
orderByFields=vessel_name ASC, sog DESC&\
f=geojson"

# Get distinct values for dropdown filters (NEW)
curl "http://localhost:3000/query?\
table=catalog.schema.table_name&\
geometryColumn=location&\
idField=id&\
returnDistinctValues=true&\
returnGeometry=false&\
outFields=vessel_type&\
f=json"

# Time range filter (NEW)
curl "http://localhost:3000/query?\
table=catalog.schema.table_name&\
geometryColumn=location&\
idField=id&\
time=1705489200000,1705492800000&\
f=geojson"
```

---

## Troubleshooting

### Provider Registration Fails
- Check Node.js version matches ArcGIS requirements
- Verify `.cdpk` file was created successfully

### No Data Returned
- Test Databricks connection manually
- Verify table name is fully qualified (catalog.schema.table)
- Check geometry column contains valid data:
  ```sql
  SELECT ST_AsText(location) FROM table LIMIT 1;
  ```

### Query is Slow
1. Add Z-ordering: `OPTIMIZE table ZORDER BY (geometry_column)`
2. Use materialized view instead of regular view
3. Consider H3 aggregation if > 10M rows
4. Check if ST_Point() is computed on every query (use materialized view to pre-compute)

### Feature Service Fails to Start
- Verify service parameters are correct
- Check Databricks access token is valid
- Review ArcGIS Server logs

---

## Support

- **GitHub Issues**: https://github.com/anandtrivedi/esri-customdatafeed/issues
- **ArcGIS Enterprise SDK**: https://developers.arcgis.com/enterprise-sdk/
- **Databricks SQL Connector**: https://docs.databricks.com/dev-tools/node-sql.html
- **Databricks Geospatial Functions**: https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-st-geospatial-functions

---

## License

MIT License

---

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Test your changes
4. Submit a pull request
