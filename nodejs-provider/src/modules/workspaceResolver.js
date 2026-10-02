/**
 * workspaceResolver.js
 * Resolves Databricks workspace credentials by profile alias.
 *
 * Reads ~/.databrickscfg (or DATABRICKS_CONFIG_FILE) for named profiles,
 * with env-var fallback for the implicit "default" profile.
 *
 * Profile shape returned:
 *   {
 *     workspaceAlias: string,             // alias used to look up this profile
 *     hostname: string,                   // workspace hostname (no protocol, no trailing slash)
 *     authType: 'pat' | 'oauth-m2m',
 *     token?: string,                     // present iff authType === 'pat'
 *     clientId?: string,                  // present iff authType === 'oauth-m2m'
 *     clientSecret?: string,              // present iff authType === 'oauth-m2m'
 *   }
 *
 * Each profile in .databrickscfg uses Databricks' standard format, e.g.:
 *
 *   [WORKSPACE_A]
 *   host  = workspace-a.cloud.databricks.com
 *   token = dapiXXXX...
 *
 *   [WORKSPACE_B]
 *   host          = workspace-b.cloud.databricks.com
 *   client_id     = <service-principal-client-id>
 *   client_secret = <service-principal-secret>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let profileCache = null;

// Candidate .databrickscfg locations when DATABRICKS_CONFIG_FILE is not set, in priority
// order. ArcGIS Server does not reliably set HOME for the provider process, so os.homedir()
// can resolve to '/' or the wrong directory and a plain ~/.databrickscfg won't be found —
// falling through to the well-known ArcGIS locations lets a standard install work with just
// the credential file in place and NO DATABRICKS_CONFIG_FILE env var (nor init_user_param.sh
// on Linux / Machine env var on Windows). The non-matching OS's path simply never exists.
const ARCGIS_CONFIG_PATHS = [
  '/home/arcgis/.databrickscfg',                                                              // Linux ArcGIS service-account home
  path.join(process.env.ProgramData || 'C:\\ProgramData', 'ArcGIS', 'cdf', '.databrickscfg'), // Windows (configure-databricks.ps1 default)
];

// Pure + dependency-injected so the fallback order is unit-testable without the real fs.
function resolveConfigPath({ env, home, exists }) {
  if (env) return env; // explicit override always wins (even if missing — surfaces a clear error)
  const candidates = [path.join(home, '.databrickscfg'), ...ARCGIS_CONFIG_PATHS];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return candidates[0]; // nothing found anywhere: report the home-based path in errors
}

function getConfigFilePath() {
  return resolveConfigPath({
    env: process.env.DATABRICKS_CONFIG_FILE,
    home: os.homedir(),
    exists: fs.existsSync,
  });
}

/**
 * Hand-rolled INI parser. Format matches Databricks .databrickscfg:
 *   - Section headers: [NAME]
 *   - Key-value: key = value (whitespace tolerated)
 *   - Comments: lines starting with # or ;
 *   - Empty lines ignored
 *   - Key-value pairs before any section header are ignored
 */
function parseIni(contents) {
  const profiles = {};
  let currentSection = null;
  const lines = contents.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!profiles[currentSection]) profiles[currentSection] = {};
      continue;
    }

    if (!currentSection) continue;

    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      profiles[currentSection][key] = value;
    }
  }

  return profiles;
}

