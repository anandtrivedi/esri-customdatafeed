/**
 * workspaceResolver.js
 * Resolves Databricks workspace credentials by profile alias.
 *
 * Named profiles come from ~/.databrickscfg (or DATABRICKS_CONFIG_FILE) and from [PROFILE] sections in the provider's
 * own .env (same format; the .databrickscfg wins on a name clash), so a .cdpk carrying a .env needs no file on each
 * machine. The plain DATABRICKS_* env vars are the fallback for the implicit "default" profile.
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
let profileSources = Object.create(null); // alias -> file it came from (for error messages)

// The provider's .env (packaged in the .cdpk). Lines above its first [SECTION] are env vars (loaded by model.js);
// [SECTION]s are workspace profiles in .databrickscfg format, read here.
let providerEnvFile = path.join(__dirname, '..', '..', '.env');

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
// A section header: a whole line "[NAME]", optionally followed by a # or ; comment. Shared with envVarsPart so the
// .env split and the profile parser always agree on where the sections start.
const SECTION_RE = /^\[([^\]]+)\]\s*(?:[#;].*)?$/;
// A line allowed above the first section: blank, a # or ; comment, or a single-line [export ]KEY=value setting.
const isSettingLine = (line) => { const t = line.trim(); return !t || /^[#;]/.test(t) || /^(?:export\s+)?[\w.-]+\s*=/.test(t); };

function parseIni(contents, source = 'the credentials file') {
  // No prototype: a [__proto__] or [constructor] section must not touch Object.prototype or shadow a lookup.
  const profiles = Object.create(null);
  let currentSection = null;
  const lines = contents.split(/\r?\n/);

  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.trim(); // also drops a leading BOM
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!profiles[currentSection]) profiles[currentSection] = Object.create(null);
      continue;
    }
    // A mistyped header ("[WEST] - prod") would otherwise be skipped and its keys merged into the previous profile.
    if (line.startsWith('[')) throw configError(`Malformed section header on line ${i + 1} of ${source}: expected [NAME]`);

    if (!currentSection) {
      // Above the first section only settings belong (the .env's env-var part, which envVarsPart ends at the same line).
      if (isSettingLine(line)) continue;
      throw configError(`Unrecognized line ${i + 1} of ${source}: expected KEY=value, [NAME] or a # comment`);
    }

    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim().replace(/^(["'])(.*)\1$/, '$2'); // token = "dapi…" as in a .env
      profiles[currentSection][key] = value;
      continue;
    }
    // Anything else inside a section (e.g. "WEST] - prod") would silently fold the next keys into this profile.
    throw configError(`Unrecognized line ${i + 1} of ${source}: expected [NAME], key = value or a # comment`);
  }

  return profiles;
}

/**
 * The env-var part of a .env: the single-line KEY=value settings (and comments) above the first line that isn't one,
 * which is where the [NAME] profiles start (or a mistyped header), so no profile key can reach process.env.
 */
function envVarsPart(text) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => !isSettingLine(l));
  return first === -1 ? text : lines.slice(0, first).join('\n');
}

function readProfilesFrom(filePath) {
  if (!fs.existsSync(filePath)) return Object.create(null);
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw configError(`Failed to read Databricks credentials file ${filePath}: ${err.message}`);
  }
  return parseIni(contents, filePath);
}

function loadProfiles() {
  if (profileCache !== null) return profileCache;
  const merged = Object.create(null);
  const sources = Object.create(null);
  for (const filePath of [providerEnvFile, getConfigFilePath()]) { // later wins: .databrickscfg over the .env
    const profiles = readProfilesFrom(filePath);
    for (const alias of Object.keys(profiles)) { merged[alias] = profiles[alias]; sources[alias] = filePath; }
  }
  profileSources = sources;
  profileCache = merged;
  return profileCache;
}

function clearProfileCache() {
  profileCache = null;
  profileSources = Object.create(null);
}

// A publisher-fixable config problem: 400, so it surfaces instead of collapsing into a 404.
function configError(message) {
  const err = new Error(message);
  err.code = 400;
  return err;
}

function buildProfileFromIni(alias, raw, source = getConfigFilePath()) {
  if (!raw.host) {
    throw configError(`Profile [${alias}] in ${source} is missing required "host"`);
  }

  const hasToken = Boolean(raw.token);
  const hasClientId = Boolean(raw.client_id);
  const hasClientSecret = Boolean(raw.client_secret);

  if (hasToken && (hasClientId || hasClientSecret)) {
    throw configError(
      `Profile [${alias}] in ${source} is ambiguous: defines both PAT (token) and OAuth M2M (client_id/client_secret). Pick one.`
    );
  }

  if (hasClientId !== hasClientSecret) {
    throw configError(
      `Profile [${alias}] in ${source} is incomplete: OAuth M2M requires both client_id and client_secret`
    );
  }

  if (!hasToken && !hasClientId) {
    throw configError(
      `Profile [${alias}] in ${source} has no credentials: provide either token (PAT) or client_id + client_secret (OAuth M2M)`
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
  const rawHost = (process.env.DATABRICKS_SERVER_HOSTNAME || process.env.DATABRICKS_HOST || '').trim();
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
        `Databricks workspace profile "${requestedAlias}" not found in ${getConfigFilePath()} or in the provider's ` +
        `.env on ArcGIS Server host "${os.hostname()}". Available profiles: ${available}. ` +
        `Add a [${requestedAlias}] section to the .env inside the .cdpk (reaches every machine), or to each ` +
        `machine's .databrickscfg via configure-databricks.sh (README Step 3).`
      );
      err.code = 400; // config error (publisher-fixable) — surface it, don't let it collapse into a 404
      throw err;
    }
    return buildProfileFromIni(requestedAlias, profiles[requestedAlias], profileSources[requestedAlias]);
  }

  if (profiles.DEFAULT) {
    return buildProfileFromIni('DEFAULT', profiles.DEFAULT, profileSources.DEFAULT);
  }

  const envDefault = buildDefaultFromEnv();
  if (envDefault) return envDefault;

  const err = new Error(
    `No default Databricks workspace configured on ArcGIS Server host "${os.hostname()}". ` +
    `Add a [DEFAULT] section to the provider's .env or to ${getConfigFilePath()} (configure-databricks.sh, README ` +
    `Step 3), or set DATABRICKS_SERVER_HOSTNAME plus DATABRICKS_ACCESS_TOKEN (or DATABRICKS_CLIENT_ID and ` +
    `DATABRICKS_CLIENT_SECRET).`
  );
  err.code = 400; // config error (publisher-fixable) — surface it, don't let it collapse into a 404
  throw err;
}

module.exports = {
  resolveWorkspace,
  clearProfileCache,
  envVarsPart,
  _internal: {
    parseIni,
    buildProfileFromIni,
    getConfigFilePath,
    setProviderEnvFile: (p) => { providerEnvFile = p; profileCache = null; },
    resolveConfigPath,
  },
};
