# Prebuilt Custom Data Feed packages (`.cdpk`)

Grab the package for **your ArcGIS Server major version** and register it — **no rename
needed** (each folder holds the file under its required canonical name
`databricks-geospatial-provider.cdpk`).

```
cdpk/
├── 12.x/databricks-geospatial-provider.cdpk   # ArcGIS Server 12.0 / 12.1
└── 11.x/databricks-geospatial-provider.cdpk   # ArcGIS Server 11.x  (see note below)
```

These are the **universal** build — pure-JS core (runs on Windows *and* Linux) with the
GovCloud (`.mil`/`.us`) OAuth allowlist patched in, so they work on commercial **and**
GovCloud Databricks. Provider **v1.1.2**.

## Verify before registering

```bash
sha256sum databricks-geospatial-provider.cdpk        # Linux/macOS
```
```powershell
Get-FileHash .\databricks-geospatial-provider.cdpk -Algorithm SHA256   # Windows
```

**12.x** SHA-256: `650589608a7b8e2f30ee43c6f089ca0c50bb359c54f4312dc81b1395d897e6b7`
(each folder's `*.cdpk.sha256` file carries its checksum).

## Register (Server operation; once per Server site)

**Linux (admin REST, file on the box):**
```bash
BASE="https://localhost:6443/arcgis"
T=$(curl -sk "$BASE/admin/generateToken" -d "username=<ADMIN>&password=<PASS>&client=requestip&f=json" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
ITEM=$(curl -sk "$BASE/admin/uploads/upload" -F "itemFile=@databricks-geospatial-provider.cdpk" -F "f=json" -F "token=$T" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['itemID'])")
curl -sk "$BASE/admin/services/types/customdataproviders/register" -d "itemId=$ITEM&f=json&token=$T"
```
Then restart ArcGIS Server on every machine. **Windows:** Server Manager → *Site → Custom
Data Feeds → Add Custom Data Provider* (file picker is client-side — copy the `.cdpk` to the
machine running the browser first).

**Re-registering an existing install:** unregister the old version first (or *update*), and
**back up the provider dir to outside `.../providers/`** — a failed `update` deletes it.

## ArcGIS 11.x note

The `12.x` package targets `arcgisVersion 12.0.0`. The `11.x` package has a downgraded
manifest. If your 11.x minor rejects the provided `11.x` build, rebuild with
`arcgisVersion` set to your exact server version (drop top-level `editingEnabled`), keeping
the GovCloud OAuth patch. CDF requires ArcGIS Server **11.2+**.
