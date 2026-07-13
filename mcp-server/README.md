# databricks-cdf-mcp

![status: Beta](https://img.shields.io/badge/status-Beta-yellow)

An MCP server that publishes Databricks Unity Catalog tables as ArcGIS feature services
through the [Custom Data Feed provider](../README.md) — from a conversation with Claude
(or Databricks Playground) instead of hand-run publishing workflows.

**Status: Beta.** The core loop — inspect a table, publish it as a feature service,
manage the provider — is tested end-to-end against a live ArcGIS Server 12.0, from Claude
(stdio) and from Databricks compute. Hosted deployments, editing-service parameters, and
unusual table shapes have seen less mileage. The underlying
[CDF provider](../README.md) is the mature component; this is a newer control layer on
top of it. Issues and feedback welcome.

## Quickstart (local, ~3 steps)

**Prerequisites:** Node 18+, an ArcGIS Server 11.4+ you have admin on, and a Databricks
CLI profile (`databricks auth login …`) with access to a SQL warehouse. The machine
running this needs HTTPS reach to the ArcGIS admin API; it does **not** have to be the
ArcGIS box.

**1. Add the server to your MCP client.**

Claude Code:
```bash
git clone https://github.com/anandtrivedi/esri-customdatafeed.git
cd esri-customdatafeed/mcp-server && npm install
claude mcp add databricks-cdf -- node "$(pwd)/bin/cli.js" serve
```

Claude Desktop (`claude_desktop_config.json` → **Settings → Developer → Edit Config**):
```json
{
  "mcpServers": {
    "databricks-cdf": {
      "command": "node",
      "args": ["/absolute/path/to/esri-customdatafeed/mcp-server/bin/cli.js", "serve"]
    }
  }
}
```

**2. Onboard your ArcGIS Server by asking.** In the client:

> *"Register my ArcGIS server at https://gis.example.com:6443/arcgis/admin (user siteadmin,
> Databricks profile DEFAULT, warehouse abc123) as `my-gis`."*

The agent calls `register_gis_target` and saves everything except the password, then prints
one command to run **once in a terminal** (the password is prompted, never typed into chat):
```bash
cd esri-customdatafeed/mcp-server
node bin/cli.js set-password my-gis
```
Then: *"test connectivity to my-gis"* → the agent confirms ArcGIS + warehouse are reachable.

