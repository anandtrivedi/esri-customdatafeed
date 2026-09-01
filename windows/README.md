# Windows deployment (PowerShell)

Pure-PowerShell ports of the repo's Linux install scripts, for shops running
ArcGIS Server on **Windows**. Runs on **Windows PowerShell 5.1** (the Windows
Server default) and **PowerShell 7+**, with no bash, Python, or WSL required.

## Prerequisites

- ArcGIS Server installed and running **on this box**.
- A **prebuilt `.cdpk`** — building isn't ported. Build the universal package on
  Linux or a build box (`register-provider.sh` option 1) and copy it here; one
  `.cdpk` runs on any platform.
- An **elevated** PowerShell session (Run as administrator) — needed to lock the
  ACL, set the Machine env var, and restart the service.

## Usage

```powershell
# 1) Register the provider (prebuilt .cdpk)
.\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk

# 2) Configure the Databricks connection
.\configure-databricks.ps1 -DatabricksHost https://your-workspace.cloud.databricks.com -AuthMode pat

# 3) Restart so the server picks up the new creds + env var
#    (both .databrickscfg and the env var are read once, at process start)
Restart-Service -DisplayName "ArcGIS Server" -Force
```

Both scripts prompt for anything not passed (admin password, secrets — always read
securely) and print `-?` help. Non-default service display name: pass
`-ServiceName "<name>"`.

| PowerShell script | Bash equivalent |
|---|---|
| `register-provider.ps1` | `register-provider.sh` |
| `configure-databricks.ps1` | `configure-databricks.sh` |

## How it differs from Linux

`configure-databricks.ps1` handles the two things Linux does differently:

- **Credentials delivery** — there's no `init_user_param.sh` startup hook on
  Windows, so the script sets **`DATABRICKS_CONFIG_FILE` as a Machine (system)
  environment variable**; the ArcGIS Server service inherits it at next start.
- **File protection** — there's no `arcgis` OS user or `chmod 600`. The
  `.databrickscfg` is written to a machine-wide path (default
  `C:\ProgramData\ArcGIS\cdf`) and locked with an **`icacls` ACL** (SYSTEM +
  Administrators + the ArcGIS Server service account).

## Notes / gotchas

- **Run against the box, not the web adaptor.** Point `register-provider.ps1` at
  `https://localhost:6443` with context `arcgis`. Going through the web adaptor can
  return HTML/redirects that break the token mint (the script explains this if it
  happens). The self-signed cert on the loopback admin call is trusted
  automatically.
- **Multi-machine:** run `configure-databricks.ps1` on **every node** (a shared
  `-ConfigFile` path all nodes can read, or a local copy each), then restart each
  node. The provider **code** and service definitions propagate automatically via
  the shared config-store — credentials do not.
