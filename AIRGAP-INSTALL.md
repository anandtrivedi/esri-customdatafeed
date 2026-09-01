# Installing in a disconnected / air-gapped environment

For ArcGIS Server hosts with **no outbound Internet** — closed or isolated networks,
boxes where code arrives only through an approved transfer path. This guide is
cross-platform (Linux and Windows) and complements the standard install docs
([root README](README.md), [`windows/`](windows/README.md)).

> **Your organization's security and transfer policy governs everything here.**
> Confirm before you move any bytes across a boundary. Approval is per-site and is
> usually the long pole, not the transfer itself — start it first.

---

## 1. Scope

The operative constraint this guide addresses is **no outbound Internet from the
ArcGIS Server host** (e.g. no route to `registry.npmjs.org`, GitHub, or a build
service). Stricter environments add rules on top — follow yours.

"Disconnected from the Internet" is **not** the same as "disconnected from
Databricks" — see §3.

---

## 2. The one hard truth

The provider is two very different things to move:

| Part | Size | Movable by hand? |
|---|---|---|
| Provider **source** (`src/*.js`, `cdconfig.json`, small JSON) | ~18 small text files | ✅ Yes — paste-able |
| Its **npm dependencies** (`@databricks/sql`, `pg`, `dotenv` + transitive) | **~301 packages, ~61 MB** in `node_modules` | ❌ No |

The provider **cannot run** without those dependencies, and on a no-Internet box
there is **no `npm install`** to fetch them. Therefore the dependency tree must
arrive **prebuilt as a bundle** — and that bundle is the **`.cdpk`**: a single
~11 MB zip of `src/` + `node_modules` + `cdconfig.json`. Getting one `.cdpk` onto
the box is the whole job.

**Dead ends — don't spend a week on these:**

- Hand-pasting `node_modules` (301 packages).
- `npm install` with no registry and no pre-seeded cache.
- **Building on the ArcGIS Server box.** Its bundled Node may not even ship `npm`;
  build the `.cdpk` on a separate connected host (§5, Path B).

---

## 3. Air-gapped ≠ cut off from Databricks

The Internet air gap affects **install only**. At **query time** the ArcGIS Server
host still needs a network route to your Databricks workspace. File these requests
**in parallel** with the transfer paperwork:

| Destination | Port | For |
|---|---|---|
| `<workspace-host>` (often via **PrivateLink**) | 443 | SQL Warehouse queries + Databricks API |
| `<lakebase-instance>.database.cloud.databricks.com` | 5432 | Lakebase (only if used) |

