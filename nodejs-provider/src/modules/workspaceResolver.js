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

function getConfigFilePath() {
  return process.env.DATABRICKS_CONFIG_FILE || path.join(os.homedir(), '.databrickscfg');
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
  const hostname = process.env.DATABRICKS_SERVER_HOSTNAME;
  const token = process.env.DATABRICKS_ACCESS_TOKEN;
  if (!hostname || !token) return null;

  return {
    workspaceAlias: 'default',
    hostname: hostname.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
    authType: 'pat',
    token,
  };
}

function resolveWorkspace(alias) {
  const requestedAlias = alias || 'default';
  const profiles = loadProfiles();

  if (requestedAlias !== 'default') {
    if (!profiles[requestedAlias]) {
      const available = Object.keys(profiles).join(', ') || '(none)';
      throw new Error(
        `Databricks workspace profile "${requestedAlias}" not found in ${getConfigFilePath()}. ` +
        `Available profiles: ${available}.`
      );
    }
    return buildProfileFromIni(requestedAlias, profiles[requestedAlias]);
  }

  if (profiles.DEFAULT) {
    return buildProfileFromIni('DEFAULT', profiles.DEFAULT);
  }

  const envDefault = buildDefaultFromEnv();
  if (envDefault) return envDefault;

  throw new Error(
    'No default Databricks workspace configured. ' +
    'Set DATABRICKS_SERVER_HOSTNAME and DATABRICKS_ACCESS_TOKEN env vars, ' +
    'or define a [DEFAULT] profile in your .databrickscfg.'
  );
}

module.exports = {
  resolveWorkspace,
  clearProfileCache,
  _internal: {
    parseIni,
    buildProfileFromIni,
    getConfigFilePath,
  },
};
