# Complete Hookup Guide

**Step-by-step guide to connect your Databricks tables with different geometry columns to ArcGIS.**

## Quick Navigation

- [Overview](#overview)
- [Step 1: Prepare Databricks Tables](#step-1-prepare-databricks-tables)
- [Step 2: Configure the Data Feed](#step-2-configure-the-data-feed)
- [Step 3: Start the Server](#step-3-start-the-server)
- [Step 4: Test with curl](#step-4-test-with-curl)
- [Step 5: Connect to ArcGIS](#step-5-connect-to-arcgis)
- [Complete Example](#complete-example-three-tables)

---

## Overview

This guide shows you how to connect **3 different Databricks tables** with **different geometry column names** to ArcGIS:

| Table | Geometry Column | Type |
|-------|----------------|------|
| `stores` | `store_location` | Point |
| `zones` | `zone_boundary` | Polygon |
| `routes` | `route_path` | LineString |

---

## Step 1: Prepare Databricks Tables

### 1.1 Create Tables in Databricks

Run this SQL in Databricks SQL Editor:

```sql
-- Create catalog and schema
CREATE CATALOG IF NOT EXISTS my_company;
CREATE SCHEMA IF NOT EXISTS my_company.operations;

-- Table 1: Store Locations (POINT)
CREATE TABLE my_company.operations.stores (
  store_id BIGINT GENERATED ALWAYS AS IDENTITY,
  store_name STRING,
  address STRING,
  city STRING,
  state STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  -- Geometry column named "store_location"
  store_location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
) USING DELTA;

-- Insert sample data
INSERT INTO my_company.operations.stores
  (store_name, address, city, state, latitude, longitude)
VALUES
  ('Downtown Store', '100 Market St', 'San Francisco', 'CA', 37.7749, -122.4194),
  ('Marina Store', '200 Bay St', 'San Francisco', 'CA', 37.8044, -122.4327),
  ('Mission Store', '300 Valencia St', 'San Francisco', 'CA', 37.7599, -122.4210);


-- Table 2: Delivery Zones (POLYGON)
CREATE TABLE my_company.operations.zones (
  zone_id BIGINT GENERATED ALWAYS AS IDENTITY,
  zone_name STRING,
  zone_type STRING,
  population INT,
  zone_boundary_wkt STRING,
  -- Geometry column named "zone_boundary"
  zone_boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(zone_boundary_wkt))
) USING DELTA;

-- Insert sample data
INSERT INTO my_company.operations.zones
  (zone_name, zone_type, population, zone_boundary_wkt)
VALUES
  ('North Zone', 'delivery', 50000,
   'POLYGON((-122.45 37.80, -122.45 37.83, -122.40 37.83, -122.40 37.80, -122.45 37.80))'),
  ('South Zone', 'delivery', 45000,
   'POLYGON((-122.45 37.75, -122.45 37.78, -122.40 37.78, -122.40 37.75, -122.45 37.75))');


-- Table 3: Delivery Routes (LINESTRING)
CREATE TABLE my_company.operations.routes (
  route_id BIGINT GENERATED ALWAYS AS IDENTITY,
  route_name STRING,
  driver_name STRING,
  route_length_km DOUBLE,
  route_path_wkt STRING,
  -- Geometry column named "route_path"
  route_path GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(route_path_wkt))
) USING DELTA;

-- Insert sample data
INSERT INTO my_company.operations.routes
  (route_name, driver_name, route_length_km, route_path_wkt)
VALUES
  ('Route A', 'John Doe', 15.5,
   'LINESTRING(-122.4194 37.7749, -122.4084 37.7849, -122.3974 37.7949)'),
  ('Route B', 'Jane Smith', 22.3,
   'LINESTRING(-122.4194 37.7749, -122.4394 37.7649, -122.4594 37.7549)');
```

### 1.2 Verify Tables

```sql
-- Check store locations
SELECT
  store_id,
  store_name,
  ST_AsText(store_location) as location_wkt,
  ST_AsGeoJSON(store_location) as location_geojson
FROM my_company.operations.stores;

-- Check zones
SELECT
  zone_id,
  zone_name,
  ST_AsText(zone_boundary) as boundary_wkt
FROM my_company.operations.zones;

-- Check routes
SELECT
  route_id,
  route_name,
  ST_AsText(route_path) as path_wkt
FROM my_company.operations.routes;
```

---

## Step 2: Configure the Data Feed

### Option A: Using JSON Configuration (Recommended)

#### 2.1 Create `config/tables.json`

```bash
mkdir -p config
```

Create `config/tables.json`:

```json
{
  "tables": [
    {
      "table_name": "my_company.operations.stores",
      "geometry_column": "store_location",
      "id_field": "store_id",
      "display_name": "Store Locations",
      "description": "Retail store point locations",
      "layer_id": 0,
      "geometry_type": "esriGeometryPoint",
      "spatial_reference_wkid": 4326,
      "max_record_count": 1000
    },
    {
      "table_name": "my_company.operations.zones",
      "geometry_column": "zone_boundary",
      "id_field": "zone_id",
      "display_name": "Delivery Zones",
      "description": "Delivery zone polygons",
      "layer_id": 1,
      "geometry_type": "esriGeometryPolygon",
      "spatial_reference_wkid": 4326,
      "max_record_count": 1000
    },
    {
      "table_name": "my_company.operations.routes",
      "geometry_column": "route_path",
      "id_field": "route_id",
      "display_name": "Delivery Routes",
      "description": "Delivery route paths",
      "layer_id": 2,
      "geometry_type": "esriGeometryPolyline",
      "spatial_reference_wkid": 4326,
      "max_record_count": 1000
    }
  ]
}
```

#### 2.2 Update `.env` file

Add this line to your `.env` file:

```bash
# Point to your table configuration
TABLE_CONFIG_FILE=/Users/anand.trivedi/Documents/gitprojects/customdatafeeds/config/tables.json

# Your existing Databricks credentials
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=your-token
```

### Option B: Using Environment Variables

Add to `.env` file:

```bash
# Table 0: Stores
TABLE_0_NAME=my_company.operations.stores
TABLE_0_GEOMETRY_COLUMN=store_location
TABLE_0_DISPLAY_NAME=Store Locations
TABLE_0_LAYER_ID=0
TABLE_0_GEOMETRY_TYPE=esriGeometryPoint
TABLE_0_ID_FIELD=store_id

# Table 1: Zones
TABLE_1_NAME=my_company.operations.zones
TABLE_1_GEOMETRY_COLUMN=zone_boundary
TABLE_1_DISPLAY_NAME=Delivery Zones
TABLE_1_LAYER_ID=1
TABLE_1_GEOMETRY_TYPE=esriGeometryPolygon
TABLE_1_ID_FIELD=zone_id

# Table 2: Routes
TABLE_2_NAME=my_company.operations.routes
TABLE_2_GEOMETRY_COLUMN=route_path
TABLE_2_DISPLAY_NAME=Delivery Routes
TABLE_2_LAYER_ID=2
TABLE_2_GEOMETRY_TYPE=esriGeometryPolyline
TABLE_2_ID_FIELD=route_id
```

---

## Step 3: Start the Server

```bash
# Activate virtual environment
cd /Users/anand.trivedi/Documents/gitprojects/customdatafeeds
source venv/bin/activate

# Start the server
cd src
python data_feed_provider.py
```

You should see:

```
INFO:__main__:Starting Databricks Geospatial Feed v1.0.0
INFO:__main__:Server running on port 5000
 * Running on http://0.0.0.0:5000
```

---

## Step 4: Test with curl

### 4.1 Health Check

```bash
curl http://localhost:5000/health
```

Expected output:
```json
{
  "status": "healthy",
  "databricks": "connected"
}
```

### 4.2 List All Layers

```bash
curl http://localhost:5000/layers | jq
```

Expected output:
```json
{
  "layers": [
    {
      "id": 0,
      "name": "Store Locations",
      "description": "Retail store point locations",
      "type": "Feature Layer",
      "geometryType": "esriGeometryPoint"
    },
    {
      "id": 1,
      "name": "Delivery Zones",
      "description": "Delivery zone polygons",
      "type": "Feature Layer",
      "geometryType": "esriGeometryPolygon"
    },
    {
      "id": 2,
      "name": "Delivery Routes",
      "description": "Delivery route paths",
      "type": "Feature Layer",
      "geometryType": "esriGeometryPolyline"
    }
  ]
}
```

### 4.3 Query Each Table

**Query Stores (Points):**
```bash
curl "http://localhost:5000/query?\
table_name=my_company.operations.stores&\
geometry_column=store_location&\
resultRecordCount=10&\
f=json" | jq '.features | length'
```

**Query Zones (Polygons):**
```bash
curl "http://localhost:5000/query?\
table_name=my_company.operations.zones&\
geometry_column=zone_boundary&\
resultRecordCount=10&\
f=json" | jq '.geometryType'
```

**Query Routes (LineStrings):**
```bash
curl "http://localhost:5000/query?\
table_name=my_company.operations.routes&\
geometry_column=route_path&\
resultRecordCount=10&\
f=json" | jq '.geometryType'
```

### 4.4 Spatial Query Example

Find stores within a bounding box:

```bash
curl -X POST http://localhost:5000/query \
  -H "Content-Type: application/json" \
  -d '{
    "table_name": "my_company.operations.stores",
    "geometry_column": "store_location",
    "geometry": "POLYGON((-122.50 37.75, -122.50 37.85, -122.35 37.85, -122.35 37.75, -122.50 37.75))",
    "spatialRel": "esriSpatialRelIntersects",
    "returnGeometry": true,
    "f": "json"
  }' | jq '.features | length'
```

---

## Step 5: Connect to ArcGIS

### 5.1 ArcGIS Pro

1. **Open ArcGIS Pro**

2. **Add a Web Service Connection**:
   - In Catalog pane → Servers
   - Right-click → New ArcGIS Server
   - Or: Add Data → Data from Path

3. **For Each Table, Enter the URL**:

   **Stores:**
   ```
   http://localhost:5000/query?table_name=my_company.operations.stores&geometry_column=store_location
   ```

   **Zones:**
   ```
   http://localhost:5000/query?table_name=my_company.operations.zones&geometry_column=zone_boundary
   ```

   **Routes:**
   ```
   http://localhost:5000/query?table_name=my_company.operations.routes&geometry_column=route_path
   ```

4. **Add to Map** - Drag and drop from Catalog

### 5.2 ArcGIS JavaScript API

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Databricks Data Feed Demo</title>
  <link rel="stylesheet" href="https://js.arcgis.com/4.27/esri/themes/light/main.css">
  <script src="https://js.arcgis.com/4.27/"></script>
  <style>
    html, body, #viewDiv {
      padding: 0;
      margin: 0;
      height: 100%;
      width: 100%;
    }
  </style>
</head>
<body>
  <div id="viewDiv"></div>

  <script>
    require([
      "esri/Map",
      "esri/views/MapView",
      "esri/layers/FeatureLayer"
    ], function(Map, MapView, FeatureLayer) {

      const map = new Map({
        basemap: "streets-navigation-vector"
      });

      const view = new MapView({
        container: "viewDiv",
        map: map,
        center: [-122.4194, 37.7749],
        zoom: 12
      });

      // Layer 1: Store Locations (Points)
      const storesLayer = new FeatureLayer({
        url: "http://localhost:5000/query?table_name=my_company.operations.stores&geometry_column=store_location",
        title: "Store Locations",
        renderer: {
          type: "simple",
          symbol: {
            type: "simple-marker",
            color: [0, 122, 255],
            size: 10,
            outline: {
              color: [255, 255, 255],
              width: 2
            }
          }
        },
        popupTemplate: {
          title: "{store_name}",
          content: [
            {
              type: "fields",
              fieldInfos: [
                { fieldName: "store_id", label: "Store ID" },
                { fieldName: "address", label: "Address" },
                { fieldName: "city", label: "City" },
                { fieldName: "state", label: "State" }
              ]
            }
          ]
        }
      });

      // Layer 2: Delivery Zones (Polygons)
      const zonesLayer = new FeatureLayer({
        url: "http://localhost:5000/query?table_name=my_company.operations.zones&geometry_column=zone_boundary",
        title: "Delivery Zones",
        renderer: {
          type: "simple",
          symbol: {
            type: "simple-fill",
            color: [255, 200, 0, 0.3],
            outline: {
              color: [255, 140, 0],
              width: 2
            }
          }
        },
        popupTemplate: {
          title: "{zone_name}",
          content: [
            {
              type: "fields",
              fieldInfos: [
                { fieldName: "zone_type", label: "Zone Type" },
                { fieldName: "population", label: "Population" }
              ]
            }
          ]
        }
      });

      // Layer 3: Delivery Routes (LineStrings)
      const routesLayer = new FeatureLayer({
        url: "http://localhost:5000/query?table_name=my_company.operations.routes&geometry_column=route_path",
        title: "Delivery Routes",
        renderer: {
          type: "simple",
          symbol: {
            type: "simple-line",
            color: [255, 0, 0],
            width: 3
          }
        },
        popupTemplate: {
          title: "{route_name}",
          content: [
            {
              type: "fields",
              fieldInfos: [
                { fieldName: "driver_name", label: "Driver" },
                { fieldName: "route_length_km", label: "Length (km)" }
              ]
            }
          ]
        }
      });

      // Add layers to map (order matters for rendering)
      map.addMany([zonesLayer, routesLayer, storesLayer]);

    });
  </script>
</body>
</html>
```

Save as `demo.html` and open in browser.

### 5.3 Python with ArcPy

```python
import arcpy

# Set workspace
arcpy.env.workspace = "C:/GISData"

# Add stores layer
stores_url = "http://localhost:5000/query?table_name=my_company.operations.stores&geometry_column=store_location"
arcpy.management.MakeFeatureLayer(stores_url, "Store_Locations")

# Add zones layer
zones_url = "http://localhost:5000/query?table_name=my_company.operations.zones&geometry_column=zone_boundary"
arcpy.management.MakeFeatureLayer(zones_url, "Delivery_Zones")

# Add routes layer
routes_url = "http://localhost:5000/query?table_name=my_company.operations.routes&geometry_column=route_path"
arcpy.management.MakeFeatureLayer(routes_url, "Delivery_Routes")

print("Layers added successfully!")
```

---

## Complete Example: Three Tables

### Summary Configuration

**Databricks Tables:**
- ✅ `my_company.operations.stores` → geometry: `store_location` (Point)
- ✅ `my_company.operations.zones` → geometry: `zone_boundary` (Polygon)
- ✅ `my_company.operations.routes` → geometry: `route_path` (LineString)

**Configuration File (`config/tables.json`):**
```json
{
  "tables": [
    {"table_name": "my_company.operations.stores", "geometry_column": "store_location", ...},
    {"table_name": "my_company.operations.zones", "geometry_column": "zone_boundary", ...},
    {"table_name": "my_company.operations.routes", "geometry_column": "route_path", ...}
  ]
}
```

**Query URLs:**
```
Stores:  http://localhost:5000/query?table_name=my_company.operations.stores&geometry_column=store_location
Zones:   http://localhost:5000/query?table_name=my_company.operations.zones&geometry_column=zone_boundary
Routes:  http://localhost:5000/query?table_name=my_company.operations.routes&geometry_column=route_path
```

---

## Troubleshooting

### Problem: "Table not found"
✅ **Solution**: Use fully qualified table name: `catalog.schema.table`

### Problem: "Geometry column not found"
✅ **Solution**: Verify geometry column name in Databricks:
```sql
DESCRIBE TABLE my_company.operations.stores;
```

### Problem: "No features returned"
✅ **Solution**: Check table has data:
```sql
SELECT COUNT(*) FROM my_company.operations.stores;
SELECT ST_AsText(store_location) FROM my_company.operations.stores LIMIT 1;
```

### Problem: "Wrong geometry type"
✅ **Solution**: Set explicitly in `config/tables.json`:
```json
{
  "geometry_type": "esriGeometryPoint"  // or Polygon, Polyline
}
```

---

## Next Steps

1. ✅ **Test all geometry types**: Run `examples/test_geometry_types.py`
2. ✅ **Add more tables**: Update `config/tables.json`
3. ✅ **Secure the API**: Add authentication (see DEPLOYMENT.md)
4. ✅ **Deploy to production**: Use Docker (see docker-compose.yml)
5. ✅ **Monitor performance**: Add logging and metrics

---

## Support

- **Full Documentation**: [README.md](README.md)
- **Multi-Table Guide**: [MULTI_TABLE_GUIDE.md](MULTI_TABLE_GUIDE.md)
- **Quick Start**: [QUICKSTART.md](QUICKSTART.md)
- **Deployment**: [DEPLOYMENT.md](DEPLOYMENT.md)

**Questions?** Check the troubleshooting sections in each guide.
