"""
Unit tests for table configuration.
Tests table registry without requiring Databricks or ArcGIS.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import unittest
import json
import tempfile
from table_config import TableConfig, TableRegistry, create_table_config


class TestTableConfig(unittest.TestCase):
    """Test table configuration."""

    def test_create_table_config(self):
        """Test creating a table configuration."""
        config = TableConfig(
            table_name='catalog.schema.table',
            geometry_column='geometry',
            id_field='id',
            display_name='Test Layer'
        )

        self.assertEqual(config.table_name, 'catalog.schema.table')
        self.assertEqual(config.geometry_column, 'geometry')
        self.assertEqual(config.id_field, 'id')
        self.assertEqual(config.display_name, 'Test Layer')

    def test_table_config_defaults(self):
        """Test default values in table configuration."""
        config = TableConfig(
            table_name='catalog.schema.table',
            geometry_column='geometry'
        )

        self.assertEqual(config.id_field, 'id')
        self.assertEqual(config.display_name, 'table')  # Should use table name
        self.assertEqual(config.geometry_type, 'esriGeometryPoint')
        self.assertEqual(config.spatial_reference_wkid, 4326)
        self.assertEqual(config.max_record_count, 1000)

    def test_table_config_to_dict(self):
        """Test converting table config to dictionary."""
        config = TableConfig(
            table_name='catalog.schema.table',
            geometry_column='geometry'
        )

        config_dict = config.to_dict()

        self.assertIsInstance(config_dict, dict)
        self.assertIn('table_name', config_dict)
        self.assertIn('geometry_column', config_dict)
        self.assertEqual(config_dict['table_name'], 'catalog.schema.table')

    def test_table_config_from_dict(self):
        """Test creating table config from dictionary."""
        data = {
            'table_name': 'catalog.schema.table',
            'geometry_column': 'geom',
            'id_field': 'id',
            'display_name': 'Test',
            'layer_id': 0,
            'geometry_type': 'esriGeometryPolygon'
        }

        config = TableConfig.from_dict(data)

        self.assertEqual(config.table_name, 'catalog.schema.table')
        self.assertEqual(config.geometry_column, 'geom')
        self.assertEqual(config.geometry_type, 'esriGeometryPolygon')


class TestTableRegistry(unittest.TestCase):
    """Test table registry."""

    def setUp(self):
        """Set up test registry."""
        self.registry = TableRegistry()

    def test_register_table(self):
        """Test registering a table."""
        config = TableConfig(
            table_name='catalog.schema.table1',
            geometry_column='geometry',
            layer_id=0
        )

        self.registry.register_table(config)

        retrieved = self.registry.get_config('catalog.schema.table1')
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.table_name, 'catalog.schema.table1')

    def test_register_multiple_tables(self):
        """Test registering multiple tables."""
        config1 = TableConfig(
            table_name='catalog.schema.table1',
            geometry_column='geom1',
            layer_id=0
        )
        config2 = TableConfig(
            table_name='catalog.schema.table2',
            geometry_column='geom2',
            layer_id=1
        )

        self.registry.register_table(config1)
        self.registry.register_table(config2)

        self.assertEqual(len(self.registry.list_all()), 2)

    def test_get_config_by_layer_id(self):
        """Test retrieving config by layer ID."""
        config = TableConfig(
            table_name='catalog.schema.table1',
            geometry_column='geometry',
            layer_id=5
        )

        self.registry.register_table(config)

        retrieved = self.registry.get_config_by_layer_id(5)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.table_name, 'catalog.schema.table1')

    def test_get_nonexistent_config(self):
        """Test retrieving non-existent config."""
        result = self.registry.get_config('nonexistent.table')
        self.assertIsNone(result)

    def test_save_and_load_from_file(self):
        """Test saving and loading configuration from file."""
        # Create configs
        config1 = TableConfig(
            table_name='catalog.schema.table1',
            geometry_column='geom1',
            layer_id=0
        )
        config2 = TableConfig(
            table_name='catalog.schema.table2',
            geometry_column='geom2',
            layer_id=1
        )

        self.registry.register_table(config1)
        self.registry.register_table(config2)

        # Save to temporary file
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as f:
            temp_file = f.name

        try:
            self.registry.save_to_file(temp_file)

            # Load in new registry
            new_registry = TableRegistry(temp_file)

            self.assertEqual(len(new_registry.list_all()), 2)
            retrieved = new_registry.get_config('catalog.schema.table1')
            self.assertIsNotNone(retrieved)
            self.assertEqual(retrieved.geometry_column, 'geom1')

        finally:
            os.unlink(temp_file)

    def test_to_esri_layers_json(self):
        """Test converting registry to Esri layers JSON."""
        config1 = TableConfig(
            table_name='catalog.schema.table1',
            geometry_column='geom1',
            display_name='Layer 1',
            layer_id=0,
            geometry_type='esriGeometryPoint'
        )
        config2 = TableConfig(
            table_name='catalog.schema.table2',
            geometry_column='geom2',
            display_name='Layer 2',
            layer_id=1,
            geometry_type='esriGeometryPolygon'
        )

        self.registry.register_table(config1)
        self.registry.register_table(config2)

        layers_json = self.registry.to_esri_layers_json()

        self.assertIn('layers', layers_json)
        self.assertIn('tables', layers_json)
        self.assertEqual(len(layers_json['layers']), 2)

        layer = layers_json['layers'][0]
        self.assertEqual(layer['type'], 'Feature Layer')
        self.assertIn('geometryType', layer)


class TestCreateTableConfig(unittest.TestCase):
    """Test convenience function for creating table configs."""

    def test_create_table_config_basic(self):
        """Test creating config with basic parameters."""
        config = create_table_config(
            table_name='test.table',
            geometry_column='geom'
        )

        self.assertEqual(config.table_name, 'test.table')
        self.assertEqual(config.geometry_column, 'geom')

    def test_create_table_config_with_kwargs(self):
        """Test creating config with additional parameters."""
        config = create_table_config(
            table_name='test.table',
            geometry_column='geom',
            display_name='My Layer',
            layer_id=10,
            geometry_type='esriGeometryPolygon'
        )

        self.assertEqual(config.display_name, 'My Layer')
        self.assertEqual(config.layer_id, 10)
        self.assertEqual(config.geometry_type, 'esriGeometryPolygon')


if __name__ == '__main__':
    unittest.main()
