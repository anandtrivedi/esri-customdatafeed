/**
 * runtimeIdCheck.js
 * Does this server's Custom Data Feeds runtime reject a response containing a feature whose id is falsy?
 *
 * ArcGIS 12.1's runtime (winnow transform-to-esri-properties.js) checks `!properties[idField]` and fails the whole
 * response when any feature's id is 0 or NULL. The 12.0 runtime has no such check and serves those rows fine, so the
 * provider only leaves them out when the check is actually present. Detected once, from the runtime files next to the
 * provider (<customdata>/providers/<provider>/src/modules → <customdata>/framework/packages/winnow/...).
 *
 * CDF_DROP_FALSY_IDS=true|false overrides the detection (default auto).
 */
const fs = require("fs");
const path = require("path");

const CHECK_FILE = ["packages", "winnow", "src", "filter-and-transform", "transforms", "transform-to-esri-properties.js"];
// The falsy test as Esri wrote it (`!properties?.[idFieldDefinition]`). If Esri relaxes it to a null check, the regex
// stops matching and the provider goes back to keeping every row.
const FALSY_CHECK = /!\s*properties\s*\??\.?\s*\[\s*idFieldDefinition\s*\]/;

/** Search upward from each start dir for <dir>/framework/<CHECK_FILE> or <dir>/<CHECK_FILE>. Returns the path or null. */
function findStrictIdCheck(startDirs, { exists = fs.existsSync, read = (p) => fs.readFileSync(p, "utf8") } = {}) {
  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 8 && dir; i++) {
      for (const candidate of [path.join(dir, "framework", ...CHECK_FILE), path.join(dir, ...CHECK_FILE)]) {
        try {
          if (exists(candidate) && FALSY_CHECK.test(read(candidate))) return candidate;
        } catch {
          // unreadable: treat as absent
        }
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

let detected; // cached auto-detection result: { found: string|null }

/** True when the provider should leave out rows whose id is 0, NULL or not a number. */
function runtimeRejectsFalsyIds() {
  const override = (process.env.CDF_DROP_FALSY_IDS || "auto").trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  if (detected === undefined) {
    const starts = [__dirname];
    if (require.main && require.main.filename) starts.push(path.dirname(require.main.filename));
    detected = { found: findStrictIdCheck(starts) };
    console.log(detected.found
      ? `CDF runtime rejects responses with an id of 0 or NULL (${detected.found}); such rows will be left out of data responses`
      : "CDF runtime accepts ids of 0 and NULL; no rows are left out");
  }
  return Boolean(detected.found);
}

module.exports = { findStrictIdCheck, runtimeRejectsFalsyIds, _resetForTests: () => { detected = undefined; } };
