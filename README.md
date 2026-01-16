# ArcGIS Custom Data Feed for Databricks

Connect your Databricks tables directly to ArcGIS Pro, Portal, and JavaScript API.

## What This Does

Exposes Databricks tables with geospatial data as ArcGIS-compatible endpoints. Use native Databricks ST_* functions, no data export needed.

## Quick Start

### 1. Deploy to AWS

See **[AWS_DEPLOY.md](AWS_DEPLOY.md)** for deployment options:
- AWS App Runner (easiest)
- ECS Fargate (production)
- EC2 (simple)

### 2. Configure Your Tables

Edit `config/tables.json`:

```json
{
  "tables": [
    {
      "table_name": "retail.locations.stores",
      "geometry_column": "store_location",
      "geometry_type": "esriGeometryPoint"
    }
  ]
}
```

### 3. Use in ArcGIS

**Your endpoint:**
```
https://your-aws-url.com/query?table_name=retail.locations.stores
```

**In ArcGIS Pro:**
- Add Data → Data from Path → Paste URL → Done!

**See [ARCGIS_TESTING.md](ARCGIS_TESTING.md) for complete guide**

---

## Features

- ✅ All geometry types (Point, Polygon, LineString, Multi*)
- ✅ Multiple tables with different geometry columns
- ✅ Native Databricks ST_* functions
- ✅ Esri JSON and GeoJSON output
- ✅ Spatial queries (intersects, contains, within)
- ✅ Docker deployment ready
- ✅ 34 unit tests

---

## Supported Databricks Functions

- `ST_Point`, `ST_GeomFromText`, `ST_GeomFromWKT`
- `ST_AsGeoJSON`, `ST_AsText`
- `ST_Intersects`, `ST_Contains`, `ST_Within`
- `ST_Distance`, `ST_Buffer`
- All standard geospatial operations

---

## Requirements

**Databricks:**
- SQL Warehouse with geospatial functions enabled
- Tables with geometry columns
- Personal access token

**AWS** (for deployment):
- AWS account
- ECR for Docker images
- App Runner / ECS / EC2

**ArcGIS** (for testing):
- ArcGIS Pro 2.x+, or
- ArcGIS Portal / Online, or
- ArcGIS JavaScript API 4.x+

---

## Installation

### Local Testing (Demo Mode)

```bash
# Clone
git clone https://github.com/anandtrivedi/esri-customdatafeed.git
cd esri-customdatafeed

# Install
python3 -m venv venv
source venv/bin/activate
pip install flask python-dotenv

# Run demo server
cd src
python demo_server.py
```

Test at: http://localhost:5000

### AWS Deployment

See **[AWS_DEPLOY.md](AWS_DEPLOY.md)**

---

## Configuration

### Environment Variables

```bash
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=your-token
```

### Table Configuration

`config/tables.json`:

```json
{
  "tables": [
    {
      "table_name": "catalog.schema.table",
      "geometry_column": "geometry_column_name",
      "id_field": "id",
      "display_name": "Display Name",
      "geometry_type": "esriGeometryPoint|Polygon|Polyline",
      "layer_id": 0
    }
  ]
}
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
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
| `table_name` | Databricks table (required) | `catalog.schema.table` |
| `geometry_column` | Geometry column name | `location` |
| `f` | Output format | `json`, `geojson`, `pjson` |
| `resultRecordCount` | Max records | `100` |
| `where` | SQL WHERE clause | `city='SF'` |
| `returnGeometry` | Include geometry | `true` |
| `outFields` | Fields to return | `*` or `id,name` |

---

## Example Usage

### Query Points
```bash
curl "https://your-url.com/query?table_name=stores&f=json"
```

### Query Polygons
```bash
curl "https://your-url.com/query?table_name=zones&f=geojson"
```

### Spatial Filter
```bash
curl -X POST https://your-url.com/query \
  -H "Content-Type: application/json" \
  -d '{
    "table_name": "stores",
    "geometry": "POLYGON(...)",
    "spatialRel": "esriSpatialRelIntersects"
  }'
