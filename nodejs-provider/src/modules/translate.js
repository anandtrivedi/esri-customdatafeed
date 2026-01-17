/**
 * translate.js
 * Converts Databricks query results to GeoJSON format
 */

function translateToGeoJSON(data, config) {
  if (!data || data.length === 0) {
    return {
      type: "FeatureCollection",
      features: []
    };
  }

  const columns = Object.keys(data[0]);
  return {
    type: "FeatureCollection",
    features: data.map((row) =>
      formatFeature(row, columns, config.idField, config.geometryColumn)
    ),
  };
}

function formatFeature(values, columns, idField, geometryField) {
  let feature = {
    type: "Feature",
    properties: {},
    geometry: {},
  };

  for (let i = 0; i < columns.length; i++) {
    const value = values[columns[i]];

    if (columns[i] === geometryField) {
      // Parse GeoJSON geometry from ST_AsGeoJSON result
      try {
        feature.geometry = JSON.parse(value);
      } catch (error) {
        console.error(`Failed to parse geometry for ${idField}:`, error);
        feature.geometry = null;
      }
    } else {
      if (columns[i] === idField) {
        if (!isValidId(value)) {
          console.warn(`Invalid ID value: ${value}`);
        }
      }
      feature.properties[columns[i]] = value;
    }
  }
  return feature;
}

// Max ID value supported by feature server:
// https://koopjs.github.io/docs/usage/provider#setting-provider-metadata-in-getdata
function isValidId(value) {
  const parsedValue = parseInt(value);
  return 0 <= parsedValue && parsedValue <= 2147483647;
}

module.exports = {
  translateToGeoJSON,
};
