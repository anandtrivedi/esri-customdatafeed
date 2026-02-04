-- Create Test Table for Databricks Community Edition
-- Run this in your Databricks SQL Editor

-- Create table in workspace.default (Databricks Community Edition)
CREATE TABLE IF NOT EXISTS workspace.default.koop_test_cities (
  objectid BIGINT,
  city_name STRING,
  population INT,
  state STRING,
  geometry_wkt STRING,
  srid INT
) USING DELTA;

-- Insert 10 US cities
INSERT INTO workspace.default.koop_test_cities VALUES
  (1, 'San Francisco', 874961, 'California', 'POINT(-122.4194 37.7749)', 4326),
  (2, 'Los Angeles', 3979576, 'California', 'POINT(-118.2437 34.0522)', 4326),
  (3, 'New York', 8336817, 'New York', 'POINT(-74.0060 40.7128)', 4326),
  (4, 'Chicago', 2693976, 'Illinois', 'POINT(-87.6298 41.8781)', 4326),
  (5, 'Houston', 2320268, 'Texas', 'POINT(-95.3698 29.7604)', 4326),
  (6, 'Seattle', 753675, 'Washington', 'POINT(-122.3321 47.6062)', 4326),
  (7, 'Denver', 727211, 'Colorado', 'POINT(-104.9903 39.7392)', 4326),
  (8, 'Boston', 692600, 'Massachusetts', 'POINT(-71.0589 42.3601)', 4326),
  (9, 'Miami', 467963, 'Florida', 'POINT(-80.1918 25.7617)', 4326),
  (10, 'Portland', 654741, 'Oregon', 'POINT(-122.6765 45.5231)', 4326);

-- Verify data was inserted
SELECT COUNT(*) as total_cities FROM workspace.default.koop_test_cities;

-- View sample data
SELECT * FROM workspace.default.koop_test_cities LIMIT 5;
