-- Setup Vessel Tracking for Custom Data Provider
-- Run this in Databricks SQL Editor

-- ============================================================================
-- PART 1: INSPECT EXISTING TABLE
-- ============================================================================

-- Check current schema
DESCRIBE atrivedi.geospatial.vessel_tracking;

-- Sample data
SELECT * FROM atrivedi.geospatial.vessel_tracking LIMIT 5;

-- Count total rows
SELECT COUNT(*) as total_rows,
       COUNT(DISTINCT mmsi) as unique_vessels
FROM atrivedi.geospatial.vessel_tracking;

-- ============================================================================
-- PART 2: OPTION 1 - CREATE VIEW WITH GEOMETRY (RECOMMENDED)
-- ============================================================================

-- Create spatial view from lat/lon columns
CREATE OR REPLACE VIEW atrivedi.geospatial.vessel_tracking_spatial AS
SELECT
  mmsi,
  vessel_name,
  lat,
  lon,
  ts,
  sog,
  cog,
  heading,
  vessel_type,
  status,
  ST_Point(lon, lat) as location  -- Create point geometry
FROM atrivedi.geospatial.vessel_tracking
WHERE lat IS NOT NULL AND lon IS NOT NULL;

-- Test the view
SELECT mmsi, vessel_name, ST_AsText(location) as location_wkt
FROM atrivedi.geospatial.vessel_tracking_spatial
LIMIT 5;

-- ============================================================================
-- PART 3: OPTION 2 - MATERIALIZED VIEW (BEST PERFORMANCE)
-- ============================================================================

-- For better query performance, create materialized view
CREATE MATERIALIZED VIEW IF NOT EXISTS atrivedi.geospatial.vessel_tracking_mv AS
SELECT
  mmsi,
  vessel_name,
  lat,
  lon,
  ts,
  sog,
  cog,
  heading,
  vessel_type,
  status,
  ST_Point(lon, lat) as location
FROM atrivedi.geospatial.vessel_tracking
WHERE lat IS NOT NULL AND lon IS NOT NULL;

-- Optimize for spatial queries
OPTIMIZE atrivedi.geospatial.vessel_tracking_mv ZORDER BY (location);

-- Analyze table statistics
ANALYZE TABLE atrivedi.geospatial.vessel_tracking_mv
COMPUTE STATISTICS FOR ALL COLUMNS;

-- ============================================================================
-- PART 4: OPTION 3 - H3 HEXAGON AGGREGATION (FOR MILLIONS OF ROWS)
-- ============================================================================

-- Create H3 aggregation at resolution 7 (~5 km² hexagons)
CREATE OR REPLACE TABLE atrivedi.geospatial.vessel_h3_hexagons AS
SELECT
  H3_LatLngToCell(lat, lon, 7) as h3_cell,
  COUNT(*) as total_positions,
  COUNT(DISTINCT mmsi) as unique_vessels,
  AVG(sog) as avg_speed,
  MAX(sog) as max_speed,
  COLLECT_SET(vessel_type) as vessel_types,
  MIN(ts) as earliest_timestamp,
  MAX(ts) as latest_timestamp,
  H3_CellToPolygon(H3_LatLngToCell(lat, lon, 7)) as cell_polygon
FROM atrivedi.geospatial.vessel_tracking
WHERE lat IS NOT NULL AND lon IS NOT NULL
GROUP BY H3_LatLngToCell(lat, lon, 7);

-- Optimize H3 table
OPTIMIZE atrivedi.geospatial.vessel_h3_hexagons ZORDER BY (cell_polygon);

-- Check results
SELECT COUNT(*) as total_hexagons,
       SUM(total_positions) as total_positions,
       SUM(unique_vessels) as unique_vessels
FROM atrivedi.geospatial.vessel_h3_hexagons;

-- ============================================================================
-- PART 5: OPTION 4 - VESSEL TRAJECTORIES (LINES)
-- ============================================================================

-- Create daily vessel trajectories (lines)
CREATE OR REPLACE VIEW atrivedi.geospatial.vessel_daily_routes AS
SELECT
  mmsi,
  MAX(vessel_name) as vessel_name,
  DATE(ts) as track_date,
  MIN(ts) as start_time,
  MAX(ts) as end_time,
  COUNT(*) as position_count,
  AVG(sog) as avg_speed,
  ST_MakeLine(
    ARRAY_AGG(
      ST_Point(lon, lat)
      ORDER BY ts
    )
  ) as route
FROM atrivedi.geospatial.vessel_tracking
WHERE lat IS NOT NULL AND lon IS NOT NULL
GROUP BY mmsi, DATE(ts);

-- Test trajectories
SELECT mmsi, vessel_name, track_date, position_count,
       ST_AsText(route) as route_wkt
FROM atrivedi.geospatial.vessel_daily_routes
LIMIT 3;

-- ============================================================================
-- PART 6: TEST QUERIES FOR CUSTOM DATA PROVIDER
-- ============================================================================

-- Test 1: Point geometry (view)
SELECT mmsi, vessel_name, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.vessel_tracking_spatial
LIMIT 5;

-- Test 2: Point geometry (materialized view)
SELECT mmsi, vessel_name, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.vessel_tracking_mv
LIMIT 5;

-- Test 3: H3 hexagons (polygons)
SELECT h3_cell, total_positions, unique_vessels,
       ST_AsGeoJSON(cell_polygon) as geometry
FROM atrivedi.geospatial.vessel_h3_hexagons
ORDER BY total_positions DESC
LIMIT 5;

-- Test 4: Vessel routes (lines)
SELECT mmsi, vessel_name, track_date,
       ST_AsGeoJSON(route) as geometry
