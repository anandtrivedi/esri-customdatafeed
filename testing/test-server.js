/**
 * test-server.js
 * Standalone test server for the Databricks Custom Data Provider
 *
 * This simulates how ArcGIS Server calls the provider's getData() method.
 * Use this to test provider logic before deploying to ArcGIS Server.
 *
 * Now includes authentication testing!
 */

// Load environment variables
require('dotenv').config({ path: require('path').join(__dirname, '../nodejs-provider/.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import the provider Model (adjust path if needed)
const Model = require('../nodejs-provider/src/model');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for browser testing
app.use(cors());
app.use(express.json());

// Serve static files (for viewer.html)
app.use(express.static(__dirname));

// Mock data for testing without Databricks
const USE_MOCK_DATA = false;  // Set to true if Databricks is not configured

const MOCK_DATA = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 1,
      properties: { restaurant_id: 1, name: 'Little Italy Pizza', category: 'Italian', rating: 4.5 },
      geometry: { type: 'Point', coordinates: [-73.9851, 40.7589] }
    },
    {
      type: 'Feature',
      id: 2,
      properties: { restaurant_id: 2, name: 'Sakura Sushi', category: 'Japanese', rating: 4.8 },
      geometry: { type: 'Point', coordinates: [-73.9776, 40.7614] }
    },
    {
      type: 'Feature',
      id: 3,
      properties: { restaurant_id: 3, name: 'Taco Fiesta', category: 'Mexican', rating: 4.2 },
      geometry: { type: 'Point', coordinates: [-73.9855, 40.7580] }
    }
  ],
  metadata: {
    name: 'restaurants',
    geometryType: 'Point',
    idField: 'restaurant_id',
    fields: [
      { name: 'restaurant_id', type: 'esriFieldTypeInteger' },
      { name: 'name', type: 'esriFieldTypeString' },
      { name: 'category', type: 'esriFieldTypeString' },
      { name: 'rating', type: 'esriFieldTypeDouble' }
    ],
    maxRecordCount: 2000
  }
};

// Initialize the provider model
const model = new Model();

/**
 * Main query endpoint
 * Simulates ArcGIS REST API query endpoint
 * Now includes authorization check!
 */
app.get('/query', async (req, res) => {
  try {
    console.log('\n--- Incoming Request ---');
    console.log('Query params:', req.query);
    console.log('Authorization header:', req.headers.authorization || 'none');

    // Use mock data if configured
    if (USE_MOCK_DATA) {
      console.log('Using mock data');
      return res.json(MOCK_DATA);
    }

    // Extract table parameter (not standard ArcGIS param, added for testing)
    // Use defaults from environment variables
    const tableName = req.query.table || req.query.tableName || process.env.DATABRICKS_DEFAULT_TABLE;
    const geometryColumn = req.query.geometryColumn || process.env.DATABRICKS_GEOMETRY_COLUMN || 'geometry_wkt';
    const idField = req.query.idField || process.env.DATABRICKS_ID_FIELD || 'objectid';

    if (!tableName) {
      return res.status(400).json({
        error: 'Missing required parameter: table',
        example: '/query?table=catalog.schema.restaurants&f=geojson'
      });
    }

    // Build request object that mimics what ArcGIS Server sends
    const mockReq = {
      params: {
        tableName: tableName,
        geometryColumn: geometryColumn,
        idField: idField
      },
      query: {
        ...req.query,
        // Remove our custom params
        table: undefined,
        tableName: undefined,
        geometryColumn: undefined,
        idField: undefined
      },
      headers: req.headers,
      ip: req.ip,
      connection: req.connection,
      _user: req._user  // For ArcGIS user auth testing
    };

    // Call authorize() first (if method exists)
    if (typeof model.authorize === 'function') {
      model.authorize(mockReq, (authError, authorized) => {
        if (authError || !authorized) {
          console.error('Authorization failed:', authError?.message || 'Access denied');
          return res.status(401).json({
            error: 'Unauthorized',
            details: authError?.message || 'Access denied'
          });
        }

        console.log('✓ Authorization successful');

        // Call the provider's getData method
        callGetData(mockReq, res);
      });
    } else {
      // No authorize() method, proceed directly to getData()
      callGetData(mockReq, res);
    }

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: 'Server error',
      details: error.message
    });
  }
});

/**
 * Helper function to call getData()
 */
function callGetData(mockReq, res) {
  model.getData(mockReq, (error, geojson) => {
    try {
      if (error) {
        console.error('Provider error:', error);
        return res.status(500).json({
          error: 'Provider error',
          details: error.message
        });
      }

      console.log('--- Response ---');
      console.log(`Returned ${geojson.features ? geojson.features.length : 0} features`);
      console.log('Metadata:', geojson.metadata);
      console.log('FiltersApplied:', geojson.filtersApplied);

      // Return GeoJSON
      res.json(geojson);
    } catch (error) {
      console.error('Response error:', error);
      res.status(500).json({
        error: 'Response error',
        details: error.message
      });
    }
  });
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mockData: USE_MOCK_DATA
  });
});

/**
 * Info endpoint - shows example URLs
 */
app.get('/', (req, res) => {
  res.json({
    message: 'Databricks Custom Data Provider Test Server',
    mockData: USE_MOCK_DATA,
    authentication: {
      simpleAuth: process.env.ENABLE_SIMPLE_AUTH === 'true',
      userAuth: process.env.ENABLE_USER_AUTH === 'true',
      auditLog: process.env.ENABLE_AUDIT_LOG === 'true'
    },
    endpoints: {
      health: 'GET /health',
      query: 'GET /query',
      viewer: 'GET /viewer.html'
    },
    examples: [
      {
        description: 'Get all features',
        url: `/query?table=catalog.schema.restaurants&f=geojson`
      },
      {
        description: 'Filter by attribute',
        url: `/query?table=catalog.schema.restaurants&where=category='Italian'&f=geojson`
      },
      {
        description: 'Spatial query (bbox)',
        url: `/query?table=catalog.schema.restaurants&geometry=-74,40,-73,41&spatialRel=esriSpatialRelIntersects&f=geojson`
      },
      {
        description: 'Count only',
        url: `/query?table=catalog.schema.restaurants&returnCountOnly=true&f=json`
      },
      {
        description: 'Pagination',
        url: `/query?table=catalog.schema.restaurants&resultRecordCount=5&resultOffset=0&f=geojson`
      },
      {
        description: 'Order by field',
        url: `/query?table=catalog.schema.restaurants&orderByFields=rating DESC&f=geojson`
      }
    ],
    notes: [
      'Replace catalog.schema.restaurants with your actual table name',
      'Use geometryColumn and idField params if different from defaults',
      'View data on map: open viewer.html in browser'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n==============================================');
  console.log('Databricks Custom Data Provider Test Server');
  console.log('==============================================');
  console.log(`Server running at: http://localhost:${PORT}`);
  console.log(`Mock data mode: ${USE_MOCK_DATA}`);
  console.log('\nEndpoints:');
  console.log(`  Info:   http://localhost:${PORT}/`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Query:  http://localhost:${PORT}/query?table=...&f=geojson`);
  console.log(`  Viewer: http://localhost:${PORT}/viewer.html`);
  console.log('\nExample:');
  console.log(`  curl "http://localhost:${PORT}/query?table=catalog.schema.restaurants&f=geojson"`);
  console.log('==============================================\n');
});
