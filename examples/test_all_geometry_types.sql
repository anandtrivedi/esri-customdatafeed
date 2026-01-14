-- ============================================================
-- Comprehensive Test for All Geometry Types
-- Tests Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon
-- ============================================================

-- Create test catalog and schema
CREATE CATALOG IF NOT EXISTS geometry_test;
CREATE SCHEMA IF NOT EXISTS geometry_test.all_types;

-- ============================================================
-- 1. POINT Geometry
-- ============================================================

CREATE OR REPLACE TABLE geometry_test.all_types.test_points (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  name STRING,
  category STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  elevation DOUBLE,
  -- Point geometry from coordinates
  geometry GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
) USING DELTA;

INSERT INTO geometry_test.all_types.test_points
  (name, category, latitude, longitude, elevation)
VALUES
  ('Store A', 'retail', 37.7749, -122.4194, 10.5),
  ('Store B', 'retail', 37.7858, -122.3962, 8.2),
  ('Warehouse C', 'warehouse', 37.7599, -122.4210, 5.0),
  ('Office D', 'office', 37.7938, -122.4024, 15.3);

-- Test query
SELECT
  id,
  name,
  category,
  ST_AsText(geometry) as wkt,
  ST_AsGeoJSON(geometry) as geojson,
  ST_GeometryType(geometry) as geom_type
FROM geometry_test.all_types.test_points;


-- ============================================================
-- 2. MULTIPOINT Geometry
-- ============================================================

