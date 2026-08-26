/**
 * version.js
 * Telemetry identity for usage tracking across Databricks.
 *
 * CONNECTOR_RELEASE is the canonical release of THIS connector, controlled by
 * the maintainer. It is intentionally NOT derived from package.json: deployers
 * routinely bump package.json's version as part of their own packaging, which
 * would otherwise overwrite the upstream release that shows up in Databricks
 * usage telemetry (we have seen deployers report e.g. 11.5.0 / 12.1.0 to match
 * their ArcGIS Enterprise version). Keeping a dedicated constant here keeps the
 * upstream version signal clean.
 *
 * Bump this on each maintainer release (keep in sync with package.json version).
 */
const CONNECTOR_RELEASE = "1.1.2";

/**
 * Optional deployer placeholder. Deployers may set CDF_DEPLOYMENT_LABEL in
 * their .env to stamp their own build / version / org (e.g. their ArcGIS
 * Enterprise version) into telemetry. It is appended as a SEPARATE token and
 * never replaces CONNECTOR_RELEASE, so the upstream version stays identifiable.
 * Sanitized (only [A-Za-z0-9._-]) and length-bounded so the user-agent and
 * Postgres application_name stay well-formed.
 */
function deploymentLabel() {
  const raw = (process.env.CDF_DEPLOYMENT_LABEL || "").trim();
  if (!raw) return null;
  const clean = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return clean || null;
}

/**
 * user-agent token for the Databricks SQL connector. The connector wraps this
 * inside `NodejsDatabricksSqlConnector/x (<tag>; Node.js ...; OS ...)`, so we
 * use a `;`-separated extra field for the deployer label — the version segment
 * stays terminated by `;` and remains cleanly parseable.
 *   esri_databricks-customdatafeed/1.1.0
 *   esri_databricks-customdatafeed/1.1.0; deploy/AGE-11.5
 */
function userAgentTag(product) {
  const label = deploymentLabel();
  return `${product}/${CONNECTOR_RELEASE}` + (label ? `; deploy/${label}` : "");
}

/**
 * Postgres application_name. A space separates the deployer label so the
 * version stays parseable, and the whole string is bounded to 63 bytes (the
 * Postgres NAMEDATALEN limit) so it is not silently truncated mid-version.
 *   esri_databricks-lakebase-customdatafeed/1.1.0
 *   esri_databricks-lakebase-customdatafeed/1.1.0 deploy/AGE-11.5
 */
function applicationName(product) {
  const label = deploymentLabel();
  const tag = `${product}/${CONNECTOR_RELEASE}` + (label ? ` deploy/${label}` : "");
  return tag.slice(0, 63);
}

module.exports = { CONNECTOR_RELEASE, deploymentLabel, userAgentTag, applicationName };
