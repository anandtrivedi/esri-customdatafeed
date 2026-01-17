# Query Examples

## Overview

The Custom Data Provider supports **different geometry column names for each table**. You specify the geometry column name in the query parameters.

## Connection Details

Configure in `nodejs-provider/src/databricks-config.json`:

```json
{
  "serverHostname": "your-workspace.cloud.databricks.com",
  "httpPath": "/sql/1.0/warehouses/your-warehouse-id",
  "accessToken": "dapi..."
}
```

## Available Tables

### 1. places
- **Geometry Column**: `geom` (geometry type, SRID 3857)
- **ID Field**: `id`
- **Other Columns**: `name`, `geog`, `updated_at`

### 2. vessel_tracking_geo (view)
- **Geometry Column**: `vessel_location` (Point)
- **ID Field**: `mmsi`
- **Other Columns**: `vessel_name`, `lat`, `lon`, `ts`, `sog`, `cog`, `heading`, `vessel_type`, `status`

---

## Query Examples

### Basic Query - Places Table

```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.places&geometryColumn=geom&idField=id&resultRecordCount=5&f=geojson"
```

**Key Points:**
- Table: `atrivedi.geospatial.places`
- Geometry column: `geom` (different from default)
- Returns: 5 features with Point/Polygon geometries

---

### Basic Query - Vessel Tracking

```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&resultRecordCount=10&f=geojson"
```

**Key Points:**
- Table: `atrivedi.geospatial.vessel_tracking_geo`
- Geometry column: `vessel_location` (different name!)
- ID field: `mmsi` (not `id`)
- Returns: 10 vessel positions

---

### Query with WHERE Filter

Filter vessels by type:
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&where=vessel_type='fishing'&resultRecordCount=20&f=geojson"
```

Filter by speed (only moving vessels):
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&where=sog>10&resultRecordCount=20&f=geojson"
```

---

### Spatial Query (Bounding Box)

Get vessels in a specific area (San Francisco Bay):
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&geometry=-122.5,37.5,-122.0,38.0&spatialRel=esriSpatialRelIntersects&f=geojson"
```

**Parameters:**
- `geometry`: bbox in format `xmin,ymin,xmax,ymax`
- `spatialRel`: `esriSpatialRelIntersects` (also supports: Contains, Within, etc.)

---

### Count Query

Count total vessels:
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&returnCountOnly=true&f=json"
```

Count fishing vessels only:
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&where=vessel_type='fishing'&returnCountOnly=true&f=json"
```

---

### Pagination

Page 1 (first 50 records):
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&resultRecordCount=50&resultOffset=0&f=geojson"
```

Page 2 (next 50 records):
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&resultRecordCount=50&resultOffset=50&f=geojson"
```

---

### Field Selection

Return only specific fields:
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&outFields=mmsi,vessel_name,vessel_type,sog&resultRecordCount=10&f=geojson"
```

---

## Different Geometry Column Names - Examples

The provider **supports different geometry column names per table**:

| Table | Geometry Column | ID Field | Notes |
|-------|----------------|----------|-------|
| `places` | `geom` | `id` | Mixed Point/Polygon |
| `vessel_tracking_geo` | `vessel_location` | `mmsi` | Points only |
| (future) `delivery_zones` | `boundary` | `zone_id` | Polygons |
| (future) `routes` | `path` | `route_id` | LineStrings |

**You specify the geometry column in each query**, so each table can have its own column name.

---

## Supported Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `table` | Fully qualified table name | `atrivedi.geospatial.vessel_tracking_geo` |
| `geometryColumn` | Name of geometry column | `vessel_location`, `geom`, `location` |
| `idField` | Unique ID field name | `mmsi`, `id`, `objectid` |
| `where` | SQL WHERE clause | `vessel_type='fishing' AND sog>10` |
| `geometry` | Bounding box (xmin,ymin,xmax,ymax) | `-122.5,37.5,-122.0,38.0` |
| `spatialRel` | Spatial relationship | `esriSpatialRelIntersects` |
| `resultRecordCount` | Max records to return | `50` (default: 2000) |
| `resultOffset` | Offset for pagination | `100` |
| `outFields` | Comma-separated fields | `mmsi,vessel_name,sog` |
| `returnCountOnly` | Return count instead of features | `true` |
| `returnGeometry` | Include geometry | `true` (default) |
| `f` | Output format | `geojson`, `json` |

---

## Creating Views with Geometry Columns

If your table has `lat/lon` but no geometry column, create a view:

```sql
CREATE OR REPLACE VIEW atrivedi.geospatial.vessel_tracking_geo AS
SELECT
    *,
    ST_Point(lon, lat) as vessel_location
FROM atrivedi.geospatial.vessel_tracking;
```

Then query the view:
```bash
curl "http://localhost:3000/query?table=atrivedi.geospatial.vessel_tracking_geo&geometryColumn=vessel_location&idField=mmsi&f=geojson"
```

---

## Performance Tips

1. **Create Indexes**: Use Z-ordering on geometry columns
   ```sql
   OPTIMIZE atrivedi.geospatial.vessel_tracking_geo
   ZORDER BY (vessel_location);
   ```

2. **Use WHERE Filters**: Reduce data transferred
   ```bash
   &where=ts>'2026-01-15'
   ```

3. **Use Spatial Filters**: Query only specific areas
   ```bash
   &geometry=-122.5,37.5,-122.0,38.0
   ```

4. **Pagination**: Fetch data in pages
   ```bash
   &resultRecordCount=100&resultOffset=0
   ```

5. **Field Selection**: Only fetch needed fields
   ```bash
   &outFields=mmsi,vessel_name,sog
   ```

---

## Testing in Browser

Open the viewer: `http://localhost:3000/viewer.html`

1. Set table: `atrivedi.geospatial.vessel_tracking_geo`
2. Set geometry column: `vessel_location`
3. Set ID field: `mmsi`
4. Add WHERE clause: `vessel_type='fishing'` (optional)
5. Click "Load Data"

---

## ArcGIS Server Deployment

After registering with ArcGIS Server, access via Feature Service URL:

```
https://your-server/arcgis/rest/services/VesselTracking/FeatureServer/0/query?where=1=1&f=geojson
```

The service parameters (table name, geometry column, ID field) are configured when creating the Feature Service, so clients don't need to specify them in every query.
