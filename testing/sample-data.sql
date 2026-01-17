-- Sample Data for Testing Databricks Custom Data Provider
-- Run these SQL statements in Databricks SQL Editor

-- Create catalog and schema if needed
-- CREATE CATALOG IF NOT EXISTS testing;
-- CREATE SCHEMA IF NOT EXISTS testing.geodata;

---------------------------------------------------------------------------
-- 1. RESTAURANTS TABLE (Point Geometry)
---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS catalog.schema.restaurants (
  restaurant_id BIGINT,
  name STRING,
  category STRING,
  rating DOUBLE,
  price_level INT,
  latitude DOUBLE,
  longitude DOUBLE,
  location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude)),
  created_at TIMESTAMP
);

-- Insert sample restaurants in New York City
INSERT INTO catalog.schema.restaurants
  (restaurant_id, name, category, rating, price_level, latitude, longitude, created_at)
VALUES
  (1, 'Little Italy Pizza', 'Italian', 4.5, 2, 40.7589, -73.9851, current_timestamp()),
  (2, 'Sakura Sushi', 'Japanese', 4.8, 3, 40.7614, -73.9776, current_timestamp()),
  (3, 'Taco Fiesta', 'Mexican', 4.2, 1, 40.7580, -73.9855, current_timestamp()),
  (4, 'Le Bistro', 'French', 4.7, 4, 40.7622, -73.9789, current_timestamp()),
  (5, 'Burger Palace', 'American', 4.0, 2, 40.7595, -73.9845, current_timestamp()),
  (6, 'Pho House', 'Vietnamese', 4.6, 2, 40.7605, -73.9830, current_timestamp()),
  (7, 'Curry Kitchen', 'Indian', 4.4, 2, 40.7598, -73.9862, current_timestamp()),
  (8, 'Greek Taverna', 'Greek', 4.3, 3, 40.7618, -73.9795, current_timestamp()),
  (9, 'BBQ Smokehouse', 'BBQ', 4.5, 2, 40.7585, -73.9840, current_timestamp()),
  (10, 'Vegetarian Delight', 'Vegetarian', 4.7, 2, 40.7610, -73.9820, current_timestamp());

-- Verify data
SELECT restaurant_id, name, category, ST_AsText(location) as location_wkt
FROM catalog.schema.restaurants
LIMIT 5;

---------------------------------------------------------------------------
-- 2. DELIVERY ZONES TABLE (Polygon Geometry)
---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS catalog.schema.delivery_zones (
  zone_id BIGINT,
  zone_name STRING,
  delivery_fee DOUBLE,
  min_order DOUBLE,
  active BOOLEAN,
  boundary_wkt STRING,
  boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(boundary_wkt))
);

-- Insert sample delivery zones
INSERT INTO catalog.schema.delivery_zones
  (zone_id, zone_name, delivery_fee, min_order, active, boundary_wkt)
VALUES
  (1, 'Downtown', 2.99, 15.00, true,
   'POLYGON((-73.990 40.755, -73.980 40.755, -73.980 40.765, -73.990 40.765, -73.990 40.755))'),
  (2, 'Midtown East', 3.99, 20.00, true,
   'POLYGON((-73.980 40.755, -73.970 40.755, -73.970 40.765, -73.980 40.765, -73.980 40.755))'),
  (3, 'Upper West', 4.99, 25.00, true,
   'POLYGON((-73.990 40.765, -73.980 40.765, -73.980 40.775, -73.990 40.775, -73.990 40.765))');

-- Verify data
SELECT zone_id, zone_name, ST_AsText(boundary) as boundary_wkt
FROM catalog.schema.delivery_zones;

---------------------------------------------------------------------------
-- 3. DELIVERY ROUTES TABLE (LineString Geometry)
---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS catalog.schema.delivery_routes (
  route_id BIGINT,
  route_name STRING,
  driver_name STRING,
  estimated_time INT,  -- minutes
  distance DOUBLE,     -- miles
  path_wkt STRING,
  path GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(path_wkt))
);

-- Insert sample routes
INSERT INTO catalog.schema.delivery_routes
  (route_id, route_name, driver_name, estimated_time, distance, path_wkt)
