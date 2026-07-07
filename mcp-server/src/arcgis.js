// ArcGIS Server Admin API client. Uses node:https directly so that
// per-target self-signed certificates can be tolerated without extra deps.

import https from "node:https";
import { URL, URLSearchParams } from "node:url";

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

function httpsRequest(urlString, { method = "GET", body, allowSelfSigned = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: !allowSelfSigned,
        timeout,
        headers: body
          ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${url.hostname} timed out after ${timeout}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

export class ArcGisClient {
  /**
   * @param {object} target — { adminUrl, user, password, allowSelfSigned }
   *   adminUrl like https://host:6443/arcgis/admin
   */
  constructor(target) {
    this.adminUrl = target.adminUrl.replace(/\/+$/, "");
    if (!/\/arcgis\/admin$/.test(this.adminUrl)) {
      throw new Error(`adminUrl must end in /arcgis/admin — got ${target.adminUrl}`);
    }
    this.restUrl = this.adminUrl.replace(/\/admin$/, "/rest");
    this.user = target.user;
    this.password = target.password;
    this.allowSelfSigned = Boolean(target.allowSelfSigned);
    this._token = null;
    this._tokenExpires = 0;
  }

  async getToken() {
    if (this._token && Date.now() < this._tokenExpires - TOKEN_REFRESH_BUFFER_MS) return this._token;
    const body = new URLSearchParams({
      username: this.user,
      password: this.password,
      client: "requestip",
      expiration: "60",
      f: "json",
    }).toString();
    const res = await httpsRequest(`${this.adminUrl}/generateToken`, {
      method: "POST",
      body,
      allowSelfSigned: this.allowSelfSigned,
    });
    const json = parseArcgisJson(res, "generateToken");
    if (!json.token) throw new Error(`generateToken failed: ${JSON.stringify(json.messages || json)}`);
    this._token = json.token;
    this._tokenExpires = json.expires || Date.now() + 55 * 60 * 1000;
    return this._token;
  }

  /** Admin API call; params object is sent urlencoded, token + f=json auto-added. */
  async request(adminPath, params = {}, { method = "GET", timeout = 30000 } = {}) {
    const token = await this.getToken();
    const search = new URLSearchParams({ ...params, token, f: "json" });
    const url = `${this.adminUrl}/${adminPath.replace(/^\/+/, "")}`;
    const res =
      method === "GET"
        ? await httpsRequest(`${url}?${search}`, { allowSelfSigned: this.allowSelfSigned, timeout })
        : await httpsRequest(url, { method, body: search.toString(), allowSelfSigned: this.allowSelfSigned, timeout });
    return parseArcgisJson(res, adminPath);
  }

  /** Public REST endpoint call (feature service queries). */
  async restRequest(restPath, params = {}) {
    const search = new URLSearchParams({ ...params, f: "json" });
    const res = await httpsRequest(`${this.restUrl}/${restPath.replace(/^\/+/, "")}?${search}`, {
      allowSelfSigned: this.allowSelfSigned,
      timeout: 60000,
    });
    return parseArcgisJson(res, restPath);
  }

  async listServices() {
    const json = await this.request("services");
    return json.services || [];
  }

  async getService(serviceName) {
    return this.request(`services/${serviceName}.FeatureServer`);
  }

  async serviceStatus(serviceName) {
    return this.request(`services/${serviceName}.FeatureServer/status`);
  }

  async createService(serviceJson) {
    return this.request("services/createService", { service: JSON.stringify(serviceJson) }, { method: "POST" });
  }

  async deleteService(serviceName) {
    return this.request(`services/${serviceName}.FeatureServer/delete`, {}, { method: "POST" });
  }

  /**
   * Multipart upload of a .cdpk (or any file) to the admin uploads endpoint.
   * Returns the upload item metadata ({ itemID, ... }).
   */
  async uploadFile(buffer, fileName) {
    const token = await this.getToken();
    const boundary = "----cdfmcp" + Date.now().toString(16);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="itemFile"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buffer, tail]);
    const url = new URL(`${this.adminUrl}/uploads/upload?token=${token}&f=json`);
    const res = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          rejectUnauthorized: !this.allowSelfSigned,
          timeout: 300000,
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
        },
        (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => resolve({ status: r.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("upload timed out"));
      });
      req.write(body);
      req.end();
    });
    const json = parseArcgisJson(res, "uploads/upload");
    if (!json.item?.itemID) throw new Error(`Upload returned no itemID: ${JSON.stringify(json).slice(0, 200)}`);
    return json.item;
  }

  /** Registered custom data providers, from the .cdpk manifests. */
  async listProviders() {
    const json = await this.request("services/types/customdataproviders");
    const providers = [];
    for (const [file, entries] of Object.entries(json)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry.type === "provider") providers.push({ ...entry, cdpkFile: file });
      }
    }
    return providers;
  }
}

function parseArcgisJson(res, context) {
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`ArcGIS ${context} returned non-JSON (HTTP ${res.status}): ${String(res.body).slice(0, 200)}`);
  }
  // ArcGIS admin reports errors in-band with HTTP 200.
  if (json.status === "error" || json.error) {
    const messages = json.messages || json.error?.message || JSON.stringify(json).slice(0, 300);
    const err = new Error(`ArcGIS ${context} error: ${Array.isArray(messages) ? messages.join("; ") : messages}`);
    err.arcgisCode = json.code || json.error?.code;
    throw err;
  }
  return json;
}
