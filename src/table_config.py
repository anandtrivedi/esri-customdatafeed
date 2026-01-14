"""
Table configuration and registry for managing multiple Databricks tables
with different geometry column names and schemas.
"""

import os
import json
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
import logging

logger = logging.getLogger(__name__)


@dataclass
class TableConfig:
    """Configuration for a single Databricks table."""

    # Required fields
    table_name: str  # Fully qualified: catalog.schema.table
    geometry_column: str  # Name of the geometry column

    # Optional fields
    id_field: str = "id"
    display_name: str = ""
    description: str = ""
    layer_id: int = 0
    geometry_type: str = "esriGeometryPoint"  # Point, Polygon, Polyline, etc.
    spatial_reference_wkid: int = 4326
    min_scale: int = 0
    max_scale: int = 0
    default_visible: bool = True
    default_where_clause: Optional[str] = None
    max_record_count: int = 1000

    def __post_init__(self):
        """Set defaults after initialization."""
        if not self.display_name:
            # Use table name as display name if not provided
            self.display_name = self.table_name.split('.')[-1]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TableConfig':
        """Create from dictionary."""
        return cls(**data)


class TableRegistry:
    """Registry for managing multiple table configurations."""

    def __init__(self, config_file: Optional[str] = None):
        """
        Initialize table registry.

        Args:
            config_file: Path to JSON configuration file
        """
        self.tables: Dict[str, TableConfig] = {}
        self.layer_id_map: Dict[int, str] = {}

        if config_file:
            self.load_from_file(config_file)

    def register_table(self, config: TableConfig) -> None:
        """
        Register a table configuration.

        Args:
            config: TableConfig object
        """
        self.tables[config.table_name] = config
        self.layer_id_map[config.layer_id] = config.table_name
        logger.info(f"Registered table: {config.table_name} (layer_id: {config.layer_id})")

    def get_config(self, table_name: str) -> Optional[TableConfig]:
        """
        Get configuration for a table.

        Args:
            table_name: Fully qualified table name

        Returns:
            TableConfig or None if not found
        """
        return self.tables.get(table_name)

    def get_config_by_layer_id(self, layer_id: int) -> Optional[TableConfig]:
        """
        Get configuration by layer ID.

        Args:
            layer_id: Layer ID

        Returns:
            TableConfig or None if not found
        """
        table_name = self.layer_id_map.get(layer_id)
        if table_name:
            return self.tables.get(table_name)
        return None

    def list_all(self) -> List[TableConfig]:
        """Get list of all registered tables."""
        return list(self.tables.values())

    def load_from_file(self, config_file: str) -> None:
        """
        Load table configurations from JSON file.

        Args:
            config_file: Path to JSON configuration file

        Example JSON format:
        {
          "tables": [
            {
              "table_name": "catalog.schema.restaurants",
              "geometry_column": "location",
              "id_field": "restaurant_id",
              "display_name": "Restaurants",
              "description": "Restaurant locations",
              "layer_id": 0,
              "geometry_type": "esriGeometryPoint"
            },
            {
              "table_name": "catalog.schema.delivery_zones",
              "geometry_column": "zone_boundary",
              "layer_id": 1,
              "geometry_type": "esriGeometryPolygon"
            }
          ]
        }
        """
        try:
            with open(config_file, 'r') as f:
                data = json.load(f)

            for table_data in data.get('tables', []):
                config = TableConfig.from_dict(table_data)
                self.register_table(config)

            logger.info(f"Loaded {len(self.tables)} table configurations from {config_file}")

        except Exception as e:
            logger.error(f"Failed to load configuration from {config_file}: {str(e)}")
            raise

    def save_to_file(self, config_file: str) -> None:
        """
        Save table configurations to JSON file.

        Args:
            config_file: Path to JSON configuration file
        """
        try:
            data = {
                "tables": [config.to_dict() for config in self.tables.values()]
            }

            with open(config_file, 'w') as f:
                json.dump(data, f, indent=2)

            logger.info(f"Saved {len(self.tables)} table configurations to {config_file}")

        except Exception as e:
            logger.error(f"Failed to save configuration to {config_file}: {str(e)}")
            raise

    def to_esri_layers_json(self) -> Dict[str, Any]:
        """
        Convert registry to ArcGIS layers JSON format.

        Returns:
            Dictionary in ArcGIS layers format
        """
        layers = []
        for config in self.tables.values():
            layers.append({
                "id": config.layer_id,
                "name": config.display_name,
                "description": config.description,
                "type": "Feature Layer",
                "geometryType": config.geometry_type,
                "minScale": config.min_scale,
                "maxScale": config.max_scale,
                "defaultVisibility": config.default_visible
            })

        return {
            "layers": sorted(layers, key=lambda x: x['id']),
            "tables": []
        }


# Global registry instance
_global_registry: Optional[TableRegistry] = None


def get_registry() -> TableRegistry:
    """
    Get the global table registry instance.

    Returns:
        TableRegistry instance
    """
    global _global_registry

    if _global_registry is None:
        # Try to load from environment variable
        config_file = os.getenv('TABLE_CONFIG_FILE')

        _global_registry = TableRegistry()

        if config_file and os.path.exists(config_file):
            _global_registry.load_from_file(config_file)
            logger.info(f"Loaded table registry from {config_file}")
        else:
            logger.info("No table configuration file specified. Using dynamic configuration.")

    return _global_registry


def initialize_registry_from_env() -> TableRegistry:
    """
    Initialize registry from environment variables.
    Useful for simple deployments with limited tables.

    Environment variables format:
    TABLE_0_NAME=catalog.schema.restaurants
    TABLE_0_GEOMETRY_COLUMN=location
    TABLE_0_DISPLAY_NAME=Restaurants
    TABLE_0_LAYER_ID=0

    TABLE_1_NAME=catalog.schema.zones
    TABLE_1_GEOMETRY_COLUMN=boundary
    ...
    """
    registry = TableRegistry()

    i = 0
    while True:
        table_name = os.getenv(f'TABLE_{i}_NAME')
        if not table_name:
            break

        geometry_column = os.getenv(f'TABLE_{i}_GEOMETRY_COLUMN', 'geometry')
        display_name = os.getenv(f'TABLE_{i}_DISPLAY_NAME', table_name.split('.')[-1])
        description = os.getenv(f'TABLE_{i}_DESCRIPTION', '')
        layer_id = int(os.getenv(f'TABLE_{i}_LAYER_ID', str(i)))
        geometry_type = os.getenv(f'TABLE_{i}_GEOMETRY_TYPE', 'esriGeometryPoint')
        id_field = os.getenv(f'TABLE_{i}_ID_FIELD', 'id')

        config = TableConfig(
            table_name=table_name,
            geometry_column=geometry_column,
            display_name=display_name,
            description=description,
            layer_id=layer_id,
            geometry_type=geometry_type,
            id_field=id_field
        )

        registry.register_table(config)
        i += 1

    if i > 0:
        logger.info(f"Initialized registry with {i} tables from environment variables")

    return registry


# Convenience function to create configurations
def create_table_config(
    table_name: str,
    geometry_column: str,
    **kwargs
) -> TableConfig:
    """
    Create a table configuration.

    Args:
        table_name: Fully qualified table name
        geometry_column: Geometry column name
        **kwargs: Additional configuration options

    Returns:
        TableConfig object
    """
    return TableConfig(
        table_name=table_name,
        geometry_column=geometry_column,
        **kwargs
    )