function loadProfiles() {
  if (profileCache !== null) return profileCache;

  const filePath = getConfigFilePath();
  if (!fs.existsSync(filePath)) {
    profileCache = {};
    return profileCache;
  }

  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read Databricks config file ${filePath}: ${err.message}`);
  }

  profileCache = parseIni(contents);
  return profileCache;
}

function clearProfileCache() {
  profileCache = null;
}

function buildProfileFromIni(alias, raw) {
  if (!raw.host) {
    throw new Error(`Profile [${alias}] in ${getConfigFilePath()} is missing required "host"`);
  }

  const hasToken = Boolean(raw.token);
  const hasClientId = Boolean(raw.client_id);
  const hasClientSecret = Boolean(raw.client_secret);

  if (hasToken && (hasClientId || hasClientSecret)) {
    throw new Error(
      `Profile [${alias}] is ambiguous: defines both PAT (token) and OAuth M2M (client_id/client_secret). Pick one.`
    );
  }

  if (hasClientId !== hasClientSecret) {
    throw new Error(
      `Profile [${alias}] is incomplete: OAuth M2M requires both client_id and client_secret`
    );
  }

  if (!hasToken && !hasClientId) {
    throw new Error(
      `Profile [${alias}] has no credentials: provide either token (PAT) or client_id + client_secret (OAuth M2M)`
    );
  }

  const hostname = raw.host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  if (hasToken) {
    return {
      workspaceAlias: alias,
      hostname,
      authType: 'pat',
      token: raw.token,
    };
  }

  return {
    workspaceAlias: alias,
    hostname,
    authType: 'oauth-m2m',
    clientId: raw.client_id,
    clientSecret: raw.client_secret,
  };
}

function buildDefaultFromEnv() {
  // DATABRICKS_HOST is injected by the Databricks Apps runtime (hostname only, no scheme);
  // DATABRICKS_SERVER_HOSTNAME is the explicit/local-dev form.
  const rawHost = process.env.DATABRICKS_SERVER_HOSTNAME || process.env.DATABRICKS_HOST;
  if (!rawHost) return null;
  const hostname = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  // Prefer OAuth M2M (service principal). Databricks Apps inject DATABRICKS_CLIENT_ID and
  // DATABRICKS_CLIENT_SECRET for the app's service principal — use them so the app never
  // needs a PAT. connectionPool and lakebasePool both consume authType 'oauth-m2m'.
  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return {
      workspaceAlias: 'default',
      hostname,
      authType: 'oauth-m2m',
      clientId,
      clientSecret,
    };
  }

  // Fall back to a PAT for local development.
  const token = process.env.DATABRICKS_ACCESS_TOKEN;
  if (token) {
    return {
      workspaceAlias: 'default',
      hostname,
      authType: 'pat',
      token,
    };
  }

  return null;
}

function resolveWorkspace(alias) {
  const requestedAlias = alias || 'default';
  const profiles = loadProfiles();

  if (requestedAlias !== 'default') {
    if (!profiles[requestedAlias]) {
      const available = Object.keys(profiles).join(', ') || '(none)';
      const err = new Error(
        `Databricks workspace profile "${requestedAlias}" not found in ${getConfigFilePath()} ` +
        `on ArcGIS Server host "${os.hostname()}". Available profiles: ${available}. ` +
        `The profile must exist on EVERY server machine — set it up with configure-databricks.sh ` +
        `(README Step 3); registering the .cdpk does NOT install credentials.`
      );
      err.code = 400; // config error (publisher-fixable) — surface it, don't let it collapse into a 404
      throw err;
    }
    return buildProfileFromIni(requestedAlias, profiles[requestedAlias]);
  }

  if (profiles.DEFAULT) {
    return buildProfileFromIni('DEFAULT', profiles.DEFAULT);
  }

  const envDefault = buildDefaultFromEnv();
  if (envDefault) return envDefault;

  const err = new Error(
    `No default Databricks workspace configured on ArcGIS Server host "${os.hostname()}". ` +
    `Define a [DEFAULT] profile in ${getConfigFilePath()} (or set DATABRICKS_SERVER_HOSTNAME and ` +
    `DATABRICKS_ACCESS_TOKEN env vars) via configure-databricks.sh (README Step 3) — ` +
    `registering the .cdpk does NOT install credentials.`
  );
  err.code = 400; // config error (publisher-fixable) — surface it, don't let it collapse into a 404
  throw err;
}

module.exports = {
  resolveWorkspace,
  clearProfileCache,
  _internal: {
    parseIni,
    buildProfileFromIni,
    getConfigFilePath,
    resolveConfigPath,
  },
};
