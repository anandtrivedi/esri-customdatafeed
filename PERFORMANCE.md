# Performance and Format Optimization

## Output Format Confirmation

### Required Format: GeoJSON ✅

ArcGIS Custom Data Feeds **require GeoJSON output** from the `getData()` method. This is confirmed by all Esri reference implementations:

**From DuckDB Sample (model.js:103-142):**
```javascript
let geojson = { type: "FeatureCollection", features: [] };
// ...
geojson.metadata = { ... };
geojson.filtersApplied = { ... };
geojson.crs = { ... };
callback(null, geojson);
```

**Our Implementation Matches:**
```javascript
// nodejs-provider/src/model.js
const geojson = translateToGeoJSON(rows, sourceConfig);
geojson.filtersApplied = generateFiltersApplied(...);
geojson.metadata = { ... };
geojson.crs = { ... };
callback(null, geojson);
```

### Format Structure

**Required Response:**
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": 1,
      "properties": { "name": "...", "category": "..." },
      "geometry": { "type": "Point", "coordinates": [-73.98, 40.75] }
    }
  ],
  "metadata": {
    "name": "LayerName",
    "geometryType": "Point",
    "idField": "id",
    "maxRecordCount": 2000,
    "exceededTransferLimit": false,
    "fields": [...]
  },
  "filtersApplied": {
    "where": true,
    "geometry": true
  },
  "crs": {
    "type": "EPSG:4326",
    "properties": { "name": "urn:ogc:def:crs:EPSG::4326" }
  }
}
```

**✅ Our implementation produces exactly this format.**

---

## WKB vs GeoJSON: When to Use Each

### GeoJSON (Current Implementation)

**Used For:**
- ✅ **Output from provider** (required by ArcGIS Custom Data Feeds)
- ✅ Human-readable format
- ✅ Direct browser consumption
- ✅ Debugging and development

**Command:**
```sql
SELECT ST_AsGeoJSON(geometry_column) AS geometry
```

**Pros:**
- Required format for Custom Data Feeds
- Text-based, easy to debug
- Direct compatibility with web maps (Leaflet, Mapbox)
- No additional parsing needed

**Cons:**
- Larger payload size (text vs binary)
- More bandwidth for large datasets

### WKB (Well-Known Binary)

**Used For:**
- ✅ **Storage in Parquet/Delta files** (more efficient)
- ✅ **Internal processing** in Databricks
- ✅ **Input to provider** from storage formats

**Command:**
```sql
-- Reading WKB from storage
SELECT ST_GeomFromWKB(CAST(wkb_column AS BLOB)) AS geometry

-- Converting to WKB (not needed for Custom Data Feeds)
SELECT ST_AsBinary(geometry_column) AS geometry_wkb
```

**Pros:**
- 40-60% smaller than GeoJSON
- Faster parsing
- Better for storage and transport between systems

**Cons:**
- Binary format, not human-readable
- **NOT supported by ArcGIS Custom Data Feeds** as output format
- Requires additional parsing step

---

## Performance Optimization Strategies

### 1. Efficient Query Pattern (Current Implementation)

**Our SQL Builder:**
```sql
-- Only fetch geometry as GeoJSON, exclude original geometry column
SELECT * EXCEPT (geometry_column),
       ST_AsGeoJSON(geometry_column) AS geometry_column
FROM table
WHERE ...
LIMIT maxRecordCount + 1  -- Fetch N+1 for exceeded limit detection
OFFSET resultOffset
```

**Benefits:**
- ✅ Only converts geometries that will be returned
- ✅ Pagination reduces payload size
- ✅ Databricks does conversion server-side (faster than Node.js)
- ✅ No intermediate format needed

### 2. Use WKB for Storage (Recommended)

**In Databricks Tables:**
```sql
-- Store geometry as WKB in Parquet/Delta
CREATE TABLE catalog.schema.locations (
  id BIGINT,
  name STRING,
  -- Store WKB for efficiency
  location_wkb BINARY,
  -- Create geometry column from WKB
  location GEOMETRY GENERATED ALWAYS AS (ST_GeomFromWKB(location_wkb))
);

