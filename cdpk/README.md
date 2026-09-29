# Prebuilt Custom Data Feed packages (`.cdpk`)

Grab the folder matching your **ArcGIS Server major version** and register the `.cdpk` inside.
Don't rename it — at register time ArcGIS checks the uploaded filename against the manifest, so
it must stay `databricks-geospatial-provider.cdpk`.

- **ArcGIS Server 12.0 / 12.1** → [`12.x/`](12.x/)
- **ArcGIS Server 11.2 – 11.5+** → [`11.x/`](11.x/)

Use the package that matches your server — the 11.x manifest happens to register on 12.x, but
the version-matched package is the supported, no-surprises choice.

**Verify before registering** (compare against that folder's `*.cdpk.sha256`):

```bash
sha256sum databricks-geospatial-provider.cdpk                          # Linux
Get-FileHash .\databricks-geospatial-provider.cdpk -Algorithm SHA256   # Windows (PowerShell)
```

Both are the same cross-platform build (pure-JS core, runs on Windows *and* Linux, with the
GovCloud `.mil`/`.us` OAuth allowlist patched in). Provider **v1.1.2**.

---

**Install, register, configure, and troubleshooting all live in the main [`../README.md`](../README.md)** —
that's the single source of truth. (Rebuilding an 11.x package: see its *Build the provider
package* section.)
