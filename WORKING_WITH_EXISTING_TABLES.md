# Working With Existing Databricks Tables

> **📖 Part of:** [ArcGIS Custom Data Feed for Databricks](README.md)
> **Related:** [Implementation Details](IMPLEMENTATION_VERIFICATION.md) | [Future Features](OPTIONAL_FEATURES.md)

This guide focuses on **using your existing Databricks tables** with the Custom Data Feed Provider. Most scenarios involve tables that already exist - you just need to determine the best way to expose them.

## Quick Decision Tree

```
Does your table have a GEOMETRY column?
├─ YES → Use table directly (see Scenario 1)
└─ NO → Does it have lat/lon columns?
    ├─ YES → Create view or materialized view (see Scenario 2)
    └─ NO → Does it have WKT/WKB geometry?
        ├─ YES → Create view with ST_GeomFromText/ST_GeomFromWKB (see Scenario 3)
        └─ NO → Check for H3 cells, GeoJSON, or address columns (see Advanced)
```

---

## Scenario 1: Table Already Has GEOMETRY Column

**Your existing table:**
```sql
-- Table already exists with geometry
CREATE TABLE my_catalog.my_schema.locations (
  id BIGINT,
  name STRING,
  location GEOMETRY,  -- Already has geometry!
  category STRING,
  timestamp TIMESTAMP
);
```

### Option A: Use Directly (Best Performance)

**When to use:** Table is already optimized, query performance is acceptable

**Setup:** Just optimize if needed
```sql
-- Optional: Add Z-ordering for better spatial queries
OPTIMIZE my_catalog.my_schema.locations
ZORDER BY (location);

-- Optional: Update statistics
ANALYZE TABLE my_catalog.my_schema.locations
COMPUTE STATISTICS FOR ALL COLUMNS;
```

**Configure provider:**
```bash
# Test locally
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.locations&\
geometryColumn=location&\
idField=id&\
resultRecordCount=10&\
f=geojson"

# Deploy to ArcGIS Server
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "LocationsService" \
  --service-parameters "tableName:my_catalog.my_schema.locations,geometryColumn:location,idField:id"
```

**Pros:** ✅ Direct access, best performance, real-time data
**Cons:** ❌ No filtering at source, all table data exposed

---

### Option B: Create Filtered View (Selective Access)

**When to use:** Need to filter data, hide columns, or apply business logic

```sql
-- Create view that filters and selects specific columns
CREATE OR REPLACE VIEW my_catalog.my_schema.locations_public AS
SELECT
  id,
  name,
  category,
  location
FROM my_catalog.my_schema.locations
WHERE
  category IN ('restaurant', 'park', 'school')  -- Filter by category
  AND location IS NOT NULL                       -- Exclude null geometries
  AND timestamp > CURRENT_DATE() - INTERVAL 30 DAYS;  -- Recent only
```

**Configure provider to use view:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.locations_public&\
geometryColumn=location&\
idField=id&\
f=geojson"
```

**Pros:** ✅ Real-time filtered data, security/privacy control
**Cons:** ❌ View query overhead on every request

---

### Option C: Materialized View (Performance + Filtering)

**When to use:** Need filtering AND high performance, data refreshed periodically (hourly/daily)

```sql
-- Create materialized view (physical table, refreshed on schedule)
CREATE MATERIALIZED VIEW my_catalog.my_schema.locations_public_mv AS
SELECT
  id,
  name,
  category,
  location
FROM my_catalog.my_schema.locations
WHERE
  category IN ('restaurant', 'park', 'school')
  AND location IS NOT NULL;

-- Optimize for spatial queries
OPTIMIZE my_catalog.my_schema.locations_public_mv
ZORDER BY (location);

-- Schedule refresh (run this periodically via job)
REFRESH MATERIALIZED VIEW my_catalog.my_schema.locations_public_mv;
```

**Pros:** ✅ Fast queries like direct table, filtered data, optimized storage
**Cons:** ❌ Data not real-time, needs refresh schedule

**Efficiency comparison:**
- Query time: ~Same as direct table (materialized = physical table)
- Storage: Only stores filtered subset
- Freshness: Depends on refresh schedule (hourly/daily typical)

---

## Scenario 2: Table Has Separate lat/lon Columns

**Your existing table:**
```sql
-- Table exists with separate lat/lon
CREATE TABLE my_catalog.my_schema.sensors (
  sensor_id BIGINT,
  sensor_name STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  temperature DOUBLE,
  humidity DOUBLE,
  timestamp TIMESTAMP
);
```

### Option A: Regular View (Real-time)

**When to use:** Data changes frequently, need real-time access, < 1M rows

```sql
CREATE OR REPLACE VIEW my_catalog.my_schema.sensors_spatial AS
SELECT
  sensor_id,
  sensor_name,
  latitude,
  longitude,
  temperature,
  humidity,
  timestamp,
  ST_Point(longitude, latitude) as location  -- Compute geometry on-the-fly
