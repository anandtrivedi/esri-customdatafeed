/**
 * filters.js
 * Generates filtersApplied object for ArcGIS
 */

function generateFiltersApplied(geoParams, idField, geometryField) {
  const {
    where,
    objectIds,
    orderByFields,
    resultOffset,
    geometry,
    resultRecordCount,
    returnDistinctValues,
    outFields,
    time,
  } = geoParams;

  const filtersApplied = {};

  // Don't apply filters if asking for unique values of a column for symbology
  if (returnDistinctValues) {
    return filtersApplied;
  }

  if (where) {
    filtersApplied.where = true;
  }

  if (objectIds && idField) {
    filtersApplied.objectIds = true;
  }

  if (resultOffset) {
    // The CDF 12.0 featureserver removes params by their geoservice name
    // (resultOffset); older Koop-based runtimes check `offset`. Declare both,
    // otherwise the runtime re-applies the offset to already-offset rows and
    // pages beyond the first lose features.
    filtersApplied.offset = true;
    filtersApplied.resultOffset = true;
  }

  if (orderByFields) {
    filtersApplied.orderByFields = true;
  }

  if (geometry && geometryField) {
    filtersApplied.geometry = true;
  }

  if (resultRecordCount) {
    // Same dual-key reasoning as resultOffset above.
    filtersApplied.limit = true;
    filtersApplied.resultRecordCount = true;
  }

  if (outFields && outFields !== '*') {
    filtersApplied.outFields = true;
  }

  if (time) {
    filtersApplied.time = true;
  }

  return filtersApplied;
}

module.exports = {
  generateFiltersApplied,
};
