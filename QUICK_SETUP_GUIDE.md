# Quick Setup Guide

5-minute guide to get your spatial data working with the Custom Data Provider.

## Scenario 1: I have a table with lat/lon columns

**Your table:**
```sql
CREATE TABLE my_catalog.my_schema.sensors (
  sensor_id BIGINT,
  sensor_name STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  temperature DOUBLE,
  timestamp TIMESTAMP
);
```

**Solution: Create a view with geometry**

```sql
-- Step 1: Create spatial view
CREATE OR REPLACE VIEW my_catalog.my_schema.sensors_spatial AS
SELECT
  sensor_id,
  sensor_name,
  latitude,
  longitude,
  temperature,
  timestamp,
  ST_Point(longitude, latitude) as location
FROM my_catalog.my_schema.sensors
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Step 2 (Optional but recommended): Materialize for better performance
CREATE MATERIALIZED VIEW my_catalog.my_schema.sensors_spatial_mv AS
SELECT
  sensor_id,
  sensor_name,
  latitude,
  longitude,
  temperature,
  timestamp,
  ST_Point(longitude, latitude) as location
FROM my_catalog.my_schema.sensors
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Step 3: Optimize
OPTIMIZE my_catalog.my_schema.sensors_spatial_mv ZORDER BY (location);
```

**Test it:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.sensors_spatial_mv&\
geometryColumn=location&\
idField=sensor_id&\
resultRecordCount=10&\
f=geojson"
```

**Deploy to ArcGIS Server:**
```bash
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "SensorsService" \
  --service-parameters "tableName:my_catalog.my_schema.sensors_spatial_mv,geometryColumn:location,idField:sensor_id"
```

---

## Scenario 2: I have a table with WKT geometry strings

**Your table:**
```sql
CREATE TABLE my_catalog.my_schema.zones (
  zone_id BIGINT,
  zone_name STRING,
  boundary_wkt STRING  -- Contains WKT like "POLYGON((......))"
);
```

**Solution: Add computed geometry column**

```sql
-- Step 1: Add geometry column
ALTER TABLE my_catalog.my_schema.zones
ADD COLUMN boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt));

-- Step 2: Optimize
OPTIMIZE my_catalog.my_schema.zones ZORDER BY (boundary);
```

**Test it:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.zones&\
geometryColumn=boundary&\
idField=zone_id&\
f=geojson"
```

---

## Scenario 3: I have GPS tracking data and want to show routes

**Your table:**
```sql
CREATE TABLE my_catalog.my_schema.gps_tracks (
  vehicle_id STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  timestamp TIMESTAMP,
  speed DOUBLE
);
```

**Solution: Aggregate into LineStrings**

```sql
-- Step 1: Create daily routes view
CREATE OR REPLACE VIEW my_catalog.my_schema.vehicle_routes AS
SELECT
  vehicle_id,
  DATE(timestamp) as route_date,
  ST_MakeLine(
    ARRAY_AGG(
      ST_Point(longitude, latitude)
      ORDER BY timestamp
    )
  ) as route,
  MIN(timestamp) as start_time,
  MAX(timestamp) as end_time,
  AVG(speed) as avg_speed,
  COUNT(*) as point_count
FROM my_catalog.my_schema.gps_tracks
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
GROUP BY vehicle_id, DATE(timestamp);
```

**Test it:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.vehicle_routes&\
geometryColumn=route&\
idField=vehicle_id&\
where=route_date=CURRENT_DATE()&\
f=geojson"
```

---

## Scenario 4: I have millions of points and need a heatmap

**Your table:**
```sql
-- Millions of rows
CREATE TABLE my_catalog.my_schema.events (
  event_id BIGINT,
  latitude DOUBLE,
  longitude DOUBLE,
  event_type STRING,
  timestamp TIMESTAMP
);
```

**Solution: Use H3 hexagonal binning**

```sql
-- Step 1: Create H3 aggregation (resolution 8 = ~0.74 km² hexagons)
CREATE TABLE my_catalog.my_schema.events_heatmap AS
SELECT
  H3_LatLngToCell(latitude, longitude, 8) as h3_cell,
  COUNT(*) as event_count,
  COUNT(DISTINCT event_type) as event_types,
  MIN(timestamp) as earliest_event,
  MAX(timestamp) as latest_event,
  H3_CellToPolygon(H3_LatLngToCell(latitude, longitude, 8)) as cell_polygon
FROM my_catalog.my_schema.events
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
GROUP BY H3_LatLngToCell(latitude, longitude, 8);

-- Step 2: Optimize
OPTIMIZE my_catalog.my_schema.events_heatmap ZORDER BY (cell_polygon);
```

**Result:** Millions of points → Thousands of hexagons (100x-1000x smaller!)

**Test it:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.events_heatmap&\
geometryColumn=cell_polygon&\
idField=h3_cell&\
where=event_count>10&\
f=geojson"
```

