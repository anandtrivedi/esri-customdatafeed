/**
 * Registration object for Databricks Geospatial Provider
 * This is the entry point that ArcGIS Custom Data Feeds framework uses
 */

const packageInfo = require('../package.json');
const cdconfigInfo = require('../cdconfig.json');

const provider = {
  type: cdconfigInfo.type,
  name: cdconfigInfo.name,
  version: packageInfo.version,
  Model: require('./model')
};

module.exports = provider;
