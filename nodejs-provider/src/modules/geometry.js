/**
 * geometry.js
 * Handles geometry queries and transformations for Databricks ST_* functions
 *
 * Databricks Spatial SQL reference:
 * https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-st-geospatial-functions-alpha
 *
 * Note on ST_Overlaps and ST_Crosses:
 * Databricks SQL does not provide native ST_Overlaps or ST_Crosses functions.
 * These are implemented below as DE-9IM (Dimensionally Extended 9-Intersection
 * Model) equivalent rewrites using functions that Databricks does support.
 * The behavior matches PostGIS for valid geometries.
 * See: https://en.wikipedia.org/wiki/DE-9IM
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
  // ST_GeomFromGeoJSON always returns GEOMETRY with SRID 4326
  let geometryFilter = `ST_GeomFromGeoJSON('${geoJsonString}')`;

  // Handle spatial reference transformation if needed
  // ST_GeomFromGeoJSON always produces SRID=4326, so if the input geometry
  // came from a different CRS we need to set the correct source SRID first
  inSR = getSpatialReference(rawGeomFilter, inSR, dbSR);
  if (inSR != dbSR) {
    // Databricks ST_Transform signature: ST_Transform(GEOMETRY, targetSRID INTEGER)
    // The source SRID is read from the geometry itself. Since ST_GeomFromGeoJSON
    // hardcodes SRID=4326, we use ST_SetSRID to stamp the actual source SRID
    // before transforming to the target.
    geometryFilter = `ST_Transform(ST_SetSRID(${geometryFilter}, ${inSR}), ${dbSR})`;
  }

  // Build spatial relationship query
  // Handle all geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)
  const geomFieldExpression = getGeometryFieldExpression(geometryField, dbSR, geometryFormat);

  const A = geomFieldExpression;
  const B = geometryFilter;

  let geomComponent = "";
  switch (spatialRel) {
    case "esriSpatialRelIntersects":
      geomComponent = `ST_Intersects(${A}, ${B})`;
      break;
    case "esriSpatialRelContains":
      geomComponent = `ST_Contains(${A}, ${B})`;
      break;
    case "esriSpatialRelWithin":
      geomComponent = `ST_Within(${A}, ${B})`;
      break;
    case "esriSpatialRelCrosses":
      geomComponent = buildCrossesExpression(A, B);
      break;
    case "esriSpatialRelOverlaps":
      geomComponent = buildOverlapsExpression(A, B);
      break;
    case "esriSpatialRelTouches":
      geomComponent = `ST_Touches(${A}, ${B})`;
      break;
    default:
      throw new Error(`Unsupported spatial relation: ${spatialRel}`);
  }
  return geomComponent;
}

/**
 * DE-9IM workaround for ST_Overlaps (not natively available in Databricks SQL).
 *
 * Two geometries overlap when they intersect, have the same dimension, but
 * neither covers the other and they don't merely touch. Per the DE-9IM matrix:
 *
 *   ST_Overlaps(A, B) ≡
 *     ST_Dimension(A) = ST_Dimension(B)
 *     AND ST_Intersects(A, B)
 *     AND NOT ST_Covers(A, B)
 *     AND NOT ST_Covers(B, A)
 *     AND NOT ST_Touches(A, B)
 *
 * For geometries of different dimension this returns false, consistent with
 * PostGIS behavior for valid geometries.
 *
 * Databricks functions used: ST_Dimension, ST_Intersects, ST_Covers, ST_Touches
 */
function buildOverlapsExpression(A, B) {
  return `(ST_Dimension(${A}) = ST_Dimension(${B}) AND ST_Intersects(${A}, ${B}) AND NOT ST_Covers(${A}, ${B}) AND NOT ST_Covers(${B}, ${A}) AND NOT ST_Touches(${A}, ${B}))`;
}

/**
 * DE-9IM workaround for ST_Crosses (not natively available in Databricks SQL).
 *
 * Two geometries cross when they intersect in a way that produces a geometry
 * of lower dimension than the maximum of the two inputs, and the intersection
 * is not the entirety of either geometry. Per the DE-9IM matrix, the key
 * property is that the intersection dimension is strictly less than the
 * maximum dimension of the inputs.
 *
 *   ST_Crosses(A, B) ≡
 *     ST_Intersects(A, B)
 *     AND NOT ST_Touches(A, B)
 *     AND NOT ST_Contains(A, B)
 *     AND NOT ST_Within(A, B)
 *     AND ST_Dimension(ST_Intersection(A, B))
 *        < GREATEST(ST_Dimension(A), ST_Dimension(B))
 *
 * Note: This is computationally heavier than a native predicate because it
 * materializes the intersection geometry to check its dimension.
 *
 * Databricks functions used: ST_Intersects, ST_Touches, ST_Contains,
 *   ST_Within, ST_Dimension, ST_Intersection, GREATEST
 */
function buildCrossesExpression(A, B) {
  return `(ST_Intersects(${A}, ${B}) AND NOT ST_Touches(${A}, ${B}) AND NOT ST_Contains(${A}, ${B}) AND NOT ST_Within(${A}, ${B}) AND ST_Dimension(ST_Intersection(${A}, ${B})) < GREATEST(ST_Dimension(${A}), ST_Dimension(${B})))`;
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
  } else if (typeof filter === "object" && filter.xmin !== undefined) {
    // Esri Envelope format
    geojson = {
      type: "Polygon",
      coordinates: [
        [
          [filter.xmin, filter.ymin],
          [filter.xmax, filter.ymin],
          [filter.xmax, filter.ymax],
          [filter.xmin, filter.ymax],
          [filter.xmin, filter.ymin],
        ],
      ],
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
  if (!geoJsonPolygon || !geoJsonPolygon.coordinates || !geoJsonPolygon.coordinates[0]) {
    return null;
  }
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
