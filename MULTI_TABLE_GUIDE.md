# Multi-Table Configuration Guide

Complete guide for configuring and using multiple Databricks tables with different geometry column names and types.

## Table of Contents

1. [Overview](#overview)
2. [Supported Geometry Types](#supported-geometry-types)
3. [Configuration Methods](#configuration-methods)
4. [JSON Configuration](#json-configuration)
5. [Environment Variable Configuration](#environment-variable-configuration)
6. [Dynamic Configuration](#dynamic-configuration)
7. [Integration Examples](#integration-examples)
8. [Best Practices](#best-practices)

---

## Overview

The ArcGIS Custom Data Feed supports multiple Databricks tables with:

- ✅ Different geometry column names (`geometry`, `location`, `boundary`, `shape`, etc.)
- ✅ Different geometry types (Point, Polygon, LineString, MultiPoint, MultiLineString, MultiPolygon)
- ✅ Different schemas and catalogs
- ✅ Different spatial references
- ✅ Per-table configuration options

### Architecture

```
┌─────────────────────────┐
│  Table Registry         │
│  (table_config.py)      │
├─────────────────────────┤
│  Table 1: restaurants   │
│    - geom: "location"   │
│    - type: Point        │
├─────────────────────────┤
│  Table 2: zones         │
│    - geom: "boundary"   │
│    - type: Polygon      │
├─────────────────────────┤
│  Table 3: routes        │
│    - geom: "path"       │
│    - type: LineString   │
└─────────────────────────┘
```

---

## Supported Geometry Types

### All geometry types are fully supported:

| Geometry Type | GeoJSON Type | Esri Type | Example Use Case |
|---------------|--------------|-----------|------------------|
| **Point** | Point | esriGeometryPoint | Store locations, addresses, POIs |
| **MultiPoint** | MultiPoint | esriGeometryMultipoint | Multiple related points |
| **LineString** | LineString | esriGeometryPolyline | Roads, routes, paths |
| **MultiLineString** | MultiLineString | esriGeometryPolyline | Multiple routes, river systems |
| **Polygon** | Polygon | esriGeometryPolygon | Boundaries, zones, parcels |
| **MultiPolygon** | MultiPolygon | esriGeometryPolygon | Archipelagos, disconnected regions |

### Format Conversion Flow

```
Databricks Table
    ↓
ST_AsGeoJSON(geometry_column)
    ↓
GeoJSON String
    ↓
Format Converter
    ├→ Esri JSON (for ArcGIS clients)
    └→ GeoJSON (for web mapping)
```

---

## Configuration Methods

### Method 1: JSON Configuration File (Recommended for Production)

**Best for**: Multiple tables, production deployments, team environments

**Pros**:
- Version controlled
- Easy to update
- Clear documentation
- Supports all options

**Cons**:
- Requires file management

### Method 2: Environment Variables

**Best for**: Simple deployments, containers, serverless

**Pros**:
- No configuration files
- Works with all cloud platforms
- Easy secrets management

**Cons**:
- Limited to basic options
- Can get verbose with many tables

### Method 3: Dynamic Configuration (Query Parameters)

**Best for**: Ad-hoc queries, development, testing

**Pros**:
- No pre-configuration needed
- Maximum flexibility
- Easy testing

**Cons**:
- Must specify parameters in every request
- No default values

---

## JSON Configuration

### Step 1: Create Configuration File

Create `config/tables.json`:

```json
{
  "tables": [
    {
      "table_name": "my_catalog.my_schema.restaurants",
      "geometry_column": "location",
      "id_field": "restaurant_id",
      "display_name": "Restaurants",
      "description": "Restaurant point locations",
      "layer_id": 0,
      "geometry_type": "esriGeometryPoint",
      "spatial_reference_wkid": 4326,
      "default_visible": true,
      "max_record_count": 1000
    },
    {
      "table_name": "my_catalog.my_schema.delivery_zones",
      "geometry_column": "zone_boundary",
      "id_field": "zone_id",
      "display_name": "Delivery Zones",
      "description": "Polygon delivery zones",
      "layer_id": 1,
      "geometry_type": "esriGeometryPolygon",
      "spatial_reference_wkid": 4326
    },
    {
      "table_name": "my_catalog.my_schema.routes",
      "geometry_column": "path_geometry",
      "id_field": "route_id",
      "display_name": "Delivery Routes",
      "description": "Delivery route paths",
      "layer_id": 2,
      "geometry_type": "esriGeometryPolyline",
      "spatial_reference_wkid": 4326
    }
  ]
}
```

### Configuration Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `table_name` | ✅ Yes | - | Fully qualified table name: `catalog.schema.table` |
| `geometry_column` | ✅ Yes | - | Name of geometry column |
| `id_field` | No | `"id"` | Primary key field name |
| `display_name` | No | Last part of table name | Display name in ArcGIS |
| `description` | No | `""` | Layer description |
| `layer_id` | No | Auto-assigned | Unique layer ID (0, 1, 2...) |
| `geometry_type` | No | `"esriGeometryPoint"` | Esri geometry type |
| `spatial_reference_wkid` | No | `4326` | Spatial reference WKID |
| `default_visible` | No | `true` | Default visibility |
| `max_record_count` | No | `1000` | Max records per query |
| `default_where_clause` | No | `null` | Default filter |

### Step 2: Set Environment Variable

```bash
# In .env file
TABLE_CONFIG_FILE=/path/to/config/tables.json
```

### Step 3: Query Tables

```bash
# Query by table name
curl "http://localhost:5000/query?table_name=my_catalog.my_schema.restaurants&resultRecordCount=10"

# Query by layer ID
curl "http://localhost:5000/layers/0/query?resultRecordCount=10"
```

---

## Environment Variable Configuration

### Step 1: Set Environment Variables

```bash
# In .env file

# Table 0: Restaurants
TABLE_0_NAME=my_catalog.my_schema.restaurants
TABLE_0_GEOMETRY_COLUMN=location
TABLE_0_DISPLAY_NAME=Restaurants
TABLE_0_LAYER_ID=0
TABLE_0_GEOMETRY_TYPE=esriGeometryPoint
TABLE_0_ID_FIELD=restaurant_id

# Table 1: Delivery Zones
TABLE_1_NAME=my_catalog.my_schema.delivery_zones
TABLE_1_GEOMETRY_COLUMN=zone_boundary
TABLE_1_DISPLAY_NAME=Delivery Zones
TABLE_1_LAYER_ID=1
TABLE_1_GEOMETRY_TYPE=esriGeometryPolygon
TABLE_1_ID_FIELD=zone_id

# Table 2: Routes
TABLE_2_NAME=my_catalog.my_schema.routes
TABLE_2_GEOMETRY_COLUMN=path_geometry
TABLE_2_DISPLAY_NAME=Delivery Routes
TABLE_2_LAYER_ID=2
TABLE_2_GEOMETRY_TYPE=esriGeometryPolyline
TABLE_2_ID_FIELD=route_id
```

### Environment Variable Pattern

```
TABLE_<N>_NAME                  - Table name (required)
TABLE_<N>_GEOMETRY_COLUMN       - Geometry column name (required)
TABLE_<N>_DISPLAY_NAME          - Display name (optional)
TABLE_<N>_LAYER_ID              - Layer ID (optional, default: N)
TABLE_<N>_GEOMETRY_TYPE         - Geometry type (optional)
TABLE_<N>_ID_FIELD              - ID field (optional, default: "id")
TABLE_<N>_DESCRIPTION           - Description (optional)
```

Where `<N>` is the table index (0, 1, 2, ...).

### Docker Compose Example

```yaml
version: '3.8'

services:
  datafeed:
    build: .
    environment:
      # Table 0
      - TABLE_0_NAME=catalog.schema.restaurants
      - TABLE_0_GEOMETRY_COLUMN=location
      - TABLE_0_DISPLAY_NAME=Restaurants
      - TABLE_0_GEOMETRY_TYPE=esriGeometryPoint

      # Table 1
      - TABLE_1_NAME=catalog.schema.zones
      - TABLE_1_GEOMETRY_COLUMN=boundary
      - TABLE_1_DISPLAY_NAME=Delivery Zones
      - TABLE_1_GEOMETRY_TYPE=esriGeometryPolygon
```

---

## Dynamic Configuration

### Use Query Parameters

No pre-configuration needed! Specify parameters in each request:

```bash
# Query with custom geometry column
curl "http://localhost:5000/query?\
table_name=my_catalog.my_schema.stores&\
geometry_column=store_location&\
resultRecordCount=10"

# Spatial query with custom column
curl -X POST http://localhost:5000/query \
  -H "Content-Type: application/json" \
  -d '{
    "table_name": "my_catalog.my_schema.parcels",
    "geometry_column": "parcel_boundary",
    "geometry": "POLYGON((-122.5 37.7, ...))",
    "spatialRel": "esriSpatialRelIntersects"
  }'
```

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `table_name` | Fully qualified table name | `catalog.schema.table` |
| `geometry_column` | Geometry column name | `location`, `boundary`, `shape` |
| `where` | SQL WHERE clause | `city='SF' AND active=true` |
| `outFields` | Fields to return | `*` or `id,name,category` |
| `returnGeometry` | Include geometry | `true` or `false` |
| `resultRecordCount` | Max records | `100` |
| `f` | Output format | `json`, `geojson`, `pjson` |

---

## Integration Examples

### Example 1: Three Tables with Different Geometries

#### Databricks Tables

```sql
-- Table 1: Points (stores)
CREATE TABLE retail.locations.stores (
  store_id BIGINT,
  store_name STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  store_location GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
);

-- Table 2: Polygons (districts)
CREATE TABLE retail.regions.districts (
  district_id BIGINT,
  district_name STRING,
  district_boundary_wkt STRING,
  district_boundary GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(district_boundary_wkt))
);

-- Table 3: LineStrings (delivery routes)
CREATE TABLE logistics.routes.delivery_paths (
  route_id BIGINT,
  route_name STRING,
  route_geom STRING,
  route_geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(route_geom))
);
```

#### Configuration File

```json
{
  "tables": [
    {
      "table_name": "retail.locations.stores",
      "geometry_column": "store_location",
      "id_field": "store_id",
      "display_name": "Retail Stores",
      "layer_id": 0,
      "geometry_type": "esriGeometryPoint"
    },
    {
      "table_name": "retail.regions.districts",
      "geometry_column": "district_boundary",
      "id_field": "district_id",
      "display_name": "Sales Districts",
      "layer_id": 1,
      "geometry_type": "esriGeometryPolygon"
    },
    {
      "table_name": "logistics.routes.delivery_paths",
      "geometry_column": "route_geometry",
      "id_field": "route_id",
      "display_name": "Delivery Routes",
      "layer_id": 2,
      "geometry_type": "esriGeometryPolyline"
    }
  ]
}
```

#### Usage

```bash
# List all layers
curl http://localhost:5000/layers

# Query stores (points)
curl "http://localhost:5000/query?table_name=retail.locations.stores"

# Query districts (polygons)
curl "http://localhost:5000/query?table_name=retail.regions.districts"

# Query routes (linestrings)
curl "http://localhost:5000/query?table_name=logistics.routes.delivery_paths"
```

### Example 2: ArcGIS JavaScript API Integration

```javascript
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

  // Layer 1: Stores (Points)
  const storesLayer = new FeatureLayer({
    url: "http://localhost:5000/query?table_name=retail.locations.stores",
    title: "Retail Stores",
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-marker",
        color: "blue",
        size: 8
      }
    }
  });

  // Layer 2: Districts (Polygons)
  const districtsLayer = new FeatureLayer({
    url: "http://localhost:5000/query?table_name=retail.regions.districts",
    title: "Sales Districts",
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [255, 200, 0, 0.3],
        outline: {
          color: "orange",
          width: 2
        }
      }
    }
  });

  // Layer 3: Routes (LineStrings)
  const routesLayer = new FeatureLayer({
    url: "http://localhost:5000/query?table_name=logistics.routes.delivery_paths",
    title: "Delivery Routes",
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-line",
        color: "red",
        width: 3
      }
    }
  });

  // Add all layers to map
  map.addMany([districtsLayer, routesLayer, storesLayer]);
});
```

### Example 3: Python Query Script

```python
import requests
import json

BASE_URL = "http://localhost:5000"

# Configuration for your tables
TABLES = [
    {
        "name": "retail.locations.stores",
        "geom_col": "store_location",
        "label": "Stores"
    },
    {
        "name": "retail.regions.districts",
        "geom_col": "district_boundary",
        "label": "Districts"
    },
    {
        "name": "logistics.routes.delivery_paths",
        "geom_col": "route_geometry",
        "label": "Routes"
    }
]

def query_table(table_name, geometry_column, where_clause=None, max_records=100):
    """Query a Databricks table via the data feed."""
    params = {
        'table_name': table_name,
        'geometry_column': geometry_column,
        'resultRecordCount': max_records,
        'f': 'geojson'
    }

    if where_clause:
        params['where'] = where_clause

    response = requests.get(f"{BASE_URL}/query", params=params)
    return response.json()

# Query all tables
for table in TABLES:
    print(f"\nQuerying {table['label']}...")
    results = query_table(
        table_name=table['name'],
        geometry_column=table['geom_col'],
        max_records=10
    )

    feature_count = len(results.get('features', []))
    print(f"  Found {feature_count} features")

    # Save to file
    filename = f"{table['label'].lower()}.geojson"
    with open(filename, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"  Saved to {filename}")
```

---

## Best Practices

### 1. Naming Conventions

**Table Names**: Use fully qualified names
```
✅ Good: catalog.schema.table
❌ Bad:  table
```

**Geometry Columns**: Use descriptive names
```
✅ Good: store_location, parcel_boundary, route_path
❌ Bad:  geom, g, field1
```

### 2. Geometry Column Setup in Databricks

**Option A: Generated Column (Recommended)**
```sql
CREATE TABLE my_table (
  id BIGINT,
  name STRING,
  lat DOUBLE,
  lon DOUBLE,
  -- Generated from coordinates
  geometry GEOMETRY GENERATED ALWAYS AS (ST_Point(lon, lat))
);
```

**Option B: From WKT String**
```sql
CREATE TABLE my_table (
  id BIGINT,
  name STRING,
  geom_wkt STRING,
  -- Generated from WKT
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(geom_wkt))
);
```

**Option C: Direct Geometry Column**
```sql
CREATE TABLE my_table (
  id BIGINT,
  name STRING,
  geometry GEOMETRY
);

-- Insert with ST_ functions
INSERT INTO my_table VALUES (
  1,
  'Location A',
  ST_Point(-122.4194, 37.7749)
);
```

### 3. Performance Optimization

```sql
-- Create spatial index (if supported)
CREATE INDEX idx_geometry ON my_table(geometry);

-- Optimize table
OPTIMIZE my_table;

-- Compute statistics
ANALYZE TABLE my_table COMPUTE STATISTICS;

-- Partition by region for large datasets
CREATE TABLE my_table (
  id BIGINT,
  region STRING,
  geometry GEOMETRY
) PARTITIONED BY (region);
```

### 4. Security

**Use Unity Catalog for access control**:
```sql
-- Grant read access to specific tables
GRANT SELECT ON TABLE catalog.schema.restaurants TO `datafeed_user`;
GRANT SELECT ON TABLE catalog.schema.zones TO `datafeed_user`;

-- Use service principal token instead of personal token
```

### 5. Error Handling

Always specify geometry column when querying:
```bash
# ✅ Explicit geometry column
curl "http://localhost:5000/query?table_name=my_table&geometry_column=location"

# ❌ Relying on defaults might fail
curl "http://localhost:5000/query?table_name=my_table"
```

### 6. Testing

Test each table configuration:
```bash
# 1. Test connection
curl http://localhost:5000/health

# 2. Test each table
for table in table1 table2 table3; do
  echo "Testing $table..."
  curl "http://localhost:5000/query?table_name=$table&resultRecordCount=1"
done

# 3. Test geometry types
curl "http://localhost:5000/query?table_name=points_table" | jq '.geometryType'
curl "http://localhost:5000/query?table_name=polygon_table" | jq '.geometryType'
```

---

## Troubleshooting

### Issue: "Geometry column not found"

**Solution**: Explicitly specify geometry column
```bash
curl "http://localhost:5000/query?\
table_name=my_table&\
geometry_column=my_geom_column_name"
```

### Issue: "Invalid geometry"

**Check**: Verify geometry data in Databricks
```sql
-- Check for NULL geometries
SELECT COUNT(*) FROM my_table WHERE geometry IS NULL;

-- Validate geometry format
SELECT id, ST_AsText(geometry) FROM my_table LIMIT 5;
```

### Issue: "Wrong geometry type displayed"

**Solution**: Configure geometry type in tables.json
```json
{
  "table_name": "my_table",
  "geometry_column": "geometry",
  "geometry_type": "esriGeometryPolygon"  // Set explicitly
}
```

### Issue: "Multiple tables return same data"

**Solution**: Verify table names are correct and unique
```bash
# List all configured tables
curl http://localhost:5000/layers | jq '.layers[].name'
```

---

## Summary

You now know how to:

✅ Configure multiple tables with different geometry columns
✅ Support all geometry types (Point, Polygon, LineString, etc.)
✅ Use JSON configuration files or environment variables
✅ Query tables dynamically without pre-configuration
✅ Integrate with ArcGIS Pro and JavaScript API
✅ Optimize performance and handle errors

**Next Steps**:
1. Create your `config/tables.json` file
2. Test each table individually
3. Integrate with ArcGIS clients
4. Monitor and optimize queries

For more information, see:
- [README.md](README.md) - Main documentation
- [QUICKSTART.md](QUICKSTART.md) - Getting started
- [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment
