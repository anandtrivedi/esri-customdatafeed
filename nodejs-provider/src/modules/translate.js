/**
 * translate.js
 * Converts Databricks query results to GeoJSON format
 */

// idFields already warned about overflowing the 32-bit OBJECTID range — warn once per field per process, not per
// feature. A 64-bit id (e.g. AIS `bigid`) would otherwise emit one console.warn for every row, flooding the ArcGIS
// log under tile load (seen: ~8,900 warnings per view) and slowing the response.
const warnedInvalidId = new Set();
const warnedUnsafeId = new Set();
const warnedDroppedId = new Set();

function translateToGeoJSON(data, config, { dropFalsyIds = false } = {}) {
  if (!data || data.length === 0) {
    return {
      type: "FeatureCollection",
      features: []
    };
  }

  const columns = Object.keys(data[0]);
  // Throttle the invalid-id warning per table+field (not just field) so two services sharing an idField name both warn.
  const warnKey = `${config.tableName || config.name || ""}|${config.idField}`;
  let features = data.map((row) =>
    formatFeature(row, columns, config.idField, config.geometryColumn, config.dbWKID, warnKey)
  );
  // ArcGIS 12.1's CDF runtime (winnow transformToEsriProperties) checks `!properties[idField]` and fails the WHOLE
  // response when any feature's id is falsy: one row with id 0 (ids from monotonically_increasing_id() or
  // row_number() - 1 start there), NULL or a non-number left a hole in every page and tile containing it. The caller
  // opts in (dropFalsyIds) only for data requests on a runtime that has that check (runtimeIdCheck.js): 12.0 serves
  // such rows fine, and layer info must keep its one sample row — the runtime picks the layer's id field from it and
  // falls back to a generated OBJECTID (which the table doesn't have) when it's missing. Only when the id column is in
  // the result (distinct values and statistics leave it out).
  if (dropFalsyIds && config.idField && columns.includes(config.idField)) {
    const kept = features.filter((f) => f.properties[config.idField]);
    if (kept.length < features.length && !warnedDroppedId.has(warnKey)) {
      warnedDroppedId.add(warnKey);
      console.error(`idField "${config.idField}" of ${config.tableName || config.name || "this table"} has rows with id 0, NULL or a non-number; ArcGIS rejects a whole response containing one, so those rows are left out (${features.length - kept.length} in this response). Publish with a unique integer idField >= 1. Logged once per table.`);
    }
    features = kept;
  }
  return {
    type: "FeatureCollection",
    features,
  };
}

function formatFeature(values, columns, idField, geometryField, dbWKID, warnKey = idField) {
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
      if (Number.isInteger(intValue) && !Number.isSafeInteger(intValue)) {
        // Above 2^53 - 1 the id is rounded, so neighbouring ids collapse into one OBJECTID: drawing still works, but
        // selection, identify and edits land on the wrong features. Logged as an error, once per table+field.
        if (!warnedUnsafeId.has(warnKey)) {
          warnedUnsafeId.add(warnKey);
          console.error(`idField "${idField}" has values above 2^53 - 1 (9007199254740991), e.g. ${value}. ArcGIS can't represent them exactly: selection, identify and editing will hit the wrong features (drawing is unaffected). Publish with a unique integer column below that limit.`);
        }
      } else if (intValue && !isValidId(intValue) && !warnedInvalidId.has(warnKey)) { // falsy ids are dropped (and logged) by translateToGeoJSON
        warnedInvalidId.add(warnKey);
        console.warn(`Invalid ID value for idField "${idField}" (e.g. ${value}): outside the 32-bit OBJECTID range (1..2147483647) or non-integer. Use a 32-bit-fitting unique integer idField. Suppressing further per-feature warnings for this field.`);
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
 *
 * Detection is a consecutive-edge test (some segment's |Δlon| > 180), NOT a bounding-box span: a bbox wider than 180°
 * also matches genuinely wide shapes through Greenwich (e.g. -100..100) and sub-85° circumpolar rings, and shifting
 * those corrupts them. Only an edge that actually jumps across ±180 marks a true dateline crossing. For a GeoJSON ring
 * the closing edge is covered because first === last; an open LineString has no closing edge.
 */
function normalizeAntimeridian(geometry, dbWKID) {
  if (!geometry || typeof geometry !== "object") return geometry;
  if (dbWKID != null && Number(dbWKID) !== 4326) return geometry;
  const spansDateline = (pts) => {
    let polar = false, jump = false;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Array.isArray(p)) return false;
      if (Math.abs(p[1]) > 85) polar = true;
      if (i > 0 && Math.abs(p[0] - pts[i - 1][0]) > 180) jump = true;
    }
    return !polar && jump;
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
  return 1 <= parsedValue && parsedValue <= 2147483647;
}

module.exports = {
  translateToGeoJSON,
  normalizeAntimeridian,
};