-- Or if you have WKT/lat-lon, create WKB:
CREATE TABLE catalog.schema.points AS
SELECT
  id,
  name,
  latitude,
  longitude,
  ST_AsBinary(ST_Point(longitude, latitude)) as location_wkb,
  ST_Point(longitude, latitude) as location
FROM source_table;
```

**Benefits:**
- 40-60% smaller Delta/Parquet files
- Faster Databricks reads
- Provider still outputs GeoJSON (converts via ST_AsGeoJSON)

### 3. Spatial Indexing in Databricks

**Enable Z-Ordering:**
```sql
-- Z-order by geometry for faster spatial queries
OPTIMIZE catalog.schema.locations
ZORDER BY (location);

-- Create table with liquid clustering (Databricks Runtime 13.3+)
CREATE TABLE catalog.schema.locations (
  id BIGINT,
  location GEOMETRY
)
CLUSTER BY (location);
```

**Benefits:**
- 10-100x faster spatial queries
- Reduces data scanned
- Lower compute costs

### 4. Pagination Best Practices

**Current Implementation:**
```javascript
// Fetch N+1 to detect if more data exists
const fetchSize = resultRecordCount + 1;

// Remove extra row if exceeded limit
if (rows.length > maxRecordCount) {
  exceededTransferLimit = true;
  rows.pop();
}
```

**Benefits:**
- ✅ Clients can paginate through large datasets
- ✅ Prevents timeout with huge result sets
- ✅ Lower memory usage

**Recommendation:**
- Set reasonable `maxRecordCount` (default: 2000)
- For million+ rows, use server-side filtering (WHERE clause)

### 5. Extent Calculation Optimization

**Current Implementation:**
```sql
-- Only calculate extent for metadata requests
SELECT ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(geometry))) AS extent
FROM table
```

**Optimization:**
- ✅ Only runs on metadata requests (not every query)
- ✅ Uses aggregate function (single pass)

**Alternative for Very Large Tables:**
```sql
-- Option 1: Pre-compute extent in materialized view
CREATE MATERIALIZED VIEW catalog.schema.table_extent AS
SELECT ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(geometry))) AS extent
FROM catalog.schema.table;

-- Option 2: Use table statistics
DESCRIBE DETAIL catalog.schema.table;
```

### 6. Field Selection

**Allow clients to limit fields:**
```sql
-- When outFields='name,category', only fetch those
SELECT name, category, ST_AsGeoJSON(geometry) AS geometry
FROM table
```

**Benefits:**
- ✅ Smaller payload
- ✅ Faster query execution
- ✅ Already implemented in sql.js module

---

## Performance Benchmarks

### Expected Performance (General Guidelines)

**Small Dataset (< 10K rows):**
- Query time: 100-500ms
- GeoJSON payload: 1-5MB
- No optimization needed

**Medium Dataset (10K-1M rows):**
- Query time: 500ms-5s (with pagination)
- GeoJSON payload: 5-50MB per page
- **Recommendations:**
  - Use pagination (2000 rows/page)
  - Enable Z-ordering
  - Use WHERE clauses to filter

**Large Dataset (1M-100M rows):**
- Query time: 1-10s per page (with filters)
- **Recommendations:**
  - **Mandatory:** Use WHERE clauses or spatial filters
  - **Mandatory:** Enable Z-ordering or liquid clustering
  - Consider: Pre-aggregation with H3 binning
  - Consider: Materialized views for common queries

**Very Large Dataset (100M+ rows):**
- **Recommendations:**
  - Use H3 binning for aggregation
  - Implement server-side caching (TTL)
  - Consider tiling strategy (only query visible extent)
  - Use Z-ordered tables with Bloom filters

### Real-World Example: NYC Taxi Dataset

**Dataset:** 1.5 billion rows, Point geometry

**Without Optimization:**
- Query time: 30+ seconds
- Risk of timeout

**With Optimization:**
```sql
-- 1. Create H3 aggregated view (resolution 8 = ~0.46 km² hexagons)
CREATE TABLE catalog.schema.taxi_h3_bins AS
SELECT
  H3_LatLngToCell(pickup_latitude, pickup_longitude, 8) as h3_cell,
  COUNT(*) as trip_count,
  AVG(fare_amount) as avg_fare,
  AVG(trip_distance) as avg_distance,
  H3_CellToPolygon(H3_LatLngToCell(pickup_latitude, pickup_longitude, 8)) as cell_geometry
