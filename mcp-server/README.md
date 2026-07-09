# databricks-cdf-mcp

An MCP server that publishes Databricks Unity Catalog tables as ArcGIS feature services
through the [Custom Data Feed provider](../README.md) — from a conversation with Claude
(or Databricks Playground) instead of hand-run publishing workflows.

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

## Hosted (streamable HTTP) mode

### 1. Service setup

The **MCP host** is whatever machine runs the server — any host with HTTPS reach to the
ArcGIS admin API and to Databricks. It does not have to be the ArcGIS Server, though
co-locating there is often simplest (it sidesteps the port-443/egress hop). Copy the code
to it and install production dependencies:

```bash
rsync -a --exclude node_modules mcp-server/ /opt/cdf-mcp/ && cd /opt/cdf-mcp && npm install --omit=dev
```

Generate a bearer token (any long random string; this is what Databricks presents to
authenticate to the server):

```bash
openssl rand -hex 32    # prints a 64-char hex string — copy it into the file below
```

Create `/opt/cdf-mcp/.env.service` with the following, then lock it down since it holds
secrets (`chmod 600 /opt/cdf-mcp/.env.service`):

```bash
CDF_MCP_BEARER_TOKEN=<paste the openssl output here>   # transport auth — required in http mode
CDF_MCP_TARGETS_FILE=/opt/cdf-mcp/targets.json         # or CDF_MCP_SECRET_SCOPE=gis-targets
DATABRICKS_CONFIG_FILE=/opt/cdf-mcp/.databrickscfg
ARCGIS_ADMIN_PASSWORD=<...>                            # only if targets use env: refs
```

systemd unit (`/etc/systemd/system/cdf-mcp.service`). `User=` is the OS account the
service runs as — use a dedicated low-privilege user (e.g. `sudo useradd -r -s
/usr/sbin/nologin cdfmcp`) or an existing service account; it just needs read access to
the files above (on the ArcGIS box, the `arcgis` user is a reasonable choice):

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

Apply the same `chmod 600` to `targets.json` and `.databrickscfg` if they live on this host.

Gotcha: the service user (`User=` in the unit) must be able to read every file referenced
here — a root-owned `.databrickscfg` silently yields "profile not found: available (none)".

### 2. Secret-scope-backed registry (recommended — no host access needed to add targets)

Set `CDF_MCP_SECRET_SCOPE=gis-targets`. Each key in the scope is a target name; its value
is the target JSON:

```bash
databricks secrets create-scope gis-targets
databricks secrets put-secret gis-targets dod-cop --string-value \
  '{"adminUrl":"https://gis.example.com:6443/arcgis/admin","user":"siteadmin",
    "password":"...","allowSelfSigned":true,
    "databricks":{"profile":"DEFAULT","warehouseId":"<id>"}}'
```

The server re-reads the scope on a 60 s TTL — new targets appear without a restart.
Gate registration with scope ACLs (`WRITE`), tool usage with `USE CONNECTION` grants.

### 3. TLS on port 443 (hard requirement for serverless callers)

Databricks serverless egress **only connects to port 443**; self-signed certificates are
accepted. Minimal Caddy front (`caddy run --config /etc/caddy/Caddyfile`):

```
https://<mcp-host-fqdn>:443 {
	tls internal
	reverse_proxy 127.0.0.1:8090
}
```

Equivalent patterns: your org's existing LB/API-gateway routing by hostname, or an NCC
private endpoint + NLB (production; see below). Scope host-firewall ingress to the
[published Databricks serverless outbound CIDRs](https://www.databricks.com/networking/v1/ip-ranges.json)
for your region rather than 0.0.0.0/0.

### 4. Egress policy (the step that actually gates Playground)

In workspaces with restricted serverless egress, connections to self-hosted endpoints are
dropped by policy **regardless of port** — well-known public sites succeeding while your
endpoint times out is the signature. An account admin must either add the MCP FQDN to the
serverless network policy allowlist, or provision an **NCC private endpoint + internal
NLB** (preferred for production/IL environments: the server is never internet-exposed).

Probe before debugging anything else:

```sql
CREATE CONNECTION cdf_gis_mcp TYPE HTTP OPTIONS (
  host 'https://<mcp-host-fqdn>', port '443', base_path '/mcp',
  bearer_token '<CDF_MCP_BEARER_TOKEN>');

SELECT http_request(conn => 'cdf_gis_mcp', method => 'POST', path => '',
  json => '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}',
  headers => map('Accept','application/json, text/event-stream')).text;
```

A JSON-RPC result = fully wired. `REMOTE_FUNCTION_HTTP_RETRY_TIMEOUT`/503 = egress policy
(step 4); connection-refused/cert errors = TLS front (step 3).

### 5. Attach in Playground

`GRANT USE CONNECTION ON CONNECTION cdf_gis_mcp TO <group>`, then in **AI Playground →
Tools → + Add tool → MCP Servers → External MCP servers**, pick the connection. Tools are
discovered automatically. The same connection works programmatically in Agent Bricks /
Multi-Agent Supervisor.

### Alternatives that skip all of the above

- **Databricks App hosting** (workspaces with open app egress): deploy this server as an
  app named `mcp-*` with streamable HTTP — Playground discovers it natively, OAuth handled
  by the platform.
- **Classic compute** (notebooks/jobs): reaches the server on any port with a plain HTTP
  client — no 443 requirement, no egress policy. Stateless HTTP mode means raw
  `requests.post` JSON-RPC works without an MCP client library.

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
