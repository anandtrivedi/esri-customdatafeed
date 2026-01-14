"""
Databricks connector with geospatial support for ArcGIS Custom Data Feeds.
Leverages Databricks SQL geospatial functions.
"""

import os
from typing import Dict, List, Optional, Any
from databricks import sql
from contextlib import contextmanager
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class DatabricksGeospatialConnector:
    """
    Connector for Databricks SQL with geospatial function support.

    Supports Databricks geospatial functions including:
    - ST_Point, ST_GeomFromText, ST_GeomFromWKT
    - ST_AsText, ST_AsGeoJSON
    - ST_Contains, ST_Within, ST_Intersects
    - ST_Distance, ST_Buffer
    - ST_X, ST_Y, ST_Centroid
    """

    def __init__(
        self,
        server_hostname: Optional[str] = None,
        http_path: Optional[str] = None,
        access_token: Optional[str] = None
    ):
        """
        Initialize Databricks connection.

        Args:
            server_hostname: Databricks workspace hostname
            http_path: SQL warehouse HTTP path
            access_token: Personal access token for authentication
        """
        self.server_hostname = server_hostname or os.getenv('DATABRICKS_SERVER_HOSTNAME')
        self.http_path = http_path or os.getenv('DATABRICKS_HTTP_PATH')
        self.access_token = access_token or os.getenv('DATABRICKS_ACCESS_TOKEN')

        if not all([self.server_hostname, self.http_path, self.access_token]):
            raise ValueError(
                "Missing required Databricks configuration. "
                "Please set DATABRICKS_SERVER_HOSTNAME, DATABRICKS_HTTP_PATH, "
                "and DATABRICKS_ACCESS_TOKEN environment variables."
            )

    @contextmanager
    def get_connection(self):
        """
        Context manager for Databricks SQL connection.

        Yields:
            connection: Databricks SQL connection object
        """
        connection = None
        try:
            connection = sql.connect(
                server_hostname=self.server_hostname,
                http_path=self.http_path,
                access_token=self.access_token
            )
            logger.info("Successfully connected to Databricks")
            yield connection
        except Exception as e:
            logger.error(f"Failed to connect to Databricks: {str(e)}")
            raise
        finally:
            if connection:
                connection.close()
                logger.info("Databricks connection closed")

    def execute_query(self, query: str, parameters: Optional[Dict[str, Any]] = None) -> List[Dict]:
        """
        Execute a SQL query and return results as list of dictionaries.

        Args:
            query: SQL query string
            parameters: Optional query parameters for parameterized queries

        Returns:
            List of dictionaries representing query results
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            try:
                logger.info(f"Executing query: {query[:100]}...")
                cursor.execute(query, parameters or {})

                # Get column names
                columns = [desc[0] for desc in cursor.description]

                # Fetch all results and convert to list of dicts
                results = []
                for row in cursor.fetchall():
                    results.append(dict(zip(columns, row)))

                logger.info(f"Query returned {len(results)} rows")
                return results
            except Exception as e:
                logger.error(f"Query execution failed: {str(e)}")
                raise
            finally:
                cursor.close()

    def get_features_with_geometry(
        self,
        table_name: str,
        geometry_column: str = 'geometry',
        where_clause: Optional[str] = None,
        limit: int = 1000
    ) -> List[Dict]:
        """
        Retrieve features with geometry in GeoJSON format.

        Args:
            table_name: Name of the table to query
            geometry_column: Name of the geometry column
            where_clause: Optional SQL WHERE clause
            limit: Maximum number of rows to return

        Returns:
            List of features with geometry as GeoJSON
        """
        where_sql = f"WHERE {where_clause}" if where_clause else ""

        query = f"""
        SELECT
            *,
            ST_AsGeoJSON({geometry_column}) as geometry_geojson
        FROM {table_name}
        {where_sql}
        LIMIT {limit}
        """

        return self.execute_query(query)

    def spatial_filter(
        self,
        table_name: str,
        geometry_column: str,
        filter_geometry_wkt: str,
        spatial_rel: str = 'intersects',
        additional_fields: str = '*',
        limit: int = 1000
    ) -> List[Dict]:
        """
        Apply spatial filter using Databricks geospatial functions.

        Args:
            table_name: Table to query
            geometry_column: Geometry column name
            filter_geometry_wkt: Filter geometry in WKT format
            spatial_rel: Spatial relationship (intersects, contains, within)
            additional_fields: Fields to select
            limit: Maximum rows to return

        Returns:
            Filtered features
        """
        # Map spatial relationship to Databricks function
        spatial_functions = {
            'intersects': 'ST_Intersects',
            'contains': 'ST_Contains',
            'within': 'ST_Within'
        }

        spatial_func = spatial_functions.get(spatial_rel.lower(), 'ST_Intersects')

        query = f"""
        SELECT
            {additional_fields},
            ST_AsGeoJSON({geometry_column}) as geometry_geojson
        FROM {table_name}
        WHERE {spatial_func}({geometry_column}, ST_GeomFromText('{filter_geometry_wkt}'))
        LIMIT {limit}
        """

        return self.execute_query(query)

    def get_extent(
        self,
        table_name: str,
        geometry_column: str = 'geometry'
    ) -> Dict[str, float]:
        """
        Calculate the extent (bounding box) of features in a table.

        Args:
            table_name: Table name
            geometry_column: Geometry column name

        Returns:
            Dictionary with xmin, ymin, xmax, ymax
        """
        query = f"""
        SELECT
            MIN(ST_XMin({geometry_column})) as xmin,
            MIN(ST_YMin({geometry_column})) as ymin,
            MAX(ST_XMax({geometry_column})) as xmax,
            MAX(ST_YMax({geometry_column})) as ymax
        FROM {table_name}
        """

        result = self.execute_query(query)
        return result[0] if result else {}

    def get_feature_count(
        self,
        table_name: str,
        where_clause: Optional[str] = None
    ) -> int:
        """
        Get count of features in table.

        Args:
            table_name: Table name
            where_clause: Optional WHERE clause

        Returns:
            Feature count
        """
        where_sql = f"WHERE {where_clause}" if where_clause else ""
        query = f"SELECT COUNT(*) as count FROM {table_name} {where_sql}"

        result = self.execute_query(query)
        return result[0]['count'] if result else 0

    def get_table_schema(self, table_name: str) -> List[Dict]:
        """
        Get schema information for a table.

        Args:
            table_name: Table name

        Returns:
            List of column definitions
        """
        query = f"DESCRIBE TABLE {table_name}"
        return self.execute_query(query)
