"""
Sample queries demonstrating the ArcGIS Custom Data Feed for Databricks.
Run these examples after starting the data feed server.
"""

import requests
import json

# Base URL for the data feed
BASE_URL = "http://localhost:5000"

# Replace with your actual Databricks table name
TABLE_NAME = "my_catalog.my_schema.locations"
GEOMETRY_COLUMN = "geometry"


def print_response(response, description):
    """Pretty print API response."""
    print(f"\n{'='*60}")
    print(f"Example: {description}")
    print(f"{'='*60}")
    print(f"Status Code: {response.status_code}")
    if response.ok:
        data = response.json()
        print(json.dumps(data, indent=2)[:1000])  # First 1000 chars
        if isinstance(data, dict) and 'features' in data:
            print(f"\nTotal features returned: {len(data['features'])}")
    else:
        print(f"Error: {response.text}")
    print()


def example_1_service_info():
    """Get service information."""
    response = requests.get(f"{BASE_URL}/info")
    print_response(response, "Service Information")


def example_2_health_check():
    """Check service health."""
    response = requests.get(f"{BASE_URL}/health")
    print_response(response, "Health Check")


def example_3_basic_query():
    """Basic query returning all features."""
    params = {
        'table_name': TABLE_NAME,
        'geometry_column': GEOMETRY_COLUMN,
        'resultRecordCount': 10,
        'f': 'json'
    }
    response = requests.get(f"{BASE_URL}/query", params=params)
    print_response(response, "Basic Query - First 10 Features")


def example_4_attribute_filter():
    """Query with attribute filter."""
    params = {
        'table_name': TABLE_NAME,
        'where': "category = 'restaurant'",
        'resultRecordCount': 5,
        'f': 'json'
    }
    response = requests.get(f"{BASE_URL}/query", params=params)
    print_response(response, "Attribute Filter - Restaurants Only")


def example_5_spatial_query_intersects():
    """Spatial query using bounding box."""
    # San Francisco Bay Area bounding box
    bbox_wkt = "POLYGON((-122.5 37.7, -122.5 37.8, -122.3 37.8, -122.3 37.7, -122.5 37.7))"

    payload = {
        'table_name': TABLE_NAME,
        'geometry_column': GEOMETRY_COLUMN,
        'geometry': bbox_wkt,
        'spatialRel': 'esriSpatialRelIntersects',
        'returnGeometry': True,
        'resultRecordCount': 20,
        'f': 'json'
    }

    response = requests.post(
        f"{BASE_URL}/query",
        json=payload
    )
    print_response(response, "Spatial Query - Features Intersecting Bounding Box")


def example_6_spatial_query_within():
    """Spatial query - features within geometry."""
    # Circular region (approximated as polygon)
    circle_wkt = "POLYGON((-122.4 37.75, -122.42 37.76, -122.44 37.75, -122.42 37.74, -122.4 37.75))"

    payload = {
        'table_name': TABLE_NAME,
        'geometry_column': GEOMETRY_COLUMN,
        'geometry': circle_wkt,
        'spatialRel': 'esriSpatialRelWithin',
        'returnGeometry': True,
        'f': 'geojson'
    }

    response = requests.post(f"{BASE_URL}/query", json=payload)
    print_response(response, "Spatial Query - Features Within Region (GeoJSON)")


def example_7_select_fields():
    """Query with specific fields."""
    params = {
        'table_name': TABLE_NAME,
        'outFields': 'id,name,category',
        'returnGeometry': False,
        'resultRecordCount': 10,
        'f': 'json'
    }
    response = requests.get(f"{BASE_URL}/query", params=params)
    print_response(response, "Select Specific Fields - No Geometry")


def example_8_combined_filters():
    """Combined attribute and spatial filters."""
    bbox_wkt = "POLYGON((-122.5 37.7, -122.5 37.9, -122.2 37.9, -122.2 37.7, -122.5 37.7))"

    payload = {
        'table_name': TABLE_NAME,
        'geometry_column': GEOMETRY_COLUMN,
        'where': "category IN ('restaurant', 'cafe')",
        'geometry': bbox_wkt,
        'spatialRel': 'esriSpatialRelIntersects',
        'returnGeometry': True,
        'resultRecordCount': 15,
        'f': 'json'
    }

    response = requests.post(f"{BASE_URL}/query", json=payload)
    print_response(response, "Combined Filters - Attribute AND Spatial")


def example_9_feature_count():
    """Get feature count."""
    params = {
        'table_name': TABLE_NAME,
        'where': "category = 'restaurant'"
    }
    response = requests.get(f"{BASE_URL}/count", params=params)
    print_response(response, "Feature Count - Restaurants")


def example_10_layer_info():
    """Get layer metadata."""
    params = {
        'table_name': TABLE_NAME
    }
    response = requests.get(f"{BASE_URL}/layers/0", params=params)
    print_response(response, "Layer Metadata Information")


def run_all_examples():
    """Run all example queries."""
    print("\n" + "="*60)
    print("ArcGIS Custom Data Feed for Databricks - Example Queries")
    print("="*60)

    examples = [
        example_1_service_info,
        example_2_health_check,
        example_3_basic_query,
        example_4_attribute_filter,
        example_5_spatial_query_intersects,
        example_6_spatial_query_within,
        example_7_select_fields,
        example_8_combined_filters,
        example_9_feature_count,
        example_10_layer_info
    ]

    for example in examples:
        try:
            example()
        except Exception as e:
            print(f"Error running {example.__name__}: {str(e)}")
            print()


if __name__ == "__main__":
    print("\nMake sure the data feed server is running on http://localhost:5000")
    print("Update TABLE_NAME variable with your actual Databricks table name\n")

    # Run all examples
    run_all_examples()

    # Or run individual examples:
    # example_1_service_info()
    # example_3_basic_query()
    # example_5_spatial_query_intersects()
