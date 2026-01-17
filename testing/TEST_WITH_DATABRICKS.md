# Testing with Real Databricks Data

## Step 1: Create Sample Data in Databricks

1. Open Databricks SQL Editor
2. Run the SQL in `check-and-create-data.sql`
3. This will:
   - Check existing tables in `atrivedi.geospatial`
   - Create `sample_restaurants` table (15 rows) for basic testing
   - Optionally create H3 aggregation of `vessel_tracking` for performance testing

## Step 2: Configure Provider

The provider is already configured to use:
- **Table**: `atrivedi.geospatial.sample_restaurants`
- **Geometry Column**: `location`
- **ID Field**: `restaurant_id`

## Step 3: Test with Real Data

### Start test server:
```bash
cd testing
# Make sure USE_MOCK_DATA = false in test-server.js
node test-server.js
```

### Test queries:

**Basic query:**
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.sample_restaurants&geometryColumn=location&idField=restaurant_id&f=geojson" | python3 -m json.tool
```

**Filter by category:**
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.sample_restaurants&geometryColumn=location&idField=restaurant_id&where=category='Italian'&f=geojson" | python3 -m json.tool
```

**Spatial query (bounding box):**
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.sample_restaurants&geometryColumn=location&idField=restaurant_id&geometry=-73.99,40.755,-73.98,40.765&spatialRel=esriSpatialRelIntersects&f=geojson" | python3 -m json.tool
```

**Count only:**
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.sample_restaurants&geometryColumn=location&idField=restaurant_id&returnCountOnly=true&f=json" | python3 -m json.tool
```

**Pagination:**
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.sample_restaurants&geometryColumn=location&idField=restaurant_id&resultRecordCount=5&resultOffset=0&f=geojson" | python3 -m json.tool
```

### Test in Browser:

1. Open `http://localhost:3000/viewer.html`
2. Set:
   - Table: `atrivedi.geospatial.sample_restaurants`
   - Geometry Column: `location`
   - ID Field: `restaurant_id`
3. Click "Load Data"
4. Data should appear on map centered on NYC

## Step 4: Test with Large Dataset (Vessel Tracking)

### Option A: Direct vessel tracking (if geometry column exists)

```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking&geometryColumn=vessel_location&idField=MMSI&resultRecordCount=100&f=geojson"
```

### Option B: H3 Aggregated (recommended for millions of rows)

After running the H3 aggregation SQL:

```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_h3&geometryColumn=cell_geometry&idField=h3_cell&f=geojson"
```

This will return hexagonal bins instead of individual points - much faster for large datasets.

## Step 5: Performance Testing

### Test pagination with large dataset:

```bash
# Page 1
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_h3&geometryColumn=cell_geometry&idField=h3_cell&resultRecordCount=100&resultOffset=0&f=geojson"

# Page 2
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_h3&geometryColumn=cell_geometry&idField=h3_cell&resultRecordCount=100&resultOffset=100&f=geojson"
```

### Test spatial filter:

```bash
# Filter to specific geographic area
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_h3&geometryColumn=cell_geometry&idField=h3_cell&geometry=-125,32,-117,42&spatialRel=esriSpatialRelIntersects&f=geojson"
```

## Troubleshooting

### If you get "Invalid access token" error:
1. Check if the token in `nodejs-provider/src/databricks-config.json` is current
2. Generate new token in Databricks: User Settings → Access Tokens
3. Update the config file

### If table doesn't exist:
Run the SQL in `check-and-create-data.sql` to create sample tables

### If geometry column is missing:
The SQL script includes commands to add geometry columns from lat/lon

## Expected Results

### Small Dataset (sample_restaurants):
- **Rows**: 15
- **Query Time**: < 1 second
- **Payload Size**: ~5 KB
- **Use Case**: Basic testing, development

### Medium Dataset (vessel_tracking_h3 aggregated):
- **Rows**: ~10,000 hexagons (from millions of points)
- **Query Time**: 1-3 seconds
- **Payload Size**: 1-5 MB per page
- **Use Case**: Production visualization

### Large Dataset (raw vessel_tracking):
- **Rows**: Millions
- **Query Time**: Varies with filters
- **Recommendation**: Use H3 aggregation or strict spatial filters
- **Use Case**: Detailed analysis with filtering
