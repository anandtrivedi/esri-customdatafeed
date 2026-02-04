/**
 * geometry.js
 * Handles geometry queries and transformations for Databricks ST_* functions
 */

const { getGeometryFieldExpression } = require("./geometryFormat");

/**
 * Build geometry filter query for Databricks
 */
function getGeometryQuery(
  geometry,
  geometryField,
  inSR,
  spatialRel = "esriSpatialRelIntersects",
  dbSR = 4326,
  geometryFormat = null
) {
  // Parse geometry - can be comma delimited or JSON
  let rawGeomFilter = "";
  try {
    rawGeomFilter = JSON.parse(geometry);
  } catch (error) {
    rawGeomFilter = geometry.split(",").map((item) => Number(item.trim()));
  }

  // Convert to GeoJSON format for ST_GeomFromGeoJSON
  const geoJsonString = toGeoJsonString(rawGeomFilter);
  let geometryFilter = `ST_GeomFromGeoJSON('${geoJsonString}')`;

  // Handle spatial reference transformation if needed
  inSR = getSpatialReference(rawGeomFilter, inSR, dbSR);
  if (inSR != dbSR) {
    // Databricks uses ST_Transform(geom, sourceCRS, targetCRS)
    geometryFilter = `ST_Transform(${geometryFilter}, 'EPSG:${inSR}', 'EPSG:${dbSR}')`;
  }

  // Build spatial relationship query
  // Handle all geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)
  const geomFieldExpression = getGeometryFieldExpression(geometryField, dbSR, geometryFormat);

  let geomComponent = "";
  switch (spatialRel) {
    case "esriSpatialRelIntersects":
      geomComponent = `ST_Intersects(${geomFieldExpression}, ${geometryFilter})`;
      break;
    case "esriSpatialRelContains":
      geomComponent = `ST_Contains(${geomFieldExpression}, ${geometryFilter})`;
      break;
    case "esriSpatialRelWithin":
      geomComponent = `ST_Within(${geomFieldExpression}, ${geometryFilter})`;
      break;
    case "esriSpatialRelCrosses":
      geomComponent = `ST_Crosses(${geomFieldExpression}, ${geometryFilter})`;
      break;
    case "esriSpatialRelOverlaps":
      geomComponent = `ST_Overlaps(${geomFieldExpression}, ${geometryFilter})`;
      break;
    case "esriSpatialRelTouches":
      geomComponent = `ST_Touches(${geomFieldExpression}, ${geometryFilter})`;
      break;
    default:
      throw new Error(`Unsupported spatial relation: ${spatialRel}`);
  }
  return geomComponent;
}

/**
 * Extract spatial reference from geometry or parameters
 */
function getSpatialReference(rawGeomFilter, inSR, dbSR) {
  if (inSR) {
    if (typeof inSR === "string") {
      try {
        const parsed = JSON.parse(inSR);
        return parsed.spatialReference?.wkid || parseInt(inSR);
      } catch {
        return parseInt(inSR);
      }
    }
    return inSR;
  }

  if (!rawGeomFilter) return dbSR;

  const { spatialReference } = rawGeomFilter || {};
  if (spatialReference) {
    if ("wkid" in spatialReference) {
      const { wkid, latestWkid } = spatialReference;
      return latestWkid === dbSR ? latestWkid : wkid;
    } else if ("wkt" in spatialReference) {
      // TODO: implement WKT parsing if needed
      throw new Error("WKT string parsing not supported");
    }
  }
  return dbSR;
}

/**
 * Convert various geometry formats to GeoJSON string
 */
function toGeoJsonString(filter) {
  let geojson = {};

  if (isSinglePointArray(filter)) {
    geojson = {
      type: "Point",
      coordinates: filter.map(Number),
    };
  } else if (isEnvelopeArray(filter)) {
    geojson = {
      type: "Polygon",
      coordinates: [
        [
          [filter[0], filter[1]], // Bottom-left corner
          [filter[2], filter[1]], // Bottom-right corner
          [filter[2], filter[3]], // Top-right corner
          [filter[0], filter[3]], // Top-left corner
          [filter[0], filter[1]], // Closing the polygon
        ],
      ],
    };
  } else if (typeof filter === "object" && filter.rings) {
    // Esri Polygon format
    geojson = {
      type: "Polygon",
      coordinates: filter.rings,
    };
  } else if (typeof filter === "object" && filter.paths) {
    // Esri Polyline format
    geojson = {
      type: "LineString",
      coordinates: filter.paths[0],
    };
  } else if (typeof filter === "object" && filter.x !== undefined) {
    // Esri Point format
    geojson = {
      type: "Point",
      coordinates: [filter.x, filter.y],
    };
  } else {
    // Assume it's already GeoJSON
    geojson = filter;
  }

  return JSON.stringify(geojson);
}

/**
 * Check if array is a single point [x, y]
 */
function isSinglePointArray(pointArray) {
  if (!Array.isArray(pointArray)) {
    return false;
  }
  if (pointArray.length !== 2) {
    return false;
  }
  return pointArray.every((item) => typeof item === "number");
}

/**
 * Check if array is an envelope [xmin, ymin, xmax, ymax]
 */
function isEnvelopeArray(envelopeArray) {
  if (!Array.isArray(envelopeArray)) {
    return false;
  }
  if (envelopeArray.length !== 4) {
    return false;
  }
  return envelopeArray.every((item) => typeof item === "number");
}

/**
 * Calculate extent from GeoJSON polygon
 */
function getExtentFromGeoJson(geoJsonPolygon, dbWKID) {
  const coordinates = geoJsonPolygon.coordinates[0];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  coordinates.forEach(([longitude, latitude]) => {
    if (longitude < minX) minX = longitude;
    if (longitude > maxX) maxX = longitude;
    if (latitude < minY) minY = latitude;
    if (latitude > maxY) maxY = latitude;
  });

  return {
    xmin: minX,
    ymin: minY,
    xmax: maxX,
    ymax: maxY,
    spatialReference: {
      wkid: dbWKID,
    },
  };
}

module.exports = {
  getGeometryQuery,
  getExtentFromGeoJson,
};
