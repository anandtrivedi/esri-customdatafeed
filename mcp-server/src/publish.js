// createService payload assembly + publish orchestration with post-publish
// smoke test. Payload shape captured from a live ArcGIS Server 12.0 CDF
// service (see USHighways reference in repo docs).

const PROVIDER_NAME = "databricks-geospatial-provider";
const SERVICE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export { PROVIDER_NAME };

/**
 * Build the full createService JSON. `manifestParams` is the serviceParameters
 * key list from the registered provider manifest — every key must be present
 * (empty string when unused) or ArcGIS rejects the service.
 */
export function buildServiceJson({ serviceName, description = "", params, manifestParams, editing = false, providerName = PROVIDER_NAME }) {
  if (!SERVICE_NAME_RE.test(serviceName)) {
    throw new Error(`Service name must match ${SERVICE_NAME_RE} — got '${serviceName}'`);
  }
  const serviceParameters = {};
  for (const key of manifestParams) serviceParameters[key] = params[key] != null ? String(params[key]) : "";
  const unknown = Object.keys(params).filter((k) => !manifestParams.includes(k));
  if (unknown.length) throw new Error(`Unknown service parameters for provider: ${unknown.join(", ")}`);
  return {
    serviceName,
    type: "FeatureServer",
    description,
    capabilities: editing ? "Query,Create,Update,Delete,Editing" : "Query",
    provider: "CUSTOMDATA",
    clusterName: "default",
    minInstancesPerNode: 0,
    maxInstancesPerNode: 0,
    instancesPerContainer: 1,
    maxWaitTime: 60,
    maxStartupTime: 300,
    maxIdleTime: 1800,
    maxUsageTime: 600,
    loadBalancing: "ROUND_ROBIN",
    isolationLevel: "HIGH",
    configuredState: "STARTED",
    recycleInterval: 24,
    recycleStartTime: "00:00",
    keepAliveInterval: 1800,
    private: false,
    isDefault: false,
    maxUploadFileSize: 0,
    allowedUploadFileTypes: "",
    properties: { disableCaching: "true" },
    jsonProperties: {
      customDataProviderInfo: {
        forwardUserIdentity: false,
        dataProviderName: providerName,
        serviceParameters,
      },
    },
    extensions: [],
    frameworkProperties: {},
    datasets: [],
  };
}

/** Locate a provider's manifest on the target server. */
export async function getProviderManifest(client, providerName = PROVIDER_NAME) {
  const providers = await client.listProviders();
  const mine = providers.find((p) => p.name === providerName);
  if (!mine) {
    throw new Error(
      `Provider '${providerName}' is not registered on this ArcGIS Server — run register_provider/provider setup first.`
    );
  }
  return {
    name: mine.name,
    arcgisVersion: mine.arcgisVersion,
    editingEnabled: Boolean(mine.editingEnabled),
    parameterKeys: (mine.properties?.serviceParameters || []).map((p) => p.key),
    cdpkFile: mine.cdpkFile,
  };
}

/** Wait for a freshly created service to report STARTED. */
export async function waitForStart(client, serviceName, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await client.serviceStatus(serviceName);
      if (last.realTimeState === "STARTED") return last;
    } catch {
      // status can 404 briefly right after creation
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Service ${serviceName} did not reach STARTED within ${timeoutMs / 1000}s (last: ${JSON.stringify(last)})`);
}

/** Post-publish verification: count + one real feature with geometry. */
export async function smokeTest(client, serviceName) {
  const countRes = await client.restRequest(`services/${serviceName}/FeatureServer/0/query`, {
    where: "1=1",
    returnCountOnly: "true",
  });
  const sample = await client.restRequest(`services/${serviceName}/FeatureServer/0/query`, {
    where: "1=1",
    outFields: "*",
    resultRecordCount: "1",
  });
  const feature = (sample.features || [])[0];
  return {
    count: countRes.count,
    sampleFeatureHasGeometry: Boolean(feature?.geometry),
    sampleAttributes: feature ? Object.keys(feature.attributes || {}).slice(0, 12) : [],
  };
}

/** Guard for unpublish: only ever delete services owned by our provider. */
export function assertOwnService(serviceJson, serviceName, providerName = PROVIDER_NAME) {
  const actual = serviceJson?.jsonProperties?.customDataProviderInfo?.dataProviderName;
  if (actual !== providerName) {
    throw new Error(
      `Refusing to delete '${serviceName}': it is not a ${providerName} service (provider: ${actual || "unknown"}).`
    );
  }
}
