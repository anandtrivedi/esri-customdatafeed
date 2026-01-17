# Geometry Patterns and Best Practices

Complete guide for using the Databricks Custom Data Provider with different geometry types and data formats.

## Table of Contents
1. [Point Geometries](#point-geometries)
2. [Line Geometries](#line-geometries)
3. [Polygon Geometries](#polygon-geometries)
4. [Performance Best Practices](#performance-best-practices)
5. [Query Examples](#query-examples)

---

## Point Geometries

### Option 1: Native GEOMETRY Column (Most Efficient) ⭐

**When to use:** New tables or when you can modify existing tables

**Performance:** ⭐⭐⭐⭐⭐ (Best)
- Indexed for spatial queries
- Smallest storage footprint
- Fastest query execution

**Table Setup:**
```sql
CREATE TABLE catalog.schema.locations (
  id BIGINT,
  name STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
);

-- Insert data
INSERT INTO catalog.schema.locations (id, name, latitude, longitude)
VALUES
  (1, 'HQ', 37.7749, -122.4194),
  (2, 'Warehouse', 40.7128, -74.0060);

-- Optimize for spatial queries
OPTIMIZE catalog.schema.locations ZORDER BY (location);
```

**Query via Custom Data Provider:**
```bash
curl "http://localhost:3000/query?table=catalog.schema.locations&geometryColumn=location&idField=id&f=geojson"
```

**ArcGIS Server Configuration:**
```bash
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "LocationsService" \
  --service-parameters "tableName:catalog.schema.locations,geometryColumn:location,idField:id"
```

---

### Option 2: Separate Lat/Long Columns (Good for Existing Tables)

**When to use:** Existing tables with lat/lon that you cannot modify

**Performance:** ⭐⭐⭐⭐ (Good)
- No table modification needed
- Geometry computed on-the-fly
- Slightly slower than native GEOMETRY

**Existing Table:**
```sql
-- Your existing table
CREATE TABLE catalog.schema.sensors (
  sensor_id BIGINT,
  sensor_name STRING,
  lat DOUBLE,
  lon DOUBLE,
  temperature DOUBLE,
  timestamp TIMESTAMP
);
```

**Solution 1: Create View with Geometry (Recommended)**
```sql
CREATE VIEW catalog.schema.sensors_spatial AS
SELECT
  sensor_id,
  sensor_name,
  lat,
  lon,
  temperature,
  timestamp,
  ST_Point(lon, lat) as location
FROM catalog.schema.sensors;

-- Materialize for better performance
CREATE MATERIALIZED VIEW catalog.schema.sensors_spatial_mv AS
SELECT
  sensor_id,
  sensor_name,
  lat,
  lon,
  temperature,
  timestamp,
  ST_Point(lon, lat) as location
FROM catalog.schema.sensors;
```

**Query:**
```bash
curl "http://localhost:3000/query?table=catalog.schema.sensors_spatial&geometryColumn=location&idField=sensor_id&f=geojson"
```

**Solution 2: Use Custom SQL Module (Future Enhancement)**
```javascript
// In modules/sql.js - add support for geometry expressions
const geometryExpr = params.geometryExpression ||
                     `ST_Point(${params.lonColumn}, ${params.latColumn})`;
```

---

### Option 3: WKT/WKB String Column

**When to use:** Data imported from external sources with WKT/WKB

**Performance:** ⭐⭐⭐ (Moderate)

**Table Setup:**
```sql
CREATE TABLE catalog.schema.points_wkt (
  id BIGINT,
  name STRING,
  location_wkt STRING,
  location GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(location_wkt))
);

-- Or for WKB
CREATE TABLE catalog.schema.points_wkb (
  id BIGINT,
  name STRING,
  location_wkb BINARY,
  location GEOMETRY GENERATED ALWAYS AS (ST_GeomFromWKB(location_wkb))
);
```

---

## Line Geometries

### Option 1: Native LineString (Most Efficient) ⭐

**When to use:** Routes, paths, trajectories

**Performance:** ⭐⭐⭐⭐⭐

**Table Setup:**
```sql
CREATE TABLE catalog.schema.routes (
  route_id BIGINT,
  route_name STRING,
  route_wkt STRING,
  route GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(route_wkt))
);

-- Insert delivery routes
INSERT INTO catalog.schema.routes (route_id, route_name, route_wkt)
VALUES
  (1, 'Route A', 'LINESTRING(-122.4194 37.7749, -122.4084 37.7849, -122.3974 37.7949)'),
  (2, 'Route B', 'LINESTRING(-74.0060 40.7128, -73.9960 40.7228, -73.9860 40.7328)');

OPTIMIZE catalog.schema.routes ZORDER BY (route);
```

**Query:**
```bash
curl "http://localhost:3000/query?table=catalog.schema.routes&geometryColumn=route&idField=route_id&f=geojson"
```

---

### Option 2: GPS Trajectories (Separate Points to LineString)

**When to use:** GPS tracking data, vessel tracking, vehicle tracking

**Performance:** ⭐⭐⭐⭐

**Raw GPS Data:**
```sql
-- Your raw GPS tracking table
CREATE TABLE catalog.schema.gps_tracks (
  track_id BIGINT,
  vehicle_id STRING,
  lat DOUBLE,
  lon DOUBLE,
  timestamp TIMESTAMP,
  speed DOUBLE
);
```

**Create LineString View:**
```sql
CREATE VIEW catalog.schema.vehicle_routes AS
SELECT
  vehicle_id,
  ST_MakeLine(
    ARRAY_AGG(
      ST_Point(lon, lat)
      ORDER BY timestamp
    )
  ) as route,
  MIN(timestamp) as start_time,
  MAX(timestamp) as end_time,
  AVG(speed) as avg_speed
FROM catalog.schema.gps_tracks
GROUP BY vehicle_id;
```

**Or aggregate by day:**
```sql
CREATE VIEW catalog.schema.vehicle_daily_routes AS
SELECT
  vehicle_id,
  DATE(timestamp) as track_date,
  ST_MakeLine(
    ARRAY_AGG(
      ST_Point(lon, lat)
      ORDER BY timestamp
    )
  ) as route,
  MIN(timestamp) as start_time,
  MAX(timestamp) as end_time
FROM catalog.schema.gps_tracks
GROUP BY vehicle_id, DATE(timestamp);
```

**Query:**
```bash
curl "http://localhost:3000/query?table=catalog.schema.vehicle_routes&geometryColumn=route&idField=vehicle_id&f=geojson"
```

---

## Polygon Geometries

### Option 1: Native Polygon (Most Efficient) ⭐

**When to use:** Zones, boundaries, service areas

**Performance:** ⭐⭐⭐⭐⭐

**Table Setup:**
```sql
CREATE TABLE catalog.schema.zones (
  zone_id BIGINT,
  zone_name STRING,
  zone_type STRING,
  boundary_wkt STRING,
  boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt))
);

-- Insert delivery zones
INSERT INTO catalog.schema.zones (zone_id, zone_name, zone_type, boundary_wkt)
VALUES
  (1, 'Downtown', 'delivery',
   'POLYGON((-122.42 37.77, -122.41 37.77, -122.41 37.78, -122.42 37.78, -122.42 37.77))'),
  (2, 'Marina', 'delivery',
   'POLYGON((-122.44 37.80, -122.43 37.80, -122.43 37.81, -122.44 37.81, -122.44 37.80))');

OPTIMIZE catalog.schema.zones ZORDER BY (boundary);
```

**Query:**
```bash
curl "http://localhost:3000/query?table=catalog.schema.zones&geometryColumn=boundary&idField=zone_id&f=geojson"
```

---

### Option 2: Polygons from Bounding Box

**When to use:** Grid cells, tiles, rectangular zones

**Table Setup:**
```sql
CREATE TABLE catalog.schema.grid_cells (
  cell_id BIGINT,
  xmin DOUBLE,
  ymin DOUBLE,
  xmax DOUBLE,
  ymax DOUBLE,
  cell_polygon GEOMETRY GENERATED ALWAYS AS (
    ST_GeomFromText(
      CONCAT(
        'POLYGON((',
        xmin, ' ', ymin, ',',
        xmax, ' ', ymin, ',',
        xmax, ' ', ymax, ',',
        xmin, ' ', ymax, ',',
        xmin, ' ', ymin,
        '))'
      )
    )
  )
);
```

---

### Option 3: H3 Hexagons (Best for Large Datasets)

**When to use:** Aggregating millions of points into hexagonal bins

**Performance:** ⭐⭐⭐⭐⭐ (For large datasets)

**Table Setup:**
```sql
-- Aggregate vessel tracking into H3 hexagons
CREATE TABLE catalog.schema.vessel_h3_hexagons AS
SELECT
  H3_LatLngToCell(lat, lon, 7) as h3_cell,
  COUNT(*) as vessel_count,
  COUNT(DISTINCT mmsi) as unique_vessels,
  AVG(sog) as avg_speed,
  H3_CellToPolygon(H3_LatLngToCell(lat, lon, 7)) as cell_polygon
FROM catalog.schema.vessel_tracking
WHERE lat IS NOT NULL AND lon IS NOT NULL
GROUP BY H3_LatLngToCell(lat, lon, 7);

OPTIMIZE catalog.schema.vessel_h3_hexagons ZORDER BY (cell_polygon);
```

**H3 Resolution Guide:**
| Resolution | Avg Hex Area | Use Case |
|------------|-------------|----------|
| 5 | 252 km² | Continental analysis |
| 6 | 36 km² | City-level analysis |
| 7 | 5 km² | Neighborhood analysis |
| 8 | 0.74 km² | Block-level analysis |
| 9 | 0.10 km² | Building-level analysis |

**Query:**
```bash
curl "http://localhost:3000/query?table=catalog.schema.vessel_h3_hexagons&geometryColumn=cell_polygon&idField=h3_cell&f=geojson"
```

---

## Performance Best Practices

### 1. Storage Format Comparison

| Format | Storage Size | Query Speed | Best For |
|--------|-------------|-------------|----------|
| Native GEOMETRY | ⭐⭐⭐⭐⭐ (Smallest) | ⭐⭐⭐⭐⭐ (Fastest) | Production tables |
| WKB Binary | ⭐⭐⭐⭐ (Small) | ⭐⭐⭐⭐ (Fast) | External imports |
| WKT String | ⭐⭐ (Large) | ⭐⭐⭐ (Moderate) | Human-readable debugging |
| Lat/Lon Computed | ⭐⭐⭐ (Medium) | ⭐⭐⭐ (Moderate) | Existing tables |

### 2. Indexing Strategy

**Always Z-order by geometry column:**
```sql
OPTIMIZE catalog.schema.your_table ZORDER BY (geometry_column);
```

**Or use Liquid Clustering (Databricks Runtime 13.3+):**
```sql
CREATE TABLE catalog.schema.your_table (
  id BIGINT,
  location GEOMETRY
)
CLUSTER BY (location);
```

### 3. Materialized Views for Complex Geometries

**When to use:**
- Converting lat/lon to geometry on every query is slow
- Aggregating trajectories into lines
- Creating H3 hexagons

**Pattern:**
```sql
CREATE MATERIALIZED VIEW catalog.schema.optimized_view AS
SELECT
  id,
  name,
  ST_Point(lon, lat) as location,
  other_columns
FROM catalog.schema.source_table;

-- Refresh periodically
REFRESH MATERIALIZED VIEW catalog.schema.optimized_view;
```

---

## Query Examples

### Point Queries

**1. All points within bounding box:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.locations&\
geometryColumn=location&\
idField=id&\
geometry=-122.5,37.7,-122.3,37.9&\
spatialRel=esriSpatialRelIntersects&\
f=geojson"
```

**2. Points with WHERE filter:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.sensors&\
geometryColumn=location&\
idField=sensor_id&\
where=temperature>25&\
f=geojson"
```

**3. Count only:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.locations&\
geometryColumn=location&\
idField=id&\
returnCountOnly=true&\
f=json"
```

### Line Queries

**1. Routes within area:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.routes&\
geometryColumn=route&\
idField=route_id&\
geometry=-122.5,37.7,-122.3,37.9&\
spatialRel=esriSpatialRelIntersects&\
f=geojson"
```

**2. Vehicle routes for specific vehicle:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.vehicle_routes&\
geometryColumn=route&\
idField=vehicle_id&\
where=vehicle_id='TRUCK001'&\
f=geojson"
```

### Polygon Queries

**1. Zones intersecting with point:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.zones&\
geometryColumn=boundary&\
idField=zone_id&\
geometry=-122.42,37.78&\
geometryType=esriGeometryPoint&\
spatialRel=esriSpatialRelContains&\
f=geojson"
```

**2. H3 hexagons with high vessel count:**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.vessel_h3_hexagons&\
geometryColumn=cell_polygon&\
idField=h3_cell&\
where=vessel_count>100&\
orderByFields=vessel_count DESC&\
f=geojson"
```

### Pagination

**1. First page (records 0-999):**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.locations&\
geometryColumn=location&\
idField=id&\
resultRecordCount=1000&\
resultOffset=0&\
f=geojson"
```

**2. Second page (records 1000-1999):**
```bash
curl "http://localhost:3000/query?\
table=catalog.schema.locations&\
geometryColumn=location&\
idField=id&\
resultRecordCount=1000&\
resultOffset=1000&\
f=geojson"
```

---

## Quick Reference: Setting Up Your Data

### Checklist for Any Geometry Type

1. **Identify your source data format:**
   - [ ] Native GEOMETRY column exists → Use directly
   - [ ] Separate lat/lon columns → Create view with ST_Point
   - [ ] WKT/WKB strings → Use ST_GeomFromText/ST_GeomFromWKB
   - [ ] GPS tracks → Aggregate with ST_MakeLine
   - [ ] Millions of points → Use H3 aggregation

2. **Create optimized table/view:**
   ```sql
   -- Example for lat/lon points
   CREATE MATERIALIZED VIEW catalog.schema.my_spatial_view AS
   SELECT
     id,
     name,
     other_columns,
     ST_Point(longitude, latitude) as location
   FROM catalog.schema.my_source_table;
   ```

3. **Optimize for spatial queries:**
   ```sql
   OPTIMIZE catalog.schema.my_spatial_view ZORDER BY (location);
   ```

4. **Test query:**
   ```bash
   curl "http://localhost:3000/query?\
   table=catalog.schema.my_spatial_view&\
   geometryColumn=location&\
   idField=id&\
   resultRecordCount=5&\
   f=geojson"
   ```

5. **Deploy to ArcGIS Server:**
   ```bash
   cdf create-service databricks-geospatial-provider \
     https://your-server/arcgis/admin YOUR_TOKEN \
     -s "MyDataService" \
     --service-parameters "tableName:catalog.schema.my_spatial_view,geometryColumn:location,idField:id"
   ```

---

## Common Patterns by Use Case

### IoT Sensors (Points)
```sql
CREATE MATERIALIZED VIEW catalog.schema.sensors_live AS
SELECT
  sensor_id,
  sensor_type,
  ST_Point(lon, lat) as location,
  temperature,
  humidity,
  timestamp
FROM catalog.schema.sensor_readings
WHERE timestamp > CURRENT_TIMESTAMP() - INTERVAL 1 HOUR;
```

### Vehicle Tracking (Lines)
```sql
CREATE VIEW catalog.schema.vehicle_routes_today AS
SELECT
  vehicle_id,
  ST_MakeLine(ARRAY_AGG(ST_Point(lon, lat) ORDER BY timestamp)) as route,
  MIN(timestamp) as start_time,
  MAX(timestamp) as end_time,
  SUM(distance) as total_distance
FROM catalog.schema.gps_events
WHERE DATE(timestamp) = CURRENT_DATE()
GROUP BY vehicle_id;
```

### Delivery Zones (Polygons)
```sql
CREATE TABLE catalog.schema.delivery_zones (
  zone_id BIGINT,
  zone_name STRING,
  boundary_wkt STRING,
  max_deliveries INT,
  boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt))
);
```

### Heatmap from Millions of Points (H3 Hexagons)
```sql
CREATE TABLE catalog.schema.activity_heatmap AS
SELECT
  H3_LatLngToCell(lat, lon, 8) as h3_cell,
  COUNT(*) as event_count,
  AVG(value) as avg_value,
  H3_CellToPolygon(H3_LatLngToCell(lat, lon, 8)) as cell_polygon
FROM catalog.schema.event_data
GROUP BY H3_LatLngToCell(lat, lon, 8);
```

---

## Performance Tuning

### Dataset Size Recommendations

**< 10K rows:**
- No special optimization needed
- Any format works fine

**10K - 1M rows:**
- Use native GEOMETRY column
- Enable Z-ordering
- Use materialized views for complex computations

**1M - 100M rows:**
- Mandatory: Native GEOMETRY + Z-ordering
- Use WHERE clauses and spatial filters
- Consider H3 aggregation for visualization

**100M+ rows:**
- Mandatory: H3 aggregation or partitioning
- Use liquid clustering
- Implement caching strategy

---

## Troubleshooting

### Error: Column 'location' not found
**Solution:** Specify correct geometry column name
```bash
curl "http://localhost:3000/query?table=...&geometryColumn=your_geom_column&..."
```

### Slow queries on large tables
**Solutions:**
1. Add Z-ordering: `OPTIMIZE table ZORDER BY (geom)`
2. Use spatial filters: `&geometry=-122.5,37.7,-122.3,37.9`
3. Add WHERE clauses: `&where=timestamp>CURRENT_DATE()`
4. Consider H3 aggregation for visualization

### Out of memory errors
**Solutions:**
1. Reduce `resultRecordCount`
2. Use pagination
3. Add filters to reduce result set
4. Use H3 aggregation instead of raw points

---

## Next Steps

1. **Review your data:** Identify geometry type and current format
2. **Choose pattern:** Select most appropriate option from this guide
3. **Create optimized table/view:** Follow examples above
4. **Test locally:** Use test server to verify
5. **Deploy to ArcGIS Server:** Create Feature Service

For additional help, see:
- [README.md](README.md) - Main documentation
- [PERFORMANCE.md](PERFORMANCE.md) - Performance optimization
- [testing/TEST_WITH_DATABRICKS.md](testing/TEST_WITH_DATABRICKS.md) - Testing guide