VALUES
  (1, 'Route A', 'John Doe', 15, 2.5,
   'LINESTRING(-73.9851 40.7589, -73.9830 40.7605, -73.9820 40.7610)'),
  (2, 'Route B', 'Jane Smith', 20, 3.2,
   'LINESTRING(-73.9776 40.7614, -73.9795 40.7618, -73.9789 40.7622)'),
  (3, 'Route C', 'Mike Johnson', 12, 1.8,
   'LINESTRING(-73.9855 40.7580, -73.9845 40.7595, -73.9840 40.7585)');

-- Verify data
SELECT route_id, route_name, ST_AsText(path) as path_wkt
FROM catalog.schema.delivery_routes;

---------------------------------------------------------------------------
-- 4. SPATIAL QUERIES - Test Examples
---------------------------------------------------------------------------

-- Find restaurants near a point (within 0.01 degrees ~ 1km)
SELECT restaurant_id, name, category,
       ST_Distance(location, ST_Point(-73.9851, 40.7589)) as distance
FROM catalog.schema.restaurants
WHERE ST_Distance(location, ST_Point(-73.9851, 40.7589)) < 0.01
ORDER BY distance;

-- Find restaurants within a delivery zone
SELECT r.restaurant_id, r.name, z.zone_name
FROM catalog.schema.restaurants r
CROSS JOIN catalog.schema.delivery_zones z
WHERE ST_Within(r.location, z.boundary);

-- Find restaurants in a bounding box
SELECT restaurant_id, name, ST_AsGeoJSON(location) as geojson
FROM catalog.schema.restaurants
WHERE ST_Intersects(
  location,
  ST_GeomFromText('POLYGON((-73.990 40.755, -73.980 40.755, -73.980 40.765, -73.990 40.765, -73.990 40.755))')
);

-- Calculate extent of all restaurants
SELECT
  ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(location))) as extent
FROM catalog.schema.restaurants;

---------------------------------------------------------------------------
-- 5. H3 BINNING EXAMPLE (Optional - for advanced use cases)
---------------------------------------------------------------------------

-- Create H3 aggregated view of restaurants
CREATE OR REPLACE TABLE catalog.schema.restaurant_h3_bins AS
SELECT
  H3_LatLngToCell(latitude, longitude, 8) as h3_cell,
  COUNT(*) as restaurant_count,
  AVG(rating) as avg_rating,
  COLLECT_LIST(category) as categories,
  H3_CellToPolygon(H3_LatLngToCell(latitude, longitude, 8)) as cell_geometry
FROM catalog.schema.restaurants
GROUP BY H3_LatLngToCell(latitude, longitude, 8);

-- Query H3 bins
SELECT
  h3_cell,
  restaurant_count,
  avg_rating,
  ST_AsGeoJSON(cell_geometry) as geojson
FROM catalog.schema.restaurant_h3_bins
WHERE restaurant_count > 1;

---------------------------------------------------------------------------
-- 6. GRANT PERMISSIONS (if needed)
---------------------------------------------------------------------------

-- Grant SELECT permissions to service principal or user
-- GRANT SELECT ON TABLE catalog.schema.restaurants TO `service-principal-name`;
-- GRANT SELECT ON TABLE catalog.schema.delivery_zones TO `service-principal-name`;
-- GRANT SELECT ON TABLE catalog.schema.delivery_routes TO `service-principal-name`;

---------------------------------------------------------------------------
-- NOTES FOR CUSTOM DATA PROVIDER CONFIGURATION
---------------------------------------------------------------------------

-- For restaurants table, use these service parameters:
--   tableName: catalog.schema.restaurants
--   geometryColumn: location
--   idField: restaurant_id

-- For delivery zones table, use:
--   tableName: catalog.schema.delivery_zones
--   geometryColumn: boundary
--   idField: zone_id

-- For delivery routes table, use:
--   tableName: catalog.schema.delivery_routes
--   geometryColumn: path
--   idField: route_id

-- For H3 bins table, use:
--   tableName: catalog.schema.restaurant_h3_bins
--   geometryColumn: cell_geometry
--   idField: h3_cell