FROM atrivedi.geospatial.vessel_daily_routes
WHERE track_date = CURRENT_DATE() - INTERVAL 1 DAY
LIMIT 5;

-- Test 5: Spatial filter (bounding box around California)
SELECT mmsi, vessel_name, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.vessel_tracking_spatial
WHERE ST_Intersects(
  location,
  ST_GeomFromText('POLYGON((-125 32, -117 32, -117 42, -125 42, -125 32))')
)
LIMIT 100;

-- Test 6: Filter by vessel type
SELECT mmsi, vessel_name, vessel_type, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.vessel_tracking_spatial
WHERE vessel_type = 'cargo'
LIMIT 50;

-- ============================================================================
-- PART 7: PERFORMANCE COMPARISON
-- ============================================================================

-- Compare query performance (run each separately)

-- Original table with computed geometry (slowest)
SELECT COUNT(*) FROM (
  SELECT mmsi, ST_AsGeoJSON(ST_Point(lon, lat)) as geom
  FROM atrivedi.geospatial.vessel_tracking
  WHERE lat IS NOT NULL AND lon IS NOT NULL
  LIMIT 1000
);

-- View with geometry (moderate)
SELECT COUNT(*) FROM (
  SELECT mmsi, ST_AsGeoJSON(location) as geom
  FROM atrivedi.geospatial.vessel_tracking_spatial
  LIMIT 1000
);

-- Materialized view with Z-ordering (fast)
SELECT COUNT(*) FROM (
  SELECT mmsi, ST_AsGeoJSON(location) as geom
  FROM atrivedi.geospatial.vessel_tracking_mv
  LIMIT 1000
);

-- H3 aggregation (fastest for visualization)
SELECT COUNT(*) FROM (
  SELECT h3_cell, ST_AsGeoJSON(cell_polygon) as geom
  FROM atrivedi.geospatial.vessel_h3_hexagons
  LIMIT 1000
);

-- ============================================================================
-- SUMMARY OF CREATED OBJECTS
-- ============================================================================

/*
1. VIEW: atrivedi.geospatial.vessel_tracking_spatial
   - Use for: Real-time point visualization
   - Geometry: location (Point)
   - ID Field: mmsi

2. MATERIALIZED VIEW: atrivedi.geospatial.vessel_tracking_mv
   - Use for: Production point visualization (best performance)
   - Geometry: location (Point)
   - ID Field: mmsi

3. TABLE: atrivedi.geospatial.vessel_h3_hexagons
   - Use for: Aggregated heatmap visualization
   - Geometry: cell_polygon (Polygon)
   - ID Field: h3_cell

4. VIEW: atrivedi.geospatial.vessel_daily_routes
   - Use for: Vessel trajectory visualization
   - Geometry: route (LineString)
   - ID Field: mmsi + track_date
*/

-- ============================================================================
-- CURL EXAMPLES FOR CUSTOM DATA PROVIDER
-- ============================================================================

/*
# Point visualization (live view)
curl "http://localhost:3000/query?\
table=atrivedi.geospatial.vessel_tracking_spatial&\
geometryColumn=location&\
idField=mmsi&\
resultRecordCount=100&\
f=geojson"

# Point visualization (optimized materialized view)
curl "http://localhost:3000/query?\
table=atrivedi.geospatial.vessel_tracking_mv&\
geometryColumn=location&\
idField=mmsi&\
resultRecordCount=100&\
f=geojson"

# H3 hexagon heatmap
curl "http://localhost:3000/query?\
table=atrivedi.geospatial.vessel_h3_hexagons&\
geometryColumn=cell_polygon&\
idField=h3_cell&\
where=total_positions>10&\
f=geojson"

# Vessel trajectories (lines)
curl "http://localhost:3000/query?\
table=atrivedi.geospatial.vessel_daily_routes&\
geometryColumn=route&\
idField=mmsi&\
where=track_date=CURRENT_DATE()-1&\
f=geojson"

# Spatial filter (California coast)
curl "http://localhost:3000/query?\
table=atrivedi.geospatial.vessel_tracking_mv&\
geometryColumn=location&\
idField=mmsi&\
geometry=-125,32,-117,42&\
spatialRel=esriSpatialRelIntersects&\
f=geojson"

# Filter by vessel type
curl "http://localhost:3000/query?\
table=atrivedi.geospatial.vessel_tracking_mv&\
geometryColumn=location&\
idField=mmsi&\
where=vessel_type='cargo'&\
f=geojson"
*/

-- ============================================================================
-- ARCGIS SERVER DEPLOYMENT
-- ============================================================================

/*
# Create Feature Service for live vessel positions
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "VesselTracking" \
  --service-parameters "tableName:atrivedi.geospatial.vessel_tracking_mv,geometryColumn:location,idField:mmsi"

# Create Feature Service for H3 heatmap
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "VesselHeatmap" \
  --service-parameters "tableName:atrivedi.geospatial.vessel_h3_hexagons,geometryColumn:cell_polygon,idField:h3_cell"

# Create Feature Service for vessel routes
cdf create-service databricks-geospatial-provider \
  https://your-server/arcgis/admin YOUR_TOKEN \
  -s "VesselRoutes" \
  --service-parameters "tableName:atrivedi.geospatial.vessel_daily_routes,geometryColumn:route,idField:mmsi"
*/

-- ============================================================================
-- REFRESH MATERIALIZED VIEWS (RUN PERIODICALLY)
-- ============================================================================

-- Refresh materialized view with latest data
REFRESH MATERIALIZED VIEW atrivedi.geospatial.vessel_tracking_mv;

-- Re-optimize after refresh
OPTIMIZE atrivedi.geospatial.vessel_tracking_mv ZORDER BY (location);

-- Schedule refresh via Databricks job
-- (Set up in Databricks Workflows to run hourly/daily)
