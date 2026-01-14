# Quick Start Guide

Get your ArcGIS Custom Data Feed for Databricks up and running in minutes.

## Prerequisites

- Python 3.8 or higher
- Databricks workspace with SQL warehouse
- Databricks personal access token
- Basic knowledge of SQL and REST APIs

## Step 1: Setup

```bash
# Clone or download the repository
cd customdatafeeds

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## Step 2: Configure Databricks Connection

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi1234567890abcdef
```

**How to find these values:**

1. **Server Hostname**:
   - Go to your Databricks workspace
   - URL bar shows: `https://your-workspace.cloud.databricks.com`
   - Use: `your-workspace.cloud.databricks.com` (without https://)

2. **HTTP Path**:
   - Go to SQL Warehouses in Databricks
   - Click on your warehouse
   - Go to "Connection Details" tab
   - Copy the "HTTP Path" value

3. **Access Token**:
   - Click your profile icon (top right)
   - Select "User Settings"
   - Go to "Access tokens" tab
   - Click "Generate new token"
   - Copy and save the token (you won't see it again!)

## Step 3: Create Sample Data in Databricks

Run the SQL script to create sample tables:

```sql
-- Copy queries from examples/setup_databricks_table.sql
-- Run in Databricks SQL Editor

CREATE CATALOG IF NOT EXISTS geospatial_demo;
CREATE SCHEMA IF NOT EXISTS geospatial_demo.locations;

CREATE OR REPLACE TABLE geospatial_demo.locations.restaurants (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  name STRING,
  category STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
) USING DELTA;

-- Insert sample data
INSERT INTO geospatial_demo.locations.restaurants
  (name, category, latitude, longitude)
VALUES
  ('Golden Gate Grill', 'restaurant', 37.7749, -122.4194),
  ('Bay Cafe', 'cafe', 37.7858, -122.3962),
  ('Pacific Diner', 'restaurant', 37.7599, -122.4210);
```

## Step 4: Start the Server

```bash
cd src
python data_feed_provider.py
```

You should see:

```
INFO:__main__:Starting Databricks Geospatial Feed v1.0.0
INFO:__main__:Server running on port 5000
 * Running on http://0.0.0.0:5000
```

## Step 5: Test the Connection

Open a new terminal and test:

```bash
# Health check
curl http://localhost:5000/health

# Service info
curl http://localhost:5000/info

# Query data
curl "http://localhost:5000/query?table_name=geospatial_demo.locations.restaurants&resultRecordCount=10&f=json"
```

## Step 6: Try Sample Queries

Run the example queries:

```bash
# In a new terminal (with venv activated)
cd examples
python sample_queries.py
```

Or test individual queries:

```bash
# Get all restaurants as GeoJSON
curl "http://localhost:5000/query?table_name=geospatial_demo.locations.restaurants&f=geojson"

# Spatial query - bounding box
curl -X POST http://localhost:5000/query \
  -H "Content-Type: application/json" \
  -d '{
    "table_name": "geospatial_demo.locations.restaurants",
    "geometry": "POLYGON((-122.5 37.7, -122.5 37.8, -122.3 37.8, -122.3 37.7, -122.5 37.7))",
    "spatialRel": "esriSpatialRelIntersects",
    "f": "json"
  }'
```

## Step 7: Connect from ArcGIS

### ArcGIS Pro

1. Open ArcGIS Pro
2. In the Catalog pane, right-click "Servers" → "New Feature Service"
3. Enter URL: `http://localhost:5000/query?table_name=geospatial_demo.locations.restaurants`
4. Click OK and add to your map

### ArcGIS JavaScript API

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

  const featureLayer = new FeatureLayer({
    url: "http://localhost:5000/query?table_name=geospatial_demo.locations.restaurants",
    outFields: ["*"],
    popupTemplate: {
      title: "{name}",
      content: "Category: {category}<br>Rating: {rating}"
    }
  });

  map.add(featureLayer);
});
```

## Common Issues

### Issue: Connection refused
**Solution**: Make sure the server is running on port 5000. Check with `curl http://localhost:5000/health`

### Issue: Databricks authentication failed
**Solution**:
1. Verify your access token is valid
2. Check token permissions (needs SQL access)
3. Ensure SQL warehouse is running

### Issue: Table not found
**Solution**:
1. Use fully qualified table name: `catalog.schema.table`
2. Verify table exists: `SHOW TABLES IN catalog.schema`
3. Check token has SELECT permission on the table

### Issue: Empty results
**Solution**:
1. Verify table has data: `SELECT COUNT(*) FROM your_table`
2. Check geometry column has valid data
3. Verify spatial query parameters

## Next Steps

1. **Add Your Data**: Replace sample table with your own Databricks tables
2. **Customize**: Modify `data_feed_provider.py` to add custom endpoints
3. **Deploy**: Use Docker (see Dockerfile) or deploy to cloud platform
4. **Secure**: Add authentication middleware and HTTPS
5. **Scale**: Use connection pooling and caching for production

## Quick Reference

### API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Service information |
| `GET /health` | Health check |
| `GET /info` | Service metadata |
| `GET /layers` | List available layers |
| `GET /query` | Query features |
| `POST /query` | Query with spatial filter |
| `GET /count` | Count features |

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `table_name` | Databricks table | `catalog.schema.table` |
| `geometry_column` | Geometry column name | `geometry` or `location` |
| `where` | SQL WHERE clause | `category='restaurant'` |
| `geometry` | Filter geometry (WKT) | `POLYGON((...))` |
| `spatialRel` | Spatial relationship | `esriSpatialRelIntersects` |
| `outFields` | Fields to return | `*` or `id,name` |
| `returnGeometry` | Include geometry | `true` or `false` |
| `resultRecordCount` | Max records | `1000` |
| `f` | Format | `json`, `geojson`, `pjson` |

## Support

- Documentation: [README.md](README.md)
- Examples: [examples/](examples/)
- Issues: Create an issue in the repository

## Resources

- [Databricks Geospatial Functions](https://docs.databricks.com/sql/language-manual/sql-ref-functions-builtin.html#geospatial-functions)
- [ArcGIS REST API](https://developers.arcgis.com/rest/)
- [ArcGIS JavaScript API](https://developers.arcgis.com/javascript/)