FROM my_catalog.my_schema.sensors
WHERE
  latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND latitude BETWEEN -90 AND 90    -- Validate coordinates
  AND longitude BETWEEN -180 AND 180;
```

**Performance:** ST_Point() computed on every query
**Use for:** < 1M rows, frequently updated data

---

### Option B: Materialized View (Optimized)

**When to use:** > 1M rows, data updated hourly/daily, need best performance

```sql
CREATE MATERIALIZED VIEW my_catalog.my_schema.sensors_spatial_mv AS
SELECT
  sensor_id,
  sensor_name,
  latitude,
  longitude,
  temperature,
  humidity,
  timestamp,
  ST_Point(longitude, latitude) as location
FROM my_catalog.my_schema.sensors
WHERE
  latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND latitude BETWEEN -90 AND 90
  AND longitude BETWEEN -180 AND 180;

-- Optimize for spatial queries
OPTIMIZE my_catalog.my_schema.sensors_spatial_mv
ZORDER BY (location);

-- Create refresh job (run hourly/daily)
REFRESH MATERIALIZED VIEW my_catalog.my_schema.sensors_spatial_mv;
```

**Performance:** Geometry pre-computed and stored, Z-ordered for fast spatial queries
**Efficiency gain:** 10-50x faster than view for large tables
**Use for:** > 1M rows, batch updates

---

### Option C: Add Computed Column (Best for New Data)

**When to use:** Can modify table, want best performance for ongoing inserts

```sql
-- Add computed geometry column to existing table
ALTER TABLE my_catalog.my_schema.sensors
ADD COLUMN location GEOMETRY
GENERATED ALWAYS AS (ST_Point(longitude, latitude));

-- Optimize
OPTIMIZE my_catalog.my_schema.sensors
ZORDER BY (location);
```

**Pros:** ✅ Geometry computed on insert, no view overhead, real-time
**Cons:** ❌ Requires ALTER TABLE permission, increases storage slightly

---

## Scenario 3: Table Has WKT or WKB Geometry

**Your existing table:**
```sql
-- Table with WKT geometry strings
CREATE TABLE my_catalog.my_schema.boundaries (
  zone_id BIGINT,
  zone_name STRING,
  boundary_wkt STRING,  -- WKT like "POLYGON((...))"
  area_sqkm DOUBLE
);
```

### Option A: Add Computed Column

```sql
ALTER TABLE my_catalog.my_schema.boundaries
ADD COLUMN boundary GEOMETRY
GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt));

OPTIMIZE my_catalog.my_schema.boundaries
ZORDER BY (boundary);
```

### Option B: Materialized View (Can't Modify Table)

```sql
CREATE MATERIALIZED VIEW my_catalog.my_schema.boundaries_spatial AS
SELECT
  zone_id,
  zone_name,
  area_sqkm,
  ST_GeomFromText(boundary_wkt) as boundary
FROM my_catalog.my_schema.boundaries
WHERE boundary_wkt IS NOT NULL;

OPTIMIZE my_catalog.my_schema.boundaries_spatial
ZORDER BY (boundary);
```

**For WKB (binary):**
```sql
ST_GeomFromWKB(boundary_wkb) as boundary
```

---

## Scenario 4: Large Table (> 10M rows) - Aggregation Required

**Your existing table:**
```sql
-- Massive event tracking table
CREATE TABLE my_catalog.my_schema.events (
  event_id BIGINT,
  user_id STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  event_type STRING,
  timestamp TIMESTAMP
);
-- Contains 100M+ rows
```

### Problem
- Too large to render all points on a map
- Queries slow even with optimization
- Client browser crashes with too much data

### Solution: H3 Hexagonal Aggregation

**Create aggregation table:**
```sql
-- Aggregate 100M points into ~50K hexagons
CREATE TABLE my_catalog.my_schema.events_h3_hexagons AS
SELECT
  H3_LatLngToCell(latitude, longitude, 7) as h3_cell,  -- Resolution 7 (~5 km²)
  COUNT(*) as event_count,
  COUNT(DISTINCT user_id) as unique_users,
  COUNT(DISTINCT event_type) as event_types,
  COLLECT_SET(event_type) as event_types_list,
  MIN(timestamp) as earliest_event,
  MAX(timestamp) as latest_event,
  H3_CellToPolygon(H3_LatLngToCell(latitude, longitude, 7)) as cell_polygon
FROM my_catalog.my_schema.events
WHERE
  latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND timestamp > CURRENT_DATE() - INTERVAL 90 DAYS  -- Last 90 days only
GROUP BY H3_LatLngToCell(latitude, longitude, 7);

-- Optimize
OPTIMIZE my_catalog.my_schema.events_h3_hexagons
ZORDER BY (cell_polygon);

-- Analyze
ANALYZE TABLE my_catalog.my_schema.events_h3_hexagons
COMPUTE STATISTICS FOR ALL COLUMNS;
```

**Result:** 100M points → 50K hexagons (2000x reduction!)

**Configure provider:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.events_h3_hexagons&\
geometryColumn=cell_polygon&\
idField=h3_cell&\
where=event_count>100&\
f=geojson"
```

**H3 Resolution Guide:**

| Resolution | Avg Area | # Hexagons (USA) | Use Case |
|------------|----------|------------------|----------|
| 5 | 252 km² | ~50K | Country-wide heatmap |
| 6 | 36 km² | ~300K | State/regional analysis |
| 7 | 5 km² | ~2M | City-wide heatmap |
| 8 | 0.74 km² | ~15M | Neighborhood detail |
| 9 | 0.10 km² | ~100M | Street-level (high zoom) |

**Rule of thumb:** Start with resolution 7 for city-scale, 8 for neighborhood-scale

**Refresh strategy:**
```sql
-- Option 1: Full refresh (replace all data)
CREATE OR REPLACE TABLE my_catalog.my_schema.events_h3_hexagons AS
SELECT ... FROM my_catalog.my_schema.events;

-- Option 2: Incremental (add new data only)
INSERT INTO my_catalog.my_schema.events_h3_hexagons
SELECT
  H3_LatLngToCell(latitude, longitude, 7) as h3_cell,
  COUNT(*) as event_count,
  ...
FROM my_catalog.my_schema.events
WHERE timestamp > (SELECT MAX(latest_event) FROM my_catalog.my_schema.events_h3_hexagons)
GROUP BY H3_LatLngToCell(latitude, longitude, 7);
```

---

## Scenario 5: GPS Tracking - Show Routes (LineStrings)

**Your existing table:**
```sql
-- GPS tracking table
CREATE TABLE my_catalog.my_schema.vehicle_tracking (
  vehicle_id STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  timestamp TIMESTAMP,
  speed DOUBLE,
  heading DOUBLE
);
-- Contains millions of GPS points
```

### Create Route Aggregation

```sql
-- Aggregate points into daily routes
CREATE MATERIALIZED VIEW my_catalog.my_schema.vehicle_daily_routes AS
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
  COUNT(*) as point_count,
  AVG(speed) as avg_speed,
  SUM(ST_Distance(
    ST_Point(longitude, latitude),
    LAG(ST_Point(longitude, latitude)) OVER (PARTITION BY vehicle_id, DATE(timestamp) ORDER BY timestamp)
  )) as total_distance_meters
FROM my_catalog.my_schema.vehicle_tracking
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
GROUP BY vehicle_id, DATE(timestamp);

-- Optimize
OPTIMIZE my_catalog.my_schema.vehicle_daily_routes
ZORDER BY (route);
```

**Result:** Millions of points → Thousands of routes

**Query routes:**
```bash
curl "http://localhost:3000/query?\
table=my_catalog.my_schema.vehicle_daily_routes&\
geometryColumn=route&\
idField=vehicle_id&\
where=route_date=CURRENT_DATE()&\
f=geojson"
```

---

## Performance Comparison Matrix

| Scenario | Approach | Query Time | Storage | Real-time | When to Use |
|----------|----------|------------|---------|-----------|-------------|
| GEOMETRY column exists | Direct table | Fast | Existing | Yes | Data already optimized |
| GEOMETRY column exists | Filtered view | Fast | None | Yes | Need to filter/hide data |
| GEOMETRY column exists | Materialized view | Fastest | Medium | No | Need filter + performance |
| lat/lon columns | Regular view | Medium | None | Yes | < 1M rows, frequent updates |
| lat/lon columns | Materialized view | Fast | Medium | No | > 1M rows, batch updates |
| lat/lon columns | Computed column | Fast | Small | Yes | Can modify table |
| WKT/WKB strings | Computed column | Fast | Medium | Yes | Can modify table |
| WKT/WKB strings | Materialized view | Fast | Medium | No | Can't modify table |
| > 10M points | H3 aggregation | Fastest | Small | No | Heatmaps, large datasets |
| GPS tracking | Route aggregation | Fast | Small | No | Show paths, not individual points |

