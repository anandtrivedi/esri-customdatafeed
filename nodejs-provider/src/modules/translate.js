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
      formatFeature(row, columns, config.idField, config.geometryColumn, config.dbWKID)
    ),
  };
}

function formatFeature(values, columns, idField, geometryField, dbWKID) {
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
        feature.geometry = normalizeAntimeridian(JSON.parse(value), dbWKID);
      } catch (error) {
        console.error(`Failed to parse geometry for ${idField}:`, error);
        feature.geometry = null;
      }
    } else if (columns[i] === idField) {
      // Cast to integer — Databricks returns BIGINT as strings/BigInts,
      // but CDF runtime requires safe integers for OBJECTID recognition
      const intValue = Number(value);
      if (!isValidId(intValue)) {
        console.warn(`Invalid ID value: ${value}`);
      }
      feature.properties[columns[i]] = intValue;
    } else {
      feature.properties[columns[i]] = value;
    }
  }
  return feature;
}

/**
 * Unwrap lines and polygons that cross the antimeridian. Stored in -180..180, a ring whose vertices jump from about
 * +179.9 to -179.9 is drawn by ArcGIS clients as a band across the whole map (H3 cell boundaries near 180° are the
 * usual case). Shifting its negative longitudes by +360 gives a small shape straddling 180°, which clients draw and
 * wrap correctly. Applied per polygon (outer ring decides; holes get the same shift so the rings stay consistent) and
 * per line. Only for geographic coordinates (4326 / unset), and not poleward of ±85° — a ring around a pole really
 * does span every longitude. Filters still run against the stored geometry in Databricks; this only changes output.
 */
function normalizeAntimeridian(geometry, dbWKID) {
  if (!geometry || typeof geometry !== "object") return geometry;
  if (dbWKID != null && Number(dbWKID) !== 4326) return geometry;
  const spansDateline = (ring) => {
    let lo = Infinity, hi = -Infinity, polar = false;
    for (const p of ring) {
      if (!Array.isArray(p)) return false;
      lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]);
      if (Math.abs(p[1]) > 85) polar = true;
    }
    return !polar && hi - lo > 180;
  };
  const shift = (ring) => ring.map((p) => (p[0] < 0 ? [p[0] + 360, ...p.slice(1)] : p));
  const polygon = (rings) => (rings.length && spansDateline(rings[0]) ? rings.map(shift) : rings);
  const line = (pts) => (spansDateline(pts) ? shift(pts) : pts);
  switch (geometry.type) {
    case "Polygon": return { ...geometry, coordinates: polygon(geometry.coordinates || []) };
    case "MultiPolygon": return { ...geometry, coordinates: (geometry.coordinates || []).map(polygon) };
    case "LineString": return { ...geometry, coordinates: line(geometry.coordinates || []) };
    case "MultiLineString": return { ...geometry, coordinates: (geometry.coordinates || []).map(line) };
    default: return geometry;
  }
}

// Max ID value supported by feature server:
// https://koopjs.github.io/docs/usage/provider#setting-provider-metadata-in-getdata
function isValidId(value) {
  const parsedValue = parseInt(value);
  return 0 <= parsedValue && parsedValue <= 2147483647;
}

module.exports = {
  translateToGeoJSON,
  normalizeAntimeridian,
};
