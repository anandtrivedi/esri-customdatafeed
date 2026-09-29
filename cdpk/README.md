# Prebuilt Custom Data Feed packages (`.cdpk`)

Grab the package for **your ArcGIS Server major version** and register it — **no rename
needed**. Each folder holds the file under the name ArcGIS expects: at register time ArcGIS
validates the uploaded filename against the package manifest's `fileName`, so it must stay
`databricks-geospatial-provider.cdpk`.

```
cdpk/
├── 12.x/
│   ├── databricks-geospatial-provider.cdpk          # ArcGIS Server 12.0 / 12.1 — prebuilt & ready
│   └── databricks-geospatial-provider.cdpk.sha256   # checksum
└── 11.x/
    ├── databricks-geospatial-provider.cdpk          # ArcGIS Server 11.2 – 11.5+ — prebuilt & ready
    └── databricks-geospatial-provider.cdpk.sha256   # checksum
```

**Use the package that matches your ArcGIS Server's major version:**
- **12.0 / 12.1** → the `12.x` package (`arcgisVersion 12.0.0`).
- **11.2 – 11.5+** → the `11.x` package (downgraded `arcgisVersion 11.2.0`; see the *ArcGIS 11.x note*).

Match the package to the server — don't run the 11.x manifest on a 12.x server (it happens to
register, but the version-matched package is the supported, no-surprises choice).

Both are the same **cross-platform** build — pure-JS core (runs on Windows *and* Linux) with the
GovCloud (`.mil`/`.us`) OAuth allowlist patched in, so they work on commercial **and**
GovCloud Databricks. Provider **v1.1.2**.

## Prerequisite: the Custom Data Feed runtime

The CDF runtime is a **separate server component, not bundled with ArcGIS Server** — install
`ArcGIS Custom Data Feeds` (for your exact server version, from My Esri) on every ArcGIS Server
machine, Windows or Linux, and restart. Without it, register fails with *"Custom data feed
runtime is not installed or configured properly."*

## Verify before registering

```bash
sha256sum databricks-geospatial-provider.cdpk           # Linux
shasum -a 256 databricks-geospatial-provider.cdpk       # macOS
```
```powershell
Get-FileHash .\databricks-geospatial-provider.cdpk -Algorithm SHA256   # Windows
```

**12.x** SHA-256: `147d0559139d878f7a3a9a05c22fda25abc08ebf1ff1d6ea8752a8caef1a9421`
**11.x** SHA-256: `514b935acd045c8e1dad317d015150327499b8be9f2ca96b2416bc0e28a39c2d`
(each folder's `*.cdpk.sha256` file carries its checksum.)

## Register (Server operation; once per Server site — deploys to all machines)

Two methods; **both work on Windows and Linux** — pick by preference, not OS.

**A. Admin REST API** (good on the box / for automation). `-k` skips the self-signed-cert
check — fine against `localhost`; don't blindly reuse it against a remote admin URL:
```bash
BASE="https://localhost:6443/arcgis"
T=$(curl -sk "$BASE/admin/generateToken" -d "username=<ADMIN>&password=<PASS>&client=requestip&f=json" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
ITEM=$(curl -sk "$BASE/admin/uploads/upload" -F "itemFile=@databricks-geospatial-provider.cdpk" -F "f=json" -F "token=$T" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['itemID'])")
curl -sk "$BASE/admin/services/types/customdataproviders/register" -d "itemId=$ITEM&f=json&token=$T"
```

**B. Server Manager GUI:** *Site → Custom Data Feeds → Add Custom Data Provider*. The file
picker runs in your **browser**, so the `.cdpk` must be on the machine you're browsing from
(copy it off the server first if needed).

**Windows, scripted:** `windows/register-provider.ps1` runs method A's REST flow for you
(first-install *register* or upgrade *update*); `windows/configure-databricks.ps1` sets the
Databricks credentials. See `windows/README.md`.

A bare provider registration is available right away. **If you also set or change the
Databricks credentials** (`init_user_param.sh` / `.databrickscfg`), **restart ArcGIS Server**
on each machine — the shared provider process reads its credentials at startup.

**Re-registering / updating:** re-registering the same version fails unless you unregister
the old one first (or use *update*). **First back up the provider directory to *outside*
`.../providers/`** (e.g. `<install>/server/usr/cdf-provider-backups/`) — in our testing a
**failed `update` deletes the live provider dir**, so keep the backup out of the prune path.

## ArcGIS 11.x note

The prebuilt `11.x` package registers across the whole 11.x line (11.2 → 11.5+). Its manifest
differs from the `12.x` one in four ways (all live-tested on 11.4 Linux, 11.5 Windows, and 12.1):

1. **`arcgisVersion` = `11.2.0`** (the floor). A lower manifest registers on any 11.x server;
   one 11.2.0 build covers 11.2 → 11.5+. CDF requires **11.2+**. (It also *happens* to register
   on 12.x, but 12.x servers should use the version-matched `12.x` package.)
2. **Top-level `editingEnabled: true` is KEPT.** 11.x *tolerates* it (registers fine; just
   shows it blank in the provider listing) and 12.x *honors* it — so keeping it means the same
   package still enables provider-level editing on 12.x. (Earlier guidance to drop it was
   over-cautious; dropping it would silently disable editing on 12.x.)
3. **`properties.hosts: false` + `properties.disableIdParam: true` are added.** The 12.1
   runtime defaults these; the 11.x runtime errors `JSONObject["hosts"] not found` without them.
4. **A `config/default.json` = `{}` file is added.** The 11.x runtime's `import-providers.js`
   does `readFileSync(<provider>/config/default.json)` and dies `ENOENT` without it (12.x
   tolerates its absence). Its symptom is a generic `"Node server failed to start"`; the real
   cause is in `<server>/framework/runtime/customdata/logs/customdataserver-*.log`.

To rebuild: **Windows** `windows/build-cdpk.ps1 -ArcgisVersion 11.2` (plus the config/hosts
additions); **Linux** rebuild via `build-release.sh` with the manifest downgraded. Match your
server's exact `currentVersion` only if a build is rejected — the 11.2.0 floor is expected to
cover the line. For `.mil`/GovCloud the rebuild must also carry the OAuth allowlist patch
(build via the scripts, not a manual zip).