---

## Scenario 5: My table already has a GEOMETRY column

**Your table:**
```sql
CREATE TABLE my_catalog.my_schema.places (
  id BIGINT,
  name STRING,
  location GEOMETRY  -- Already has geometry!
);
```

**Solution: Use directly!**

```sql
-- Optional: Just optimize for better performance
OPTIMIZE my_catalog.my_schema.places ZORDER BY (location);
```

**Test it:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.places&\
geometryColumn=location&\
idField=id&\
f=geojson"
```

**That's it! No transformation needed.**

---

## Choosing the Right Approach

### Use Native GEOMETRY Column When:
- ✅ You're creating new tables
- ✅ You can modify existing tables
- ✅ You want best performance

### Use Views When:
- ✅ You can't modify the original table
- ✅ You want to keep original data unchanged
- ✅ You need real-time data (view stays in sync)

### Use Materialized Views When:
- ✅ You want view convenience + native performance
- ✅ You can refresh periodically (hourly/daily)
- ✅ Data doesn't change constantly

### Use H3 Aggregation When:
- ✅ You have millions+ of points
- ✅ You need heatmap visualization
- ✅ Individual points aren't necessary
- ✅ You want fast rendering in web maps

---

## Performance Tips

### For Small Tables (< 100K rows)
- Any approach works fine
- Views are sufficient

### For Medium Tables (100K - 1M rows)
- Use materialized views
- Add Z-ordering
- Use WHERE clauses in queries

### For Large Tables (1M+ rows)
```sql
-- 1. Create materialized view
CREATE MATERIALIZED VIEW catalog.schema.my_data_mv AS
SELECT id, name, ST_Point(lon, lat) as location, other_columns
FROM catalog.schema.my_data;

-- 2. Z-order by geometry
OPTIMIZE catalog.schema.my_data_mv ZORDER BY (location);

-- 3. Analyze statistics
ANALYZE TABLE catalog.schema.my_data_mv
COMPUTE STATISTICS FOR ALL COLUMNS;
```

### For Very Large Tables (100M+ rows)
- **Mandatory**: Use H3 aggregation for visualization
- Consider partitioning by date/region
- Use incremental refresh strategies

---

## Testing Checklist

Before deploying to ArcGIS Server, test locally:

```bash
# 1. Health check
curl "http://localhost:3000/health"

# 2. Basic query
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
resultRecordCount=5&\
f=geojson" | python3 -m json.tool

# 3. Count query
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
returnCountOnly=true&\
f=json"

# 4. Spatial filter
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
geometry=-180,-90,180,90&\
spatialRel=esriSpatialRelIntersects&\
f=geojson" | python3 -m json.tool

# 5. WHERE clause
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
where=your_field='value'&\
f=geojson"
```

If all tests pass, you're ready to deploy! 🚀

---

## Common Issues

### Issue: "Column 'location' not found"
**Fix:** Specify the correct geometry column name:
```bash
curl "...&geometryColumn=YOUR_ACTUAL_COLUMN_NAME&..."
```

### Issue: "Table not found"
**Fix:** Use fully qualified name:
```bash
curl "...&table=catalog.schema.table_name&..."
```

### Issue: Queries are slow
**Fixes:**
1. Add Z-ordering: `OPTIMIZE table ZORDER BY (geometry)`
2. Use materialized view instead of view
3. Add WHERE clauses to filter data
4. Consider H3 aggregation for large datasets

### Issue: NULL geometries
**Fix:** Filter them out in your view:
```sql
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
```

---

## H3 Resolution Guide

Choose the right H3 resolution for your use case:

| Resolution | Avg Hex Area | Use Case | Example |
|------------|-------------|----------|---------|
| 5 | 252 km² | Continental | Country-wide analysis |
| 6 | 36 km² | Regional | State/province analysis |
| 7 | 5 km² | City | City-wide heatmaps |
| 8 | 0.74 km² | Neighborhood | District analysis |
| 9 | 0.10 km² | Block | Street-level detail |
| 10 | 0.015 km² | Building | Building-level precision |

**Rule of thumb:** Start with resolution 7 or 8, adjust based on zoom level needs.

---

## Need More Help?

- **Complete geometry guide**: [GEOMETRY_PATTERNS.md](GEOMETRY_PATTERNS.md)
- **Real-world examples**: [testing/setup-vessel-tracking.sql](testing/setup-vessel-tracking.sql)
- **Performance tuning**: [PERFORMANCE.md](PERFORMANCE.md)
- **Testing guide**: [testing/TEST_WITH_DATABRICKS.md](testing/TEST_WITH_DATABRICKS.md)
