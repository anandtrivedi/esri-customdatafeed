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
└── 11.x/                                             # ArcGIS Server 11.x — not prebuilt yet; build per the note below
```

**Currently prebuilt: 12.x** (covers 12.0 and 12.1). For **11.x**, see the *ArcGIS 11.x note*
at the bottom.

These are the **universal** build — pure-JS core (runs on Windows *and* Linux) with the
GovCloud (`.mil`/`.us`) OAuth allowlist patched in, so they work on commercial **and**
GovCloud Databricks. Provider **v1.1.2**.

## Verify before registering

```bash
sha256sum databricks-geospatial-provider.cdpk           # Linux
shasum -a 256 databricks-geospatial-provider.cdpk       # macOS
```
```powershell
Get-FileHash .\databricks-geospatial-provider.cdpk -Algorithm SHA256   # Windows
```

**12.x** SHA-256: `650589608a7b8e2f30ee43c6f089ca0c50bb359c54f4312dc81b1395d897e6b7`
(each folder's `*.cdpk.sha256` file carries its checksum).

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

The `12.x` package targets `arcgisVersion 12.0.0`, which registers on **12.0 and 12.1**.
An **11.x** package needs a *downgraded* manifest and is **not prebuilt here yet** — build it
by setting `arcgisVersion` to your server version and dropping the top-level `editingEnabled`
(keep the GovCloud OAuth patch), then drop the result in `cdpk/11.x/`. Easiest builds:
**Windows** `windows/build-cdpk.ps1 -ArcgisVersion <your-version>` (e.g. `-ArcgisVersion 11.5`);
**Linux** rebuild via `build-release.sh` with the manifest downgraded. One 11.x build is
expected to cover the 11.x line; if a specific minor rejects it, rebuild for that exact
version. CDF requires ArcGIS Server **11.2+**.
