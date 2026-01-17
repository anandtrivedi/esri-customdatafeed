-- Check and Create Sample Data for Testing
-- Run this in Databricks SQL Editor

-- ============================================================================
-- PART 1: CHECK EXISTING TABLES
-- ============================================================================

-- List all tables in atrivedi.geospatial
SHOW TABLES IN atrivedi.geospatial;

-- Check vessel_tracking table structure
DESCRIBE TABLE atrivedi.geospatial.vessel_tracking;

-- Check row count
SELECT COUNT(*) as total_rows FROM atrivedi.geospatial.vessel_tracking;

-- Check for geometry columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_catalog = 'atrivedi'
  AND table_schema = 'geospatial'
  AND table_name = 'vessel_tracking';

-- Sample data from vessel_tracking
SELECT * FROM atrivedi.geospatial.vessel_tracking LIMIT 5;

-- ============================================================================
-- PART 2: CREATE SAMPLE TABLES IF NEEDED
-- ============================================================================

-- Option 1: If vessel_tracking has lat/lon but no geometry column, add it
-- (Uncomment if needed)
/*
ALTER TABLE atrivedi.geospatial.vessel_tracking
ADD COLUMN location GEOMETRY GENERATED ALWAYS AS (
  ST_Point(lon, lat)
);
*/

-- Option 2: Create sample restaurants table (from original sample-data.sql)
CREATE TABLE IF NOT EXISTS atrivedi.geospatial.sample_restaurants (
  restaurant_id BIGINT,
  name STRING,
  category STRING,
  rating DOUBLE,
  price_level INT,
  latitude DOUBLE,
  longitude DOUBLE,
  location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude)),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- Insert sample data (NYC area)
INSERT INTO atrivedi.geospatial.sample_restaurants
  (restaurant_id, name, category, rating, price_level, latitude, longitude)
VALUES
  (1, 'Little Italy Pizza', 'Italian', 4.5, 2, 40.7589, -73.9851),
  (2, 'Sakura Sushi', 'Japanese', 4.8, 3, 40.7614, -73.9776),
  (3, 'Taco Fiesta', 'Mexican', 4.2, 1, 40.7580, -73.9855),
  (4, 'Le Bistro', 'French', 4.7, 4, 40.7622, -73.9789),
  (5, 'Burger Palace', 'American', 4.0, 2, 40.7595, -73.9845),
  (6, 'Pho House', 'Vietnamese', 4.6, 2, 40.7605, -73.9830),
  (7, 'Curry Kitchen', 'Indian', 4.4, 2, 40.7598, -73.9862),
  (8, 'Greek Taverna', 'Greek', 4.3, 3, 40.7618, -73.9795),
  (9, 'BBQ Smokehouse', 'BBQ', 4.5, 2, 40.7585, -73.9840),
  (10, 'Vegetarian Delight', 'Vegetarian', 4.7, 2, 40.7610, -73.9820),
  (11, 'Dim Sum Palace', 'Chinese', 4.6, 2, 40.7600, -73.9850),
  (12, 'Pasta Roma', 'Italian', 4.4, 3, 40.7590, -73.9835),
  (13, 'Thai Spice', 'Thai', 4.5, 2, 40.7608, -73.9825),
  (14, 'Steakhouse Prime', 'Steakhouse', 4.8, 4, 40.7615, -73.9805),
  (15, 'Seafood Catch', 'Seafood', 4.6, 3, 40.7592, -73.9842);

-- Verify
SELECT COUNT(*) as count,
       MIN(latitude) as min_lat, MAX(latitude) as max_lat,
       MIN(longitude) as min_lon, MAX(longitude) as max_lon
FROM atrivedi.geospatial.sample_restaurants;

-- Check geometry
SELECT restaurant_id, name, ST_AsText(location) as location_wkt
FROM atrivedi.geospatial.sample_restaurants
LIMIT 5;

-- ============================================================================
-- PART 3: TEST QUERIES FOR CUSTOM DATA PROVIDER
-- ============================================================================

-- Test 1: Basic query with GeoJSON output
SELECT restaurant_id, name, category, rating,
       ST_AsGeoJSON(location) as geometry_geojson
FROM atrivedi.geospatial.sample_restaurants
LIMIT 5;

-- Test 2: Extent calculation (for metadata)
SELECT ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(location))) as extent
FROM atrivedi.geospatial.sample_restaurants;