- **DNS** must resolve the workspace/PrivateLink FQDN from the host.
- **TLS-inspecting proxy or internal CA?** Node does **not** use the OS trust store.
  Point it at your CA bundle with `NODE_EXTRA_CA_CERTS=<path-to-pem>` (set in the
  ArcGIS Server service environment), or you'll see `SELF_SIGNED_CERT_IN_CHAIN` /
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` at first query.
- **Auth that works offline:** a workspace **Personal Access Token** or a
  **workspace-hosted OAuth M2M service principal** (client_id/secret) — both
  authenticate directly against the workspace host. **Auth that breaks the air gap:**
  any flow through an external IdP (Entra/Azure AD device-code,
  `login.microsoftonline.com`) or a browser-based OAuth flow — that's Internet
  egress, and there's no browser on a headless hardened box. Choose PAT or workspace
  M2M.

---

## 4. Preflight (before you request anything)

A wrong answer here invalidates the artifact you spent weeks getting approved.

1. **ArcGIS Server 11.4+** with **Custom Data Feeds enabled** (12.0+ for editing).
2. **Bundled Node version** on the target — the provider runs on the CDF runtime's
   own Node, and `@databricks/sql`/`pg` need a current major. Print it:
   - Linux: `/opt/arcgis/server/framework/runtime/node/bin/node -v`
     (hardened installs: `/app/arcgis/...`)
   - Windows: `& "C:\Program Files\ArcGIS\Server\framework\runtime\node\bin\node.exe" -v`
3. **Target OS/arch** — confirm the `.cdpk` you'll ship matches (the universal
   pure-JS bundle is portable; see §7 on native modules).
4. **Single vs. multi-node site.** Registering a `.cdpk` is **site-level** — it
   propagates to every node via the shared config-store, so you register **once**.
   But **credentials are per-machine** (see §6) — configure them on **every node**.
5. **Admin access** to register the provider (ArcGIS Server admin login).
6. **The Databricks values** the publish step needs: workspace host, SQL Warehouse
   HTTP path, and the table's catalog/schema/name + geometry column.

---

## 5. Get one `.cdpk` onto the box

**Decision table — pick what your environment actually allows:**

| You have… | Use |
|---|---|
| A published `.cdpk` + removable media, an internal artifact repo (Artifactory/Nexus/SCCM), or a sanctioned file share | **Path A** (recommended) |
| An approved file-transfer service / data diode | **Path A** (mind archive rules) |
| No prebuilt `.cdpk` — a connected build/dev host + an approved path into the network | **Path B** (build) → then A |

### Path A — approved binary transfer  *(recommended)*

Move exactly **one `.cdpk`** (plus its checksum) through your approved channel:
removable media, an internal generic artifact repo, an SCCM/patch pipeline, a
sanctioned share, or an approved file-transfer service.

1. On the connected side, obtain the `.cdpk` (a published release, or build it —
   Path B) and record its hash: `shasum -a 256 databricks-geospatial-provider.cdpk`.
2. Move it across your approved path.
3. On the target, **verify the hash matches** before use
   (`Get-FileHash <file> -Algorithm SHA256` on Windows).

> Some transfer services and content filters **block or strip archives** they can't
> inspect; a `.cdpk` is a zip, so it may need an explicit allowance. Renaming the
> extension to slip it past a filter is a **policy violation**, not a workaround.

### Path B — build the artifact on a connected host

There is no true "build inside the air gap." Build the `.cdpk` on a **connected
build/dev host** (never the ArcGIS Server box — its bundled Node may lack `npm`),
then ship it via Path A. **Linux or Windows both build it** — npm is cross-platform;
you do not need Linux.

- **Linux / macOS:** `bash build-release.sh` — runs `npm ci`, applies + verifies the
  GovCloud OAuth allowlist, and writes `dist/<name>-v<ver>.cdpk` + `.sha256`.
- **Windows:** `.\windows\build-cdpk.ps1` (pure PowerShell) — same steps: `npm ci`,
  GovCloud patch/guard, then `Compress-Archive` of `src/ + node_modules/ +
  cdconfig.json + package.json + package-lock.json`, renamed to the `.cdpk` name from
  `cdconfig.json`.

> **Don't hand-zip it for a GovCloud (`.mil`/`.us`) site.** The build patches
> `@databricks/sql`'s `OAuthManager.js` to add `.cloud.databricks.mil` /
> `.cloud.databricks.us` to its OAuth domain allowlist; a raw `Compress-Archive` that
> skips this yields a `.cdpk` that **fails OAuth M2M on GovCloud**. Use the build
> script (it patches + guards), or apply the same edit by hand. Commercial
> (`.cloud.databricks.com`) and PAT auth are unaffected.

> An **internal npm "mirror"** only helps if it is **pre-seeded with the exact
> lockfile versions** — most internal repos are *proxy* caches that fetch upstream on
> a miss, which fails with no Internet. Test-resolve `package-lock.json` against it
> first.

---

## 6. Install (same for every path)

None of this needs the Internet.

1. **Register** the provider from the `.cdpk` — no build, no npm:
   - Linux: `sudo bash register-provider.sh` (auto-detects the prebuilt `.cdpk`)
   - Windows: `.\windows\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk`
   - Multi-node: register **once** (it's site-level).
2. **Configure credentials** offline — writes `.databrickscfg`, no network calls:
   - Linux: `sudo bash configure-databricks.sh`
   - Windows: `.\windows\configure-databricks.ps1 -DatabricksHost https://<host> -AuthMode pat|oauth`
   - Do this on **every node** (credentials don't propagate).
3. **Restart** ArcGIS Server so it reads the new provider + credentials.
4. **Verify (offline smoke test):** publish a feature service against a known table
   and run a minimal query (`.../FeatureServer/0/query?where=1=1&resultRecordCount=1`).
   Rows back = the provider loaded, authenticated, and reached Databricks. If it
   fails, check the ArcGIS Server logs and the §3 network/TLS items first.

---

## 7. Appendix — evidence for a security review

- **Integrity.** Record the `.cdpk` SHA-256 on the connected side and re-verify on the
  target (§5). Keep the original `.cdpk` unmodified — that hash is authoritative even
  if a scanner unzips it.
- **Provenance.** Note the release version / git commit and build date. `version.js`
  reports the running provider version.
- **Dependency inventory (SBOM).** Generate on the connected side (can't be done
  offline): `npm ls --all`, keep `package-lock.json`, and produce a CycloneDX/SPDX
  SBOM plus `npm audit` output. Build with `--omit=dev --ignore-scripts` so no dev
  packages or lifecycle scripts ship.
- **Native binaries — verify, don't assume.** The provider's *core is pure
  JavaScript*, but the **default universal `.cdpk` contains three optional `.node`
  files**: `lz4.node` + `xxhash.node` (lz4 compression acceleration — the provider
  falls back to pure-JS if absent) and `fsevents.node` (a macOS-only dev/transitive
  module that no-ops elsewhere). **None are required.** List what's present:
  - Linux: `unzip -l <file>.cdpk | grep -E '\.(node|dll|so|dylib)$'`
  - Windows: `Get-ChildItem -Recurse <extracted> -Include *.node,*.dll,*.so`

  To ship a **zero-native-binary** bundle, rebuild with `--omit=dev` and prune the
  optional lz4 modules before packaging.
- **Telemetry.** Usage telemetry is **best-effort and fail-soft** — if its endpoint
  is unreachable (as in any air gap) the provider continues normally; it does not
  block queries. The only network destination the provider *needs* is your Databricks
  workspace host (§3). Confirm no other egress with your host firewall logs.
- **Secrets.** `.databrickscfg` holds credentials in plaintext on disk — restrict it
  to the ArcGIS Server service account (mode `600` / owner `arcgis` on Linux; SYSTEM +
  Administrators + service-account ACL on Windows — the configure scripts do this).
  Rotate PATs/secrets per your policy: re-run the configure script + restart.