FROM catalog.schema.taxi_trips
GROUP BY H3_LatLngToCell(pickup_latitude, pickup_longitude, 8);

-- 2. Z-order the aggregated table
OPTIMIZE catalog.schema.taxi_h3_bins
ZORDER BY (cell_geometry);

-- Result: ~10,000 hexagons instead of 1.5B points
```

**After Optimization:**
- Query time: 200-500ms
- Payload: 2-5MB
- Much better user experience

---

## Databricks-Specific Optimizations

### 1. Photon Engine

**Enable Photon for geospatial queries:**
```sql
-- In SQL Warehouse configuration
SET spark.databricks.photon.enabled = true;
```

**Benefits:**
- 2-10x faster geospatial function execution
- Lower costs (less compute time)

### 2. Result Caching

**Databricks caches query results automatically:**
- Same query within 15 minutes = instant results
- Leverage this for metadata requests

### 3. Serverless SQL Warehouses

**For production:**
- Use Serverless SQL Warehouse (auto-scaling)
- Faster cold start times
- Better cost efficiency for variable workloads

---

## When to Use Alternative Formats

### Use WKB Storage When:
- ✅ You have 100M+ rows
- ✅ Storage costs are significant
- ✅ You're reading from Parquet/Delta files with WKB columns

### Use H3 Binning When:
- ✅ You have billions of points
- ✅ You need aggregated views
- ✅ Individual points aren't necessary for visualization

### Use Tiling (Future Enhancement):
- ✅ You need web-scale visualization
- ✅ You're building a slippy map (zoom levels)
- ✅ Consider implementing vector tile output format

---

## Conclusion

### Current Implementation ✅

Our provider is **optimized for the ArcGIS Custom Data Feed format**:

1. ✅ **GeoJSON output** (required format)
2. ✅ **Pagination** with exceeded transfer limit detection
3. ✅ **Server-side geometry conversion** (ST_AsGeoJSON in Databricks)
4. ✅ **Field selection** support
5. ✅ **Spatial query pushdown** (ST_Intersects, etc.)
6. ✅ **Extent calculation** (only on metadata requests)

### Recommendations for Large Datasets

**For Tables < 10M rows:**
- Current implementation is sufficient
- Optional: Add Z-ordering

**For Tables 10M-100M rows:**
- Enable Z-ordering or liquid clustering
- Use pagination consistently
- Consider H3 binning for visualization layers

**For Tables 100M+ rows:**
- **Mandatory:** H3 binning or pre-aggregation
- Implement caching strategy
- Consider multiple resolution levels

**Storage Format:**
- Use WKB in Parquet/Delta files (40-60% smaller)
- Provider converts to GeoJSON automatically
- Best of both worlds: efficient storage + required output format

---

## Additional Resources

- **Databricks Geospatial Functions**: https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-st-geospatial-functions
- **Databricks Photon**: https://docs.databricks.com/aws/en/compute/photon
- **H3 Spatial Indexing**: https://h3geo.org/
- **Z-Ordering**: https://docs.databricks.com/aws/en/delta/data-skipping
