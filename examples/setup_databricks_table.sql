-- Sample SQL scripts for setting up Databricks tables for the Custom Data Feed

-- ============================================================
-- Example 1: Point geometry table with generated geometry
-- ============================================================

CREATE CATALOG IF NOT EXISTS geospatial_demo;
CREATE SCHEMA IF NOT EXISTS geospatial_demo.locations;

-- Table with point locations
CREATE OR REPLACE TABLE geospatial_demo.locations.restaurants (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  name STRING,
  category STRING,
  address STRING,
  city STRING,
  state STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  rating DOUBLE,
  price_range STRING,
  created_date TIMESTAMP,
  -- Generated geometry column from lat/lon
  geometry GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
) USING DELTA;

-- Insert sample data
INSERT INTO geospatial_demo.locations.restaurants
  (name, category, address, city, state, latitude, longitude, rating, price_range, created_date)
VALUES
  ('Golden Gate Grill', 'restaurant', '123 Market St', 'San Francisco', 'CA', 37.7749, -122.4194, 4.5, '$$', current_timestamp()),
  ('Bay Cafe', 'cafe', '456 Mission St', 'San Francisco', 'CA', 37.7858, -122.3962, 4.2, '$', current_timestamp()),
  ('Pacific Diner', 'restaurant', '789 Valencia St', 'San Francisco', 'CA', 37.7599, -122.4210, 4.7, '$$$', current_timestamp()),
  ('Downtown Coffee', 'cafe', '321 Montgomery St', 'San Francisco', 'CA', 37.7938, -122.4024, 4.0, '$', current_timestamp()),
  ('Sunset Bistro', 'restaurant', '654 Irving St', 'San Francisco', 'CA', 37.7638, -122.4668, 4.6, '$$', current_timestamp());


-- ============================================================
-- Example 2: Polygon geometry table with WKT
-- ============================================================

