// GIS target registry. Credentials NEVER pass through tool arguments or chat:
// targets are registered out-of-band and passwords resolve from references.
//
// Sources, merged in this order (later wins on name collision):
//   1. env single target      — ARCGIS_ADMIN_URL / ARCGIS_ADMIN_USER / ARCGIS_ADMIN_PASSWORD → "default"
//   2. local file             — ~/.cdf-mcp/targets.json (or CDF_MCP_TARGETS_FILE), mode 0600
//   3. Databricks secret scope — CDF_MCP_SECRET_SCOPE: each key is a target name whose
//                                value is the target JSON. Zero-touch registration:
//                                `databricks secrets put-secret <scope> <name>` from any laptop.
//
// Target shape:
// {
//   "adminUrl": "https://host:6443/arcgis/admin",
//   "user": "siteadmin",
//   "password": "..."                  // literal (local file only), or
//   "passwordRef": "env:VAR" | "secret:scope/key",
//   "allowSelfSigned": true,
//   "databricks": { "profile": "Pubsec-FE", "warehouseId": "..." }
// }

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAuth, getSecret, listSecretKeys } from "./databricks.js";

const SCOPE_CACHE_TTL_MS = 60 * 1000;

export function localTargetsPath() {
  return process.env.CDF_MCP_TARGETS_FILE || path.join(homedir(), ".cdf-mcp", "targets.json");
}

function loadLocalTargets() {
  try {
    return JSON.parse(readFileSync(localTargetsPath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveLocalTarget(name, target) {
  const file = localTargetsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const targets = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  targets[name] = target;
  writeFileSync(file, JSON.stringify(targets, null, 2) + "\n", { mode: 0o600 });
  return file;
}

function envTarget() {
  if (!process.env.ARCGIS_ADMIN_URL) return {};
  return {
    default: {
      adminUrl: process.env.ARCGIS_ADMIN_URL,
      user: process.env.ARCGIS_ADMIN_USER,
      passwordRef: "env:ARCGIS_ADMIN_PASSWORD",
      allowSelfSigned: process.env.ARCGIS_ALLOW_SELF_SIGNED === "true",
      databricks: {
        profile: process.env.CDF_MCP_DATABRICKS_PROFILE,
        warehouseId: process.env.DATABRICKS_WAREHOUSE_ID,
      },
    },
  };
}

export class TargetRegistry {
  constructor({ secretScope = process.env.CDF_MCP_SECRET_SCOPE, secretProfile = process.env.CDF_MCP_SECRET_PROFILE, deps = {} } = {}) {
    this.secretScope = secretScope;
    this.secretProfile = secretProfile;
    this._scopeCache = null;
    this._scopeCacheTime = 0;
    // Dependency injection for tests.
    this._getAuth = deps.getAuth || getAuth;
    this._getSecret = deps.getSecret || getSecret;
    this._listSecretKeys = deps.listSecretKeys || listSecretKeys;
    this._loadLocal = deps.loadLocalTargets || loadLocalTargets;
  }

  async _scopeTargets() {
    if (!this.secretScope) return {};
    if (this._scopeCache && Date.now() - this._scopeCacheTime < SCOPE_CACHE_TTL_MS) return this._scopeCache;
    const auth = this._getAuth({ profile: this.secretProfile });
    const keys = await this._listSecretKeys(auth, this.secretScope);
    const targets = {};
    for (const key of keys) {
      try {
        const value = await this._getSecret(auth, this.secretScope, key);
        const parsed = JSON.parse(value);
        if (parsed && parsed.adminUrl) targets[key] = parsed;
      } catch {
        // Non-JSON keys (e.g. bare passwords referenced via secret:) are skipped.
      }
    }
    this._scopeCache = targets;
    this._scopeCacheTime = Date.now();
    return targets;
  }

  /** All targets with passwords REDACTED — safe to return through a tool. */
  async listTargets() {
    const merged = { ...envTarget(), ...this._loadLocal(), ...(await this._scopeTargets()) };
    return Object.fromEntries(
      Object.entries(merged).map(([name, t]) => [
        name,
        {
          adminUrl: t.adminUrl,
          user: t.user,
          allowSelfSigned: Boolean(t.allowSelfSigned),
          databricks: t.databricks || {},
          credentialSource: t.password ? "inline" : t.passwordRef || "(missing)",
        },
      ])
    );
  }

  /**
   * Resolve a target by name or by admin/host URL, with its password materialized.
   * Never expose the returned object through a tool result.
   */
  async resolve(nameOrUrl) {
    const merged = { ...envTarget(), ...this._loadLocal(), ...(await this._scopeTargets()) };
    const names = Object.keys(merged);
    if (names.length === 0) {
      throw new Error(
        "No GIS targets registered. An operator must register one (cdf-mcp register-target, " +
          "or put-secret into the configured secret scope) — credentials are never accepted via chat/tools."
      );
    }
    let name = nameOrUrl;
    if (!name) {
      if (names.length === 1) name = names[0];
      else throw new Error(`Multiple GIS targets registered (${names.join(", ")}) — specify one via the 'target' parameter.`);
    }
    let target = merged[name];
    if (!target) {
      // Try URL/host matching: "https://xyz.com:6443/..." or bare "xyz.com".
      const wanted = String(nameOrUrl).replace(/^https?:\/\//, "").split("/")[0].split(":")[0].toLowerCase();
      const hit = Object.entries(merged).find(([, t]) => {
        try {
          return new URL(t.adminUrl).hostname.toLowerCase() === wanted;
        } catch {
          return false;
        }
      });
      if (hit) [name, target] = hit;
    }
    if (!target) {
      throw new Error(
        `GIS target '${nameOrUrl}' is not registered (known: ${names.join(", ")}). ` +
          "An operator must register it first — passwords are never accepted through this interface."
      );
    }
    return { name, ...target, password: await this._resolvePassword(target, name) };
  }

  async _resolvePassword(target, name) {
    if (target.password) return target.password;
    const ref = target.passwordRef;
    if (!ref) throw new Error(`Target '${name}' has no password or passwordRef configured.`);
    if (ref.startsWith("env:")) {
      const value = process.env[ref.slice(4)];
      if (!value) throw new Error(`Target '${name}': env var ${ref.slice(4)} is not set on the MCP server host.`);
      return value;
    }
    if (ref.startsWith("secret:")) {
      const [scope, key] = ref.slice(7).split("/");
      if (!scope || !key) throw new Error(`Target '${name}': malformed secret ref '${ref}' (want secret:scope/key).`);
      const auth = this._getAuth({ profile: this.secretProfile });
      return this._getSecret(auth, scope, key);
    }
    throw new Error(`Target '${name}': unsupported passwordRef '${ref}' (use env: or secret:).`);
  }
}
