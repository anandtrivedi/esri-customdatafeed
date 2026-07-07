// Provider lifecycle: .cdpk repackaging (rename + baked .env) and the
// upload → register/update → verify flow against the ArcGIS admin API.
//
// Baking the .env INTO the .cdpk is deliberate: the CDF runtime extracts the
// package over the provider directory on every update, wiping any manually
// placed .env — the historical footgun. A baked .env survives every update
// and makes registration fully remote (no filesystem access to the GIS box).

import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";

/**
 * Repackage a .cdpk buffer: optionally rename the provider (cdconfig.json
 * `name`) and/or bake a .env file. Returns { buffer, providerName }.
 */
export function repackageCdpk(cdpkBuffer, { providerName, envVars } = {}) {
  const zip = new AdmZip(cdpkBuffer);
  const cdconfigEntry = zip.getEntry("cdconfig.json");
  if (!cdconfigEntry) throw new Error("Not a valid .cdpk: no cdconfig.json at archive root");
  const cdconfig = JSON.parse(zip.readAsText(cdconfigEntry));
  const originalName = cdconfig.name;

  let changed = false;
  if (providerName && providerName !== originalName) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(providerName)) {
      throw new Error(`Provider name must be lowercase alphanumeric/hyphen — got '${providerName}'`);
    }
    cdconfig.name = providerName;
    // ArcGIS validates that cdconfig "fileName" matches the uploaded .cdpk name.
    cdconfig.fileName = `${providerName}.cdpk`;
    zip.updateFile(cdconfigEntry, Buffer.from(JSON.stringify(cdconfig, null, 2)));
    changed = true;
  }
  if (envVars && Object.keys(envVars).length > 0) {
    const banned = Object.keys(envVars).filter((k) => !/^[A-Z][A-Z0-9_]*$/.test(k));
    if (banned.length) throw new Error(`Invalid env var names: ${banned.join(", ")}`);
    const envText = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    if (zip.getEntry(".env")) zip.updateFile(".env", Buffer.from(envText));
    else zip.addFile(".env", Buffer.from(envText));
    changed = true;
  }
  return {
    buffer: changed ? zip.toBuffer() : cdpkBuffer,
    providerName: cdconfig.name,
    originalName,
  };
}

export function loadCdpk(path) {
  return readFileSync(path);
}

/**
 * Register (or update) a provider from a .cdpk buffer.
 * mode: "register" (first install) | "update" (replace existing).
 * Returns the provider manifest as the server now reports it.
 */
export async function registerProviderFlow(client, cdpkBuffer, providerName, { mode = "register" } = {}) {
  const existing = (await client.listProviders()).find((p) => p.name === providerName);
  if (mode === "register" && existing) {
    throw new Error(
      `Provider '${providerName}' is already registered (${existing.cdpkFile}). Use update=true to replace it — ` +
        "and note the update replaces the live provider directory."
    );
  }
  if (mode === "update" && !existing) {
    throw new Error(`Provider '${providerName}' is not registered — use register (update=false) for a first install.`);
  }
  const item = await client.uploadFile(cdpkBuffer, `${providerName}.cdpk`);
  const op = mode === "update" ? "update" : "register";
  // Registration validates the package by starting it with the bundled Node
  // runtime — routinely 30-120s for a real provider with node_modules.
  await client.request(`services/types/customdataproviders/${op}`, { id: item.itemID }, { method: "POST", timeout: 300000 });
  const after = (await client.listProviders()).find((p) => p.name === providerName);
  if (!after) throw new Error(`${op} reported success but provider '${providerName}' is not in the registry — check server logs.`);
  return {
    name: after.name,
    arcgisVersion: after.arcgisVersion,
    editingEnabled: Boolean(after.editingEnabled),
    parameterKeys: (after.properties?.serviceParameters || []).map((p) => p.key),
    cdpkFile: after.cdpkFile,
  };
}

/**
 * Unregister a provider. Refuses if any FeatureServer service still uses it.
 * `serviceProviders` is [{serviceName, dataProviderName}] gathered by the caller.
 */
export async function unregisterProviderFlow(client, providerName, serviceProviders) {
  const inUse = serviceProviders.filter((s) => s.dataProviderName === providerName).map((s) => s.serviceName);
  if (inUse.length) {
    throw new Error(
      `Refusing to unregister '${providerName}': ${inUse.length} service(s) still use it (${inUse.slice(0, 5).join(", ")}). ` +
        "Unpublish them first."
    );
  }
  const manifest = (await client.listProviders()).find((p) => p.name === providerName);
  if (!manifest) throw new Error(`Provider '${providerName}' is not registered.`);
  await client.request(
    `services/types/customdataproviders/unregister`,
    { customdataFilename: manifest.cdpkFile || `${providerName}.cdpk` },
    { method: "POST", timeout: 120000 }
  );
  const still = (await client.listProviders()).find((p) => p.name === providerName);
  if (still) throw new Error(`unregister reported success but '${providerName}' is still registered.`);
  return { unregistered: providerName };
}
