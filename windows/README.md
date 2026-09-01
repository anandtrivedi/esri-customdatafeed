# Windows deployment (PowerShell)

The primary install scripts in the repo root (`register-provider.sh`, `configure-databricks.sh`,
`publish-service.sh`, …) are **bash** and target **Linux** ArcGIS Server. This folder holds
**pure-PowerShell** ports for shops running ArcGIS Server on **Windows** — where Git Bash / WSL
aren't available (e.g. locked-down laptops) and Linux-only mechanisms like `init_user_param.sh`
don't exist.

Both scripts run on **Windows PowerShell 5.1** (default on Windows Server) and **PowerShell 7+**,
with **no external dependencies** — no bash, python3, Git Bash, or WSL.

## What's ported

| PowerShell script | Bash equivalent | What it does on Windows |
|---|---|---|
| `register-provider.ps1` | `register-provider.sh` | Registers/updates a **prebuilt `.cdpk`** via the admin REST API; restarts the **ArcGIS Server Windows service** instead of `startserver.sh` |
| `configure-databricks.ps1` | `configure-databricks.sh` | Writes `.databrickscfg` (INI-merge preserving other profiles, locked-down ACL); sets **`DATABRICKS_CONFIG_FILE` as a Machine env var** — the Windows replacement for `init_user_param.sh` |

## The two things that differ from Linux

1. **No `init_user_param.sh`.** That's a Linux ArcGIS startup hook. On Windows, credentials reach
   the server process through the **service account's environment**. `configure-databricks.ps1`
   sets `DATABRICKS_CONFIG_FILE` as a **Machine (system) environment variable**; the ArcGIS Server
   service inherits it at next start.
2. **No `arcgis` OS user; no `chmod 600`.** The `.databrickscfg` is written to a machine-wide path
   (default `C:\ProgramData\ArcGIS\cdf`) and locked down with an **ACL** (SYSTEM + Administrators +
   the ArcGIS Server service account) via `icacls`.

Building the `.cdpk` is **not** ported — build the universal package on Linux or a build box
(`register-provider.sh` option 1) and copy the `.cdpk` here. One `.cdpk` runs on any platform.

## Usage

Run both in an **elevated** PowerShell (Run as administrator) — needed to set the Machine env var,
lock the ACL, and restart the service.

```powershell
# 1) Register the provider (prebuilt .cdpk)
.\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk

# 2) Configure the Databricks connection
.\configure-databricks.ps1 -DatabricksHost https://your-workspace.cloud.databricks.com -AuthMode pat

# 3) Restart so the server picks up creds + env var
Restart-Service -DisplayName "ArcGIS Server" -Force
```

Both scripts prompt for anything not passed (admin password, secrets — always read securely).
Run with `-?` for full parameter help. If your ArcGIS Server service has a non-default display
name, pass `-ServiceName "<name>"`.

## Notes / gotchas

- **Self-signed cert:** the scripts trust ArcGIS Server's self-signed cert for the loopback admin
  call automatically (PS 7 via `-SkipCertificateCheck`; PS 5.1 via a process-scoped trust callback).
- **Web adaptor:** run `register-provider.ps1` **on the box** against `https://localhost:6443`
  with context `arcgis`. Going through the web adaptor can return HTML/redirects that break the
  token mint (the script explains this if it happens).
- **Restart required:** both `.databrickscfg` and the env var are read once at process start — a
  running server won't see changes until the service restarts.
- **Multi-machine:** repeat `configure-databricks.ps1` on every node (a shared `-ConfigFile` path
  all nodes can read, or a local copy each), then restart each node. The provider **code** and
  service definitions propagate automatically via the shared config-store; credentials do not.
