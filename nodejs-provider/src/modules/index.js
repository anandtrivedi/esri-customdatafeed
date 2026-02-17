/**
 * modules/index.js
 * Exports all helper modules for the Databricks provider
 */

const { translateToGeoJSON } = require("./translate");
const { buildSqlQuery } = require("./sql");
const { generateFiltersApplied } = require("./filters");
const { getGeometryQuery, getExtentFromGeoJson } = require("./geometry");
const { getAuditLogger } = require("./auditLog");
const { getGeometryFieldExpression } = require("./geometryFormat");
const {
  validateFieldName,
  validateIdentifier,
  escapeSqlString,
  checkWhereClauseSafety,
  validateInteger,
} = require("./sanitize");
const { buildInsertSql, buildUpdateSql, buildDeleteSql, toGeoJSON } = require("./editSql");
const { buildLakebaseSelectSql, parseGeometryFilter, getSpatialPredicate, buildGeomParam, parseInSR } = require("./lakebaseQuery");
const { getLakebasePool, shutdownLakebasePools } = require("./lakebasePool");

module.exports = {
  translateToGeoJSON,
  buildSqlQuery,
  generateFiltersApplied,
  getGeometryQuery,
  getExtentFromGeoJson,
  getAuditLogger,
  getGeometryFieldExpression,
  validateFieldName,
  validateIdentifier,
  escapeSqlString,
  checkWhereClauseSafety,
  validateInteger,
  buildInsertSql,
  buildUpdateSql,
  buildDeleteSql,
  toGeoJSON,
  buildLakebaseSelectSql,
  parseGeometryFilter,
  getSpatialPredicate,
  buildGeomParam,
  parseInSR,
  getLakebasePool,
  shutdownLakebasePools,
};
