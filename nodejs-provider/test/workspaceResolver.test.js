const path = require('path');
const fs = require('fs');
const { expect } = require('chai');

const TMP_DIR = path.join(__dirname, '_tmp_workspace_resolver');
const TMP_CFG = path.join(TMP_DIR, '.databrickscfg');

describe('workspaceResolver', () => {
  let resolver;
  let originalConfigEnv;
  let originalHostnameEnv;
  let originalTokenEnv;

  before(() => {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    resolver = require('../src/modules/workspaceResolver');
    originalConfigEnv = process.env.DATABRICKS_CONFIG_FILE;
    originalHostnameEnv = process.env.DATABRICKS_SERVER_HOSTNAME;
    originalTokenEnv = process.env.DATABRICKS_ACCESS_TOKEN;
  });

  after(() => {
    if (fs.existsSync(TMP_CFG)) fs.unlinkSync(TMP_CFG);
    if (fs.existsSync(TMP_DIR)) fs.rmdirSync(TMP_DIR);

    if (originalConfigEnv === undefined) delete process.env.DATABRICKS_CONFIG_FILE;
    else process.env.DATABRICKS_CONFIG_FILE = originalConfigEnv;
    if (originalHostnameEnv === undefined) delete process.env.DATABRICKS_SERVER_HOSTNAME;
    else process.env.DATABRICKS_SERVER_HOSTNAME = originalHostnameEnv;
    if (originalTokenEnv === undefined) delete process.env.DATABRICKS_ACCESS_TOKEN;
    else process.env.DATABRICKS_ACCESS_TOKEN = originalTokenEnv;
  });

  beforeEach(() => {
    process.env.DATABRICKS_CONFIG_FILE = TMP_CFG;
    if (fs.existsSync(TMP_CFG)) fs.unlinkSync(TMP_CFG);
    delete process.env.DATABRICKS_SERVER_HOSTNAME;
    delete process.env.DATABRICKS_ACCESS_TOKEN;
    delete process.env.DATABRICKS_HOST;
    delete process.env.DATABRICKS_CLIENT_ID;
    delete process.env.DATABRICKS_CLIENT_SECRET;
    resolver.clearProfileCache();
  });

  function writeConfig(contents) {
    fs.writeFileSync(TMP_CFG, contents);
    resolver.clearProfileCache();
  }

  describe('parseIni', () => {
    it('parses simple sections and key-value pairs', () => {
      const result = resolver._internal.parseIni(`
[A]
host = a.example.com
token = xyz

[B]
host = b.example.com
`);
      expect(result).to.deep.equal({
        A: { host: 'a.example.com', token: 'xyz' },
        B: { host: 'b.example.com' },
      });
    });

    it('ignores # and ; comments and blank lines', () => {
      const result = resolver._internal.parseIni(`
# Top comment
; Another comment

[A]
host = a.example.com
# inline-ish comment
token = xyz
`);
      expect(result.A).to.deep.equal({ host: 'a.example.com', token: 'xyz' });
    });

    it('tolerates whitespace around = and trims values', () => {
      const result = resolver._internal.parseIni(`
[A]
host=a.example.com
  token   =     xyz
`);
      expect(result.A).to.deep.equal({ host: 'a.example.com', token: 'xyz' });
    });

    it('ignores key-value pairs that appear before any section header', () => {
      const result = resolver._internal.parseIni(`
host = orphan.example.com
[A]
host = a.example.com
`);
      expect(result).to.deep.equal({ A: { host: 'a.example.com' } });
    });

    it('keeps a [__proto__] section from leaking keys into other profiles', () => {
      const result = resolver._internal.parseIni('[__proto__]\nhost = attacker.example.com\n[PROD]\ntoken = dapi\n');
      expect(result.PROD.host).to.equal(undefined);
      expect({}.host).to.equal(undefined); // Object.prototype untouched
    });

    it('preserves = in values (e.g. base64 secrets)', () => {
      const result = resolver._internal.parseIni(`
[A]
host = a.example.com
client_secret = abc==
`);
      expect(result.A.client_secret).to.equal('abc==');
    });
  });

  describe('resolveWorkspace — PAT profile', () => {
    it('returns PAT-based config from a named profile', () => {
      writeConfig(`
[WORKSPACE_A]
host = workspace-a.cloud.databricks.com
token = dapi-aaaa
`);
      const profile = resolver.resolveWorkspace('WORKSPACE_A');
      expect(profile).to.deep.equal({
        workspaceAlias: 'WORKSPACE_A',
        hostname: 'workspace-a.cloud.databricks.com',
        authType: 'pat',
        token: 'dapi-aaaa',
      });
    });

    it('strips https:// prefix and trailing slashes from host', () => {
      writeConfig(`
[A]
host = https://workspace-a.cloud.databricks.com/
token = dapi-aaaa
`);
      const profile = resolver.resolveWorkspace('A');
      expect(profile.hostname).to.equal('workspace-a.cloud.databricks.com');
    });
  });

  describe('resolveWorkspace — OAuth M2M profile', () => {
    it('returns OAuth M2M config when client_id + client_secret are present', () => {
      writeConfig(`
[WORKSPACE_B]
host = workspace-b.cloud.databricks.com
client_id = sp-bbbb
client_secret = secret-bbbb
`);
      const profile = resolver.resolveWorkspace('WORKSPACE_B');
      expect(profile).to.deep.equal({
        workspaceAlias: 'WORKSPACE_B',
        hostname: 'workspace-b.cloud.databricks.com',
        authType: 'oauth-m2m',
        clientId: 'sp-bbbb',
        clientSecret: 'secret-bbbb',
      });
    });
  });

  describe('resolveWorkspace — default profile resolution', () => {
    it('returns env-derived default when no .databrickscfg exists', () => {
      process.env.DATABRICKS_SERVER_HOSTNAME = 'env-host.example.com';
      process.env.DATABRICKS_ACCESS_TOKEN = 'dapi-env';
      const profile = resolver.resolveWorkspace();
      expect(profile).to.deep.equal({
        workspaceAlias: 'default',
        hostname: 'env-host.example.com',
        authType: 'pat',
        token: 'dapi-env',
      });
    });

    it('returns OAuth M2M config from injected service-principal env (Databricks Apps)', () => {
      process.env.DATABRICKS_HOST = 'app-host.cloud.databricks.com';
      process.env.DATABRICKS_CLIENT_ID = 'sp-client-id';
      process.env.DATABRICKS_CLIENT_SECRET = 'sp-secret';
      const profile = resolver.resolveWorkspace();
      expect(profile).to.deep.equal({
        workspaceAlias: 'default',
        hostname: 'app-host.cloud.databricks.com',
        authType: 'oauth-m2m',
        clientId: 'sp-client-id',
        clientSecret: 'sp-secret',
      });
    });

    it('prefers OAuth M2M over a PAT when both are present in env', () => {
      process.env.DATABRICKS_SERVER_HOSTNAME = 'env-host.example.com';
      process.env.DATABRICKS_ACCESS_TOKEN = 'dapi-env';
      process.env.DATABRICKS_CLIENT_ID = 'sp-client-id';
      process.env.DATABRICKS_CLIENT_SECRET = 'sp-secret';
      const profile = resolver.resolveWorkspace();
      expect(profile.authType).to.equal('oauth-m2m');
      expect(profile.token).to.equal(undefined);
    });

    it('honors no-arg call as equivalent to alias "default"', () => {
      process.env.DATABRICKS_SERVER_HOSTNAME = 'env-host.example.com';
      process.env.DATABRICKS_ACCESS_TOKEN = 'dapi-env';
      const a = resolver.resolveWorkspace();
      const b = resolver.resolveWorkspace('default');
      expect(a).to.deep.equal(b);
    });

    it('prefers [DEFAULT] profile in .databrickscfg over env vars', () => {
      writeConfig(`
[DEFAULT]
host = file-host.example.com
token = dapi-file
`);
      process.env.DATABRICKS_SERVER_HOSTNAME = 'env-host.example.com';
      process.env.DATABRICKS_ACCESS_TOKEN = 'dapi-env';
      const profile = resolver.resolveWorkspace('default');
      expect(profile.hostname).to.equal('file-host.example.com');
      expect(profile.token).to.equal('dapi-file');
    });

    it('throws when no default available (no env, no [DEFAULT])', () => {
      writeConfig(`[OTHER]
host = other.example.com
token = dapi-other
`);
      expect(() => resolver.resolveWorkspace()).to.throw(/No default Databricks workspace/);
    });

    it('strips https:// from env-derived hostname', () => {
      process.env.DATABRICKS_SERVER_HOSTNAME = 'https://env-host.example.com/';
      process.env.DATABRICKS_ACCESS_TOKEN = 'dapi-env';
      const profile = resolver.resolveWorkspace();
      expect(profile.hostname).to.equal('env-host.example.com');
    });
  });

  describe('resolveWorkspace — error cases', () => {
    it('throws when named profile is missing', () => {
      writeConfig(`[A]
host = a.example.com
token = xyz
`);
      expect(() => resolver.resolveWorkspace('NONEXISTENT'))
        .to.throw(/profile "NONEXISTENT" not found/);
    });

    it('lists available profiles in the not-found error', () => {
      writeConfig(`[A]
host = a.example.com
token = xyz

[B]
host = b.example.com
token = abc
`);
      expect(() => resolver.resolveWorkspace('NONEXISTENT'))
        .to.throw(/A.*B|B.*A/);
    });

    it('throws when profile has no host', () => {
      writeConfig(`[A]
token = xyz
`);
      expect(() => resolver.resolveWorkspace('A')).to.throw(/missing required "host"/);
    });

    it('throws when profile has both PAT and OAuth credentials', () => {
      writeConfig(`[A]
host = a.example.com
token = xyz
client_id = sp
client_secret = ss
`);
      expect(() => resolver.resolveWorkspace('A')).to.throw(/ambiguous/);
    });

    it('throws when OAuth profile has client_id but no client_secret', () => {
      writeConfig(`[A]
host = a.example.com
client_id = sp
`);
      expect(() => resolver.resolveWorkspace('A')).to.throw(/incomplete/);
    });

    it('throws when OAuth profile has client_secret but no client_id', () => {
      writeConfig(`[A]
host = a.example.com
client_secret = ss
`);
      expect(() => resolver.resolveWorkspace('A')).to.throw(/incomplete/);
    });

    it('throws when profile has neither PAT nor OAuth credentials', () => {
      writeConfig(`[A]
host = a.example.com
`);
      expect(() => resolver.resolveWorkspace('A')).to.throw(/no credentials/);
    });
  });

  describe('resolveWorkspace — workspace-named env vars (no .databrickscfg needed)', () => {
    const set = {};
    const env = (k, v) => { set[k] = true; process.env[k] = v; };
    afterEach(() => { for (const k of Object.keys(set)) { delete process.env[k]; delete set[k]; } });

    it('resolves a named PAT workspace from DATABRICKS_<ALIAS>_* (hyphens become underscores)', () => {
      env('DATABRICKS_DOD_FE_HOST', 'https://dod.example.com/');
      env('DATABRICKS_DOD_FE_TOKEN', 'dapi-env\n'); // a mounted Secret's trailing newline is trimmed
      expect(resolver.resolveWorkspace('DoD-FE')).to.deep.equal({
        workspaceAlias: 'DoD-FE', hostname: 'dod.example.com', authType: 'pat', token: 'dapi-env',
      });
    });

    it('resolves an OAuth M2M and a PAT workspace side by side', () => {
      env('DATABRICKS_WEST_HOST', 'west.example.com');
      env('DATABRICKS_WEST_CLIENT_ID', 'id-w');
      env('DATABRICKS_WEST_CLIENT_SECRET', 'secret-w');
      env('DATABRICKS_EAST_HOST', 'east.example.com');
      env('DATABRICKS_EAST_TOKEN', 'dapi-e');
      expect(resolver.resolveWorkspace('west')).to.deep.equal({
        workspaceAlias: 'west', hostname: 'west.example.com', authType: 'oauth-m2m', clientId: 'id-w', clientSecret: 'secret-w',
      });
      expect(resolver.resolveWorkspace('EAST')).to.include({ hostname: 'east.example.com', authType: 'pat' });
    });

    it('keeps a .databrickscfg profile winning over env vars for the same name', () => {
      writeConfig('[WEST]\nhost = file.example.com\ntoken = dapi-file\n');
      env('DATABRICKS_WEST_HOST', 'env.example.com');
      env('DATABRICKS_WEST_TOKEN', 'dapi-env');
      expect(resolver.resolveWorkspace('WEST')).to.include({ hostname: 'file.example.com', token: 'dapi-file' });
    });

    it('reports an incomplete env workspace by variable name, never by value', () => {
      env('DATABRICKS_WEST_HOST', 'west.example.com');
      env('DATABRICKS_WEST_CLIENT_ID', 'id-only-value');
      let first;
      try { resolver.resolveWorkspace('WEST'); } catch (e) { first = e; }
      expect(first.message).to.match(/incomplete: OAuth M2M requires both/);
      expect(first.message).to.not.include('id-only-value');
      expect(first.code).to.equal(400); // a config error the publisher can fix, not a 404
      env('DATABRICKS_WEST_CLIENT_SECRET', 'super-secret-value');
      env('DATABRICKS_WEST_TOKEN', 'dapi-also');
      let msg = '';
      try { resolver.resolveWorkspace('WEST'); } catch (e) { msg = e.message; }
      expect(msg).to.match(/ambiguous/);
      expect(msg).to.not.include('super-secret-value');
      expect(msg).to.not.include('dapi-also');
    });

    it('resolves a workspace whose name is an Object.prototype key (constructor) from env vars', () => {
      env('DATABRICKS_CONSTRUCTOR_HOST', 'c.example.com');
      env('DATABRICKS_CONSTRUCTOR_TOKEN', 'dapi-c');
      expect(resolver.resolveWorkspace('constructor')).to.include({ hostname: 'c.example.com', authType: 'pat' });
    });

    it('names the env var it looked for when a workspace is found nowhere', () => {
      expect(() => resolver.resolveWorkspace('DoD-FE')).to.throw(/No DATABRICKS_DOD_FE_HOST environment variable either/);
    });

    it("doesn't build a workspace out of the plain default env vars (alias ACCESS vs DATABRICKS_ACCESS_TOKEN)", () => {
      env('DATABRICKS_ACCESS_TOKEN', 'dapi-default');
      env('DATABRICKS_ACCESS_HOST', 'other.example.com'); // even with a _HOST, the default token must not be borrowed
      expect(() => resolver.resolveWorkspace('ACCESS')).to.throw(/not found.*name ACCESS can't come from env vars/);
    });

    it('leaves the default workspace on the plain DATABRICKS_* vars', () => {
      env('DATABRICKS_SERVER_HOSTNAME', 'default.example.com');
      env('DATABRICKS_ACCESS_TOKEN', 'dapi-default');
      env('DATABRICKS_WEST_HOST', 'west.example.com');
      env('DATABRICKS_WEST_TOKEN', 'dapi-w');
      expect(resolver.resolveWorkspace()).to.include({ hostname: 'default.example.com', token: 'dapi-default' });
    });
  });

  describe('resolveConfigPath — .databrickscfg location fallback', () => {
    // Pure helper: picks the .databrickscfg path so a standard ArcGIS install needs
    // only /home/arcgis/.databrickscfg — no DATABRICKS_CONFIG_FILE / init_user_param.sh.
    const resolveConfigPath = (opts) => resolver._internal.resolveConfigPath(opts);

    it('explicit DATABRICKS_CONFIG_FILE always wins, even if missing', () => {
      const p = resolveConfigPath({ env: '/custom/path.cfg', home: '/home/arcgis', exists: () => true });
      expect(p).to.equal('/custom/path.cfg');
    });

    it('uses the user home .databrickscfg when it exists', () => {
      const home = '/home/alice';
      const p = resolveConfigPath({ env: undefined, home, exists: (f) => f === `${home}/.databrickscfg` });
      expect(p).to.equal('/home/alice/.databrickscfg');
    });

    it('falls through to /home/arcgis/.databrickscfg when HOME is unusable (ArcGIS case)', () => {
      // ArcGIS Server often leaves HOME as '/', so os.homedir()-based path does not exist.
      const p = resolveConfigPath({ env: undefined, home: '/', exists: (f) => f === '/home/arcgis/.databrickscfg' });
      expect(p).to.equal('/home/arcgis/.databrickscfg');
    });

    it('falls through to the Windows ProgramData path when that is the one that exists', () => {
      const p = resolveConfigPath({
        env: undefined,
        home: 'C:\\Users\\svc',
        exists: (f) => /ProgramData[\\/]ArcGIS[\\/]cdf[\\/]\.databrickscfg$/.test(f),
      });
      expect(p).to.match(/ProgramData[\\/]ArcGIS[\\/]cdf[\\/]\.databrickscfg$/);
    });

    it('prefers the user home over /home/arcgis when both exist', () => {
      const home = '/home/alice';
      const p = resolveConfigPath({ env: undefined, home, exists: () => true });
      expect(p).to.equal('/home/alice/.databrickscfg');
    });

    it('reports the home-based path when nothing exists anywhere', () => {
      const p = resolveConfigPath({ env: undefined, home: '/home/alice', exists: () => false });
      expect(p).to.equal('/home/alice/.databrickscfg');
    });
  });
});
