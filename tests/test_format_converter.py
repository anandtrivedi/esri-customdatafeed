"""
Unit tests for format converter.
Tests geometry conversion without requiring Databricks or ArcGIS.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import unittest
import json
from format_converter import FormatConverter


class TestFormatConverter(unittest.TestCase):
    """Test format conversion functions."""

    def test_point_geojson_to_esri(self):
        """Test Point geometry conversion."""
        geojson_geom = {
            "type": "Point",
            "coordinates": [-122.4194, 37.7749]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertEqual(esri_geom['x'], -122.4194)
        self.assertEqual(esri_geom['y'], 37.7749)

    def test_point_3d_geojson_to_esri(self):
        """Test 3D Point geometry conversion."""
        geojson_geom = {
            "type": "Point",
            "coordinates": [-122.4194, 37.7749, 10.5]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertEqual(esri_geom['x'], -122.4194)
        self.assertEqual(esri_geom['y'], 37.7749)
        self.assertEqual(esri_geom['z'], 10.5)

    def test_multipoint_geojson_to_esri(self):
        """Test MultiPoint geometry conversion."""
        geojson_geom = {
            "type": "MultiPoint",
            "coordinates": [
                [-122.4, 37.8],
                [-122.41, 37.81],
                [-122.39, 37.79]
            ]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertIn('points', esri_geom)
        self.assertEqual(len(esri_geom['points']), 3)
        self.assertEqual(esri_geom['points'][0], [-122.4, 37.8])

    def test_linestring_geojson_to_esri(self):
        """Test LineString geometry conversion."""
        geojson_geom = {
            "type": "LineString",
            "coordinates": [
                [-122.42, 37.78],
                [-122.41, 37.77],
                [-122.40, 37.76]
            ]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertIn('paths', esri_geom)
        self.assertEqual(len(esri_geom['paths']), 1)
        self.assertEqual(len(esri_geom['paths'][0]), 3)

    def test_multilinestring_geojson_to_esri(self):
        """Test MultiLineString geometry conversion."""
        geojson_geom = {
            "type": "MultiLineString",
            "coordinates": [
                [[-122.42, 37.80], [-122.40, 37.78]],
                [[-122.41, 37.79], [-122.39, 37.77]]
            ]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertIn('paths', esri_geom)
        self.assertEqual(len(esri_geom['paths']), 2)

    def test_polygon_geojson_to_esri(self):
        """Test Polygon geometry conversion."""
        geojson_geom = {
            "type": "Polygon",
            "coordinates": [
                [
                    [-122.42, 37.79],
                    [-122.42, 37.78],
                    [-122.40, 37.78],
                    [-122.40, 37.79],
                    [-122.42, 37.79]
                ]
            ]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertIn('rings', esri_geom)
        self.assertEqual(len(esri_geom['rings']), 1)
        self.assertEqual(len(esri_geom['rings'][0]), 5)

    def test_polygon_with_hole_geojson_to_esri(self):
        """Test Polygon with hole geometry conversion."""
        geojson_geom = {
            "type": "Polygon",
            "coordinates": [
                # Outer ring
                [[-122.50, 37.80], [-122.50, 37.78], [-122.47, 37.78], [-122.47, 37.80], [-122.50, 37.80]],
                # Inner ring (hole)
                [[-122.49, 37.795], [-122.49, 37.785], [-122.48, 37.785], [-122.48, 37.795], [-122.49, 37.795]]
            ]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertIn('rings', esri_geom)
        self.assertEqual(len(esri_geom['rings']), 2)

    def test_multipolygon_geojson_to_esri(self):
        """Test MultiPolygon geometry conversion."""
        geojson_geom = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[-122.42, 37.82], [-122.42, 37.81], [-122.41, 37.81], [-122.41, 37.82], [-122.42, 37.82]]],
                [[[-122.40, 37.82], [-122.40, 37.81], [-122.39, 37.81], [-122.39, 37.82], [-122.40, 37.82]]]
            ]
        }

        esri_geom = FormatConverter._geojson_to_esri_geometry(geojson_geom)

        self.assertIn('rings', esri_geom)
        self.assertEqual(len(esri_geom['rings']), 2)

    def test_to_esri_json_features(self):
        """Test complete conversion to Esri JSON FeatureSet."""
        databricks_results = [
            {
                'id': 1,
                'name': 'Store A',
                'category': 'retail',
                'geometry_geojson': '{"type":"Point","coordinates":[-122.4194,37.7749]}'
            },
            {
                'id': 2,
                'name': 'Store B',
                'category': 'retail',
                'geometry_geojson': '{"type":"Point","coordinates":[-122.3962,37.7858]}'
            }
        ]

        result = FormatConverter.to_esri_json_features(databricks_results)

        self.assertEqual(result['geometryType'], 'esriGeometryPoint')
        self.assertEqual(len(result['features']), 2)
        self.assertIn('spatialReference', result)
        self.assertEqual(result['spatialReference']['wkid'], 4326)

        # Check first feature
        feature = result['features'][0]
        self.assertIn('geometry', feature)
        self.assertIn('attributes', feature)
        self.assertEqual(feature['attributes']['name'], 'Store A')
        self.assertEqual(feature['geometry']['x'], -122.4194)
        self.assertEqual(feature['geometry']['y'], 37.7749)

    def test_to_geojson_features(self):
        """Test complete conversion to GeoJSON FeatureCollection."""
        databricks_results = [
            {
                'id': 1,
                'name': 'Store A',
                'geometry_geojson': '{"type":"Point","coordinates":[-122.4194,37.7749]}'
            }
        ]

        result = FormatConverter.to_geojson_features(databricks_results)

        self.assertEqual(result['type'], 'FeatureCollection')
        self.assertEqual(len(result['features']), 1)

        feature = result['features'][0]
        self.assertEqual(feature['type'], 'Feature')
        self.assertEqual(feature['properties']['name'], 'Store A')
        self.assertEqual(feature['geometry']['type'], 'Point')

    def test_infer_geometry_type_point(self):
        """Test geometry type inference for Point."""
        features = [
            {'geometry': {'x': -122.4194, 'y': 37.7749}}
        ]
        geom_type = FormatConverter._infer_geometry_type(features)
        self.assertEqual(geom_type, 'esriGeometryPoint')

    def test_infer_geometry_type_multipoint(self):
        """Test geometry type inference for MultiPoint."""
        features = [
            {'geometry': {'points': [[-122.4, 37.8], [-122.41, 37.81]]}}
        ]
        geom_type = FormatConverter._infer_geometry_type(features)
        self.assertEqual(geom_type, 'esriGeometryMultipoint')

    def test_infer_geometry_type_polyline(self):
        """Test geometry type inference for Polyline."""
        features = [
            {'geometry': {'paths': [[[-122.42, 37.78], [-122.41, 37.77]]]}}
        ]
        geom_type = FormatConverter._infer_geometry_type(features)
        self.assertEqual(geom_type, 'esriGeometryPolyline')

    def test_infer_geometry_type_polygon(self):
        """Test geometry type inference for Polygon."""
        features = [
            {'geometry': {'rings': [[[-122.42, 37.79], [-122.42, 37.78], [-122.40, 37.78], [-122.42, 37.79]]]}}
        ]
        geom_type = FormatConverter._infer_geometry_type(features)
        self.assertEqual(geom_type, 'esriGeometryPolygon')

    def test_esri_envelope_to_wkt(self):
        """Test Esri envelope to WKT conversion."""
        envelope = {
            'xmin': -122.5,
            'ymin': 37.7,
            'xmax': -122.3,
            'ymax': 37.9
        }

        wkt = FormatConverter.esri_envelope_to_wkt(envelope)

        self.assertIn('POLYGON', wkt)
        self.assertIn('-122.5 37.7', wkt)
        self.assertIn('-122.3 37.9', wkt)

    def test_esri_point_to_wkt(self):
        """Test Esri Point to WKT conversion."""
        geometry = {'x': -122.4194, 'y': 37.7749}
        wkt = FormatConverter.esri_geometry_to_wkt(geometry, 'esriGeometryPoint')
        self.assertEqual(wkt, 'POINT(-122.4194 37.7749)')

    def test_esri_polygon_to_wkt(self):
        """Test Esri Polygon to WKT conversion."""
        geometry = {
            'rings': [
                [[-122.42, 37.79], [-122.42, 37.78], [-122.40, 37.78], [-122.40, 37.79], [-122.42, 37.79]]
            ]
        }
        wkt = FormatConverter.esri_geometry_to_wkt(geometry, 'esriGeometryPolygon')
        self.assertIn('POLYGON', wkt)

    def test_esri_polyline_to_wkt(self):
        """Test Esri Polyline to WKT conversion."""
        geometry = {
            'paths': [
                [[-122.42, 37.78], [-122.41, 37.77], [-122.40, 37.76]]
            ]
        }
        wkt = FormatConverter.esri_geometry_to_wkt(geometry, 'esriGeometryPolyline')
        self.assertIn('LINESTRING', wkt)

    def test_esri_multilinestring_to_wkt(self):
        """Test Esri MultiLineString to WKT conversion."""
        geometry = {
            'paths': [
                [[-122.42, 37.80], [-122.40, 37.78]],
                [[-122.41, 37.79], [-122.39, 37.77]]
            ]
        }
        wkt = FormatConverter.esri_geometry_to_wkt(geometry, 'esriGeometryPolyline')
        self.assertIn('MULTILINESTRING', wkt)


if __name__ == '__main__':
    unittest.main()