If the CDF provider isn't installed on that server yet, also ask:
*"install the Databricks provider on my-gis from ./nodejs-provider"* — `register_provider`
builds and registers it (see [Provider lifecycle](#provider-lifecycle)).

**3. Publish.** *"publish `catalog.schema.my_table` to my-gis"* — the agent inspects the
table, derives every service parameter, publishes, smoke-tests, and hands back the
FeatureServer URL.

### Notes

- **Where the password lives:** `set-password` writes it into `~/.cdf-mcp/targets.json`
  (mode 0600) on the machine running the server, and validates it against the admin API
  before saving. It never passes through the model or chat transcript. For shared/hosted
  deployments, use a secret-scope-backed registry instead (below).
- **Full tool reference and security model:** [main README, section 7](../README.md#7-agent-driven-publishing-mcp-server).
- **Databricks auth:** the server uses your `.databrickscfg` profiles. In hosted mode the
  config file must be readable by the service user (a root-owned `.databrickscfg` yields a
  confusing "profile not found: available (none)").

## Hosting for Databricks (Playground / Genie Code / Agent Bricks)

To use the tools from Databricks (not just a local editor), the server has to run
somewhere Databricks can reach. Two ways, easiest first.

### Option A — Deploy as a Databricks App (recommended)

The platform hosts the server, handles TLS, and fronts auth via Databricks Apps
permissions — no VM, no reverse proxy, no bearer token. The app name must start with
`mcp-` so Playground discovers it. `app.yaml` is included in this directory.

```bash
databricks apps create mcp-cdf
databricks sync . /Workspace/Users/<you>/apps/mcp-cdf --exclude node_modules --exclude .git
# bind a SQL warehouse (used for table inspection) as the resource app.yaml expects:
databricks apps update mcp-cdf --json \
  '{"resources":[{"name":"sql-warehouse","sql_warehouse":{"id":"<warehouse-id>","permission":"CAN_USE"}}]}'
databricks apps deploy mcp-cdf --source-code-path /Workspace/Users/<you>/apps/mcp-cdf
```

The app authenticates to Databricks as its own service principal (injected OAuth — no PAT),
and reads GIS targets from a secret scope (set `CDF_MCP_SECRET_SCOPE`, below). Then attach
it: **AI Playground → Tools → MCP Servers → External**, or Genie Code → **Settings → MCP
Servers**. Grant the app's service principal `USE CONNECTION` / workspace access to control
who can call it.

> **Restricted npm proxies:** the build runs `npm install`. If your workspace uses a proxy
> that filters newly published packages (e.g. the FE internal proxy's 7-day window), the
> build can 404 on a recent transitive dependency. This repo pins the known offender
> (`zod-to-json-schema`); if the build still 404s on a package, ask your registry admin to
> mirror it, or use Option B. On workspaces with normal registry access this just works.

> **Egress to the ArcGIS Server:** the publishing tools (`register_provider`,
> `publish_layer`, …) call your ArcGIS admin API. In workspaces with restricted serverless
> egress (SEG), the app can reach Databricks (SQL/inspection works) but not an external
> ArcGIS host until an admin allowlists it or provides an NCC private endpoint. Where app
> egress is open, everything works.

### Option B — Self-host the HTTP server (fallback)

Run the server yourself on any host with HTTPS reach to ArcGIS + Databricks, and register
it as a [UC HTTP connection](https://docs.databricks.com/aws/en/generative-ai/mcp/external-mcp).
Use this when you can't deploy an app (e.g. restricted registry) or need to sit next to an
on-prem ArcGIS Server.

<details>
<summary>Self-hosted runbook (systemd + TLS + UC connection)</summary>

**Service setup.** Copy the code to the host and install production deps:

```bash
rsync -a --exclude node_modules mcp-server/ /opt/cdf-mcp/ && cd /opt/cdf-mcp && npm install --omit=dev
openssl rand -hex 32    # generate a bearer token — paste into the env file below
```

Create `/opt/cdf-mcp/.env.service` (holds secrets — `chmod 600`):

```bash
CDF_MCP_BEARER_TOKEN=<paste the openssl output>   # standalone HTTP transport auth
CDF_MCP_TARGETS_FILE=/opt/cdf-mcp/targets.json     # or CDF_MCP_SECRET_SCOPE=gis-targets
DATABRICKS_CONFIG_FILE=/opt/cdf-mcp/.databrickscfg
ARCGIS_ADMIN_PASSWORD=<...>                         # only if targets use env: refs
```

systemd unit (`/etc/systemd/system/cdf-mcp.service`) — `User=` is a dedicated low-privilege
OS account (`sudo useradd -r -s /usr/sbin/nologin cdfmcp`) that can read the files above:

```ini
[Service]
User=cdfmcp
WorkingDirectory=/opt/cdf-mcp
EnvironmentFile=/opt/cdf-mcp/.env.service
ExecStart=/usr/bin/node bin/cli.js serve --transport http --port 8090
Restart=always
[Install]
WantedBy=multi-user.target
```

Gotcha: a root-owned `.databrickscfg` the service user can't read yields "profile not
found: available (none)".

**TLS on 443.** Databricks serverless egress only connects to 443 (self-signed OK). Front
it with Caddy (`reverse_proxy 127.0.0.1:8090`), your org LB, or an NCC private endpoint +
NLB. Scope host-firewall ingress to the [published serverless outbound CIDRs](https://www.databricks.com/networking/v1/ip-ranges.json).

**UC connection + probe.** Then attach in Playground as in Option A.

```sql
CREATE CONNECTION cdf_gis_mcp TYPE HTTP OPTIONS (
  host 'https://<mcp-host-fqdn>', port '443', base_path '/mcp',
  bearer_token '<CDF_MCP_BEARER_TOKEN>');
SELECT http_request(conn => 'cdf_gis_mcp', method => 'POST', path => '',
  json => '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}',
  headers => map('Accept','application/json, text/event-stream')).text;
```

A JSON-RPC result = wired. `REMOTE_FUNCTION_HTTP_RETRY_TIMEOUT`/503 = egress policy blocks
the host (allowlist the FQDN / use NCC); connection-refused or cert errors = TLS front.
</details>

### GIS targets in hosted mode — secret scope

Both options read targets from a Databricks secret scope (no host filesystem needed). Set
`CDF_MCP_SECRET_SCOPE=gis-targets`; each key is a target name, its value the target JSON:

```bash
databricks secrets create-scope gis-targets
databricks secrets put-secret gis-targets dod-cop --string-value \
  '{"adminUrl":"https://gis.example.com:6443/arcgis/admin","user":"siteadmin",
    "password":"...","allowSelfSigned":true,
    "databricks":{"profile":"DEFAULT","warehouseId":"<id>"}}'
```

Anyone with `WRITE` on the scope adds a target from anywhere; the server picks it up within
a minute.

### Testing without hosting

**Classic (non-serverless) compute** reaches a self-hosted server on any port with a plain
HTTP client — no 443, no egress policy. Stateless HTTP means raw `requests.post` JSON-RPC
works without an MCP client library — the quickest way to exercise the tools and to tell a
server problem from an egress-policy one.

## Provider lifecycle

The `register_provider` and `unregister_provider` tools, verified end-to-end against
ArcGIS Server 12.0 (register → publish through the new provider → in-place update →
unregister, production provider untouched). Operational notes from that testing:

- **Prefer building from source** (`sourcePath` pointing at `nodejs-provider/`): the
  tool runs `npm install --omit=dev` and assembles the zip from an explicit include
  list, so root `.env` files never ship and dependency files whose names contain
  `.env` are never stripped. The dependency tree is pure JavaScript (no native
  binaries), so a package built on any OS runs on the server.
- **Airgapped hosts:** vendor `node_modules` alongside the source and pass
  `skipInstall: true` (a failed install also falls back to existing `node_modules`
  with a warning), or build the `.cdpk` on a connected machine and register it via
  `cdpkPath`. The ArcGIS Server itself never needs npm or internet.
- **Package quality matters** (for hand-built packages). Registration validates the
  `.cdpk` by starting it with the bundled Node runtime; a package built with
  over-broad zip excludes (e.g. `'*.env*'`, which strips
  `@dabh/diagnostics/adapters/process.env.js` out of `node_modules`) fails with
  `Cannot find module '../adapters/process.env'`. The authoritative copy of a working
  package lives in the server's config-store
  (`/opt/arcgis/server/usr/config-store/customdataproviders/*.cdpk`). The
  source-build path checks for that canary file automatically.
- **Bake env into the package** (`envVars` parameter) instead of hand-placing `.env`
  in the provider directory — baked config survives every update; hand-placed `.env`
  is wiped by each one.
- **New provider code loads on ArcGIS Server restart.** Registration succeeds without
  one, but services on a *newly registered* provider return connection errors until
  the server restarts. Registration can take 30–120 s (validation), and a failed
  validation may leave a half-registered entry that ArcGIS cleans up asynchronously —
  wait a minute and retry.
- **Side-by-side installs** (`providerName` rename) are the safe way to test new
  provider builds next to production: services pin to a provider by name, so the
  production provider and its services are never touched.

## Tests

```bash
npm test   # 25 tests: param derivation, payload assembly, registry/credential resolution
```
