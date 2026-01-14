"""
ArcGIS Custom Data Feed Provider for Databricks.

Implements the ArcGIS Custom Data Feed API specification to serve
geospatial data from Databricks with full geospatial function support.
"""

from flask import Flask, request, jsonify, Response
from databricks_connector import DatabricksGeospatialConnector
from format_converter import FormatConverter
from dotenv import load_dotenv
import os
import json
import logging
from typing import Dict, Any

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)

# Initialize Databricks connector
db_connector = DatabricksGeospatialConnector()

# Configuration
FEED_NAME = os.getenv('FEED_NAME', 'Databricks Geospatial Feed')
FEED_DESCRIPTION = os.getenv('FEED_DESCRIPTION', 'Custom data feed leveraging Databricks geospatial functions')
FEED_VERSION = os.getenv('FEED_VERSION', '1.0.0')


@app.route('/')
def root():
    """Root endpoint - service information."""
    return jsonify({
        "name": FEED_NAME,
        "description": FEED_DESCRIPTION,
        "version": FEED_VERSION,
        "provider": "Databricks",
        "endpoints": {
            "info": "/info",
            "query": "/query",
            "layers": "/layers",
            "layer_info": "/layers/<layer_id>",
            "health": "/health"
        }
    })


@app.route('/health')
def health():
    """Health check endpoint."""
    try:
        # Test connection by executing a simple query
        db_connector.execute_query("SELECT 1 as test")
        return jsonify({
            "status": "healthy",
            "databricks": "connected"
        }), 200
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return jsonify({
            "status": "unhealthy",
            "error": str(e)
        }), 503


@app.route('/info')
def info():
    """
    Service metadata endpoint.
    Returns information about the data feed provider.
    """
    return jsonify({
        "currentVersion": FEED_VERSION,
        "serviceDescription": FEED_DESCRIPTION,
        "hasVersionedData": False,
        "supportsDisconnectedEditing": False,
        "hasStaticData": False,
        "maxRecordCount": 1000,
        "supportedQueryFormats": "JSON, GeoJSON",
        "capabilities": "Query",
        "description": FEED_DESCRIPTION,
        "copyrightText": "",
        "spatialReference": {
            "wkid": 4326,
            "latestWkid": 4326
        },
        "initialExtent": {
            "xmin": -180,
            "ymin": -90,
            "xmax": 180,
            "ymax": 90,
            "spatialReference": {
                "wkid": 4326
            }
        },
        "fullExtent": {
            "xmin": -180,
            "ymin": -90,
            "xmax": 180,
            "ymax": 90,
            "spatialReference": {
                "wkid": 4326
            }
        },
        "units": "esriDecimalDegrees",
        "supportedGeometryFilters": [
            "esriSpatialRelIntersects",
            "esriSpatialRelContains",
            "esriSpatialRelWithin"
        ]
    })


