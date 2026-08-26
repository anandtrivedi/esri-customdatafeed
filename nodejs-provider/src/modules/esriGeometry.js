/**
 * esriGeometry.js
 * Shared Esri → GeoJSON conversion helpers used by both the query-filter builders
 * (geometry.js, lakebaseQuery.js) and the edit builder (editSql.js).
 *
 * Esri `rings` encode BOTH polygons and multipolygons in one flat array, distinguished
 * by winding: exterior rings are CLOCKWISE, holes are COUNTER-CLOCKWISE. Mapping the whole
 * `rings` array straight to a GeoJSON Polygon's coordinates is wrong for a multipolygon —
 * a 2nd exterior ring would be misread as a hole of the first. This groups each exterior
 * ring with the holes that follow it and emits Polygon (one exterior) or MultiPolygon (many).
 */

/**
 * Signed area of a ring (shoelace). > 0 = counter-clockwise, < 0 = clockwise.
 * @param {number[][]} ring - Array of [x, y] coordinate pairs
 */
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a;
}

/**
 * Convert Esri polygon `rings` to a GeoJSON Polygon or MultiPolygon.
 * @param {number[][][]} rings - Esri rings array
 * @returns {{type: string, coordinates: any}} GeoJSON geometry
 */
function esriRingsToGeoJSON(rings) {
  if (!Array.isArray(rings) || rings.length === 0) {
    return { type: 'Polygon', coordinates: [] };
  }

  const polygons = [];
  let current = null;
  for (const ring of rings) {
    // Esri: clockwise ring (signedArea < 0) is an exterior ring → starts a new polygon.
    // Counter-clockwise (>= 0) is a hole → attaches to the current polygon.
    if (signedArea(ring) < 0 || current === null) {
      current = [ring];
      polygons.push(current);
    } else {
      current.push(ring);
    }
  }

  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

/**
 * Convert Esri polyline `paths` to a GeoJSON LineString (single path) or MultiLineString.
 * @param {number[][][]} paths - Esri paths array
 */
function esriPathsToGeoJSON(paths) {
  return paths.length === 1
    ? { type: 'LineString', coordinates: paths[0] }
    : { type: 'MultiLineString', coordinates: paths };
}

module.exports = { esriRingsToGeoJSON, esriPathsToGeoJSON, signedArea };
