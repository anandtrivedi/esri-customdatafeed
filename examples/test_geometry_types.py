"""
Test script to verify all geometry types work correctly with the ArcGIS Custom Data Feed.

This script tests:
- Point, MultiPoint
- LineString, MultiLineString
- Polygon, MultiPolygon

Prerequisites:
1. Run test_all_geometry_types.sql in Databricks to create test tables
2. Start the data feed server: python src/data_feed_provider.py
3. Run this script: python examples/test_geometry_types.py
"""

import requests
import json
import sys
from typing import Dict, List, Any

# Configuration
BASE_URL = "http://localhost:5000"

# Test tables (update with your catalog/schema)
TEST_TABLES = {
    "Point": {
        "table_name": "geometry_test.all_types.test_points",
        "geometry_column": "geometry",
        "expected_type": "esriGeometryPoint",
        "expected_geojson_type": "Point"
    },
    "MultiPoint": {
        "table_name": "geometry_test.all_types.test_multipoints",
        "geometry_column": "geometry",
        "expected_type": "esriGeometryMultipoint",
        "expected_geojson_type": "MultiPoint"
    },
    "LineString": {
        "table_name": "geometry_test.all_types.test_linestrings",
        "geometry_column": "geometry",
        "expected_type": "esriGeometryPolyline",
        "expected_geojson_type": "LineString"
    },
    "MultiLineString": {
        "table_name": "geometry_test.all_types.test_multilinestrings",
        "geometry_column": "geometry",
        "expected_type": "esriGeometryPolyline",
        "expected_geojson_type": "MultiLineString"
    },
    "Polygon": {
        "table_name": "geometry_test.all_types.test_polygons",
        "geometry_column": "geometry",
        "expected_type": "esriGeometryPolygon",
        "expected_geojson_type": "Polygon"
    },
    "MultiPolygon": {
        "table_name": "geometry_test.all_types.test_multipolygons",
        "geometry_column": "geometry",
        "expected_type": "esriGeometryPolygon",
        "expected_geojson_type": "MultiPolygon"
    }
}


class TestResult:
    """Test result tracking."""

    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []

    def pass_test(self, test_name: str):
        self.passed += 1
        print(f"  ✅ PASS: {test_name}")

    def fail_test(self, test_name: str, reason: str):
        self.failed += 1
        self.errors.append(f"{test_name}: {reason}")
        print(f"  ❌ FAIL: {test_name}")
        print(f"     Reason: {reason}")

    def summary(self):
        total = self.passed + self.failed
        print(f"\n{'='*60}")
        print(f"TEST SUMMARY")
        print(f"{'='*60}")
        print(f"Total Tests: {total}")
        print(f"Passed: {self.passed} ({100*self.passed//total if total > 0 else 0}%)")
        print(f"Failed: {self.failed}")

        if self.errors:
            print(f"\nErrors:")
            for error in self.errors:
                print(f"  - {error}")

        return self.failed == 0