CREATE OR REPLACE TABLE geospatial_demo.locations.service_areas (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  name STRING,
  service_type STRING,
  population INT,
  area_sq_km DOUBLE,
  geometry_wkt STRING,
  -- Parse WKT into geometry
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

-- Insert sample polygons (neighborhoods)
INSERT INTO geospatial_demo.locations.service_areas
  (name, service_type, population, area_sq_km, geometry_wkt)
VALUES
  ('Financial District', 'delivery', 15000, 2.5,
   'POLYGON((-122.405 37.790, -122.405 37.800, -122.390 37.800, -122.390 37.790, -122.405 37.790))'),
  ('Mission District', 'delivery', 45000, 8.2,
   'POLYGON((-122.430 37.745, -122.430 37.770, -122.400 37.770, -122.400 37.745, -122.430 37.745))'),
  ('Richmond District', 'delivery', 38000, 12.4,
   'POLYGON((-122.510 37.770, -122.510 37.800, -122.450 37.800, -122.450 37.770, -122.510 37.770))');


-- ============================================================
-- Example 3: LineString geometry (routes)
-- ============================================================

CREATE OR REPLACE TABLE geospatial_demo.locations.delivery_routes (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  route_name STRING,
  driver_name STRING,
  route_length_km DOUBLE,
  estimated_time_minutes INT,
  geometry_wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

-- Insert sample routes
INSERT INTO geospatial_demo.locations.delivery_routes
  (route_name, driver_name, route_length_km, estimated_time_minutes, geometry_wkt)
VALUES
  ('Route A', 'John Doe', 15.3, 45,
   'LINESTRING(-122.4194 37.7749, -122.4084 37.7849, -122.3974 37.7949)'),
  ('Route B', 'Jane Smith', 22.7, 60,
   'LINESTRING(-122.4194 37.7749, -122.4494 37.7649, -122.4794 37.7549)');


-- ============================================================
-- Useful Queries for Testing the Data Feed
-- ============================================================

-- Query 1: Get all restaurants with their geometries as GeoJSON
SELECT
  id,
  name,
  category,
  city,
  rating,
  ST_AsGeoJSON(geometry) as geometry_geojson
FROM geospatial_demo.locations.restaurants;


-- Query 2: Find restaurants within a bounding box
SELECT
  id,
  name,
  category,
  ST_AsGeoJSON(geometry) as geometry_geojson
FROM geospatial_demo.locations.restaurants
WHERE ST_Intersects(
  geometry,
  ST_GeomFromText('POLYGON((-122.45 37.76, -122.45 37.79, -122.38 37.79, -122.38 37.76, -122.45 37.76))')
);


-- Query 3: Find restaurants within 5km of a point (using ST_Distance)
SELECT
  id,
  name,
  category,
  ST_Distance(geometry, ST_Point(-122.4194, 37.7749)) * 111.32 as distance_km,
  ST_AsGeoJSON(geometry) as geometry_geojson
FROM geospatial_demo.locations.restaurants
WHERE ST_Distance(geometry, ST_Point(-122.4194, 37.7749)) * 111.32 < 5
ORDER BY distance_km;


-- Query 4: Find restaurants within a service area
SELECT
  r.id,
  r.name,
  r.category,
  s.name as service_area,
  ST_AsGeoJSON(r.geometry) as geometry_geojson
FROM geospatial_demo.locations.restaurants r
JOIN geospatial_demo.locations.service_areas s
  ON ST_Within(r.geometry, s.geometry);


-- Query 5: Get extent (bounding box) of all restaurants
SELECT
  MIN(ST_X(geometry)) as min_longitude,
  MAX(ST_X(geometry)) as max_longitude,
  MIN(ST_Y(geometry)) as min_latitude,
  MAX(ST_Y(geometry)) as max_latitude
FROM geospatial_demo.locations.restaurants;


-- Query 6: Buffer analysis - find restaurants near a route
SELECT
  r.id,
  r.name,
  rt.route_name,
  ST_AsGeoJSON(r.geometry) as geometry_geojson
FROM geospatial_demo.locations.restaurants r
CROSS JOIN geospatial_demo.locations.delivery_routes rt
WHERE ST_Distance(r.geometry, rt.geometry) * 111.32 < 1  -- Within 1km
  AND rt.route_name = 'Route A';


-- Query 7: Aggregate by spatial area
SELECT
  s.name as service_area,
  s.service_type,
  COUNT(r.id) as restaurant_count,
  AVG(r.rating) as avg_rating,
  ST_AsGeoJSON(s.geometry) as area_geometry
FROM geospatial_demo.locations.service_areas s
LEFT JOIN geospatial_demo.locations.restaurants r
  ON ST_Within(r.geometry, s.geometry)
GROUP BY s.id, s.name, s.service_type, s.geometry;


-- ============================================================
-- Optimization: Create indexes and optimize tables
-- ============================================================

-- Optimize tables for better query performance
OPTIMIZE geospatial_demo.locations.restaurants;
OPTIMIZE geospatial_demo.locations.service_areas;
OPTIMIZE geospatial_demo.locations.delivery_routes;

-- Analyze tables for statistics
ANALYZE TABLE geospatial_demo.locations.restaurants COMPUTE STATISTICS;
ANALYZE TABLE geospatial_demo.locations.service_areas COMPUTE STATISTICS;
ANALYZE TABLE geospatial_demo.locations.delivery_routes COMPUTE STATISTICS;


-- ============================================================
-- Grant permissions (if using Unity Catalog)
-- ============================================================

-- Grant SELECT permission to a user or service principal
-- GRANT SELECT ON TABLE geospatial_demo.locations.restaurants TO `user@example.com`;
-- GRANT SELECT ON SCHEMA geospatial_demo.locations TO `user@example.com`;


-- ============================================================
-- View table schema
-- ============================================================

DESCRIBE TABLE geospatial_demo.locations.restaurants;
DESCRIBE EXTENDED geospatial_demo.locations.restaurants;