```

### In ArcGIS JavaScript API
```javascript
const layer = new FeatureLayer({
  url: "https://your-url.com/query?table_name=stores"
});
map.add(layer);
```

---

## Databricks Table Setup

Your tables need a geometry column:

```sql
-- Option 1: Generated from lat/lon
CREATE TABLE stores (
  id BIGINT,
  name STRING,
  lat DOUBLE,
  lon DOUBLE,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_Point(lon, lat))
);

-- Option 2: From WKT
CREATE TABLE zones (
  id BIGINT,
  name STRING,
  wkt STRING,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_GeomFromText(wkt))
);

-- Option 3: Direct insert
INSERT INTO stores VALUES (1, 'Store A', ST_Point(-122.4, 37.7));
```

---

## Testing

### Unit Tests (No Databricks needed)
```bash
python tests/run_all_tests.py
```

Expected: 34 tests pass

### Demo Server (No Databricks needed)
```bash
python src/demo_server.py
```

Test at http://localhost:5000

### With Databricks
```bash
# Configure .env with credentials
python src/data_feed_provider.py
```

---

## Testing Status

⚠️ **Important:** This software has been tested:

- ✅ **Core functionality:** 34 unit tests passing
- ✅ **Format validation:** GeoJSON verified at geojson.io
- ✅ **API endpoints:** All working locally
- ⚠️ **ArcGIS integration:** Not yet tested with actual ArcGIS software

**Recommendation:** Test in your ArcGIS environment before production use.

---

## Troubleshooting

### "Cannot connect to server"
→ Check AWS deployment is running
→ Test: `curl https://your-url.com/health`

### "Table not found"
→ Use fully qualified name: `catalog.schema.table`
→ Check table exists in Databricks

### "No features"
→ Verify geometry column name
→ Check data exists: `SELECT COUNT(*) FROM table`

### "Invalid geometry"
→ Test in Databricks: `SELECT ST_AsText(geometry) FROM table LIMIT 1`
→ Ensure geometry is valid

---

## Architecture

```
ArcGIS Client → HTTP REST API → Databricks SQL → Delta Lake Tables
                     ↓
              Format Converter
                     ↓
              Esri JSON / GeoJSON
```

---

## Files

```
esri-customdatafeed/
├── src/
│   ├── data_feed_provider.py   # Main API server
│   ├── databricks_connector.py # Databricks integration
│   ├── format_converter.py     # Format conversions
│   ├── table_config.py         # Table registry
│   └── demo_server.py          # Demo mode (no Databricks)
├── config/
│   └── tables.json             # Table configuration
├── tests/                       # Unit tests
├── examples/                    # SQL examples
├── AWS_DEPLOY.md               # AWS deployment guide
├── ARCGIS_TESTING.md           # ArcGIS testing guide
├── Dockerfile                   # Docker config
└── docker-compose.yml          # Docker Compose
```

---

## Documentation

- **[AWS_DEPLOY.md](AWS_DEPLOY.md)** - Deploy to AWS
- **[ARCGIS_TESTING.md](ARCGIS_TESTING.md)** - Test in ArcGIS
- **[docs/archive/](docs/archive/)** - Additional guides

---

## Support

- **GitHub Issues:** https://github.com/anandtrivedi/esri-customdatafeed/issues
- **Databricks Docs:** https://docs.databricks.com/sql/language-manual/sql-ref-functions-builtin.html#geospatial-functions
- **ArcGIS REST API:** https://developers.arcgis.com/rest/

---

## License

MIT License - see LICENSE file

---

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests
4. Submit a pull request

---

## Quick Links

- **GitHub:** https://github.com/anandtrivedi/esri-customdatafeed
- **Deploy:** [AWS_DEPLOY.md](AWS_DEPLOY.md)
- **Test:** [ARCGIS_TESTING.md](ARCGIS_TESTING.md)

---

**Need help?** Open an issue on GitHub or check the docs in `docs/archive/`.