-- Test 3: Spatial query (bounding box)
SELECT restaurant_id, name, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.sample_restaurants
WHERE ST_Intersects(
  location,
  ST_GeomFromText('POLYGON((-73.990 40.755, -73.980 40.755, -73.980 40.765, -73.990 40.765, -73.990 40.755))')
);

-- Test 4: WHERE clause filter
SELECT restaurant_id, name, category, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.sample_restaurants
WHERE category IN ('Italian', 'Japanese')
ORDER BY rating DESC;

-- Test 5: Count query
SELECT COUNT(*) as total_count
FROM atrivedi.geospatial.sample_restaurants;

-- Test 6: Pagination
SELECT restaurant_id, name, ST_AsGeoJSON(location) as geometry
FROM atrivedi.geospatial.sample_restaurants
ORDER BY restaurant_id
LIMIT 5 OFFSET 0;

-- ============================================================================
-- PART 4: OPTIMIZE FOR PERFORMANCE
-- ============================================================================

-- Enable Z-ordering for spatial queries
OPTIMIZE atrivedi.geospatial.sample_restaurants
ZORDER BY (location);

-- Collect statistics
ANALYZE TABLE atrivedi.geospatial.sample_restaurants
COMPUTE STATISTICS FOR ALL COLUMNS;

-- ============================================================================
-- PART 5: CHECK VESSEL TRACKING FOR LARGE DATASET TESTING
-- ============================================================================

-- Get vessel_tracking info
SELECT
  COUNT(*) as total_rows,
  COUNT(DISTINCT MMSI) as unique_vessels,
  MIN(BaseDateTime) as earliest_date,
  MAX(BaseDateTime) as latest_date
FROM atrivedi.geospatial.vessel_tracking;

-- Check if it has geometry or needs to be created
-- (You may need to run this if vessel_tracking has lat/lon but no geometry)
/*
-- Create geometry column from lat/lon if needed
ALTER TABLE atrivedi.geospatial.vessel_tracking
ADD COLUMN vessel_location GEOMETRY GENERATED ALWAYS AS (
  CASE
    WHEN LAT IS NOT NULL AND LON IS NOT NULL
    THEN ST_Point(LON, LAT)
    ELSE NULL
  END
);

-- Optimize the vessel tracking table
OPTIMIZE atrivedi.geospatial.vessel_tracking
ZORDER BY (vessel_location);
*/

-- Sample vessel data with geometry
SELECT *
FROM atrivedi.geospatial.vessel_tracking
LIMIT 5;

-- ============================================================================
-- PART 6: CREATE H3 AGGREGATION FOR LARGE DATASET (IF NEEDED)
-- ============================================================================

/*
-- For very large vessel_tracking dataset, create H3 aggregated view
-- This reduces millions of points to thousands of hexagons

CREATE OR REPLACE TABLE atrivedi.geospatial.vessel_tracking_h3 AS
SELECT
  H3_LatLngToCell(LAT, LON, 7) as h3_cell,
  COUNT(*) as vessel_count,
  COUNT(DISTINCT MMSI) as unique_vessels,
  AVG(SOG) as avg_speed,
  H3_CellToPolygon(H3_LatLngToCell(LAT, LON, 7)) as cell_geometry
FROM atrivedi.geospatial.vessel_tracking
WHERE LAT IS NOT NULL AND LON IS NOT NULL
GROUP BY H3_LatLngToCell(LAT, LON, 7);

-- Optimize H3 table
OPTIMIZE atrivedi.geospatial.vessel_tracking_h3
ZORDER BY (cell_geometry);

-- Test H3 aggregation
SELECT COUNT(*) as total_hexagons FROM atrivedi.geospatial.vessel_tracking_h3;
*/

-- ============================================================================
-- SUMMARY OF TABLES FOR PROVIDER TESTING
-- ============================================================================

-- Small dataset (15 rows) - Good for basic testing
-- Table: atrivedi.geospatial.sample_restaurants
-- Geometry column: location
-- ID field: restaurant_id

-- Large dataset (millions of rows?) - Good for performance testing
-- Table: atrivedi.geospatial.vessel_tracking
-- Geometry column: vessel_location (or to be created)
-- ID field: MMSI

-- Medium dataset (aggregated) - Good for performance testing
-- Table: atrivedi.geospatial.vessel_tracking_h3
-- Geometry column: cell_geometry
-- ID field: h3_cell