@app.route('/layers')
def list_layers():
    """
    List available layers (tables) endpoint.
    Returns information about available datasets.
    """
    try:
        # This should be configured based on your Databricks catalog/schema
        # For now, return a sample structure
        return jsonify({
            "layers": [
                {
                    "id": 0,
                    "name": "GeospatialData",
                    "description": "Geospatial data from Databricks",
                    "type": "Feature Layer",
                    "geometryType": "esriGeometryPoint",
                    "minScale": 0,
                    "maxScale": 0
                }
            ],
            "tables": []
        })
    except Exception as e:
        logger.error(f"Error listing layers: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route('/layers/<int:layer_id>')
def layer_info(layer_id: int):
    """
    Layer metadata endpoint.
    Returns detailed information about a specific layer.
    """
    # Get table configuration from request or environment
    table_name = request.args.get('table_name')

    if not table_name:
        return jsonify({
            "error": "table_name parameter required"
        }), 400

    try:
        # Get table schema
        schema = db_connector.get_table_schema(table_name)

        # Get extent
        extent = db_connector.get_extent(
            table_name,
            request.args.get('geometry_column', 'geometry')
        )

        return jsonify({
            "id": layer_id,
            "name": table_name,
            "type": "Feature Layer",
            "geometryType": "esriGeometryPoint",  # Could be inferred from data
            "description": f"Databricks table: {table_name}",
            "copyrightText": "",
            "defaultVisibility": True,
            "extent": {
                "xmin": extent.get('xmin', -180),
                "ymin": extent.get('ymin', -90),
                "xmax": extent.get('xmax', 180),
                "ymax": extent.get('ymax', 90),
                "spatialReference": {"wkid": 4326}
            },
            "fields": _schema_to_fields(schema),
            "capabilities": "Query",
            "maxRecordCount": 1000,
            "supportedQueryFormats": "JSON, GeoJSON"
        })
    except Exception as e:
        logger.error(f"Error getting layer info: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route('/query', methods=['GET', 'POST'])
def query():
    """
    Query endpoint - supports spatial and attribute queries.

    Supports ArcGIS query parameters:
    - table_name: Databricks table name (required)
    - geometry_column: Name of geometry column (default: 'geometry')
    - where: SQL WHERE clause
    - geometry: Filter geometry (Esri JSON or WKT)
    - geometryType: Type of filter geometry
    - spatialRel: Spatial relationship (esriSpatialRelIntersects, etc.)
    - outFields: Fields to return (comma-separated or *)
    - returnGeometry: Whether to return geometry (true/false)
    - resultRecordCount: Max records to return
    - f: Output format (json, geojson, pjson)
    """
    try:
        # Get parameters from query string or POST body
        if request.method == 'POST':
            params = request.get_json() or request.form.to_dict()
        else:
            params = request.args.to_dict()

        # Required parameters
        table_name = params.get('table_name')
        if not table_name:
            return jsonify({"error": "table_name parameter required"}), 400

        # Optional parameters
        geometry_column = params.get('geometry_column', 'geometry')
        where_clause = params.get('where')
        return_geometry = params.get('returnGeometry', 'true').lower() == 'true'
        out_fields = params.get('outFields', '*')
        result_record_count = int(params.get('resultRecordCount', 1000))
        output_format = params.get('f', 'json').lower()

        # Spatial filter parameters
        filter_geometry = params.get('geometry')
        geometry_type = params.get('geometryType')
        spatial_rel = params.get('spatialRel', 'esriSpatialRelIntersects')

        # Build query
        if filter_geometry and return_geometry:
            # Convert filter geometry to WKT if needed
            if isinstance(filter_geometry, str):
                try:
                    filter_geometry = json.loads(filter_geometry)
                except:
                    pass  # Assume it's already WKT

            if isinstance(filter_geometry, dict):
                # Esri JSON geometry - convert to WKT
                filter_wkt = FormatConverter.esri_geometry_to_wkt(
                    filter_geometry,
                    geometry_type or 'esriGeometryPolygon'
                )
            else:
                filter_wkt = filter_geometry

            # Map Esri spatial relationship to Databricks function
            spatial_rel_map = {
                'esriSpatialRelIntersects': 'intersects',
                'esriSpatialRelContains': 'contains',
                'esriSpatialRelWithin': 'within'
            }
            spatial_rel_db = spatial_rel_map.get(spatial_rel, 'intersects')

            # Execute spatial query
            results = db_connector.spatial_filter(
                table_name=table_name,
                geometry_column=geometry_column,
                filter_geometry_wkt=filter_wkt,
                spatial_rel=spatial_rel_db,
                additional_fields=out_fields,
                limit=result_record_count
            )
        elif return_geometry:
            # Regular query with geometry
            results = db_connector.get_features_with_geometry(
                table_name=table_name,
                geometry_column=geometry_column,
                where_clause=where_clause,
                limit=result_record_count
            )
        else:
            # Query without geometry
            where_sql = f"WHERE {where_clause}" if where_clause else ""
            query_sql = f"""
                SELECT {out_fields}
                FROM {table_name}
                {where_sql}
                LIMIT {result_record_count}
            """
            results = db_connector.execute_query(query_sql)

        # Format response
        if output_format == 'geojson':
            response_data = FormatConverter.to_geojson_features(
                results,
                geometry_field='geometry_geojson'
            )
        else:  # json or pjson (pretty json)
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
    """
    Count endpoint - returns feature count for a query.
    """
    try:
        if request.method == 'POST':
            params = request.get_json() or request.form.to_dict()
        else:
            params = request.args.to_dict()

        table_name = params.get('table_name')
        if not table_name:
            return jsonify({"error": "table_name parameter required"}), 400

        where_clause = params.get('where')

        count = db_connector.get_feature_count(table_name, where_clause)

        return jsonify({
            "count": count
        })

    except Exception as e:
        logger.error(f"Count error: {str(e)}")
        return jsonify({"error": str(e)}), 500


def _schema_to_fields(schema: list) -> list:
    """Convert Databricks schema to Esri field definitions."""
    type_mapping = {
        'string': 'esriFieldTypeString',
        'int': 'esriFieldTypeInteger',
        'bigint': 'esriFieldTypeBigInteger',
        'double': 'esriFieldTypeDouble',
        'float': 'esriFieldTypeSingle',
        'boolean': 'esriFieldTypeSmallInteger',
        'date': 'esriFieldTypeDate',
        'timestamp': 'esriFieldTypeDate',
    }

    fields = []
    for col in schema:
        col_name = col.get('col_name', '')
        col_type = col.get('data_type', '').lower()

        if col_name and not col_name.startswith('#'):  # Skip comments
            esri_type = type_mapping.get(col_type, 'esriFieldTypeString')
            fields.append({
                "name": col_name,
                "type": esri_type,
                "alias": col_name,
                "length": 256 if esri_type == 'esriFieldTypeString' else None
            })

    return fields


if __name__ == '__main__':
    port = int(os.getenv('FLASK_PORT', 5000))
    debug = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'

    logger.info(f"Starting {FEED_NAME} v{FEED_VERSION}")
    logger.info(f"Server running on port {port}")

    app.run(
        host='0.0.0.0',
        port=port,
        debug=debug
    )
