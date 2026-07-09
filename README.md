# ArcGIS Custom Data Feed Provider for Databricks

A Node.js Custom Data Provider that connects Databricks tables to ArcGIS Server as Feature Services. Supports two backends:

| Backend | Engine | Best for | Capabilities |
|---------|--------|----------|-------------|
| **Lakehouse** | Databricks SQL Warehouse | Large-scale analytics, complex queries across massive tables | Query |
| **Lakebase** | Databricks Managed PostgreSQL + PostGIS | Low-latency serving (14–16ms), interactive maps, feature editing | Query + Editing |

Choose **Lakehouse** when you need to query large Delta Lake tables directly with full Databricks SQL power. Choose **Lakebase** when you need fast, interactive map performance or feature editing — Lakebase serves data at PostgreSQL speeds with native PostGIS spatial indexing.

One provider is registered once. Each Feature Service chooses its backend via service parameters.

> **How to read this README**
>
> The manual install path is **6 steps**:
>
> 1. [Get the code and install dependencies](#1-get-the-code-and-install-dependencies) *(Setup)*
> 2. [Configure Databricks connection](#2-configure-databricks-connection) *(Setup)*
> 3. [Configure Lakebase](#3-configure-lakebase-optional) *(Setup, optional)*
> 4. [Package and register the provider](#4-package-and-register-provider) *(Setup)*
> 5. [Apply production hardening](#5-production-hardening-recommended) *(recommended)*
> 6. [Create your first Feature Service](#6-create-your-first-feature-service)
>
> **Easier path — let an agent do most of it ([section 7: MCP server](#7-agent-driven-publishing-mcp-server)).** You still build the `.cdpk` once (the packaging half of step 4 — or use one someone already built). From there the bundled MCP server turns the rest into a conversation with Claude (or Databricks Playground): `register_provider` uploads and registers the package with the Databricks config **baked in** — replacing steps 2–3 and the register half of step 4, and immune to the update-wipes-`.env` failure — and `publish_layer` handles step 6 end to end (derives every service parameter from the table, publishes, smoke-tests). Step 1 (an ArcGIS Server), the one-time packaging, and step 5 (hardening) stay manual. Steps 2–6 below remain the reference for what the tools do under the hood — and the fallback when you can't run an MCP client.
>
> Once you hit the **"Installation complete"** marker after step 6, you're done — [section 7](#7-agent-driven-publishing-mcp-server) covers the MCP server (agent-driven install, publishing, and day-2 operations), and everything after that is reference material — query parameters, performance benchmarks, geometry formats, environment-variable reference, troubleshooting, and a brief design appendix — to look up as needed.

## Overview

![CDF Overview — Direct Integration with ArcGIS Enterprise](cdf-overview.png)

## Architecture

![CDF Architecture — Databricks + Lakebase](cdf-architecture.png)

![Cell Towers served from Databricks Lakebase via ArcGIS Feature Service](screenshots/03-celltowers-editable-map.png)

## Project Structure

```
nodejs-provider/
  cdconfig.json               # CDF provider manifest (registered with ArcGIS Server)
  package.json
  .env.example                # Environment config template
  .databrickscfg.example      # Multi-workspace profile template
  src/
    index.js                  # Provider entry point
    model.js                  # getData/editData/authorize — routes between backends
    modules/
      # --- Shared ---
      workspaceResolver.js    # Resolves .databrickscfg profile → workspace + auth config
      sanitize.js             # SQL injection prevention
      translate.js            # Row-to-GeoJSON conversion
      filters.js              # filtersApplied metadata
      auditLog.js             # Query audit logging
      # --- Lakehouse backend ---
      connectionPool.js       # Databricks SQL connection pooling (keyed per workspace+warehouse)
      sql.js                  # Databricks SQL query builder
      geometry.js             # Spatial filter construction (with DE-9IM workarounds)
      geometryFormat.js       # WKT/WKB/GeoJSON format handling
      # --- Lakebase backend ---
      lakebasePool.js         # PostgreSQL connection pooling (pg module, workspace-aware)
      lakebaseQuery.js        # PostGIS SELECT query builder
      editSql.js              # INSERT/UPDATE/DELETE SQL builders
  test/                       # 350 unit tests (mocha + chai)

mcp-server/                   # MCP server: publish/manage CDF feature services from agents
  bin/cli.js                  # serve (stdio|http) + register-target + list-targets
  src/                        # 8 tools over the ArcGIS admin API + Statement Execution API
  test/                       # 25 unit tests (mocha + chai)
```

## Setup

**Every command in this guide runs on the ArcGIS Server host itself — not on your laptop.** SSH into the box first and stay there for the whole install. That's why the `curl` examples target `https://localhost:6443/...`: `localhost` *is* the ArcGIS Server, because you're already logged into it. (The only exceptions are the two collapsed "alternative" blocks — the CDF CLI and the `referer` token flow — which use `your-server` as a placeholder for the box's external hostname, for the rare case you run them from elsewhere.)

> **Which user runs what:**
> - **Your SSH user** (typically `ubuntu` on a fresh AWS AMI) runs the build, package, and upload work — `git clone`, `npm install`, `zip`, and the `curl` calls to the Admin REST API.
> - **`sudo` is required** for anything that reads or writes under `/opt/arcgis/` (the ArcGIS Server install tree). Editing `init_user_param.sh`, placing `.databrickscfg`, recreating `.env` after a `.cdpk` re-extraction, and tailing logs all need `sudo`.
> - **`sudo -u arcgis`** is used to start, stop, or restart ArcGIS Server itself, because the server processes run as the `arcgis` OS user. Example: `sudo -u arcgis /opt/arcgis/server/startserver.sh`.
> - Files you create under `/opt/arcgis/...` should be `chown arcgis:arcgis` so the server can read them.

### Prerequisites

- **ArcGIS Server 11.4 or later** with Custom Data Feeds enabled. ArcGIS Server includes a Node.js runtime — you do not need to install Node separately. ArcGIS Server 12.0+ is recommended if you want feature editing.
- **A Databricks SQL Warehouse** with geospatial functions enabled.
- **Network access from the ArcGIS Server box to your Databricks workspace.** Open these outbound ports from the ArcGIS Server's network (firewall / VPC security group / on-prem ACL):

  | Destination | Port | Protocol | Used for |
  |---|---|---|---|
  | `<workspace>.cloud.databricks.com` | 443 | HTTPS | SQL Warehouse queries + all Databricks REST API calls (token mint, Lakebase credential mint, etc.) |
  | `<lakebase-instance>.database.cloud.databricks.com` | 5432 | PostgreSQL over TLS | Lakebase queries and edits (only if you use the Lakebase backend) |

  Nothing needs to be opened *inbound* on the Databricks side — Databricks already listens on these ports and gates access via IP allowlists. If your workspace has [IP access lists](https://docs.databricks.com/aws/en/security/network/front-end/ip-access-list) enabled, allowlist the ArcGIS Server's outbound IP — otherwise the first query returns `HTTP 403` with no clear error in the ArcGIS Server UI. Apply this **per workspace** if you're connecting to more than one.
- **Optional:** A Databricks Lakebase instance — only needed for low-latency serving or feature editing.

### 1. Get the code and install dependencies

Do this **on the ArcGIS Server box itself** (the Linux or Windows machine where ArcGIS Server is installed), not on your laptop — the provider includes native modules that must compile for the server's OS, otherwise they fail to load at runtime.

The provider's source lives in the **`nodejs-provider/` subdirectory at the root of this repo** (see [Project Structure](#project-structure) above). Clone the repo on the server and `cd` into that subdirectory before running `npm install`:

```bash
git clone <this-repo-url>                # clones into ./esri-customdatafeed/
cd esri-customdatafeed/nodejs-provider   # provider source + cdconfig.json + package.json live here
npm install
```

> **If `npm` errors with `Cannot find module '../lib/cli.js'`:** on some installs the ArcGIS-bundled `npm` launcher is broken (and there may be no system npm at all). Invoke npm through the bundled Node directly — same `install` semantics, just explicit paths:
> ```bash
> /opt/arcgis/server/framework/runtime/node/bin/node \
>   /opt/arcgis/server/framework/runtime/node/lib/node_modules/npm/bin/npm-cli.js install
> ```
> The bundled Node binary is typically mode `700`, owned by the `arcgis` OS user — if you're logged in as a different user (e.g. `ubuntu`) you'll get *Permission denied*; prefix the command with `sudo -u arcgis`. Use the same pattern for any other npm command on the server. Building with the bundled Node is preferred anyway — it guarantees native modules compile against the exact Node version the CDF runtime uses.

### 2. Configure Databricks Connection

```bash
cp .env.example .env
```

**For a single workspace with a PAT (Personal Access Token)**, set three env vars in `.env`:

```bash
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi_your_pat_here
```

Other env vars in [`.env.example`](nodejs-provider/.env.example) (pool sizes, query timeouts, audit log) are operational tuning — leave them at defaults unless you have a reason.

**For multiple workspaces, or for service-principal OAuth M2M auth instead of a PAT**, skip these env vars (leave them empty or remove the lines) and use the `.databrickscfg`-based setup in the next section.

### Multiple Workspaces or OAuth M2M

*Optional — skip this whole section if you only need one workspace and you're happy using a PAT.* The env vars in Step 2 already cover you; jump ahead to [Step 3](#3-configure-lakebase-optional).

Use this section if you need either of:
- **Multiple Databricks workspaces** served by the same ArcGIS Server (one Feature Service per workspace, with isolated connection pools per workspace), OR
- **Service-principal OAuth M2M auth** (recommended for production — a machine identity with `client_id`+`client_secret` that auto-refreshes tokens, instead of a long-lived PAT tied to a user).

Both modes work for Lakehouse and Lakebase. You configure them through a `.databrickscfg` file — the same one the Databricks CLI uses.

#### `.databrickscfg` profiles

The provider reads `~/.databrickscfg` (or the path in `DATABRICKS_CONFIG_FILE`) — same format used by the Databricks CLI / Asset Bundles / dbt. See [`.databrickscfg.example`](nodejs-provider/.databrickscfg.example) for a copy-paste template.

```ini
# PAT (Personal Access Token)
[WORKSPACE_A]
host  = workspace-a.cloud.databricks.com
token = dapiXXXXXXXXXXXXXXXXX

# OAuth M2M (service principal — recommended for production)
[WORKSPACE_B]
host          = workspace-b.cloud.databricks.com
client_id     = <service-principal-client-id>
client_secret = <service-principal-secret>
```

- Each profile uses **one** auth mode — either `token` (PAT) **or** `client_id` + `client_secret` (OAuth M2M). Mixing both in one profile errors at request time.
- Different profiles can use different auth modes independently — all-PAT, all-OAuth M2M, or any mix.
- Add a profile per workspace.

#### Default profile resolution

When a service is created **without** a `workspace` parameter:

1. If a `[DEFAULT]` profile exists in `.databrickscfg`, it's used.
2. Otherwise, env vars (`DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN`) form a synthesized default.
3. If neither is set, the service errors at request time.

If you go all-in on `.databrickscfg`, leave the `DATABRICKS_*` credential env vars in `.env` empty (or delete those lines) — the resolver picks `.databrickscfg` `[DEFAULT]` first, and empty/missing env vars avoid any chance of mismatched credentials.

#### Example: services pointing at different workspaces

Using the two profiles from the snippets above (`[WORKSPACE_A]` PAT and `[WORKSPACE_B]` OAuth M2M), here's how a Lakehouse service and a Lakebase service register against different workspaces — full createService payloads are in [Step 6: Create your first Feature Service](#6-create-your-first-feature-service) below.

```json
// Lakehouse service → workspace A (PAT)
"serviceParameters": {
  "workspace": "WORKSPACE_A",
  "warehouseHttpPath": "/sql/1.0/warehouses/aaaa",
  "tableName": "catalog_a.geo.cells",
  "geometryColumn": "geometry",
  "idField": "id"
}

// Lakebase service → workspace B (OAuth M2M)
"serviceParameters": {
  "workspace": "WORKSPACE_B",
  "lakebaseHost": "instance-bbbb.database.cloud.databricks.com",
  "lakebasePort": "5432",
  "lakebaseDatabase": "geospatial",
  "lakebaseTable": "buildings",
  "geometryColumn": "geometry",
  "idField": "id"
}
```

For OAuth M2M Lakebase services, the provider exchanges `client_id`/`client_secret` at the workspace's `/oidc/v1/token` endpoint, then uses that token to call `/api/2.0/database/credentials` for the Lakebase OAuth token. Auto-refreshes ~5 minutes before expiry.

#### Service principal setup (OAuth M2M)

Per workspace, in the Databricks account console:

1. Create a service principal (or reuse an existing one).
2. Assign the SP to the workspace.
3. Generate an OAuth secret — save the `client_id` and `client_secret`.
4. Grant the SP `CAN_USE` on the SQL warehouse.
5. For Lakebase: grant the SP database-level access on the Lakebase instance.

Reference: [Authorize service principal access with OAuth M2M](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m).

#### `.databrickscfg` location on ArcGIS Server

ArcGIS Server runs as the `arcgis` OS user, whose home directory may not be set up — so don't rely on the default `~/.databrickscfg` lookup. Put the file at an explicit path (e.g. `/opt/arcgis/server/usr/.databrickscfg`) and point `DATABRICKS_CONFIG_FILE` at it. The init-script setup and file permissions are covered in [Step 5: Production hardening](#5-production-hardening-recommended) below.

#### Verifying it works

Provider logs (append `/logz` to the app URL, or tail `/opt/arcgis/server/usr/logs/*/server/server-*.log`) will show distinct connection pools per workspace:

```
[Pool WORKSPACE_A|/sql/1.0/warehouses/abc123] Initialized (min: 2, max: 10)
[Pool WORKSPACE_B|/sql/1.0/warehouses/xyz789] Initialized (min: 2, max: 10)
```

#### Multi-workspace troubleshooting

| Symptom | Likely cause |
|---|---|
| `Databricks workspace profile "X" not found` | Profile name typo (case-sensitive), wrong `DATABRICKS_CONFIG_FILE`, or file isn't readable by the `arcgis` user |
| `Profile [X] is ambiguous: defines both PAT and OAuth M2M` | Pick one — comment out either `token` OR `client_id`+`client_secret` |
| `OAuth M2M token endpoint returned 401` | SP `client_id`/`client_secret` is wrong/revoked, or SP isn't assigned to the workspace |
| `No Lakebase instance found with hostname X in workspace Y` | The `lakebaseHost` belongs to a different workspace than the `workspace` profile points at |
| `Source IP address X is blocked by Databricks IP ACL` | The ArcGIS Server's outbound IP isn't on that workspace's IP allowlist (workspace-level setting in Databricks, separate from CDF) |
| Single-workspace deployment regressed after upgrade | Env vars `DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN` missing from init script |

### 3. Configure Lakebase (optional)

Skip this step if you don't need editing or low-latency serving.

**One-time Lakebase database setup:** enable PostGIS on each database the provider will use — `CREATE EXTENSION IF NOT EXISTS postgis;`. The provider's Lakebase queries and edits rely on PostGIS geometry types and ST_* functions; without it the first query fails with `function st_intersects does not exist`.

> **Heads-up if your Lakebase table is populated via Databricks Synced Tables** (the reverse-ETL feature that copies a Unity Catalog table into Lakebase): Databricks Sync **does not carry GEOMETRY or GEOGRAPHY columns** — the sync will fail if your source Delta table has them. The fix is to store geometry as WKT in a STRING column on the Databricks side, sync that, and either convert at query time or via a generated column on the Lakebase side. Full details and the workaround SQL are in [Known Limitations → Lakebase Synced Tables](#lakebase-synced-tables-geometrygeography-types-not-supported). If you're creating your Lakebase table directly (not via sync), ignore this — native PostGIS geometry works fine.

For Lakebase services, no extra provider-side config is needed. Per-table connection details (`lakebaseHost`, `lakebaseDatabase`, etc.) go on each Feature Service when you create it (see [Step 6: Create your first Feature Service](#6-create-your-first-feature-service)). Authentication is automatic — the provider uses your PAT from Step 2 (or the resolved workspace profile in multi-workspace setups) to mint short-lived Lakebase OAuth tokens, auto-refreshing them before expiry.

To bypass automatic token minting and use a fixed credential (testing, CI), set `LAKEBASE_PASSWORD` in `.env`. Other Lakebase tuning vars (`LAKEBASE_POOL_MIN/MAX`, `LAKEBASE_SSL_VERIFY`) are documented in [`.env.example`](nodejs-provider/.env.example).

### 4. Package and Register Provider

> **Agent shortcut:** with a built `.cdpk` (step a below), the [MCP server's](#7-agent-driven-publishing-mcp-server) `register_provider` tool performs the upload/register/update flow for you — including baking `.env` config into the package so upgrades can't wipe it.

This is a **one-time** action that tells ArcGIS Server "the Databricks CDF provider exists and is available to use." You only do it again when you change the provider's source code. Creating individual Feature Services against the registered provider is the next step: [Step 6](#6-create-your-first-feature-service).

You package the provider as a `.cdpk` file (just a zip archive with a different extension), upload it, and register it. Recommended path uses the standard Admin REST API and works on any ArcGIS Server install:

> **Fresh server vs. reused server.** On a server with **no CDF provider registered yet**, the steps below just work. If a Databricks CDF provider is *already* registered (pre-baked or reused AMI), know that `register` is strictly first-install — ArcGIS Server refuses any `register` call for a provider name that's already registered (*"Custom data provider with name '...' is already registered"*). Your options:
> - **Same provider name, new code** (the upgrade case) — use the **`update`** operation instead of `register`; see "Upgrading the provider later" below the commands.
> - **Retire the old one** — list what's registered, then unregister by `.cdpk` filename:
>   ```bash
>   # list registered providers
>   curl -sk "https://localhost:6443/arcgis/admin/services/types/customdataproviders?token=$TOKEN&f=json"
>   # unregister one (also deletes its extracted provider directory)
>   curl -sk -X POST "https://localhost:6443/arcgis/admin/services/types/customdataproviders/unregister?token=$TOKEN&f=json" \
>     --data-urlencode "customdataFilename=old-provider-name.cdpk"
>   ```
> Either way, restart the server (below) afterward so everything reloads cleanly.

> **Where does `TOKEN` come from?** It's an **ArcGIS Server admin token** — *not* your Databricks PAT. You mint it from ArcGIS Server with your `siteadmin` credentials, and every `/arcgis/admin/...` call below reuses it. See [Admin token binding: `requestip` vs `referer`](#admin-token-binding-requestip-vs-referer) for the difference between the two binding modes and when to use each.

All four commands below are part of this step — run them in order on the server. (The letters (a)–(d) are deliberate: they are sub-commands of this step, not the README's numbered install Steps.)

```bash
# (a) Build the .cdpk — from inside the nodejs-provider/ directory (where you ran npm install)
#     Keep the .env excludes EXACTLY as written. A wildcard like '*.env*' would
#     also strip node_modules files whose names contain ".env" (e.g.
#     @dabh/diagnostics/adapters/process.env.js, a transitive dep of
#     @databricks/sql) — the broken package then fails provider validation at
#     register time with "Cannot find module '../adapters/process.env'".
cd esri-customdatafeed/nodejs-provider   # if not already there
zip -r databricks-geospatial-provider.cdpk \
  cdconfig.json package.json package-lock.json src/ node_modules/ \
  -x '.env' '.env.*' 'test/*' '*.md'

# (b) Get an ArcGIS admin token (siteadmin login). client=requestip binds the
#     token to your IP — no Referer header to keep in sync. Run this on the box
#     (or replace localhost with the server host) and use your real password.
TOKEN=$(curl -sk -X POST 'https://localhost:6443/arcgis/admin/generateToken?f=json' \
  --data-urlencode 'username=siteadmin' \
  --data-urlencode 'password=...' \
  --data-urlencode 'client=requestip' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# (c) Upload the .cdpk. The response contains an itemID — copy it, the next
#     command needs it. Do NOT skip this even if you skipped optional steps.
curl -k "https://localhost:6443/arcgis/admin/uploads/upload?token=$TOKEN&f=json" \
  -F "itemFile=@databricks-geospatial-provider.cdpk"
# Returns: {"status":"success","item":{"itemID":"i273bb53a-..."}}   <-- copy this itemID

# (d) Register the upload — paste the itemID from (c)'s response. This itemID
#     always comes from the upload above; it has nothing to do with Lakebase.
#     register is for FIRST install only — see the upgrade note below.
curl -k "https://localhost:6443/arcgis/admin/services/types/customdataproviders/register?token=$TOKEN&f=json" \
  --data-urlencode "id=ITEM_ID_FROM_UPLOAD_RESPONSE"
```

**Upgrading the provider later** (new code, same provider name): `register` will refuse with *"Custom data provider with name '...' is already registered"*. Build and upload the new `.cdpk` exactly as in (a)–(c), then call **`update`** instead of `register`:

```bash
curl -k "https://localhost:6443/arcgis/admin/services/types/customdataproviders/update?token=$TOKEN&f=json" \
  --data-urlencode "id=ITEM_ID_FROM_UPLOAD_RESPONSE"
```

> ⚠️ **Back up `.env` before running `update`.** The update extracts the new `.cdpk` over the provider directory (wiping any `.env` you added), and if the new package fails validation the runtime **deletes the provider directory entirely** — your services stay down until a good `.cdpk` is updated in. Back up first: `sudo cp <provider-dir>/.env /tmp/cdf.env.bak`.

> **What just happened.** The `register` (or `update`) call triggers ArcGIS Server to extract your `.cdpk` into `/opt/arcgis/server/framework/runtime/customdata/providers/databricks-geospatial-provider/`, then validates it by starting the provider with the bundled Node runtime. The server handles the placement automatically — you do not copy or move files manually. The `git clone` in your home directory and the `.cdpk` archive were just staging artifacts; the live install is what's now under `/opt/arcgis/...`.
>
> **Before updating (skip on first install):** if you've already registered once and added a `.env` to the live provider directory, **back it up first** — the `.cdpk` extraction wipes the directory (and a *failed* update deletes it entirely):
> ```bash
> sudo cp /opt/arcgis/server/framework/runtime/customdata/providers/databricks-geospatial-provider/.env /tmp/cdf.env.bak
> ```
>
> **After registration — two things to do every time:**
> 1. **Recreate `.env`** in the live provider directory (`/opt/arcgis/server/framework/runtime/customdata/providers/databricks-geospatial-provider/.env`) if you use one. The `.cdpk` extraction overwrites whatever was there, so any local `.env` you had under `/opt/arcgis/...` is gone. (The `.env` in your home-dir clone is not used at runtime.) Restore from your backup if you made one. This is one of the cases where you need `sudo` — see the [user-context callout](#setup) at the top of Setup.
> 2. **Restart ArcGIS Server** (`sudo -u arcgis /opt/arcgis/server/stopserver.sh` then `startserver.sh`) so the new code loads.

<details>
<summary>Alternative: CDF CLI from the ArcGIS Enterprise SDK</summary>

If you have the [ArcGIS Enterprise SDK](https://developers.arcgis.com/enterprise-sdk/) installed and prefer its CLI:

```bash
cdf export databricks-geospatial-provider
cdf register databricks-geospatial-provider https://your-server/arcgis/admin TOKEN
```

For self-signed certs, set `NODE_TLS_REJECT_UNAUTHORIZED=0` or `NODE_EXTRA_CA_CERTS=/path/to/cert.pem`. If you hit "Invalid token, ClientID does not match", fall back to the REST API above — the CDF CLI uses `Authorization: Bearer` which conflicts with ArcGIS's referer-based tokens.
</details>

## 5. Production hardening (recommended)

These steps harden the deployment for production. Skip if you're just trying the provider locally — Steps 1-4 alone will work.

> **Where things live on the ArcGIS Server box.** A Linux install lands under `/opt/arcgis/server/` by default; on Windows the equivalent is typically `C:\Program Files\ArcGIS\Server\`. Substitute your install root if it's elsewhere. The paths in the rest of this section assume the Linux default. Edits to files under `/opt/arcgis/` need `sudo`, and any change requires a server restart (`sudo -u arcgis /opt/arcgis/server/stopserver.sh` then `startserver.sh`). If you want to verify the install state before/after changes, jump to the [sanity-check block](#troubleshooting) at the top of Troubleshooting.

### Set environment variables in `init_user_param.sh`

ArcGIS Server reads a startup script (typically at `/opt/arcgis/server/usr/init_user_param.sh` on Linux) and exports anything in it as environment variables for the embedded Node.js runtime. Put Databricks credentials and `DATABRICKS_CONFIG_FILE` here for production rather than only in the provider's `.env` — `init_user_param.sh` is the most reliable channel into the JVM-hosted runtime.

```bash
# /opt/arcgis/server/usr/init_user_param.sh
export DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
export DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
export DATABRICKS_ACCESS_TOKEN=dapi...
# For multi-workspace setups, point the resolver at the shared config file:
export DATABRICKS_CONFIG_FILE=/opt/arcgis/server/usr/.databrickscfg
```

The `.databrickscfg` itself (when used) should live at the path you set above with `chmod 600` and `chown arcgis:arcgis` so only the `arcgis` OS user (the one ArcGIS Server runs as) can read it. Restart ArcGIS Server after editing `init_user_param.sh`.

### Admin token binding: `requestip` vs `referer`

When you call `generateToken`, the `client` parameter decides what the token is bound to. The two practical options:

- **`client=requestip` (recommended).** The token is tied to the IP that requested it. No `Referer` header to manage on any subsequent call — simplest and least error-prone, especially when running curl on the box against `localhost`. This is what [Step 4](#4-package-and-register-provider) uses.
- **`client=referer`.** The token is tied to a referer URL, and *every* subsequent `/arcgis/admin/...` call must send a `Referer` header that matches the `referer=` value you passed at generation time. Any mismatch returns `HTTP 498 — "Invalid token, ClientID does not match"`, or a JSON error object with no `token` key (which breaks `json.load(...)["token"]` parsing). Use this only if your environment can't rely on a stable request IP.

```bash
# requestip — token bound to your IP, no Referer header needed anywhere
TOKEN=$(curl -sk -X POST 'https://localhost:6443/arcgis/admin/generateToken?f=json' \
  --data-urlencode 'username=siteadmin' \
  --data-urlencode 'password=...' \
  --data-urlencode 'client=requestip' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# subsequent calls just pass the token — no Referer required
curl -sk "https://localhost:6443/arcgis/admin/services?token=$TOKEN&f=json"
```

```bash
# referer alternative — the referer= value AND the Referer header on every call must agree
TOKEN=$(curl -sk -X POST 'https://your-server:6443/arcgis/admin/generateToken?f=json' \
  -H 'Referer: https://your-server:6443' \
  --data-urlencode 'username=siteadmin' \
  --data-urlencode 'password=...' \
  --data-urlencode 'client=referer' \
  --data-urlencode 'referer=https://your-server:6443' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# EVERY subsequent admin call must then repeat the matching Referer header
curl -sk -H "Referer: https://your-server:6443" \
  "https://your-server:6443/arcgis/admin/services?token=$TOKEN&f=json"
```

## 6. Create your first Feature Service

> **Agent shortcut:** the [MCP server's](#7-agent-driven-publishing-mcp-server) `publish_layer` tool does everything in this section from one sentence — it inspects the table, derives all service parameters (geometry column/format, SRID, a validated id field), creates the service, and smoke-tests it live.

In [Step 4](#4-package-and-register-provider) you registered the provider — that was a one-time install. **This step is what you do every time you want to expose a new Databricks table as a Feature Service**: a separate REST call per table, against a different admin endpoint (`/createService` instead of `/customdataproviders/register`). Each service points at one table via service parameters, and the presence of `lakebaseHost` determines which backend (Lakehouse or Lakebase) is used.

> **Before you start — your source table must satisfy:**
>
> - **`idField` is an integer column with unique values in the range 0 – 2,147,483,647.** ArcGIS uses this as OBJECTID. Both INT and BIGINT work (Databricks BIGINT is read back as a string and cast to a number).
> - **Geometry uses `lon lat` order** (the GIS standard). If you store WKT, write `POINT(lon lat)`, not `POINT(lat lon)`.
> - **Lakehouse only**: table name must be fully qualified (`catalog.schema.table`), and the SQL warehouse must be running (serverless adds a ~5–15s cold-start to the first query).
> - **Lakebase only**: the geometry column is native PostGIS geometry.
>
> If your source table has only `latitude` / `longitude` columns instead of a geometry column, see [Working with Existing Tables](#working-with-existing-tables) for the view pattern.

### Lakehouse Service Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `workspace` | No | env-default | Profile name from `.databrickscfg` (see [Multiple Workspaces or OAuth M2M](#multiple-workspaces-or-oauth-m2m)). If empty, uses `DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN` env vars. |
| `warehouseHttpPath` | No | `DATABRICKS_HTTP_PATH` env | SQL warehouse HTTP path (e.g. `/sql/1.0/warehouses/abc123`). Override per-service if you have multiple warehouses. |
| `tableName` | Yes | - | Fully qualified table name (`catalog.schema.table`) |
| `geometryColumn` | No | `geometry` | Name of the geometry column |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `geometryFormat` | No | auto-detect | `WKT`, `WKB`, `GEOJSON`, or `GEOMETRY` (native). See [Geometry Support](#geometry-support) for when you need to set this explicitly. |
| `timeColumn` | No | - | Timestamp column for time-aware queries |
| `maxRecordCount` | No | `2000` | Max features returned per page (clients can request fewer) |
| `srid` | No | `4326` | EPSG SRID of the geometry column |

### Lakebase Service Parameters

Setting `lakebaseHost` routes a service to Lakebase instead of Lakehouse.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `workspace` | No | env-default | Profile name from `.databrickscfg` — see [Multiple Workspaces or OAuth M2M](#multiple-workspaces-or-oauth-m2m). Determines which workspace mints Lakebase OAuth tokens. |
| `lakebaseHost` | Yes | - | Lakebase instance hostname |
| `lakebasePort` | No | `5432` | PostgreSQL port |
| `lakebaseDatabase` | Yes | - | Database name |
| `lakebaseSchema` | No | `public` | PostgreSQL schema |
| `lakebaseTable` | Yes | - | Table name |
| `geometryColumn` | No | `geometry` | Geometry column (PostGIS native) |
| `idField` | No | `id` | Integer primary key column (used as OBJECTID) |
| `maxRecordCount` | No | `2000` | Max features returned per page (clients can request fewer) |
| `srid` | No | `4326` | EPSG SRID of the geometry column |
| `editingEnabled` | No | `false` | Set to `true` to enable applyEdits (also requires `capabilities: "Query,Editing"`) |

Editing is enabled at the provider level (`editingEnabled: true` in [`cdconfig.json`](nodejs-provider/cdconfig.json)). To actually expose editing on a service, set `"capabilities": "Query,Editing"` and `"editingEnabled": "true"` in the `createService` call. Lakebase services work for read-only use cases too — just set `"capabilities": "Query"`.

### Examples

Create services via the **Admin REST API** (`createService` endpoint). All service parameters from `cdconfig.json` must be included — use empty strings for parameters that don't apply.

> **Note:** There is no `cdf create-service` CLI command. Services are created through the Admin REST API or the ArcGIS Server Admin Directory UI. Services may be created in a STOPPED state — start them via the Admin API (`services/<name>.FeatureServer/start`) or the ArcGIS Server Manager UI.

#### Lakehouse service (read-only)

```bash
curl -k "https://localhost:6443/arcgis/admin/services/createService?token=$TOKEN&f=json" \
  --data-urlencode 'service={
    "serviceName": "MyCellTowers",
    "type": "FeatureServer",
    "capabilities": "Query",
    "provider": "CUSTOMDATA",
    "clusterName": "default",
    "minInstancesPerNode": 0, "maxInstancesPerNode": 0,
    "instancesPerContainer": 1,
    "configuredState": "STARTED",
    "properties": {"disableCaching": "true"},
    "jsonProperties": {
      "customDataProviderInfo": {
        "dataProviderName": "databricks-geospatial-provider",
        "serviceParameters": {
          "workspace": "",
          "warehouseHttpPath": "",
          "tableName": "catalog.schema.us_cell_towers",
          "geometryColumn": "geometry",
          "idField": "id",
          "geometryFormat": "WKT",
          "timeColumn": "",
          "lakebaseHost": "",
          "lakebasePort": "",
          "lakebaseDatabase": "",
          "lakebaseSchema": "",
          "lakebaseTable": "",
          "maxRecordCount": "2000",
          "srid": "4326",
          "editingEnabled": ""
        }
      }
    }
  }'
```

#### Lakebase service (read + write)

```bash
curl -k "https://localhost:6443/arcgis/admin/services/createService?token=$TOKEN&f=json" \
  --data-urlencode 'service={
    "serviceName": "CellTowersEditable",
    "type": "FeatureServer",
    "capabilities": "Query,Editing",
    "provider": "CUSTOMDATA",
    "clusterName": "default",
    "minInstancesPerNode": 0, "maxInstancesPerNode": 0,
    "instancesPerContainer": 1,
    "configuredState": "STARTED",
    "properties": {"disableCaching": "true"},
    "jsonProperties": {
      "customDataProviderInfo": {
        "dataProviderName": "databricks-geospatial-provider",
        "serviceParameters": {
          "workspace": "",
          "warehouseHttpPath": "",
          "tableName": "",
          "geometryColumn": "geometry",
          "idField": "id",
          "geometryFormat": "",
          "timeColumn": "",
          "lakebaseHost": "instance-xxx.database.cloud.databricks.com",
          "lakebasePort": "5432",
          "lakebaseDatabase": "geospatial",
          "lakebaseSchema": "public",
          "lakebaseTable": "cell_towers",
          "maxRecordCount": "2000",
          "srid": "4326",
          "editingEnabled": "true"
        }
      }
    }
  }'
```

### How Routing Works

The provider routes automatically — no configuration needed beyond service parameters:

```
getData(req) → lakebaseHost set? → YES: PostgreSQL path / NO: Databricks SQL path
editData(req) → Always Lakebase (Lakehouse is read-only)
```

---

> ### Installation complete
>
> With the provider registered and at least one Feature Service created, you have a working deployment. **Everything below this point is reference material** — supported query parameters, performance benchmarks, geometry format details, environment-variable reference, and troubleshooting. Skim or skip ahead as needed.

---

## 7. Agent-driven publishing (`mcp-server/`)

An MCP server that turns provider setup **and** per-layer publishing (sections 3–6) into a conversation. Instead of hand-building `createService` JSON, an agent inspects the Unity Catalog table (geometry column/format, SRID, int32-safe unique id, time column — all derived automatically), publishes it as a feature service, smoke-tests it live, and returns the FeatureServer URL. Given a built `.cdpk`, it also installs and upgrades the provider itself — with environment config **baked into the package**, so the ".cdpk update wiped my `.env`" failure mode (section 6 warning) can't happen.

### Quickstart (local, Claude Code / Claude Desktop)

```bash
cd mcp-server && npm install

# One-time, per GIS environment — validates credentials before saving (~/.cdf-mcp/targets.json, 0600)
node bin/cli.js register-target my-gis \
  --admin-url https://gis.example.com:6443/arcgis/admin --user siteadmin \
  --databricks-profile DEFAULT --warehouse-id <sql-warehouse-id> [--allow-self-signed]

# Register with Claude Code
claude mcp add databricks-cdf -- node /path/to/esri-customdatafeed/mcp-server/bin/cli.js serve
```

Then: *"publish catalog.schema.my_table to my-gis"* — or *"why can't I publish this table?"* (inspection reports blocking problems with the fix named).

### Tools

| Tool | What it does |
|------|--------------|
| `list_gis_targets` | Registered ArcGIS targets (credentials never shown) |
| `test_connectivity` | Mints an ArcGIS admin token + probes the SQL warehouse |
| `provider_status` | Is the CDF `.cdpk` registered, version, editing enabled |
| `register_provider` | Install/upgrade the provider from a `.cdpk` — optional rename (side-by-side installs) and env baking; upgrades need `update: true` + `confirm` |
| `unregister_provider` | Remove a provider — refuses while any service still uses it, or if any service can't be verified |
| `inspect_table` | DESCRIBE + sampling → derived service parameters + validation report |
| `create_publish_view` | Fix-up view with a `ROW_NUMBER()` int32 `objectid` for tables that fail id validation |
| `publish_layer` | Inspect → createService → wait for START → live smoke test → FeatureServer URL (`dryRun` supported) |
| `list_layers` | Feature services with backing Databricks table attribution |
| `unpublish_layer` | Delete a service — refuses non-CDF services, requires `confirm: true` |

### Security model

- **Credentials never pass through chat or tool arguments.** Tools accept a target *name*; passwords resolve server-side from `env:VAR` or `secret:scope/key` references. Unknown targets fail with "an operator must register it" — by design.
- **Zero-touch registration for teams:** back the registry with a Databricks secret scope (`CDF_MCP_SECRET_SCOPE`) — each key is a target name whose value is the target JSON. Anyone with `WRITE` on the scope registers a GIS server via `databricks secrets put-secret`, from anywhere; the running server picks it up within a minute. Who may *call* the tools is governed by Unity Catalog (`USE CONNECTION`) in hosted mode.
- **Hosted mode** enforces a bearer token on every request and should sit behind TLS.
- The ArcGIS admin token is minted short-lived per operation and never returned.

### Hosted mode (Databricks Playground / Genie / Agent Bricks)

Run `serve --transport http --port <port>` as a service (systemd unit, TLS reverse proxy) and register it as a [UC HTTP connection / external MCP server](https://docs.databricks.com/aws/en/generative-ai/mcp/external-mcp). Hard requirements learned from real deployment testing:

1. **The endpoint must present HTTPS on port 443** — Databricks serverless egress does not connect to other ports. Self-signed certificates are accepted. Standard patterns: a reverse proxy on 443 on the MCP host; your org's existing load balancer/API gateway routing by hostname; or (production, locked-down environments) an **NCC private endpoint + NLB** mapping 443 to the service.
2. **Serverless egress policy must permit the destination.** In environments with restricted egress (SEG), arbitrary self-hosted endpoints are dropped regardless of port — an admin must allowlist the FQDN in the serverless network policy or provision the NCC private endpoint. Verify with a `http_request()` probe against the connection before debugging anything else.
3. Where Databricks Apps have open egress, hosting the MCP server as an app named `mcp-*` is the zero-infrastructure alternative (Playground discovers it natively).

Classic (non-serverless) compute reaches the server with none of these constraints — useful for notebook-based agents and for isolating egress-policy issues from server issues.

See [`mcp-server/README.md`](mcp-server/README.md) for the full operator runbook (systemd unit, reverse proxy, `CREATE CONNECTION` SQL, Playground attach steps).

## Supported Operations

### Query (both backends)

Standard ArcGIS REST API query parameters:

- `where` — SQL WHERE clause filtering
- `objectIds` — Query specific features by ID
- `geometry` + `spatialRel` — Spatial queries (intersects, contains, within, crosses, overlaps, touches)
- `outFields` — Field selection
- `resultRecordCount` + `resultOffset` — Pagination
- `orderByFields` — Sorting
- `returnCountOnly` — Count queries
- `returnGeometry` — Include/exclude geometry

#### Lakehouse-only query features

- `returnDistinctValues` — Unique values
- `time` — Time range filter (requires `timeColumn` service parameter)
- Multiple geometry formats (WKT, WKB, GeoJSON, native GEOMETRY)

### Editing (Lakebase only)

Full `applyEdits` support:

| Operation | Description |
|-----------|-------------|
| **Add** | Insert features with auto-generated IDs (`RETURNING id`) |
| **Update** | Modify attributes and/or geometry by OBJECTID |
| **Delete** | Remove features by OBJECTID (with per-row failure reporting) |

Transaction support: set `rollbackOnFailure=true` to wrap all operations in a single PostgreSQL transaction.

---

## Performance: Lakebase vs Lakehouse

Benchmark on 17M Overture Maps Places (Point features), warm averages (2 warm runs after 1 cold), measured end-to-end through ArcGIS Server REST API:

| Query Type | Lakebase | Lakehouse | Speedup |
|---|---|---|---|
| Spatial: city block (~1k features) | **120 ms** | 3,566 ms | **29.7x** |
| Spatial: DC metro (~2k features) | **152 ms** | 4,466 ms | **29.4x** |
| Spatial: LA metro (~2k features) | **130 ms** | 2,643 ms | **20.3x** |
| Spatial count (DC metro) | **185 ms** | 2,197 ms | **11.9x** |
| objectIds lookup (5 features) | **32 ms** | 357 ms | **11.2x** |
| Attribute: name LIKE '%Starbucks%' | **47 ms** | 499 ms | **10.6x** |
| Spatial + WHERE filter | **112 ms** | 928 ms | **8.3x** |
| COUNT (full table) | 636 ms | **150 ms** | Lakehouse 4.2x faster |

**Key takeaways:**
- **Lakebase is 8-30x faster** for spatial queries thanks to PostGIS GIST indexes (row-level R-tree pruning vs Lakehouse file-level scanning).
- **All Lakebase queries are sub-200ms** (32-185 ms), making the service fully interactive for map rendering and pan/zoom.
- **COUNT is the one case Lakehouse wins** — columnar statistics enable instant aggregation without scanning rows.

Config: Lakebase CU_4 with GIST index, Lakehouse Large Serverless SQL Warehouse (Z-ordered), ArcGIS Server 12.0 on m5.xlarge (us-east-1).

---

## Spatial Functions — Backend Differences

| Spatial Relation | Lakehouse (Databricks SQL) | Lakebase (PostGIS) |
|-----------------|----------------------------|---------------------|
| Intersects | `ST_Intersects` | `ST_Intersects` |
| Contains | `ST_Contains` | `ST_Contains` |
| Within | `ST_Within` | `ST_Within` |
| Touches | `ST_Touches` | `ST_Touches` |
| Overlaps | DE-9IM workaround (5 functions) | `ST_Overlaps` (native) |
| Crosses | DE-9IM workaround (7 functions) | `ST_Crosses` (native) |

Lakebase/PostGIS has all 6 spatial predicates natively with GIST index support. Databricks SQL lacks native `ST_Overlaps` and `ST_Crosses`, so the provider implements DE-9IM equivalents. See [`geometry.js`](nodejs-provider/src/modules/geometry.js) for details.

---

## Geometry Support

All geometry types work: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.

**Lakehouse** supports four storage formats. Pick based on what your table already has — if you're designing a new table, prefer native `GEOMETRY`.

| Format | Storage | Example | When to use |
|--------|---------|---------|-------------|
| `GEOMETRY` *(recommended for new tables)* | Native GEOMETRY column | (native) | Fastest at scale — no string parsing. Use this if your Databricks runtime supports native geometry. |
| `WKB` | BINARY column | hex bytes | Good production choice when native `GEOMETRY` isn't available. Compact and fast. |
| `WKT` | STRING column | `POINT(-77.03 38.90)` | Human-readable, easy to debug. Common in demo data and required for Lakebase Synced Tables. Has measurable parse overhead at large scale. |
| `GEOJSON` | STRING column | `{"type":"Point",...}` | Useful when JSON tooling already produces it. |

**How format detection works** (in priority order):

1. **Explicit `geometryFormat` service parameter** — always wins. Recommended for production: it's unambiguous and skips the probe below.
2. **Column-name hints** — a column named like `geometry_wkt` → WKT, `geom_wkb` → WKB, `geojson_col` → GeoJSON.
3. **Schema probe** — for generically-named columns (like `geometry`), the provider runs `DESCRIBE TABLE` once and maps the column type: `STRING` → WKT, `BINARY` → WKB, anything else → native GEOMETRY. The result is cached for the process lifetime.

**The one case where you MUST set `geometryFormat` explicitly:** GeoJSON stored in a generically-named STRING column — the schema probe sees `STRING` and guesses WKT. Set `geometryFormat: "GEOJSON"` on the service.

**Lakebase** uses native PostGIS geometry only — no `geometryFormat` configuration needed.

---

## Environment Variables

Set these in your `.env` file, or in `init_user_param.sh` on ArcGIS Server. Per-table settings (`tableName`, `geometryColumn`, `idField`, etc.) are NOT set here — they're configured per-service via `createService`.

| Variable | Description |
|----------|-------------|
| **Databricks Connection (required for Lakehouse)** | |
| `DATABRICKS_SERVER_HOSTNAME` | Workspace hostname |
| `DATABRICKS_HTTP_PATH` | SQL Warehouse HTTP path |
| `DATABRICKS_ACCESS_TOKEN` | Personal Access Token (PAT) — generate at Settings > Developer > Access tokens |
| **Lakebase Connection (optional)** | |
| `LAKEBASE_PASSWORD` | OAuth token or password (auto-generated from PAT if omitted) |
| `LAKEBASE_USER` | Username (default: `databricks`) |
| `LAKEBASE_INSTANCE_NAME` | Instance name override (skips hostname→name lookup) |
| **Multi-Workspace (optional)** | |
| `DATABRICKS_CONFIG_FILE` | Path to `.databrickscfg` with named workspace profiles (default: `~/.databrickscfg`) |
| **Query Defaults** | |
| `DATABRICKS_MAX_RECORD_COUNT` | Max features per page (default: `2000`) |
| `DATABRICKS_QUERY_TIMEOUT` | Query timeout in ms (default: `120000`) |
| `DATABRICKS_SRID` | Default SRID when a service doesn't set `srid` (default: `4326`) |
| **Connection Pool Tuning** | |
| `DATABRICKS_POOL_MIN` / `DATABRICKS_POOL_MAX` | Lakehouse pool size (default: `2` / `10`) |
| `LAKEBASE_POOL_MIN` / `LAKEBASE_POOL_MAX` | Lakebase pool size (default: `2` / `10`) |
| `LAKEBASE_SSL_VERIFY` | Set to `true` to verify Lakebase SSL certs (default: `false`) |
| **Security** | |
| `ENABLE_USER_AUTH` | Set to `true` to require ArcGIS user authentication |
| `ENABLE_AUDIT_LOG` | Set to `true` to enable query audit logging |
| `DATABRICKS_API_SSL_VERIFY` | TLS verification on Databricks REST calls (token minting, Lakebase credentials). Verified by default — set to `false` only behind a TLS-intercepting proxy |

---

## Working with Existing Tables

**Your table already has geometry data in some column** — use it directly. Point the service's `geometryColumn` at that column. Any of the supported formats work: native `GEOMETRY`, WKT or GeoJSON in a STRING column, or WKB in a BINARY column. If the column name doesn't make the format obvious, also set `geometryFormat` — see [Geometry Support](#geometry-support).

**Your table has only `latitude` / `longitude` columns** (no geometry column at all) — create a view that builds one from the coordinates, then point your Feature Service at the view:

```sql
-- Lakehouse (Databricks SQL)
CREATE VIEW catalog.schema.my_table_geo AS
SELECT *, ST_Point(longitude, latitude) AS geometry
FROM catalog.schema.my_table
WHERE latitude IS NOT NULL;

-- Lakebase (PostGIS)
CREATE VIEW public.my_table_geo AS
SELECT *, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) AS geometry
FROM public.my_table
WHERE latitude IS NOT NULL;
```

Then create your Feature Service with `tableName` (or `lakebaseTable`) set to `my_table_geo` instead of the source table.

---

## Troubleshooting

<details>
<summary><b>First, sanity-check the install state on the ArcGIS Server box</b></summary>

Before debugging a specific symptom, confirm the registered provider, env vars, and `.databrickscfg` look right. Most issues fall out from one of these being misconfigured. The provider files are owned by the `arcgis` OS user, so SSH in and run with `sudo`:

```bash
sudo bash -c '
echo "=== Provider dir (this is what ArcGIS Server actually runs) ==="
ls -la /opt/arcgis/server/framework/runtime/customdata/providers/databricks-geospatial-provider/

echo ""
echo "=== Provider .env (redacted) ==="
[ -f /opt/arcgis/server/framework/runtime/customdata/providers/databricks-geospatial-provider/.env ] \
  && sed -E "s/(TOKEN|PASSWORD|SECRET) *= *.+/\1=<REDACTED>/g" \
       /opt/arcgis/server/framework/runtime/customdata/providers/databricks-geospatial-provider/.env \
  || echo "(no .env file)"

echo ""
echo "=== init_user_param.sh (redacted) ==="
sed -E "s/(TOKEN|PASSWORD|SECRET) *= *.+/\1=<REDACTED>/g" /opt/arcgis/server/usr/init_user_param.sh 2>/dev/null

echo ""
echo "=== .databrickscfg profiles (redacted) ==="
sed -E "s/(token|client_secret) *= *.+/\1 = <REDACTED>/g" /opt/arcgis/server/usr/.databrickscfg 2>/dev/null

echo ""
echo "=== Most recent server log lines mentioning Custom_data_feeds ==="
ls -t /opt/arcgis/server/usr/logs/*/server/server-*.log 2>/dev/null | head -1 \
  | xargs grep -E "Custom_data_feeds|Pool " 2>/dev/null | tail -10
'
```

This dumps everything that matters — provider directory contents, env vars, multi-workspace profiles, and the last few Custom_data_feeds log lines — with secrets redacted, in one command.

</details>

**Register/update fails: `Failed to start '/opt/arcgis/.../customdata/app/src/index.js'`**
- Tail the server log for the real module error. If it shows `Cannot find module '../adapters/process.env'`, your `.cdpk` was built with an overbroad exclude (e.g. `-x '*.env*'`) that stripped `node_modules` files whose names contain `.env`. Rebuild with the exact excludes from [Step 4(a)](#4-package-and-register-provider): `-x '.env' '.env.*' 'test/*' '*.md'`.
- **A failed `update` deletes the live provider directory** and your CDF services 404 until a good package is in. Upload a correctly-built `.cdpk` and run `update` again, then recreate `.env` and restart.

**Service won't start / "Provider not found" / "UNABLE_TO_GET_JNDI_NAME"**
- Verify the `.cdpk` was registered (check ArcGIS Server Manager → Site → Extensions).
- Confirm `dataProviderName` in the service JSON matches the registered provider name exactly.
- **Native module mismatch**: if you built `node_modules` on a different OS than the ArcGIS Server (e.g., macOS → Linux), the provider will fail to load. Run `npm install` on the ArcGIS Server box itself.
- Check ArcGIS Server logs (typically `/opt/arcgis/server/usr/logs/<machine>/server/server-*.log` on Linux).

**Service shows STARTED in admin but `HTTP 404 — Service not found` from REST**
- Provider initialization failed silently after the admin layer started the service. Tail the server log and look for `Custom_data_feeds` lines — common culprits are a missing/expired credential, a `.databrickscfg` profile name that doesn't match, or an unreachable warehouse.

**`HTTP 498 — "Invalid token, ClientID does not match"` on admin REST calls**
- You minted the token with `client=referer` but a subsequent admin call sent a missing or mismatched `Referer` header — every call must repeat `-H "Referer: https://your-server:6443"` matching the `referer=` value you passed at generation time. The simplest fix is to mint the token with `client=requestip` instead, which has no `Referer` requirement at all. See [Admin token binding: `requestip` vs `referer`](#admin-token-binding-requestip-vs-referer).

**`HTTP 403` on first query — telling the two flavors apart**
- `Source IP address X is blocked by Databricks IP ACL` → the workspace's IP access list doesn't include the ArcGIS Server's outbound IP. Fix in the Databricks account console (Workspaces → your workspace → IP access lists). See [Prerequisites](#prerequisites).
- `Invalid access token` → the PAT (or service-principal credentials) is expired, revoked, or wrong. Generate a fresh one in Databricks and update the `.env` or `.databrickscfg` entry. Restart ArcGIS Server so the cached value is replaced.

**Connection times out or "no route to host" / `ECONNREFUSED` / `ETIMEDOUT`**
- A firewall is blocking the outbound port to Databricks (not the same as an IP allowlist 403). Confirm the ArcGIS Server's network can reach Databricks on `443` (SQL warehouse + REST API) and, if you're using Lakebase, also on `5432` (PostgreSQL). See [Prerequisites](#prerequisites) for the port table.

**Updated `.databrickscfg` but the new profile or token isn't being used**
- The provider caches `.databrickscfg` at first read. **Restart ArcGIS Server** any time you edit the file. (Same applies to changes in `init_user_param.sh`.)

**No data returned (empty features array)**
- Lakehouse: test the SQL warehouse connection independently (e.g. via the Databricks UI or `databricks sql`).
- Lakebase: verify auto-generated token minting works, or check `LAKEBASE_PASSWORD` if you set it manually.
- Confirm the fully-qualified table name and the geometry column name are correct.

**OBJECTID issues / features missing**
- The `idField` column must be an integer type. Databricks BIGINT comes back as a string and is cast to a number — values must fit in a 32-bit signed integer (≤ 2,147,483,647).

**Editing fails (Lakebase)**
- Confirm `capabilities: "Query,Editing"` AND `editingEnabled: "true"` were both set during `createService`.
- Confirm `lakebaseHost` is in the service parameters (editing only works via Lakebase, not Lakehouse).
- Check Lakebase auth: token may have expired (auto-refresh fails if the underlying PAT is dead).
- ArcGIS Server 12.0+ is required for the `editData()` interface.
- **Authorization**: on standalone ArcGIS Server, the built-in `ADMINISTER` and `PUBLISH` privileges both allow editing (no extra setup). On federated ArcGIS Enterprise (Portal), the user's Portal role needs the "Edit features" privilege.

**Query is slow**
- Lakehouse: the first query after warehouse idle is slow due to cold-start (5–15s for serverless).
- Lakehouse: add Z-ordering on the geometry column: `OPTIMIZE table ZORDER BY (geometry_column)`.
- Lakebase: add a GIST index: `CREATE INDEX ON table USING GIST (geometry_column)`.

## Known Limitations

### Lakebase Synced Tables: GEOMETRY/GEOGRAPHY types not supported

Databricks [Synced Tables](https://docs.databricks.com/aws/en/oltp/instances/sync-data/sync-table) (reverse ETL from Unity Catalog to Lakebase) do not support GEOMETRY or GEOGRAPHY column types. The sync will fail if the source table contains these types.

**Workaround:** Store geometry as WKT strings (type STRING) in your source Delta Lake table. STRING maps to TEXT in PostgreSQL and syncs without issues. Once in Lakebase, convert to native PostGIS geometry at query time or via a generated column:

```sql
-- Option A: Convert at query time
SELECT *, ST_GeomFromText(geometry_wkt, 4326) AS geom FROM my_table;

-- Option B: Add a generated column after sync (requires a separate editable table)
ALTER TABLE my_table ADD COLUMN geom GEOMETRY(Point, 4326)
  GENERATED ALWAYS AS (ST_GeomFromText(geometry_wkt, 4326)) STORED;
CREATE INDEX ON my_table USING GIST (geom);
```

This limitation only affects Synced Tables (Databricks → Lakebase sync). Tables created directly in Lakebase with PostGIS geometry columns work fine — the provider's Lakebase backend uses native PostGIS geometry for all queries and editing.

**Full supported type mapping:** [Lakebase Instances docs](https://docs.databricks.com/aws/en/oltp/instances/sync-data/sync-table) | [Lakebase Projects docs](https://docs.databricks.com/aws/en/oltp/projects/reverse-etl)

## Appendix: Why three config files?

*Not required reading for installation — skip unless you're curious about the design or troubleshooting where credentials should live.*

The provider can read credentials from three places. Each fits a different stage of a deployment's life:

| File | Best used for | Why |
|---|---|---|
| `.env` in the provider directory | Local dev / quick setup | Easy to edit and reload. Loaded from an explicit path by the provider's own dotenv call — always finds it. |
| `~/.databrickscfg` (or path in `DATABRICKS_CONFIG_FILE`) | Multi-workspace and/or OAuth M2M | Standard Databricks config file (same one the CLI, dbt, Asset Bundles use). INI sections naturally represent multiple workspaces — something `.env`'s flat key=value can't do. |
| `init_user_param.sh` | Production | Set once at ArcGIS Server startup; survives provider re-registration and avoids collisions if more than one CDF provider runs on the same server. |

**Why both `.env` and `.databrickscfg`?** `.env` is flat key=value, so it can't represent multiple workspaces (no way to have two `DATABRICKS_SERVER_HOSTNAME` values). `.databrickscfg` has named sections, which solves that. Single-workspace installs can use either; multi-workspace installs need `.databrickscfg`.

**Why does `.env` "just work" but `.databrickscfg` needs `DATABRICKS_CONFIG_FILE` set explicitly?** The provider loads `.env` from a known path relative to its own source directory (`<provider>/../.env`), so it always finds it. `.databrickscfg` defaults to `~/.databrickscfg` to match the Databricks ecosystem convention — but on ArcGIS Server, `~` is the home directory of the `arcgis` OS user, which usually isn't set up. The `DATABRICKS_CONFIG_FILE` env var is the standard escape hatch (the Databricks CLI uses the same one).

**Why prefer `init_user_param.sh` over `.env` for production?** Three reasons:

1. `.env` lives *inside* the provider directory. The `.cdpk` extraction overwrites the directory on every re-registration, taking `.env` with it. `init_user_param.sh` lives outside the provider tree and survives.
2. If you ever run a second CDF provider on the same ArcGIS Server, both share `process.env`. Each provider's dotenv call into its own `.env` can collide. Vars set in `init_user_param.sh` are set once at JVM startup — no collisions.
3. `.env` is only read by the provider's startup code via dotenv. Anything that needs env vars before the provider boots won't see them. `init_user_param.sh` sets vars at the JVM level, so they're universally visible.

## Running the unit tests

These are the provider's own unit tests (mocha + chai) — they exercise the SQL builders, geometry handling, sanitization, and workspace resolver in isolation, **not** your live deployment. Useful if you're modifying the source or want to verify nothing's broken before packaging a `.cdpk`.

```bash
cd esri-customdatafeed/nodejs-provider
npm test
# 350 passing
```

## License

MIT
