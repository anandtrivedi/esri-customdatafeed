# Windows deployment (PowerShell)

Pure-PowerShell ports of the repo's Linux install scripts, for shops running
ArcGIS Server on **Windows**. Runs on **Windows PowerShell 5.1** (the Windows
Server default) and **PowerShell 7+**, with no bash, Python, or WSL required.

## Prerequisites

- ArcGIS Server installed and running **on this box** (11.4+, or 12.0+ for editing).
- A **`.cdpk`** — either a prebuilt one (a release, or your internal artifact repo),
  or build one with **`build-cdpk.ps1`** on a *connected* box (needs npm registry
  access — never build on the ArcGIS Server host). Copy it next to these scripts; one
  `.cdpk` runs on any platform. Disconnected environment? See
  [AIRGAP-INSTALL.md](../AIRGAP-INSTALL.md).
- An **elevated** PowerShell (Run as administrator), opened in this `windows\`
  folder — needed to lock the ACL, set the Machine env var, and restart the service.
- If the scripts came from a zip or file share, unblock them first:
  `Get-ChildItem .\*.ps1 | Unblock-File`. If PowerShell still blocks them (a
  `Restricted` execution policy, common via GPO), run each as
  `powershell.exe -ExecutionPolicy Bypass -File .\configure-databricks.ps1 …` or set
  it for the session with `Set-ExecutionPolicy -Scope Process Bypass`. (Windows
  Server's `RemoteSigned` default is fine once the files are unblocked.)
- Outbound HTTPS (443) from this box to your Databricks workspace host.

## Usage

Run on the box, against the local admin endpoint. Configure **first**, so the
provider sees your credentials the moment the register step restarts the server.
Both scripts prompt for anything not passed (admin password, tokens, secrets —
always read securely) and print `-?` help.

```powershell
# 1) Configure the Databricks connection.
#    Omit -AuthMode to be prompted: 1) PAT  2) OAuth M2M (service principal).
.\configure-databricks.ps1 -DatabricksHost https://your-workspace.cloud.databricks.com

# 2) Register the provider (prebuilt .cdpk). This restarts the ArcGIS Server
#    service, which loads the provider AND picks up the credentials from step 1.
#    Defaults: -AdminUrl https://localhost:6443  -Context arcgis  -AdminUser siteadmin
.\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk -Restart yes
```

### Auth — PAT or OAuth M2M (you choose; PAT is not required)

Omitting `-AuthMode` prompts you to pick. To be explicit:

```powershell
# Personal Access Token
.\configure-databricks.ps1 -DatabricksHost https://your-ws.cloud.databricks.com -AuthMode pat

# OAuth M2M service principal (recommended for production — no user, auto-refreshing)
.\configure-databricks.ps1 -DatabricksHost https://your-ws.cloud.databricks.com -AuthMode oauth
```

PAT writes `token = …`; OAuth writes `client_id` / `client_secret`. Either way the
profile also gets `host = …`.

### Where credentials go, and the `workspace` link

| What | Default | Override |
|---|---|---|
| Credential file (`.databrickscfg`) | `C:\ProgramData\ArcGIS\cdf\.databrickscfg` | `-ConfigFile <path>` |
| Profile (section) inside it | `DEFAULT` | `-ProfileName <name>` |
| Machine env var pointing the provider at the file | `DATABRICKS_CONFIG_FILE` = that path | set automatically |

The `-ProfileName` you write **is** the value a published service's **`workspace`**
parameter must use (omit `-ProfileName` → the service uses `workspace=DEFAULT`).
Multiple workspaces: run configure once per workspace with distinct `-ProfileName`
into the same file. Non-default Windows service name? Pass `-ServiceName "<name>"`
(`Get-Service *ArcGIS*` to find it).

## Verify

```powershell
[Environment]::GetEnvironmentVariable('DATABRICKS_CONFIG_FILE','Machine')   # -> the .databrickscfg path
icacls C:\ProgramData\ArcGIS\cdf\.databrickscfg                              # SYSTEM:R, Administrators:F, service acct:R
```

On success `configure-databricks.ps1` prints `wrote …` (and, if the Databricks CLI
is present, `authenticated to Databricks as profile '…'`); `register-provider.ps1`
ends with `provider … registered and verified active`.

**Next — publish a feature service.** On Windows this is done in **ArcGIS Server
Manager** (browser) or via the admin REST API; see *Publish your feature services*
in the [root README](../README.md). The service's **`workspace`** parameter must
match the profile name you configured above.

## How it differs from Linux

`configure-databricks.ps1` handles the two things Linux does differently:

- **Credentials delivery** — there's no `init_user_param.sh` startup hook on
  Windows, so the script sets **`DATABRICKS_CONFIG_FILE` as a Machine (system)
  environment variable**; the ArcGIS Server service inherits it at next start.
- **File protection** — there's no `arcgis` OS user or `chmod 600`. The
  `.databrickscfg` is locked with an **`icacls` ACL** (SYSTEM + Administrators + the
  ArcGIS Server service account, which the script auto-detects).

## Notes / gotchas

- **Run against the box, not the web adaptor.** The defaults (`https://localhost:6443`,
  context `arcgis`) are correct on the box. Going through the web adaptor can return
  HTML/redirects that break the token mint (the script explains this if it happens).
  The self-signed cert on the loopback admin call is trusted automatically.
- **Re-running is safe.** `register-provider.ps1` auto-detects register vs update (drop
  in a newer `.cdpk` to upgrade); `configure-databricks.ps1` merges into `.databrickscfg`,
  preserving other profiles and replacing only the target profile's credentials
  (rotate a secret = re-run + restart).
- **A change needs a restart.** Both the credential file and the env var are read once,
  at process start. `register-provider.ps1 -Restart yes` covers the initial install; for
  a later credential rotation, restart manually: `Restart-Service -DisplayName "ArcGIS Server" -Force`.
- **Multi-machine:** run `configure-databricks.ps1` on **every node** (a shared
  `-ConfigFile` path all nodes can read, or a local copy each), then restart each node.
  The provider **code** and service definitions propagate automatically via the shared
  config-store — credentials do not.
