/**
 * Local test script for the Databricks Geospatial Provider
 * Run this to test the provider logic without deploying to ArcGIS Server
 */

const Model = require('./src/model');

// Mock request object simulating ArcGIS request
const mockRequest = {
  params: {
    tableName: 'catalog.schema.restaurants',
    geometryColumn: 'location',
    idField: 'restaurant_id'
  },
  query: {
    where: "category = 'Italian'",
    resultRecordCount: 10,
    resultOffset: 0
  }
};

async function testProvider() {
  console.log('Testing Databricks Geospatial Provider...\n');

  const model = new Model();

  try {
    console.log('Fetching data with parameters:');
    console.log('  Table:', mockRequest.params.tableName);
    console.log('  Geometry Column:', mockRequest.params.geometryColumn);
    console.log('  ID Field:', mockRequest.params.idField);
    console.log('  WHERE:', mockRequest.query.where);
    console.log('  Limit:', mockRequest.query.resultRecordCount);
    console.log('\n');

    // Call getData() method
    const geojson = await model.getData(mockRequest);

    console.log('✓ Successfully fetched data!');
    console.log('\nGeoJSON Result:');
    console.log('  Feature Count:', geojson.features.length);
    console.log('  Geometry Type:', geojson.metadata.geometryType);
    console.log('  ID Field:', geojson.metadata.idField);
    console.log('  Fields:', geojson.metadata.fields.map(f => f.name).join(', '));

    // Show first feature
    if (geojson.features.length > 0) {
      console.log('\nFirst Feature:');
      console.log(JSON.stringify(geojson.features[0], null, 2));
    }

    // Show metadata
    console.log('\nMetadata:');
    console.log(JSON.stringify(geojson.metadata, null, 2));

    // Clean up
    await model.close();
    console.log('\n✓ Test completed successfully!');

  } catch (error) {
    console.error('\n✗ Test failed with error:', error);
    await model.close();
    process.exit(1);
  }
}

// Run the test
testProvider();
