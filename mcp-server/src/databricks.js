// Databricks REST helpers: auth resolution, SQL Statement Execution API, secrets.
// No SDK dependency — plain fetch against the workspace REST API keeps the
// server installable with only the MCP SDK + zod.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const OBJECTID_MAX = 2147483647;

export { OBJECTID_MAX };

/** Parse ~/.databrickscfg (INI subset: [section], key = value). */
export function parseDatabricksCfg(filePath) {
  const cfgPath =
    filePath || process.env.DATABRICKS_CONFIG_FILE || path.join(homedir(), ".databrickscfg");
  let raw;
  try {
    raw = readFileSync(cfgPath, "utf8");
  } catch {
    return {};
  }
  const profiles = {};
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const section = trimmed.match(/^\[(.+)\]$/);
    if (section) {
      current = {};
      profiles[section[1]] = current;
      continue;
    }
    const kv = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (kv && current) current[kv[1].toLowerCase()] = kv[2].trim();
  }
  return profiles;
}

// Cache for OAuth M2M access tokens (app runtime), keyed by client id.
const _m2mCache = new Map();

/** OAuth M2M client-credentials exchange — the auth path inside a Databricks App. */
async function m2mToken(host, clientId, clientSecret) {
  const cached = _m2mCache.get(clientId);
  if (cached && Date.now() < cached.expires - 5 * 60 * 1000) return cached.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" }).toString();
  const res = await fetch(`${host}/oidc/v1/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth M2M token exchange failed (HTTP ${res.status}): ${json.error_description || JSON.stringify(json).slice(0, 200)}`);
  }
  _m2mCache.set(clientId, { token: json.access_token, expires: Date.now() + (json.expires_in || 3600) * 1000 });
  return json.access_token;
}

/**
 * Resolve {host, token} for a profile. Async because the app-runtime path
 * mints an OAuth token over the network.
 * Precedence: explicit env PAT → app-runtime OAuth M2M (injected client
 * id/secret) → profile token (PAT) → `databricks auth token --profile X`.
 */
export async function getAuth({ profile, cfgFile } = {}) {
  if (!profile && process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN) {
    return { host: normalizeHost(process.env.DATABRICKS_HOST), token: process.env.DATABRICKS_TOKEN };
  }
  // Databricks App runtime injects the app service principal's OAuth creds.
  if (!profile && process.env.DATABRICKS_HOST && process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET) {
    const host = normalizeHost(process.env.DATABRICKS_HOST);
    return { host, token: await m2mToken(host, process.env.DATABRICKS_CLIENT_ID, process.env.DATABRICKS_CLIENT_SECRET) };
  }
  const profiles = parseDatabricksCfg(cfgFile);
  const name = profile || "DEFAULT";
  const entry = profiles[name];
  if (!entry || !entry.host) {
    throw new Error(
      `Databricks profile '${name}' not found in .databrickscfg — available: ${Object.keys(profiles).join(", ") || "(none)"}`
    );
  }
  const host = normalizeHost(entry.host);
  if (entry.token) return { host, token: entry.token };
  // OAuth profile — let the Databricks CLI mint a short-lived access token.
  const out = execFileSync("databricks", ["auth", "token", "--profile", name], {
    encoding: "utf8",
    timeout: 30000,
  });
  const token = JSON.parse(out).access_token;
  if (!token) throw new Error(`databricks auth token returned no access_token for profile '${name}'`);
  return { host, token };
}

function normalizeHost(host) {
  return host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host}`;
}

async function apiCall(auth, method, apiPath, body) {
  const res = await fetch(`${auth.host}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Databricks API ${apiPath} → HTTP ${res.status}: ${json.message || text.slice(0, 300)}`);
  }
  return json;
}

/**
 * Execute a SQL statement on a warehouse via the Statement Execution API.
 * Returns { columns: [{name, type}], rows: [[...]] }.
 */
export async function execSql(auth, warehouseId, statement, { timeoutSeconds = 50 } = {}) {
  let result = await apiCall(auth, "POST", "/api/2.0/sql/statements", {
    warehouse_id: warehouseId,
    statement,
    wait_timeout: "30s",
    on_wait_timeout: "CONTINUE",
    disposition: "INLINE",
    format: "JSON_ARRAY",
  });
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (["PENDING", "RUNNING"].includes(result.status?.state)) {
    if (Date.now() > deadline) throw new Error(`SQL statement timed out after ${timeoutSeconds}s: ${statement.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 2000));
    result = await apiCall(auth, "GET", `/api/2.0/sql/statements/${result.statement_id}`);
  }
  if (result.status?.state !== "SUCCEEDED") {
    const err = result.status?.error?.message || JSON.stringify(result.status);
    throw new Error(`SQL failed: ${err}`);
  }
  return {
    columns: (result.manifest?.schema?.columns || []).map((c) => ({ name: c.name, type: c.type_text })),
    rows: result.result?.data_array || [],
  };
}

/** Read one secret value (UTF-8) from a scope. */
export async function getSecret(auth, scope, key) {
  const json = await apiCall(
    auth,
    "GET",
    `/api/2.0/secrets/get?scope=${encodeURIComponent(scope)}&key=${encodeURIComponent(key)}`
  );
  return Buffer.from(json.value, "base64").toString("utf8");
}

/** List secret keys in a scope (returns [] if the scope doesn't exist). */
export async function listSecretKeys(auth, scope) {
  try {
    const json = await apiCall(auth, "GET", `/api/2.0/secrets/list?scope=${encodeURIComponent(scope)}`);
    return (json.secrets || []).map((s) => s.key);
  } catch (e) {
    if (String(e.message).includes("RESOURCE_DOES_NOT_EXIST")) return [];
    throw e;
  }
}