---

## Optimization Checklist

### For All Tables/Views

```sql
-- 1. Z-ordering (most important for spatial queries)
OPTIMIZE catalog.schema.table_name
ZORDER BY (geometry_column);

-- 2. Statistics (helps query optimizer)
ANALYZE TABLE catalog.schema.table_name
COMPUTE STATISTICS FOR ALL COLUMNS;

-- 3. Liquid Clustering (Databricks Runtime 13.3+, alternative to Z-order)
ALTER TABLE catalog.schema.table_name
CLUSTER BY (geometry_column, other_common_filter_columns);
```

### For Large Tables (> 10M rows)

```sql
-- Partition by common filter columns
CREATE TABLE catalog.schema.table_name (
  id BIGINT,
  location GEOMETRY,
  event_date DATE,
  ...
)
PARTITIONED BY (event_date);

-- Then optimize each partition
OPTIMIZE catalog.schema.table_name
WHERE event_date = '2026-01-17'
ZORDER BY (location);
```

---

## Common Patterns by Industry

### IoT Sensors (Real-time)
```sql
-- Existing table: sensor readings with lat/lon
-- Pattern: Regular view (real-time) + Z-ordering on base table
CREATE OR REPLACE VIEW sensors_spatial AS
SELECT sensor_id, ST_Point(lon, lat) as location, ...
FROM sensors;
```

### E-commerce Deliveries
```sql
-- Existing table: delivery zones with WKT polygons
-- Pattern: Computed column on base table
ALTER TABLE delivery_zones
ADD COLUMN boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt));
```

### Vehicle Fleet (Historical)
```sql
-- Existing table: GPS logs (millions of rows)
-- Pattern: Daily materialized view + routes
CREATE MATERIALIZED VIEW vehicle_routes_daily AS
SELECT vehicle_id, DATE(ts) as date, ST_MakeLine(...) as route
FROM vehicle_gps
GROUP BY vehicle_id, DATE(ts);
```

### Mobile App Analytics (Billions)
```sql
-- Existing table: user events (billions of rows)
-- Pattern: H3 aggregation at multiple resolutions
CREATE TABLE user_events_h3_res7 AS
SELECT H3_LatLngToCell(lat, lon, 7) as h3_cell, COUNT(*) as count, ...
FROM user_events
GROUP BY H3_LatLngToCell(lat, lon, 7);
```

---

## Testing Your Configuration

Before deploying to ArcGIS Server, test locally:

```bash
# 1. Check table schema
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
returnCountOnly=true&\
f=json"

# 2. Fetch small sample
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
resultRecordCount=5&\
f=geojson" | python3 -m json.tool

# 3. Test with filter
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
where=your_column='value'&\
f=geojson"

# 4. Test spatial filter
curl "http://localhost:3000/query?\
table=YOUR_TABLE&\
geometryColumn=YOUR_GEOM_COLUMN&\
idField=YOUR_ID_FIELD&\
geometry=-180,-90,180,90&\
spatialRel=esriSpatialRelIntersects&\
f=geojson"
```

---

## Troubleshooting

### Query is slow
1. Add Z-ordering: `OPTIMIZE table ZORDER BY (geometry_column)`
2. Use materialized view instead of regular view
3. Consider H3 aggregation if > 10M rows
4. Check if ST_Point() is computed on every query (use materialized view)

### Too much data returned
1. Use filtered view or materialized view to reduce dataset
2. Implement H3 aggregation for large point datasets
3. Add WHERE clause in queries: `&where=timestamp>CURRENT_DATE()`

### Real-time requirement
- Use regular view (not materialized view)
- Or use materialized view with frequent refresh (every 5-15 minutes)
- Or add computed column to base table

### Can't modify existing table
- Use regular view for < 1M rows
- Use materialized view for > 1M rows
- Schedule materialized view refresh via Databricks job

---

## Summary: Decision Framework

1. **Table has GEOMETRY column?**
   - Yes → Use directly, add Z-ordering if needed
   - No → Continue

2. **Can you modify the table?**
   - Yes → Add computed column (best performance + real-time)
   - No → Continue

3. **How many rows?**
   - < 1M → Regular view is fine
   - 1M - 10M → Materialized view (refresh hourly/daily)
   - > 10M → H3 aggregation required

4. **Need real-time data?**
   - Yes → Regular view or computed column
   - No → Materialized view (best performance)

5. **Showing individual points or aggregated?**
   - Individual → Use view/table with geometry
   - Aggregated → Use H3 hexagons or route aggregation
