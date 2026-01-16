# ArcGIS Testing Guide

Simple guide to test your deployed data feed in ArcGIS.

## Your Endpoint URL Format

After AWS deployment, your endpoint looks like:
```
https://your-aws-url.com/query?table_name=CATALOG.SCHEMA.TABLE&geometry_column=GEOM_COLUMN
```

Example:
```
https://xyz123.us-west-2.awsapprunner.com/query?table_name=retail.locations.stores&geometry_column=store_location
```

---

## Test in ArcGIS Pro (Desktop)

### Method 1: Add Feature Service

1. **Open ArcGIS Pro**

2. **Insert** tab → **Connections** → **New Feature Service**

3. **Enter URL:**
   ```
   https://your-aws-url.com/query?table_name=your.table.name&geometry_column=geom
   ```

4. **Click OK**

5. Layer appears in Catalog pane → Drag to map

### Method 2: Add Data from Path

1. **Map** tab → **Add Data** → **Data from Path**

2. **Paste URL:**
   ```
   https://your-aws-url.com/query?table_name=your.table.name
   ```

3. **OK** → Layer added to map

### Troubleshooting ArcGIS Pro

| Issue | Solution |
|-------|----------|
| "Cannot connect" | Check URL in browser first: `https://your-url.com/health` |
| "Invalid geometry" | Verify `geometry_column` parameter is correct |
| "No features" | Check table has data in Databricks |
| "Timeout" | Increase `resultRecordCount` or add `where` clause |

---

## Test in ArcGIS JavaScript API (Web)

Create `test.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Data Feed Test</title>
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
        center: [-122.4194, 37.7749], // Adjust to your data
        zoom: 12
      });

      // YOUR DATA FEED URL
      const layer = new FeatureLayer({
        url: "https://your-aws-url.com/query?table_name=your.table&geometry_column=geom",
        title: "My Data",
        outFields: ["*"],
        popupTemplate: {
          title: "{name}",
          content: "Category: {category}<br>ID: {id}"
        }
      });

      map.add(layer);
    });
  </script>
</body>
</html>
```

Save and open in browser.

---

## Test in ArcGIS Online / Portal

### Step 1: Add Item

1. Go to **Content** → **Add Item**

2. Select **From a URL**

3. **URL:**
   ```
   https://your-aws-url.com/info
   ```

4. **Type:** Feature Service

5. **Add Item**

### Step 2: Use in Web Map

1. Open **Map Viewer**

2. **Add** → **Add Layer from URL**

3. **Paste URL:**
   ```
   https://your-aws-url.com/query?table_name=your.table
   ```

4. Layer appears on map

---

## Endpoint Testing (Before ArcGIS)

Test these URLs in your browser first:

### 1. Health Check
```
https://your-aws-url.com/health
```

Should return:
```json
{
  "status": "healthy",
  "databricks": "connected"
}
```

### 2. Service Info
```
https://your-aws-url.com/info
```

Should return service metadata.

### 3. List Layers
```
https://your-aws-url.com/layers
```

Shows configured tables.

### 4. Query Data (JSON)
```
https://your-aws-url.com/query?table_name=catalog.schema.table&f=json&resultRecordCount=5
```

Should return Esri JSON with features.

### 5. Query Data (GeoJSON)
```
https://your-aws-url.com/query?table_name=catalog.schema.table&f=geojson&resultRecordCount=5
```

Should return GeoJSON (validate at geojson.io).

---

## URL Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `table_name` | ✅ Yes | Databricks table | `catalog.schema.table` |
| `geometry_column` | No | Geometry column name | `location` or `geometry` |
| `f` | No | Output format | `json`, `geojson`, `pjson` |
| `resultRecordCount` | No | Max records (default: 1000) | `100` |
| `where` | No | SQL WHERE clause | `city='SF'` |
| `returnGeometry` | No | Include geometry | `true` or `false` |
| `outFields` | No | Fields to return | `*` or `id,name` |

---

## Common Scenarios

### Scenario 1: Points (Store Locations)

**Table:** `retail.locations.stores`
**Geometry:** `store_location` (Point)

**URL:**
```
https://your-url.com/query?table_name=retail.locations.stores&geometry_column=store_location
```

**ArcGIS Pro:** Points appear on map with store attributes

### Scenario 2: Polygons (Zones)

**Table:** `logistics.regions.delivery_zones`
**Geometry:** `zone_boundary` (Polygon)

**URL:**
```
https://your-url.com/query?table_name=logistics.regions.delivery_zones&geometry_column=zone_boundary
```

**ArcGIS Pro:** Polygons appear as colored zones

### Scenario 3: Lines (Routes)

**Table:** `logistics.routes.delivery_paths`
**Geometry:** `route_geometry` (LineString)

**URL:**
```
https://your-url.com/query?table_name=logistics.routes.delivery_paths&geometry_column=route_geometry
```

**ArcGIS Pro:** Lines appear as route paths

---

## Performance Tips

1. **Limit Records:**
   ```
   ?table_name=your.table&resultRecordCount=100
   ```

2. **Filter Data:**
   ```
   ?table_name=your.table&where=category='active'
   ```

3. **Select Specific Fields:**
   ```
   ?table_name=your.table&outFields=id,name,category
   ```

4. **Skip Geometry (Faster):**
   ```
   ?table_name=your.table&returnGeometry=false
   ```

---

## Troubleshooting

### "Cannot reach server"
→ Check AWS deployment is running
→ Test health check: `https://your-url.com/health`
→ Check security groups allow traffic on port 5000

### "Table not found"
→ Use fully qualified name: `catalog.schema.table`
→ Check table exists in Databricks
→ Verify token has SELECT permission

### "Invalid geometry"
→ Check `geometry_column` parameter matches your table
→ Verify geometry data is valid in Databricks:
  ```sql
  SELECT ST_AsText(geometry) FROM your_table LIMIT 1;
  ```

### "No features displayed"
→ Check data exists:
  ```
  https://your-url.com/count?table_name=your.table
  ```
→ Try GeoJSON format to validate geometry:
  ```
  https://your-url.com/query?table_name=your.table&f=geojson
  ```
→ Upload to https://geojson.io to visualize

### "Slow performance"
→ Add WHERE clause to filter data
→ Reduce resultRecordCount
→ Create indexes in Databricks
→ Optimize Delta Lake tables

---

## Support

**Working?** ✅ Great! You're using Databricks data in ArcGIS!

**Issues?** Check:
1. AWS deployment is running (`/health` endpoint)
2. Databricks credentials are correct
3. Table name is fully qualified
4. Geometry column name matches your table

---

## Summary

**Your endpoint:**
```
https://YOUR-AWS-URL.com/query?table_name=YOUR.TABLE&geometry_column=YOUR_GEOM
```

**Use in:**
- ✅ ArcGIS Pro (Add Data from Path)
- ✅ ArcGIS JavaScript API (FeatureLayer URL)
- ✅ ArcGIS Portal/Online (Add Item from URL)

**That's it!** 🎉
