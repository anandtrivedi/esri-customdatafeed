/**
 * scale.js
 * Parses the optional `minScale` service parameter: the most zoomed-out map scale at which clients should draw the
 * layer. Advertised as standard layer metadata (`minScale`), so Map Viewer, Pro and the JS SDK don't request features
 * when zoomed out further; the CDF runtime copies it into the layer JSON.
 *
 * Accepts a scale denominator ("577791") or a Web Mercator zoom level ("zoom 10", "level 10", "z10", "lod 10").
 */

// Web Mercator (ArcGIS Online / Google tiling scheme) scale at zoom 0, at 96 dpi; zoom n = this / 2^n.
const ZOOM0_SCALE = 591657527.591555;

function zoomToScale(zoom) {
  return Math.round(ZOOM0_SCALE / Math.pow(2, zoom));
}

/** @returns {number|null} scale denominator, or null when unset; throws on a malformed value */
function parseMinScale(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  const zoom = v.match(/^(?:zoom|level|lod|z)\s*[:=]?\s*(\d{1,2})$/);
  if (zoom) {
    const z = parseInt(zoom[1], 10);
    if (z > 23) throw new Error(`minScale: zoom ${z} is out of range (0-23)`);
    return zoomToScale(z);
  }
  const n = Number(v.replace(/^1\s*:\s*/, '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`minScale: expected a scale like 577791 or a zoom level like "zoom 10", got "${value}"`);
  }
  return Math.round(n);
}

module.exports = { parseMinScale, zoomToScale, ZOOM0_SCALE };