def test_health_check() -> bool:
    """Test server health check."""
    print("\n[1] Testing Health Check...")
    try:
        response = requests.get(f"{BASE_URL}/health", timeout=5)
        if response.status_code == 200:
            data = response.json()
            if data.get('status') == 'healthy':
                print("  ✅ Server is healthy")
                return True
            else:
                print(f"  ❌ Server unhealthy: {data}")
                return False
        else:
            print(f"  ❌ Health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"  ❌ Connection error: {str(e)}")
        return False


def test_geometry_type_esri_json(
    geometry_name: str,
    config: Dict[str, str],
    results: TestResult
):
    """Test geometry type with Esri JSON format."""
    print(f"\n[TEST] {geometry_name} - Esri JSON Format")

    try:
        # Query the table
        params = {
            'table_name': config['table_name'],
            'geometry_column': config['geometry_column'],
            'resultRecordCount': 10,
            'f': 'json'
        }

        response = requests.get(f"{BASE_URL}/query", params=params, timeout=30)

        if response.status_code != 200:
            results.fail_test(
                f"{geometry_name} Esri JSON",
                f"HTTP {response.status_code}: {response.text[:200]}"
            )
            return

        data = response.json()

        # Test 1: Check geometry type
        actual_geom_type = data.get('geometryType')
        expected_geom_type = config['expected_type']

        if actual_geom_type == expected_geom_type:
            results.pass_test(f"{geometry_name} - Geometry Type Match")
        else:
            results.fail_test(
                f"{geometry_name} - Geometry Type",
                f"Expected {expected_geom_type}, got {actual_geom_type}"
            )

        # Test 2: Check features exist
        features = data.get('features', [])
        if len(features) > 0:
            results.pass_test(f"{geometry_name} - Features Retrieved ({len(features)})")
        else:
            results.fail_test(f"{geometry_name} - Features", "No features returned")

        # Test 3: Check geometry structure
        if features:
            feature = features[0]
            geom = feature.get('geometry')

            if geom:
                results.pass_test(f"{geometry_name} - Geometry Present")

                # Verify geometry structure based on type
                if 'Point' in expected_geom_type and 'Multi' not in expected_geom_type:
                    if 'x' in geom and 'y' in geom:
                        results.pass_test(f"{geometry_name} - Point Structure Valid")
                    else:
                        results.fail_test(f"{geometry_name} - Point Structure", "Missing x/y")

                elif 'Multipoint' in expected_geom_type:
                    if 'points' in geom:
                        results.pass_test(f"{geometry_name} - MultiPoint Structure Valid")
                    else:
                        results.fail_test(f"{geometry_name} - MultiPoint Structure", "Missing points array")

                elif 'Polyline' in expected_geom_type:
                    if 'paths' in geom:
                        results.pass_test(f"{geometry_name} - Polyline Structure Valid")
                    else:
                        results.fail_test(f"{geometry_name} - Polyline Structure", "Missing paths array")

                elif 'Polygon' in expected_geom_type:
                    if 'rings' in geom:
                        results.pass_test(f"{geometry_name} - Polygon Structure Valid")
                    else:
                        results.fail_test(f"{geometry_name} - Polygon Structure", "Missing rings array")
            else:
                results.fail_test(f"{geometry_name} - Geometry", "Geometry is null")

        # Test 4: Check attributes
        if features:
            attributes = features[0].get('attributes')
            if attributes and len(attributes) > 0:
                results.pass_test(f"{geometry_name} - Attributes Present")
            else:
                results.fail_test(f"{geometry_name} - Attributes", "No attributes found")

    except Exception as e:
        results.fail_test(f"{geometry_name} Esri JSON", f"Exception: {str(e)}")


def test_geometry_type_geojson(
    geometry_name: str,
    config: Dict[str, str],
    results: TestResult
):
    """Test geometry type with GeoJSON format."""
    print(f"\n[TEST] {geometry_name} - GeoJSON Format")

    try:
        # Query the table
        params = {
            'table_name': config['table_name'],
            'geometry_column': config['geometry_column'],
            'resultRecordCount': 10,
            'f': 'geojson'
        }

        response = requests.get(f"{BASE_URL}/query", params=params, timeout=30)

        if response.status_code != 200:
            results.fail_test(
                f"{geometry_name} GeoJSON",
                f"HTTP {response.status_code}: {response.text[:200]}"
            )
            return

        data = response.json()

        # Test 1: Check FeatureCollection
        if data.get('type') == 'FeatureCollection':
            results.pass_test(f"{geometry_name} - FeatureCollection Type")
        else:
            results.fail_test(f"{geometry_name} - FeatureCollection", "Invalid type")

        # Test 2: Check features exist
        features = data.get('features', [])
        if len(features) > 0:
            results.pass_test(f"{geometry_name} - GeoJSON Features ({len(features)})")
        else:
            results.fail_test(f"{geometry_name} - GeoJSON Features", "No features")

        # Test 3: Verify geometry type
        if features:
            feature = features[0]
            geom = feature.get('geometry')

            if geom:
                actual_type = geom.get('type')
                expected_type = config['expected_geojson_type']

                if actual_type == expected_type:
                    results.pass_test(f"{geometry_name} - GeoJSON Geometry Type Match")
                else:
                    results.fail_test(
                        f"{geometry_name} - GeoJSON Geometry Type",
                        f"Expected {expected_type}, got {actual_type}"
                    )

                # Check coordinates exist
                if 'coordinates' in geom:
                    results.pass_test(f"{geometry_name} - Coordinates Present")
                else:
                    results.fail_test(f"{geometry_name} - Coordinates", "Missing coordinates")
            else:
                results.fail_test(f"{geometry_name} - GeoJSON Geometry", "Geometry is null")

    except Exception as e:
        results.fail_test(f"{geometry_name} GeoJSON", f"Exception: {str(e)}")


def test_spatial_query(results: TestResult):
    """Test spatial query with polygon filter."""
    print(f"\n[TEST] Spatial Query - Bounding Box Filter")

    try:
        # San Francisco bounding box
        bbox_wkt = "POLYGON((-122.52 37.70, -122.52 37.85, -122.35 37.85, -122.35 37.70, -122.52 37.70))"

        payload = {
            'table_name': 'geometry_test.all_types.test_points',
            'geometry_column': 'geometry',
            'geometry': bbox_wkt,
            'spatialRel': 'esriSpatialRelIntersects',
            'returnGeometry': True,
            'f': 'json'
        }

        response = requests.post(f"{BASE_URL}/query", json=payload, timeout=30)

        if response.status_code == 200:
            data = response.json()
            features = data.get('features', [])
            results.pass_test(f"Spatial Query - Success ({len(features)} features)")
        else:
            results.fail_test("Spatial Query", f"HTTP {response.status_code}")

    except Exception as e:
        results.fail_test("Spatial Query", f"Exception: {str(e)}")


def test_count_endpoint(results: TestResult):
    """Test count endpoint."""
    print(f"\n[TEST] Count Endpoint")

    try:
        params = {
            'table_name': 'geometry_test.all_types.test_points'
        }

        response = requests.get(f"{BASE_URL}/count", params=params, timeout=30)

        if response.status_code == 200:
            data = response.json()
            count = data.get('count')
            if count is not None and count >= 0:
                results.pass_test(f"Count Endpoint - Success (count: {count})")
            else:
                results.fail_test("Count Endpoint", "Invalid count value")
        else:
            results.fail_test("Count Endpoint", f"HTTP {response.status_code}")

    except Exception as e:
        results.fail_test("Count Endpoint", f"Exception: {str(e)}")


def main():
    """Run all tests."""
    print("="*60)
    print("ArcGIS Custom Data Feed - Geometry Type Tests")
    print("="*60)

    # Check server health
    if not test_health_check():
        print("\n❌ Server is not accessible. Please start the server first.")
        print("   Run: cd src && python data_feed_provider.py")
        sys.exit(1)

    results = TestResult()

    # Test each geometry type
    for geom_name, config in TEST_TABLES.items():
        test_geometry_type_esri_json(geom_name, config, results)
        test_geometry_type_geojson(geom_name, config, results)

    # Test spatial queries
    test_spatial_query(results)

    # Test count endpoint
    test_count_endpoint(results)

    # Print summary
    success = results.summary()

    if success:
        print("\n🎉 All tests passed!")
        sys.exit(0)
    else:
        print("\n⚠️  Some tests failed. Check the errors above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
