"""
Format converters for ArcGIS Custom Data Feeds.
Converts between Databricks results and ArcGIS formats (Esri JSON, GeoJSON).
"""

import json
from typing import Dict, List, Any, Optional
import logging

logger = logging.getLogger(__name__)


class FormatConverter:
    """Converts data between Databricks and ArcGIS formats."""

    @staticmethod
    def to_esri_json_features(
        databricks_results: List[Dict],
        geometry_field: str = 'geometry_geojson',
        id_field: str = 'id',
        spatial_reference: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Convert Databricks query results to Esri JSON FeatureSet.

        Args:
            databricks_results: List of query result dictionaries
            geometry_field: Name of the field containing geometry (GeoJSON string)
            id_field: Name of the ID field
            spatial_reference: Spatial reference definition (default: WGS84)

        Returns:
            Esri JSON FeatureSet
        """
        if spatial_reference is None:
            spatial_reference = {"wkid": 4326, "latestWkid": 4326}  # WGS84

        features = []
        for row in databricks_results:
            try:
                # Parse geometry if present
                geometry = None
                if geometry_field in row and row[geometry_field]:
                    geojson_geom = json.loads(row[geometry_field]) if isinstance(
                        row[geometry_field], str
                    ) else row[geometry_field]
                    geometry = FormatConverter._geojson_to_esri_geometry(geojson_geom)

                # Build attributes (exclude geometry field)
                attributes = {
                    k: v for k, v in row.items()
                    if k != geometry_field
                }

                feature = {
                    "attributes": attributes,
                    "geometry": geometry
                }

                features.append(feature)
            except Exception as e:
                logger.warning(f"Error converting feature: {str(e)}")
                continue

        return {
            "objectIdFieldName": id_field,
            "globalIdFieldName": "",
            "geometryType": FormatConverter._infer_geometry_type(features),
            "spatialReference": spatial_reference,
            "fields": FormatConverter._infer_fields(databricks_results, geometry_field),
            "features": features
        }

    @staticmethod
    def to_geojson_features(
        databricks_results: List[Dict],
        geometry_field: str = 'geometry_geojson',
        id_field: str = 'id'
    ) -> Dict[str, Any]:
        """
        Convert Databricks query results to GeoJSON FeatureCollection.

        Args:
            databricks_results: List of query result dictionaries
            geometry_field: Name of the field containing geometry (GeoJSON string)
            id_field: Name of the ID field

        Returns:
            GeoJSON FeatureCollection
        """
        features = []
        for row in databricks_results:
            try:
                # Parse geometry
                geometry = None
                if geometry_field in row and row[geometry_field]:
                    geometry = json.loads(row[geometry_field]) if isinstance(
                        row[geometry_field], str
                    ) else row[geometry_field]

                # Build properties (exclude geometry field)
                properties = {
                    k: v for k, v in row.items()
                    if k != geometry_field
                }

                feature = {
                    "type": "Feature",
                    "id": row.get(id_field),
                    "geometry": geometry,
                    "properties": properties
                }

                features.append(feature)
            except Exception as e:
                logger.warning(f"Error converting feature to GeoJSON: {str(e)}")
                continue

        return {
            "type": "FeatureCollection",
            "features": features
        }

    @staticmethod
    def _geojson_to_esri_geometry(geojson_geom: Dict) -> Dict:
        """
        Convert GeoJSON geometry to Esri JSON geometry.

        Args:
            geojson_geom: GeoJSON geometry object

        Returns:
            Esri JSON geometry
        """
        geom_type = geojson_geom.get('type', '').lower()
        coords = geojson_geom.get('coordinates', [])

        if geom_type == 'point':
            return {
                'x': coords[0],
                'y': coords[1],
                'z': coords[2] if len(coords) > 2 else None
            }
        elif geom_type == 'multipoint':
            return {
                'points': coords
            }
        elif geom_type == 'linestring':
            return {
                'paths': [coords]
            }
        elif geom_type == 'multilinestring':
            return {
                'paths': coords
            }
        elif geom_type == 'polygon':
            return {
                'rings': coords
            }
        elif geom_type == 'multipolygon':
            # Flatten all polygons into a single rings array
            rings = []
            for polygon in coords:
                rings.extend(polygon)
            return {
                'rings': rings
            }
        else:
            logger.warning(f"Unsupported geometry type: {geom_type}")
            return {}

    @staticmethod
    def _infer_geometry_type(features: List[Dict]) -> str:
        """
        Infer Esri geometry type from features.

        Args:
            features: List of Esri JSON features

        Returns:
            Geometry type string
        """
        if not features:
            return "esriGeometryNull"

        for feature in features:
            geom = feature.get('geometry', {})
            if 'x' in geom and 'y' in geom:
                return "esriGeometryPoint"
            elif 'points' in geom:
                return "esriGeometryMultipoint"
            elif 'paths' in geom:
                return "esriGeometryPolyline"
            elif 'rings' in geom:
                return "esriGeometryPolygon"

        return "esriGeometryNull"

    @staticmethod
    def _infer_fields(
        databricks_results: List[Dict],
        exclude_field: Optional[str] = None
    ) -> List[Dict]:
        """
        Infer Esri field definitions from Databricks results.

        Args:
            databricks_results: Query results
            exclude_field: Field to exclude (typically geometry field)

        Returns:
            List of Esri field definitions
        """
        if not databricks_results:
            return []

        fields = []
        sample = databricks_results[0]

        type_mapping = {
            int: "esriFieldTypeInteger",
            float: "esriFieldTypeDouble",
            str: "esriFieldTypeString",
            bool: "esriFieldTypeSmallInteger",
        }

        for field_name, value in sample.items():
            if field_name == exclude_field:
                continue

            field_type = type_mapping.get(type(value), "esriFieldTypeString")

            fields.append({
                "name": field_name,
                "type": field_type,
                "alias": field_name,
                "length": 256 if field_type == "esriFieldTypeString" else None
            })

        return fields

    @staticmethod
    def esri_envelope_to_wkt(envelope: Dict) -> str:
        """
        Convert Esri JSON envelope to WKT polygon.

        Args:
            envelope: Esri JSON envelope {xmin, ymin, xmax, ymax}

        Returns:
            WKT polygon string
        """
        xmin = envelope['xmin']
        ymin = envelope['ymin']
        xmax = envelope['xmax']
        ymax = envelope['ymax']

        wkt = (
            f"POLYGON(("
            f"{xmin} {ymin}, {xmax} {ymin}, "
            f"{xmax} {ymax}, {xmin} {ymax}, "
            f"{xmin} {ymin}"
            f"))"
        )
        return wkt

    @staticmethod
    def esri_geometry_to_wkt(geometry: Dict, geometry_type: str) -> str:
        """
        Convert Esri JSON geometry to WKT.

        Args:
            geometry: Esri JSON geometry
            geometry_type: Esri geometry type

        Returns:
            WKT string
        """
        if geometry_type.lower() == 'esrigeometrypoint':
            return f"POINT({geometry['x']} {geometry['y']})"

        elif geometry_type.lower() == 'esrigeometrypolygon':
            rings = geometry.get('rings', [])
            if not rings:
                return ""

            ring_wkts = []
            for ring in rings:
                coords = ', '.join([f"{pt[0]} {pt[1]}" for pt in ring])
                ring_wkts.append(f"({coords})")

            return f"POLYGON({', '.join(ring_wkts)})"

        elif geometry_type.lower() == 'esrigeometrypolyline':
            paths = geometry.get('paths', [])
            if not paths:
                return ""

            if len(paths) == 1:
                coords = ', '.join([f"{pt[0]} {pt[1]}" for pt in paths[0]])
                return f"LINESTRING({coords})"
            else:
                line_wkts = []
                for path in paths:
                    coords = ', '.join([f"{pt[0]} {pt[1]}" for pt in path])
                    line_wkts.append(f"({coords})")
                return f"MULTILINESTRING({', '.join(line_wkts)})"

        else:
            logger.warning(f"Unsupported geometry type for WKT conversion: {geometry_type}")
            return ""
