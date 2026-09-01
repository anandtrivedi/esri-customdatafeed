#Requires -Version 5.1
<#
.SYNOPSIS
  configure-databricks.ps1 — Windows PowerShell port of configure-databricks.sh.
  Writes the .databrickscfg the CDF provider reads, and (the Windows replacement
  for init_user_param.sh) sets DATABRICKS_CONFIG_FILE as a Machine environment
  variable so the ArcGIS Server service picks it up.

.DESCRIPTION
  Pure PowerShell — no bash, python3, Git Bash, or WSL required. Works on Windows
  PowerShell 5.1 and PowerShell 7+.

  On Windows there is NO init_user_param.sh (that's a Linux ArcGIS mechanism), and
  there is no 'arcgis' OS user. So instead of a per-user ~/.databrickscfg + shell
  export, this script:
    1. Writes .databrickscfg to a machine-wide path (default C:\ProgramData\ArcGIS\cdf),
       INI-merging so existing profiles are preserved, then locks the file's ACL down
       to SYSTEM + Administrators + the ArcGIS Server service account.
    2. Sets DATABRICKS_CONFIG_FILE as a MACHINE (system) environment variable pointing
       at that file, so the ArcGIS Server service process inherits it at next start.
  Restart the ArcGIS Server service afterward — env vars and .databrickscfg are read
  once at process start.

  MULTI-MACHINE: the provider code + service definitions propagate across a site
  automatically, but this file + env var are per-machine. Either put .databrickscfg on
  a shared path all nodes can read and run this on each node with that same -ConfigFile,
  or run this on each node with its own local copy. Rotations: edit the file, restart each node.

.EXAMPLE
  .\configure-databricks.ps1
  Interactive: prompts for host, auth mode, and secrets.

.EXAMPLE
  .\configure-databricks.ps1 -DatabricksHost https://myws.cloud.databricks.com -AuthMode pat
  Prompts only for the PAT (secure).
#>
[CmdletBinding()]
param(
  [string]$ConfigFile  = "C:\ProgramData\ArcGIS\cdf\.databrickscfg",
  [string]$ProfileName = "DEFAULT",
  [string]$DatabricksHost,
  [ValidateSet('ask','pat','oauth')][string]$AuthMode = 'ask',
  [securestring]$Token,
  [string]$ClientId,
  [securestring]$ClientSecret,
  [bool]$SetConfigFileEnv = $true,
  [string]$ServiceName = "ArcGIS Server"
)

$ErrorActionPreference = 'Stop'

function Write-Head($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Read-Plain([securestring]$s) {
  if (-not $s) { return "" }
  [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

# --- minimal INI read/write that preserves other profiles -------------------
# Returns an ordered map: sectionName -> ordered map of key->value.
function Read-Ini([string]$Path) {
  $sections = [ordered]@{}
  if (Test-Path -LiteralPath $Path) {
    $cur = $null
    foreach ($line in Get-Content -LiteralPath $Path) {
      $t = $line.Trim()
      if ($t -match '^\[(.+)\]$') {
        $cur = $Matches[1]
        if (-not $sections.Contains($cur)) { $sections[$cur] = [ordered]@{} }
      } elseif ($cur -and $t -and ($t -notmatch '^[#;]') -and ($t -match '^([^=]+?)\s*=\s*(.*)$')) {
        $sections[$cur][$Matches[1].Trim()] = $Matches[2].Trim()
      }
    }
  }
  return $sections
}
function Write-Ini([System.Collections.Specialized.OrderedDictionary]$Sections, [string]$Path) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($sec in $Sections.Keys) {
    [void]$sb.AppendLine("[$sec]")
    foreach ($k in $Sections[$sec].Keys) { [void]$sb.AppendLine("$k = $($Sections[$sec][$k])") }
    [void]$sb.AppendLine("")
  }
  # Write with no BOM; the Databricks SDK's INI reader is byte-oriented.
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $sb.ToString(), $enc)
}

# --- lock a file's ACL to SYSTEM + Administrators + the service account ------
function Set-CfgAcl([string]$Path) {
  try {
    & icacls $Path /inheritance:r | Out-Null
    & icacls $Path /grant:r "*S-1-5-18:R"      | Out-Null   # SYSTEM
    & icacls $Path /grant:r "*S-1-5-32-544:F"  | Out-Null   # Administrators
    # Grant the ArcGIS Server service account read, if it's a normal (non-built-in) account.
    $svc = Get-CimInstance Win32_Service -Filter "DisplayName='$ServiceName'" -ErrorAction SilentlyContinue
    if (-not $svc) { $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue }
    $acct = $svc.StartName
    if ($acct) {
      # Normalize the StartName into a form icacls can resolve. Built-in accounts
      # go through their well-known SIDs; a local account stored as ".\name" must
      # be rewritten to "COMPUTER\name" (icacls does not understand the ".\" prefix
      # and fails with "No mapping between account names and security IDs").
      if ($acct -match '^(LocalSystem|\.?\\?NT AUTHORITY\\SYSTEM)$') {
        $acct = $null                                                    # SYSTEM already granted above
      } elseif ($acct -match 'NetworkService') {
        & icacls $Path /grant:r "*S-1-5-20:R" | Out-Null; $acct = $null  # NetworkService SID
      } elseif ($acct -match 'LocalService') {
        & icacls $Path /grant:r "*S-1-5-19:R" | Out-Null; $acct = $null  # LocalService SID
      } elseif ($acct -like '.\*') {
        $acct = "$env:COMPUTERNAME\" + $acct.Substring(2)                # .\name -> COMPUTER\name
      }
      if ($acct) {
        & icacls $Path /grant:r "${acct}:R" | Out-Null
        if ($LASTEXITCODE -eq 0) {
          Write-Host "  [ok] granted read to service account '$acct'." -ForegroundColor Green
        } else {
          Write-Host "  [warn] could not grant read to service account '$acct' (icacls exit $LASTEXITCODE)." -ForegroundColor Yellow
          Write-Host "         Ensure that account can READ $Path, or the provider will fail to load credentials."
        }
      }
    }
    Write-Host "  [ok] locked ACL on $Path (SYSTEM + Administrators + service account)." -ForegroundColor Green
  } catch {
    Write-Host "  [warn] could not fully lock the ACL: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "         Ensure the ArcGIS Server service account can READ $Path."
  }
}

# ===========================================================================
Write-Host "============================================================"
Write-Host " Configure Databricks connection (.databrickscfg) - Windows"
Write-Host "============================================================"

# admin check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "!! Run this in an ELEVATED PowerShell (Run as administrator)." -ForegroundColor Red
  Write-Host "   Needed to lock the file ACL and set the Machine environment variable."
  exit 1
}

# --- collect inputs ---------------------------------------------------------
Write-Head "Connection"
if (-not $DatabricksHost) {
  while (-not $DatabricksHost) { $DatabricksHost = Read-Host "  Databricks host (e.g. https://your-workspace.cloud.databricks.com)" }
}
$DatabricksHost = $DatabricksHost.TrimEnd('/')

if ($AuthMode -eq 'ask') {
  $m = Read-Host "  Auth mode: 1) Personal Access Token (PAT)  2) OAuth M2M (service principal)  [1]"
  $AuthMode = if ($m -eq '2') { 'oauth' } else { 'pat' }
}

$tokenPlain = ""; $secretPlain = ""
if ($AuthMode -eq 'oauth') {
  if (-not $ClientId) { while (-not $ClientId) { $ClientId = Read-Host "  Service principal client_id" } }
  if (-not $ClientSecret) { $ClientSecret = Read-Host "  Service principal client_secret" -AsSecureString }
  $secretPlain = Read-Plain $ClientSecret
  if (-not $secretPlain) { throw "client_secret is required." }
} else {
  if (-not $Token) { $Token = Read-Host "  Personal Access Token (dapi...)" -AsSecureString }
  $tokenPlain = Read-Plain $Token
  if (-not $tokenPlain) { throw "token is required." }
}

# --- merge + write the profile (preserving other profiles) ------------------
Write-Head "Write .databrickscfg"
$destDir = Split-Path -Parent $ConfigFile
if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

# Fail closed: if the existing file is present but unreadable, don't clobber other workspaces.
$ini = Read-Ini $ConfigFile
if (-not $ini.Contains($ProfileName)) { $ini[$ProfileName] = [ordered]@{} }
# clear prior auth keys so PAT<->OAuth can't mix
foreach ($k in @('token','client_id','client_secret')) { if ($ini[$ProfileName].Contains($k)) { $ini[$ProfileName].Remove($k) } }
$ini[$ProfileName]['host'] = $DatabricksHost
if ($AuthMode -eq 'oauth') {
  $ini[$ProfileName]['client_id']     = $ClientId
  $ini[$ProfileName]['client_secret'] = $secretPlain
} else {
  $ini[$ProfileName]['token'] = $tokenPlain
}

# Atomic same-dir write: temp -> lock ACL -> move.
$tmp = Join-Path $destDir (".databrickscfg.cdftmp." + [Guid]::NewGuid().ToString("N"))
Write-Ini $ini $tmp
Set-CfgAcl $tmp
Move-Item -LiteralPath $tmp -Destination $ConfigFile -Force
Write-Host "  [ok] wrote $ConfigFile (profile '$ProfileName', $AuthMode auth, host $DatabricksHost)." -ForegroundColor Green

# scrub secrets from memory
$tokenPlain = $null; $secretPlain = $null; [System.GC]::Collect()

# --- set DATABRICKS_CONFIG_FILE as a Machine env var (init_user_param.sh replacement) ---
if ($SetConfigFileEnv) {
  Write-Head "Machine environment (replaces init_user_param.sh)"
  [Environment]::SetEnvironmentVariable('DATABRICKS_CONFIG_FILE', $ConfigFile, 'Machine')
  Write-Host "  [ok] set Machine env var DATABRICKS_CONFIG_FILE=$ConfigFile" -ForegroundColor Green
  Write-Host "       (The ArcGIS Server service reads this at start - a running server won't see it until restart.)"
}

# --- optional connectivity check --------------------------------------------
Write-Head "Verify"
$dbx = Get-Command databricks -ErrorAction SilentlyContinue
if ($dbx) {
  Write-Host "-> checking the profile with the Databricks CLI..."
  $env:DATABRICKS_CONFIG_FILE = $ConfigFile
  & databricks current-user me --profile $ProfileName -o json *> $null
  if ($LASTEXITCODE -eq 0) { Write-Host "   [ok] authenticated to Databricks as profile '$ProfileName'." -ForegroundColor Green }
  else { Write-Host "   [warn] CLI could not authenticate (bad token/secret, wrong host, or no network). File was written; fix and re-run if needed." -ForegroundColor Yellow }
} else {
  Write-Host "  (Databricks CLI not installed - skipping live check. Use diagnose-service after publishing to confirm.)"
}

Write-Host ""
Write-Host "============================================================"
Write-Host " Done. RESTART ArcGIS Server so it picks up the new credentials + env var:"
Write-Host "   Restart-Service -DisplayName '$ServiceName' -Force"
Write-Host ""
Write-Host " Multi-machine: repeat on every node (shared -ConfigFile path, or a local copy each),"
Write-Host " then restart each node. Rotations: edit the file + restart."
Write-Host "============================================================"