CREATE OR REPLACE TABLE geometry_test.all_types.test_multipoints (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  cluster_name STRING,
  point_count INT,
  geometry_wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

INSERT INTO geometry_test.all_types.test_multipoints
  (cluster_name, point_count, geometry_wkt)
VALUES
  ('Cluster North', 3, 'MULTIPOINT((-122.4 37.8), (-122.41 37.81), (-122.39 37.79))'),
  ('Cluster South', 4, 'MULTIPOINT((-122.42 37.75), (-122.43 37.74), (-122.41 37.76), (-122.44 37.75))'),
  ('Cluster East', 2, 'MULTIPOINT((-122.38 37.78), (-122.37 37.77))');

-- Test query
SELECT
  id,
  cluster_name,
  point_count,
  ST_AsText(geometry) as wkt,
  ST_AsGeoJSON(geometry) as geojson,
  ST_GeometryType(geometry) as geom_type,
  ST_NumGeometries(geometry) as num_points
FROM geometry_test.all_types.test_multipoints;


-- ============================================================
-- 3. LINESTRING Geometry
-- ============================================================

CREATE OR REPLACE TABLE geometry_test.all_types.test_linestrings (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  route_name STRING,
  route_type STRING,
  length_km DOUBLE,
  geometry_wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

INSERT INTO geometry_test.all_types.test_linestrings
  (route_name, route_type, length_km, geometry_wkt)
VALUES
  ('Route 1', 'delivery', 5.2, 'LINESTRING(-122.42 37.78, -122.41 37.77, -122.40 37.76, -122.39 37.75)'),
  ('Highway 101', 'highway', 15.8, 'LINESTRING(-122.45 37.80, -122.43 37.78, -122.41 37.76, -122.39 37.74, -122.37 37.72)'),
  ('Walking Path', 'pedestrian', 1.2, 'LINESTRING(-122.415 37.775, -122.414 37.774, -122.413 37.773)');

-- Test query
SELECT
  id,
  route_name,
  route_type,
  length_km,
  ST_AsText(geometry) as wkt,
  ST_AsGeoJSON(geometry) as geojson,
  ST_GeometryType(geometry) as geom_type,
  ST_Length(geometry) as calculated_length
FROM geometry_test.all_types.test_linestrings;


-- ============================================================
-- 4. MULTILINESTRING Geometry
-- ============================================================

CREATE OR REPLACE TABLE geometry_test.all_types.test_multilinestrings (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  network_name STRING,
  line_count INT,
  geometry_wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

INSERT INTO geometry_test.all_types.test_multilinestrings
  (network_name, line_count, geometry_wkt)
VALUES
  ('River System', 2,
   'MULTILINESTRING((-122.42 37.80, -122.40 37.78, -122.38 37.76), (-122.41 37.79, -122.39 37.77))'),
  ('Power Lines', 3,
   'MULTILINESTRING((-122.45 37.82, -122.43 37.80), (-122.43 37.80, -122.41 37.78), (-122.41 37.78, -122.39 37.76))');

-- Test query
SELECT
  id,
  network_name,
  line_count,
  ST_AsText(geometry) as wkt,
  ST_AsGeoJSON(geometry) as geojson,
  ST_GeometryType(geometry) as geom_type,
  ST_NumGeometries(geometry) as num_lines
FROM geometry_test.all_types.test_multilinestrings;


-- ============================================================
-- 5. POLYGON Geometry
-- ============================================================

CREATE OR REPLACE TABLE geometry_test.all_types.test_polygons (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  zone_name STRING,
  zone_type STRING,
  area_sq_km DOUBLE,
  geometry_wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

INSERT INTO geometry_test.all_types.test_polygons
  (zone_name, zone_type, area_sq_km, geometry_wkt)
VALUES
  ('Downtown Zone', 'commercial', 2.5,
   'POLYGON((-122.42 37.79, -122.42 37.78, -122.40 37.78, -122.40 37.79, -122.42 37.79))'),
  ('Park Area', 'recreation', 1.8,
   'POLYGON((-122.45 37.77, -122.45 37.76, -122.43 37.76, -122.43 37.77, -122.45 37.77))'),
  ('Industrial District', 'industrial', 5.2,
   'POLYGON((-122.48 37.75, -122.48 37.73, -122.45 37.73, -122.45 37.75, -122.48 37.75))'),
  -- Polygon with hole (donut)
  ('Protected Area with Exclusion', 'protected', 3.0,
   'POLYGON((-122.50 37.80, -122.50 37.78, -122.47 37.78, -122.47 37.80, -122.50 37.80), (-122.49 37.795, -122.49 37.785, -122.48 37.785, -122.48 37.795, -122.49 37.795))');

-- Test query
SELECT
  id,
  zone_name,
  zone_type,
  area_sq_km,
  ST_AsText(geometry) as wkt,
  ST_AsGeoJSON(geometry) as geojson,
  ST_GeometryType(geometry) as geom_type,
  ST_Area(geometry) as calculated_area,
  ST_NumInteriorRings(geometry) as num_holes
FROM geometry_test.all_types.test_polygons;


-- ============================================================
-- 6. MULTIPOLYGON Geometry
-- ============================================================

CREATE OR REPLACE TABLE geometry_test.all_types.test_multipolygons (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  region_name STRING,
  polygon_count INT,
  geometry_wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt))
) USING DELTA;

INSERT INTO geometry_test.all_types.test_multipolygons
  (region_name, polygon_count, geometry_wkt)
VALUES
  ('Islands Group A', 2,
   'MULTIPOLYGON(((-122.42 37.82, -122.42 37.81, -122.41 37.81, -122.41 37.82, -122.42 37.82)), ((-122.40 37.82, -122.40 37.81, -122.39 37.81, -122.39 37.82, -122.40 37.82)))'),
  ('Disconnected Parcels', 3,
   'MULTIPOLYGON(((-122.45 37.79, -122.45 37.78, -122.44 37.78, -122.44 37.79, -122.45 37.79)), ((-122.43 37.77, -122.43 37.76, -122.42 37.76, -122.42 37.77, -122.43 37.77)), ((-122.41 37.75, -122.41 37.74, -122.40 37.74, -122.40 37.75, -122.41 37.75)))');

-- Test query
SELECT
  id,
  region_name,
  polygon_count,
  ST_AsText(geometry) as wkt,
  ST_AsGeoJSON(geometry) as geojson,
  ST_GeometryType(geometry) as geom_type,
  ST_NumGeometries(geometry) as num_polygons,
  ST_Area(geometry) as total_area
FROM geometry_test.all_types.test_multipolygons;


-- ============================================================
-- Combined Query: All Geometry Types
-- ============================================================

-- Union all geometry types for comprehensive view
SELECT
  'Point' as geometry_category,
  id,
  name as feature_name,
  ST_GeometryType(geometry) as type,
  ST_AsGeoJSON(geometry) as geojson
FROM geometry_test.all_types.test_points

UNION ALL

SELECT
  'MultiPoint' as geometry_category,
  id,
  cluster_name as feature_name,
  ST_GeometryType(geometry) as type,
  ST_AsGeoJSON(geometry) as geojson
FROM geometry_test.all_types.test_multipoints

UNION ALL

SELECT
  'LineString' as geometry_category,
  id,
  route_name as feature_name,
  ST_GeometryType(geometry) as type,
  ST_AsGeoJSON(geometry) as geojson
FROM geometry_test.all_types.test_linestrings

UNION ALL

SELECT
  'MultiLineString' as geometry_category,
  id,
  network_name as feature_name,
  ST_GeometryType(geometry) as type,
  ST_AsGeoJSON(geometry) as geojson
FROM geometry_test.all_types.test_multilinestrings

UNION ALL

SELECT
  'Polygon' as geometry_category,
  id,
  zone_name as feature_name,
  ST_GeometryType(geometry) as type,
  ST_AsGeoJSON(geometry) as geojson
FROM geometry_test.all_types.test_polygons

UNION ALL

SELECT
  'MultiPolygon' as geometry_category,
  id,
  region_name as feature_name,
  ST_GeometryType(geometry) as type,
  ST_AsGeoJSON(geometry) as geojson
FROM geometry_test.all_types.test_multipolygons;


-- ============================================================
-- Spatial Queries: Test Each Geometry Type
-- ============================================================

-- Define test bounding box for San Francisco
SET VAR test_bbox = ST_GeomFromText('POLYGON((-122.52 37.70, -122.52 37.85, -122.35 37.85, -122.35 37.70, -122.52 37.70))');

-- 1. Find points in bounding box
SELECT 'Points in bbox' as query_type, COUNT(*) as count
FROM geometry_test.all_types.test_points
WHERE ST_Within(geometry, test_bbox);

-- 2. Find lines intersecting bounding box
SELECT 'Lines intersecting bbox' as query_type, COUNT(*) as count
FROM geometry_test.all_types.test_linestrings
WHERE ST_Intersects(geometry, test_bbox);

-- 3. Find polygons intersecting bounding box
SELECT 'Polygons intersecting bbox' as query_type, COUNT(*) as count
FROM geometry_test.all_types.test_polygons
WHERE ST_Intersects(geometry, test_bbox);

-- 4. Distance calculations
SELECT
  p.name as point_name,
  z.zone_name,
  ST_Distance(p.geometry, z.geometry) * 111.32 as distance_km
FROM geometry_test.all_types.test_points p
CROSS JOIN geometry_test.all_types.test_polygons z
WHERE z.zone_name = 'Downtown Zone'
ORDER BY distance_km
LIMIT 5;


-- ============================================================
-- Optimize Tables for Performance
-- ============================================================

OPTIMIZE geometry_test.all_types.test_points;
OPTIMIZE geometry_test.all_types.test_multipoints;
OPTIMIZE geometry_test.all_types.test_linestrings;
OPTIMIZE geometry_test.all_types.test_multilinestrings;
OPTIMIZE geometry_test.all_types.test_polygons;
OPTIMIZE geometry_test.all_types.test_multipolygons;

-- Compute statistics
ANALYZE TABLE geometry_test.all_types.test_points COMPUTE STATISTICS;
ANALYZE TABLE geometry_test.all_types.test_multipoints COMPUTE STATISTICS;
ANALYZE TABLE geometry_test.all_types.test_linestrings COMPUTE STATISTICS;
ANALYZE TABLE geometry_test.all_types.test_multilinestrings COMPUTE STATISTICS;
ANALYZE TABLE geometry_test.all_types.test_polygons COMPUTE STATISTICS;
ANALYZE TABLE geometry_test.all_types.test_multipolygons COMPUTE STATISTICS;


-- ============================================================
-- Validation Queries
-- ============================================================

-- Check all tables have data
SELECT 'test_points' as table_name, COUNT(*) as row_count FROM geometry_test.all_types.test_points
UNION ALL
SELECT 'test_multipoints', COUNT(*) FROM geometry_test.all_types.test_multipoints
UNION ALL
SELECT 'test_linestrings', COUNT(*) FROM geometry_test.all_types.test_linestrings
UNION ALL
SELECT 'test_multilinestrings', COUNT(*) FROM geometry_test.all_types.test_multilinestrings
UNION ALL
SELECT 'test_polygons', COUNT(*) FROM geometry_test.all_types.test_polygons
UNION ALL
SELECT 'test_multipolygons', COUNT(*) FROM geometry_test.all_types.test_multipolygons;

-- Check all geometries are valid
SELECT 'Points valid' as check_name,
       SUM(CASE WHEN ST_IsValid(geometry) THEN 1 ELSE 0 END) as valid_count,
       COUNT(*) as total_count
FROM geometry_test.all_types.test_points

UNION ALL

SELECT 'Polygons valid',
       SUM(CASE WHEN ST_IsValid(geometry) THEN 1 ELSE 0 END),
       COUNT(*)
FROM geometry_test.all_types.test_polygons

UNION ALL

SELECT 'LineStrings valid',
       SUM(CASE WHEN ST_IsValid(geometry) THEN 1 ELSE 0 END),
       COUNT(*)
FROM geometry_test.all_types.test_linestrings;
