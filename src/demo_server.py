"""
Demo server for local testing without Databricks.
Serves mock data to test the API endpoints and format conversions.
"""

from flask import Flask, request, jsonify, Response
import json
import logging
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from format_converter import FormatConverter
from table_config import TableRegistry, TableConfig

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)

# Mock data for testing
MOCK_DATA = {
    "restaurants": [
        {
            "id": 1,
            "name": "Golden Gate Grill",
            "category": "restaurant",
            "city": "San Francisco",
            "latitude": 37.7749,
            "longitude": -122.4194,
            "rating": 4.5,
            "geometry_geojson": '{"type":"Point","coordinates":[-122.4194,37.7749]}'
        },
        {
            "id": 2,
            "name": "Bay Cafe",
            "category": "cafe",
            "city": "San Francisco",
            "latitude": 37.7858,
            "longitude": -122.3962,
            "rating": 4.2,
            "geometry_geojson": '{"type":"Point","coordinates":[-122.3962,37.7858]}'
        },
        {
            "id": 3,
            "name": "Pacific Diner",
            "category": "restaurant",
            "city": "San Francisco",
            "latitude": 37.7599,
            "longitude": -122.4210,
            "rating": 4.7,
            "geometry_geojson": '{"type":"Point","coordinates":[-122.4210,37.7599]}'
        }
    ],
    "zones": [
        {
            "id": 1,
            "zone_name": "Downtown Zone",
            "zone_type": "commercial",
            "population": 50000,
            "geometry_geojson": '{"type":"Polygon","coordinates":[[[-122.42,37.79],[-122.42,37.78],[-122.40,37.78],[-122.40,37.79],[-122.42,37.79]]]}'
        },
        {
            "id": 2,
            "zone_name": "Marina District",
            "zone_type": "residential",
            "population": 35000,
            "geometry_geojson": '{"type":"Polygon","coordinates":[[[-122.45,37.81],[-122.45,37.80],[-122.43,37.80],[-122.43,37.81],[-122.45,37.81]]]}'
        }
    ],
    "routes": [
        {
            "id": 1,
            "route_name": "Route A",
            "driver": "John Doe",
            "length_km": 15.3,
            "geometry_geojson": '{"type":"LineString","coordinates":[[-122.4194,37.7749],[-122.4084,37.7849],[-122.3974,37.7949]]}'
        },
        {
            "id": 2,
            "route_name": "Route B",
            "driver": "Jane Smith",
            "length_km": 22.7,
            "geometry_geojson": '{"type":"LineString","coordinates":[[-122.4194,37.7749],[-122.4494,37.7649],[-122.4794,37.7549]]}'
        }
    ]
}

# Initialize table registry
registry = TableRegistry()
registry.register_table(TableConfig(
    table_name="demo.restaurants",
    geometry_column="geometry_geojson",
    display_name="Restaurants (Demo)",
    layer_id=0,
    geometry_type="esriGeometryPoint"
))
registry.register_table(TableConfig(
    table_name="demo.zones",
    geometry_column="geometry_geojson",
    display_name="Delivery Zones (Demo)",
    layer_id=1,
    geometry_type="esriGeometryPolygon"
))
registry.register_table(TableConfig(
    table_name="demo.routes",
    geometry_column="geometry_geojson",
    display_name="Delivery Routes (Demo)",
    layer_id=2,
    geometry_type="esriGeometryPolyline"
))


@app.route('/')
def root():
    """Root endpoint - service information."""
    return jsonify({
        "name": "ArcGIS Custom Data Feed - Demo Mode",
        "description": "Demo server with mock data for local testing",
        "version": "1.0.0-demo",
        "mode": "DEMO - No Databricks connection required",
        "endpoints": {
            "info": "/info",
            "query": "/query",
            "layers": "/layers",
            "layer_info": "/layers/<layer_id>",
            "health": "/health"
        },
        "available_tables": list(MOCK_DATA.keys()),
        "sample_query": "/query?table_name=demo.restaurants&f=json"
    })


@app.route('/health')
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "healthy",
        "mode": "demo",
        "databricks": "not connected (demo mode)"
    }), 200


