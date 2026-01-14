# ArcGIS Custom Data Feed for Databricks

A custom data feed provider for ArcGIS Enterprise that integrates with Databricks and leverages its geospatial functions through DBSQL.

## ⚠️ Testing Status

**Core Functionality:** ✅ Fully tested (34 unit tests passing)
**ArcGIS Integration:** ⚠️ Not yet tested with actual ArcGIS software

This software has comprehensive unit tests and format validation, but **has not been tested with ArcGIS Pro or ArcGIS JavaScript API**. Please test in your environment before production use. See [TESTING_STATUS.md](TESTING_STATUS.md) for details.

## Features

- Full ArcGIS Custom Data Feed API implementation
- Native Databricks geospatial function support (ST_* functions)
- Spatial query support (intersects, contains, within)
- Multiple output formats (Esri JSON, GeoJSON)
- Automatic geometry format conversion
- RESTful API endpoints compatible with ArcGIS clients

## Supported Databricks Geospatial Functions

This feed provider leverages Databricks SQL geospatial functions including:

- **Geometry Creation**: `ST_Point`, `ST_GeomFromText`, `ST_GeomFromWKT`
- **Geometry Output**: `ST_AsText`, `ST_AsGeoJSON`
- **Spatial Relationships**: `ST_Contains`, `ST_Within`, `ST_Intersects`
- **Spatial Operations**: `ST_Distance`, `ST_Buffer`, `ST_Centroid`
- **Coordinate Extraction**: `ST_X`, `ST_Y`, `ST_XMin`, `ST_XMax`, `ST_YMin`, `ST_YMax`

## Architecture

```
┌─────────────────┐
│  ArcGIS Client  │
│  (Map, Portal)  │
└────────┬────────┘
         │ HTTP/REST
         ▼
┌─────────────────────────┐
│  Custom Data Feed API   │
│  (Flask Application)    │
├─────────────────────────┤
│  - Query Endpoint       │
│  - Metadata Endpoints   │
│  - Format Converters    │
└────────┬────────────────┘
         │ JDBC/SQL
         ▼
┌─────────────────────────┐
│  Databricks SQL         │
│  - Geospatial Functions │
│  - Delta Lake Tables    │
└─────────────────────────┘
```

## Installation

### Prerequisites

- Python 3.8+
- Databricks workspace with SQL warehouse
- Databricks personal access token
- ArcGIS Enterprise (for consumption)

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd customdatafeeds
```

2. Create virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your Databricks credentials
```

5. Update `.env` file with your Databricks credentials:
```
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=your-access-token
```

## Usage

### Starting the Server

```bash
cd src
python data_feed_provider.py
```

The server will start on `http://localhost:5000` by default.

### API Endpoints

#### Service Information
```
GET /
GET /info
```

Returns metadata about the data feed provider.

#### Health Check
```
GET /health
```

Returns server and Databricks connection status.

#### List Layers
```
GET /layers
```

Returns available layers (tables) from Databricks.

#### Layer Information
```
GET /layers/<layer_id>?table_name=<table_name>
```

Returns metadata for a specific layer.

#### Query Features
```
GET /query?table_name=<table>&geometry_column=<column>&where=<clause>
POST /query
```

Query features with spatial and attribute filters.

**Parameters:**
- `table_name` (required): Databricks table name
- `geometry_column`: Name of geometry column (default: 'geometry')
- `where`: SQL WHERE clause for attribute filtering
- `geometry`: Filter geometry (Esri JSON or WKT)
- `geometryType`: Type of filter geometry
- `spatialRel`: Spatial relationship (esriSpatialRelIntersects, esriSpatialRelContains, esriSpatialRelWithin)
- `outFields`: Fields to return (comma-separated or *)
- `returnGeometry`: Include geometry in response (true/false)
- `resultRecordCount`: Maximum records to return
- `f`: Output format (json, geojson, pjson)

#### Count Features
```
GET /count?table_name=<table>&where=<clause>
POST /count
```

Returns feature count matching the query.

## Query Examples

### Basic Query
```bash
curl "http://localhost:5000/query?table_name=my_catalog.my_schema.locations&resultRecordCount=10&f=json"
```

### Query with Attribute Filter
```bash
curl "http://localhost:5000/query?table_name=my_catalog.my_schema.locations&where=city='San Francisco'&f=geojson"
```

### Spatial Query (Intersects)
```bash
curl -X POST "http://localhost:5000/query" \
  -H "Content-Type: application/json" \
  -d '{
    "table_name": "my_catalog.my_schema.locations",
    "geometry_column": "location",
    "geometry": "POLYGON((-122.5 37.5, -122.5 38.0, -122.0 38.0, -122.0 37.5, -122.5 37.5))",
    "spatialRel": "esriSpatialRelIntersects",
    "returnGeometry": true,
    "f": "json"
  }'
```

### Query Specific Fields
```bash
curl "http://localhost:5000/query?table_name=my_catalog.my_schema.locations&outFields=id,name,category&returnGeometry=false&f=json"
```

## Databricks Table Requirements

Your Databricks tables should have:

1. A geometry column stored as:
   - WKT string
   - Databricks geometry type
   - Or any format supported by `ST_GeomFromText()`

2. Example table creation:
```sql
CREATE TABLE my_catalog.my_schema.locations (
  id BIGINT,
  name STRING,
  category STRING,
  latitude DOUBLE,
  longitude DOUBLE,
  geometry GEOMETRY GENERATED ALWAYS AS (ST_Point(longitude, latitude))
);
```

