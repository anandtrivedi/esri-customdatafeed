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
