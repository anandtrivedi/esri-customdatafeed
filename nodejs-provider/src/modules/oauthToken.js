/**
 * oauthToken.js
 * OAuth M2M (client credentials) access tokens for service principals, minted at the workspace's /oidc/v1/token with
 * only the scope each caller needs: "sql" for the SQL warehouse, "postgres" for the Lakebase REST APIs.
 *
 * The SQL driver's own M2M flow (authType 'databricks-oauth') always asks for all-apis, so a secret limited to sql
 * failed with "Scopes 'all-apis' are not assigned to the client" (verified live). Minting here also skips the
 * driver's OAuth host allowlist, which doesn't know GovCloud (.mil/.us) hosts.
 *
 * Tokens are cached per host + client + scope, refreshed 5 minutes before expiry, and concurrent callers share one
 * in-flight request.
 */

const https = require('https');

const TOKEN_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;

const cache = Object.create(null);    // key -> { token, expiry }
const inFlight = Object.create(null); // key -> Promise<{ token, expiry }>
const warnedFallback = new Set();

function cacheKey(workspaceConfig, scope) {
  return `${workspaceConfig.hostname}|${workspaceConfig.clientId}|${scope}`;
}

function requestToken(workspaceConfig, scope, { timeoutMs = DEFAULT_TIMEOUT_MS, tlsVerify = true } = {}) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${workspaceConfig.clientId}:${workspaceConfig.clientSecret}`).toString('base64');
    const body = `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`;
    const options = {
      hostname: workspaceConfig.hostname,
      port: 443,
      path: '/oidc/v1/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: tlsVerify,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.access_token) {
              reject(new Error(`OAuth M2M response missing access_token: ${data.substring(0, 200)}`));
              return;
            }
            const expiresInMs = (parsed.expires_in || 3600) * 1000;
            resolve({ token: parsed.access_token, expiry: Date.now() + expiresInMs });
          } catch (e) {
            reject(new Error(`Failed to parse OAuth M2M response: ${e.message}`));
          }
        } else {
          const err = new Error(`OAuth M2M token endpoint returned ${res.statusCode} for scope "${scope}": ${data.substring(0, 300)}`);
          err.invalidScope = res.statusCode === 400 && /invalid_scope/.test(data);
          reject(err);
        }
      });
    });

    // A blackholed workspace must fail, not hang: pool creation awaits this call.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => reject(new Error(`OAuth M2M token request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

// A workspace that doesn't recognise the narrow scope name (invalid_scope) gets all-apis instead, as before. A secret
// that lacks the scope (access_denied) is not retried: a secret without sql doesn't have all-apis either.
async function mint(workspaceConfig, scope, options) {
  try {
    return await requestToken(workspaceConfig, scope, options);
  } catch (err) {
    if (!err.invalidScope || scope === 'all-apis') throw err;
    const key = cacheKey(workspaceConfig, scope);
    if (!warnedFallback.has(key)) {
      warnedFallback.add(key);
      console.warn(`[OAuth] ${workspaceConfig.hostname} rejected scope "${scope}" as invalid; using all-apis`);
    }
    return requestToken(workspaceConfig, 'all-apis', options);
  }
}

/**
 * Get a bearer token for a service principal profile, limited to `scope`.
 * @param {object} workspaceConfig - resolved profile with hostname, clientId, clientSecret
 * @param {string} scope - e.g. 'sql' or 'postgres'
 * @param {{timeoutMs?: number, tlsVerify?: boolean}} [options]
 */
async function getOAuthToken(workspaceConfig, scope, options) {
  const key = cacheKey(workspaceConfig, scope);
  const cached = cache[key];
  if (cached && Date.now() < cached.expiry - TOKEN_BUFFER_MS) return cached.token;
  if (!inFlight[key]) {
    inFlight[key] = mint(workspaceConfig, scope, options)
      .then((fresh) => { cache[key] = fresh; return fresh; })
      .finally(() => { delete inFlight[key]; });
  }
  return (await inFlight[key]).token;
}

function clearOAuthTokenCache() {
  for (const k of Object.keys(cache)) delete cache[k];
  warnedFallback.clear();
}

module.exports = { getOAuthToken, clearOAuthTokenCache, TOKEN_BUFFER_MS };