3. Or with WKT:
```sql
CREATE TABLE my_catalog.my_schema.polygons (
  id BIGINT,
  name STRING,
  geometry STRING,  -- WKT format
  area DOUBLE
);
```

## Integrating with ArcGIS Enterprise

### Adding as a Custom Data Source

1. In ArcGIS Enterprise Portal, go to **Content**
2. Click **Add Item** > **From a URL**
3. Enter the feed URL: `http://your-server:5000/info`
4. Set item type to **Feature Service**
5. Configure the item properties

### Using in ArcGIS Pro

1. Add a new connection to the custom data feed
2. Use the query endpoint URL: `http://your-server:5000/query`
3. Specify the `table_name` parameter for your Databricks table
4. Add layers to your map

### Using in Web Maps

```javascript
// ArcGIS JavaScript API example
const featureLayer = new FeatureLayer({
  url: "http://your-server:5000/query?table_name=my_catalog.my_schema.locations",
  outFields: ["*"],
  returnGeometry: true
});

map.add(featureLayer);
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABRICKS_SERVER_HOSTNAME` | Databricks workspace hostname | Required |
| `DATABRICKS_HTTP_PATH` | SQL warehouse HTTP path | Required |
| `DATABRICKS_ACCESS_TOKEN` | Personal access token | Required |
| `FEED_NAME` | Data feed name | Databricks Geospatial Feed |
| `FEED_DESCRIPTION` | Feed description | Custom data feed... |
| `FEED_VERSION` | Feed version | 1.0.0 |
| `FLASK_PORT` | Server port | 5000 |
| `FLASK_DEBUG` | Debug mode | False |

## Advanced Usage

### Custom Spatial Operations

The Databricks connector supports custom SQL queries with any geospatial function:

```python
from databricks_connector import DatabricksGeospatialConnector

connector = DatabricksGeospatialConnector()

# Buffer query
query = """
SELECT
  id,
  name,
  ST_AsGeoJSON(ST_Buffer(geometry, 0.01)) as buffered_geometry
FROM my_catalog.my_schema.locations
WHERE ST_Distance(geometry, ST_Point(-122.4194, 37.7749)) < 0.1
"""

results = connector.execute_query(query)
```

### Extending the API

Add custom endpoints in `data_feed_provider.py`:

```python
@app.route('/custom/nearby')
def find_nearby():
    lon = request.args.get('lon', type=float)
    lat = request.args.get('lat', type=float)
    distance = request.args.get('distance', 1.0, type=float)

    query = f"""
    SELECT *,
           ST_Distance(geometry, ST_Point({lon}, {lat})) as distance,
           ST_AsGeoJSON(geometry) as geometry_geojson
    FROM my_table
    WHERE ST_Distance(geometry, ST_Point({lon}, {lat})) < {distance}
    ORDER BY distance
    """

    results = db_connector.execute_query(query)
    return jsonify(FormatConverter.to_esri_json_features(results))
```

## Troubleshooting

### Connection Issues

1. Verify Databricks credentials in `.env`
2. Check SQL warehouse is running
3. Verify network connectivity: `ping your-workspace.cloud.databricks.com`
4. Test connection: `curl http://localhost:5000/health`

### Query Issues

1. Check table name is fully qualified: `catalog.schema.table`
2. Verify geometry column exists and has valid data
3. Check SQL warehouse logs in Databricks console
4. Enable debug logging: `FLASK_DEBUG=True`

### Geometry Issues

1. Ensure geometry data is in WKT format or Databricks geometry type
2. Verify spatial reference (default is WGS84/EPSG:4326)
3. Test geometry functions in Databricks SQL directly
4. Check for NULL geometries: `WHERE geometry IS NOT NULL`

## Performance Optimization

1. **Indexes**: Create indexes on frequently queried columns
```sql
CREATE INDEX idx_location ON my_table(geometry);
```

2. **Partitioning**: Partition large tables by spatial region
```sql
CREATE TABLE my_table (...)
PARTITIONED BY (region_id);
```

3. **Caching**: Enable Delta Lake caching for hot data
```sql
CACHE SELECT * FROM my_table WHERE region = 'active';
```

4. **Limit Results**: Always use `resultRecordCount` parameter

## Security Considerations

1. **Authentication**: Implement authentication middleware
2. **Authorization**: Use Databricks Unity Catalog for access control
3. **HTTPS**: Deploy behind reverse proxy with SSL
4. **Token Security**: Never commit `.env` file; use secrets manager
5. **SQL Injection**: Use parameterized queries (already implemented)

## Development

### Running Tests

```bash
pytest tests/
```

### Code Structure

```
customdatafeeds/
├── src/
│   ├── __init__.py
│   ├── data_feed_provider.py    # Main Flask application
│   ├── databricks_connector.py   # Databricks connection & queries
│   └── format_converter.py       # Format conversion utilities
├── tests/
│   ├── test_connector.py
│   ├── test_converter.py
│   └── test_api.py
├── requirements.txt
├── .env.example
├── .gitignore
└── README.md
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - See LICENSE file for details

## Support

For issues and questions:
- GitHub Issues: [repository-url]/issues
- Documentation: [repository-url]/docs

## References

- [ArcGIS Enterprise SDK](https://developers.arcgis.com/enterprise-sdk/)
- [Databricks Geospatial Functions](https://docs.databricks.com/sql/language-manual/sql-ref-functions-builtin.html#geospatial-functions)
- [Databricks SQL Connector](https://docs.databricks.com/dev-tools/python-sql-connector.html)
- [ArcGIS REST API](https://developers.arcgis.com/rest/)