@app.route('/info')
def info():
    """Service metadata endpoint."""
    return jsonify({
        "currentVersion": "1.0.0-demo",
        "serviceDescription": "Demo service with mock data for testing",
        "mode": "DEMO",
        "hasVersionedData": False,
        "supportsDisconnectedEditing": False,
        "hasStaticData": True,
        "maxRecordCount": 1000,
        "supportedQueryFormats": "JSON, GeoJSON",
        "capabilities": "Query",
        "spatialReference": {
            "wkid": 4326,
            "latestWkid": 4326
        },
        "initialExtent": {
            "xmin": -122.5,
            "ymin": 37.7,
            "xmax": -122.3,
            "ymax": 37.9,
            "spatialReference": {"wkid": 4326}
        },
        "fullExtent": {
            "xmin": -122.5,
            "ymin": 37.7,
            "xmax": -122.3,
            "ymax": 37.9,
            "spatialReference": {"wkid": 4326}
        }
    })


@app.route('/layers')
def list_layers():
    """List available layers endpoint."""
    return jsonify(registry.to_esri_layers_json())


@app.route('/layers/<int:layer_id>')
def layer_info(layer_id: int):
    """Layer metadata endpoint."""
    config = registry.get_config_by_layer_id(layer_id)

    if not config:
        return jsonify({"error": f"Layer {layer_id} not found"}), 404

    return jsonify({
        "id": config.layer_id,
        "name": config.display_name,
        "type": "Feature Layer",
        "geometryType": config.geometry_type,
        "description": config.description,
        "extent": {
            "xmin": -122.5,
            "ymin": 37.7,
            "xmax": -122.3,
            "ymax": 37.9,
            "spatialReference": {"wkid": 4326}
        },
        "capabilities": "Query",
        "maxRecordCount": 1000
    })


@app.route('/query', methods=['GET', 'POST'])
def query():
    """Query endpoint - returns mock data."""
    try:
        # Get parameters
        if request.method == 'POST':
            params = request.get_json() or request.form.to_dict()
        else:
            params = request.args.to_dict()

        # Get table name
        table_name = params.get('table_name', '')
        output_format = params.get('f', 'json').lower()
        max_records = int(params.get('resultRecordCount', 1000))

        # Extract short table name
        short_name = table_name.split('.')[-1] if table_name else ''

        # Get mock data
        if short_name not in MOCK_DATA:
            return jsonify({
                "error": f"Table '{table_name}' not found in demo data",
                "available_tables": list(MOCK_DATA.keys()),
                "hint": "Use table_name=demo.restaurants or demo.zones or demo.routes"
            }), 404

        results = MOCK_DATA[short_name][:max_records]

        # Format response
        if output_format == 'geojson':
            response_data = FormatConverter.to_geojson_features(
                results,
                geometry_field='geometry_geojson'
            )
        else:  # json or pjson
            response_data = FormatConverter.to_esri_json_features(
                results,
                geometry_field='geometry_geojson'
            )

        # Return response
        if output_format == 'pjson':
            return Response(
                json.dumps(response_data, indent=2),
                mimetype='application/json'
            )
        else:
            return jsonify(response_data)

    except Exception as e:
        logger.error(f"Query error: {str(e)}", exc_info=True)
        return jsonify({
            "error": str(e),
            "message": "Failed to execute query"
        }), 500


@app.route('/count', methods=['GET', 'POST'])
def count():
    """Count endpoint."""
    try:
        if request.method == 'POST':
            params = request.get_json() or request.form.to_dict()
        else:
            params = request.args.to_dict()

        table_name = params.get('table_name', '')
        short_name = table_name.split('.')[-1] if table_name else ''

        if short_name not in MOCK_DATA:
            return jsonify({"error": f"Table '{table_name}' not found"}), 404

        count = len(MOCK_DATA[short_name])

        return jsonify({"count": count})

    except Exception as e:
        logger.error(f"Count error: {str(e)}")
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    port = 5000

    print("\n" + "="*70)
    print("🎯 ArcGIS Custom Data Feed - DEMO MODE")
    print("="*70)
    print("\n📍 Server starting on: http://localhost:5000")
    print("\n🚀 Try these URLs in your browser:")
    print("   • Service Info:  http://localhost:5000/")
    print("   • Health Check:  http://localhost:5000/health")
    print("   • List Layers:   http://localhost:5000/layers")
    print("   • Query Points:  http://localhost:5000/query?table_name=demo.restaurants&f=json")
    print("   • Query Polygons: http://localhost:5000/query?table_name=demo.zones&f=geojson")
    print("   • Query Lines:   http://localhost:5000/query?table_name=demo.routes&f=json")
    print("\n⚠️  DEMO MODE: Using mock data (no Databricks connection)")
    print("="*70 + "\n")

    app.run(
        host='0.0.0.0',
        port=port,
        debug=True
    )
