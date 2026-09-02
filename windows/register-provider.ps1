#Requires -Version 5.1
<#
.SYNOPSIS
  register-provider.ps1 - Windows PowerShell port of register-provider.sh.
  Registers (first install) or updates (upgrade) a PREBUILT Databricks CDF
  provider (.cdpk) on a Windows ArcGIS Server, via the admin REST API.

.DESCRIPTION
  Pure PowerShell - no bash, python3, Git Bash, or WSL required. Works on
  Windows PowerShell 5.1 (default on Windows Server) and PowerShell 7+.

  Flow: locate the .cdpk -> read its provider name -> mint an admin token ->
  register or update (auto-detected) -> restart the ArcGIS Server service ->
  verify the provider is listed. Safe to re-run.

  BUILDING is intentionally NOT ported: build the universal .cdpk on Linux or a
  build box (register-provider.sh option 1) and copy it here, then run this to
  register it. One .cdpk runs on any platform (pure-JS core).

  NOTE ON UPDATES: registering a name that already exists is refused by ArcGIS,
  so for an existing provider this calls `update`. An update RE-EXTRACTS over the
  provider directory (wiping any .env inside it - credentials in .databrickscfg /
  the DATABRICKS_CONFIG_FILE env var live elsewhere and are safe). A FAILED update
  can leave existing services 404ing until a good package is registered, so it
  always confirms first.

.EXAMPLE
  .\register-provider.ps1
  Interactive: prompts for the .cdpk, admin login, and restart.

.EXAMPLE
  .\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk -AdminUser siteadmin -Restart yes -Yes
  Non-interactive-ish: still prompts for the admin password (secure), skips y/N confirmations.
#>
[CmdletBinding()]
param(
  [string]$CdpkPath,
  [string]$AdminUrl    = "https://localhost:6443",
  [string]$Context     = "arcgis",
  [string]$AdminUser   = "siteadmin",
  [securestring]$AdminPassword,
  [string]$InstallRoot = "C:\Program Files\ArcGIS\Server",
  [string]$ProviderName,
  [ValidateSet('ask','yes','no')][string]$Restart = 'ask',
  [switch]$Yes,                     # skip y/N confirmations (register/update/restart)
  [string]$ServiceName = "ArcGIS Server"
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# TLS + self-signed cert handling. ArcGIS Server presents a self-signed cert on
# :6443; loopback calls on the box are safe to trust. PS7 uses -SkipCertificateCheck;
# 5.1 has no such flag, so we set a trust-all validation callback (WebRequest-based).
# ---------------------------------------------------------------------------
$script:IwrExtra = @{}
if ($PSVersionTable.PSVersion.Major -ge 6) {
  $script:IwrExtra['SkipCertificateCheck'] = $true
} else {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  # Trust-all callback for loopback admin calls only. Scoped to this process.
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

function Write-Head($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Confirm-Step([string]$Prompt, [bool]$DefaultYes) {
  if ($Yes) { return $true }
  $suffix = if ($DefaultYes) { "(Y/n)" } else { "(y/N)" }
  $ans = Read-Host "  $Prompt $suffix"
  if ([string]::IsNullOrWhiteSpace($ans)) { return $DefaultYes }
  return ($ans -match '^(y|yes)$')
}

# --- read provider name (and optionally verify GovCloud allowlist) from a .cdpk zip ---
function Get-CdpkProviderName([string]$Path) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
      $entry = $zip.Entries |
        Where-Object { $_.Name -eq 'cdconfig.json' } |
        Sort-Object { $_.FullName.Length } | Select-Object -First 1   # shallowest cdconfig.json
      if (-not $entry) { return $null }
      $sr = New-Object System.IO.StreamReader($entry.Open())
      try { $json = $sr.ReadToEnd() } finally { $sr.Dispose() }
      return ($json | ConvertFrom-Json).name
    } finally { $zip.Dispose() }
  } catch { return $null }
}

# --- mint an ArcGIS admin token (client=requestip, matching the .sh) ----------
function New-AdminToken([string]$Server,[string]$Ctx,[string]$User,[string]$PlainPass) {
  $body = @{ username = $User; password = $PlainPass; client = 'requestip'; f = 'json' }
  try {
    $r = Invoke-RestMethod -Uri "$Server/$Ctx/admin/generateToken" -Method Post -Body $body @IwrExtra
  } catch {
    throw "Token request failed: $($_.Exception.Message)"
  }
  if ($r.token) { return $r.token }
  # ArcGIS returns HTTP 200 with an error object on bad creds/HTML-through-WA.
  $msg = if ($r.messages) { ($r.messages -join '; ') } elseif ($r.error) { $r.error.message } else { ($r | ConvertTo-Json -Depth 5) }
  throw "No token returned. Server said: $msg`n   - HTML/redirect => you went through the web adaptor; use -AdminUrl https://localhost:6443 -Context arcgis ON the box.`n   - 'Invalid username or password' => wrong admin creds.`n   - refused/timeout => ArcGIS Server not running on that port."
}

# --- list registered custom-data providers; returns array of names -----------
function Get-RegisteredProviders([string]$Server,[string]$Ctx,[string]$Token) {
  $r = Invoke-RestMethod -Uri "$Server/$Ctx/admin/services/types/customdataproviders" `
       -Method Post -Body @{ token = $Token; f = 'json' } @IwrExtra
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($p in $r.PSObject.Properties) {
    if ($p.Value -is [System.Array]) {
      foreach ($e in $p.Value) {
        if ($e.type -eq 'provider' -and $e.name) { $names.Add([string]$e.name) }
      }
    }
  }
  return $names
}

# --- multipart upload of the .cdpk (works on 5.1 and 7 by hand-building body) --
function Send-CdpkUpload([string]$Server,[string]$Ctx,[string]$Token,[string]$Path) {
  $boundary = "----CDF" + [Guid]::NewGuid().ToString("N")
  $fileName = [System.IO.Path]::GetFileName($Path)
  $fileBytes = [System.IO.File]::ReadAllBytes($Path)
  $enc = [System.Text.Encoding]::UTF8
  $pre  = "--$boundary`r`nContent-Disposition: form-data; name=`"itemFile`"; filename=`"$fileName`"`r`nContent-Type: application/octet-stream`r`n`r`n"
  $post = "`r`n--$boundary--`r`n"
  $ms = New-Object System.IO.MemoryStream
  $preB  = $enc.GetBytes($pre);  $ms.Write($preB, 0, $preB.Length)
  $ms.Write($fileBytes, 0, $fileBytes.Length)
  $postB = $enc.GetBytes($post); $ms.Write($postB, 0, $postB.Length)
  $bodyBytes = $ms.ToArray(); $ms.Dispose()

  # token+f in the query string (documented working pattern for uploads; can't mix with multipart body)
  $uri = "$Server/$Ctx/admin/uploads/upload?token=$Token&f=json"
  $r = Invoke-RestMethod -Uri $uri -Method Post -ContentType "multipart/form-data; boundary=$boundary" `
       -Body $bodyBytes @IwrExtra
  if ($r.item -and $r.item.itemID) { return $r.item.itemID }
  throw "Upload did not return an itemID. Server said: $($r | ConvertTo-Json -Depth 6)"
}

# ===========================================================================
Write-Host "============================================================"
Write-Host " Databricks CDF - Register / Update Provider (Windows)"
Write-Host "============================================================"

# --- locate the .cdpk -------------------------------------------------------
Write-Head "Package"
if (-not $CdpkPath) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot  = Split-Path -Parent $scriptDir
  $cands = @(
    (Join-Path $scriptDir '*.cdpk'),
    (Join-Path $repoRoot  '*.cdpk'),
    (Join-Path $repoRoot  'dist\*.cdpk'),
    (Join-Path $repoRoot  'nodejs-provider\*.cdpk')
  )
  $found = foreach ($g in $cands) { Get-ChildItem $g -ErrorAction SilentlyContinue }
  $found = $found | Select-Object -Unique
  if ($found.Count -eq 1) {
    $CdpkPath = $found[0].FullName
    Write-Host "  Found prebuilt package: $CdpkPath"
  } elseif ($found.Count -gt 1) {
    Write-Host "  Multiple .cdpk files found:"
    for ($i=0; $i -lt $found.Count; $i++) { Write-Host ("    {0}) {1}" -f ($i+1), $found[$i].FullName) }
    $pick = Read-Host "  choose a number [1]"; if ([string]::IsNullOrWhiteSpace($pick)) { $pick = 1 }
    $CdpkPath = $found[[int]$pick - 1].FullName
  } else {
    $CdpkPath = Read-Host "  Path to the .cdpk file"
  }
}
if (-not (Test-Path -LiteralPath $CdpkPath -PathType Leaf)) { throw "File not found: $CdpkPath" }
if ($CdpkPath -notlike '*.cdpk') { Write-Host "  [warn] '$CdpkPath' does not end in .cdpk - continuing anyway." -ForegroundColor Yellow }

# integrity check if a sibling .sha256 exists (build-release.sh / GitHub Release ships one)
$shaFile = "$CdpkPath.sha256"
if (Test-Path -LiteralPath $shaFile) {
  $got  = (Get-FileHash -LiteralPath $CdpkPath -Algorithm SHA256).Hash.ToLower()
  $want = ((Get-Content -LiteralPath $shaFile -First 1) -split '\s+')[0].ToLower()
  if ($got -eq $want) { Write-Host "  [ok] sha256 verified against $(Split-Path $shaFile -Leaf)" -ForegroundColor Green }
  else { throw "sha256 MISMATCH - '$CdpkPath' does not match its .sha256 (corrupt/tampered?).`n  got : $got`n  want: $want" }
}

# provider name: parameter > package's cdconfig.json > default
if (-not $ProviderName) { $ProviderName = Get-CdpkProviderName $CdpkPath }
if (-not $ProviderName) { $ProviderName = "databricks-geospatial-provider" }
Write-Host "  Provider name: $ProviderName"
$providerDir = Join-Path $InstallRoot "framework\runtime\customdata\providers\$ProviderName"

# --- admin connection + token ----------------------------------------------
Write-Head "ArcGIS connection"
if (-not $AdminPassword) { $AdminPassword = Read-Host "  Admin password for '$AdminUser' @ $AdminUrl/$Context" -AsSecureString }
$plainPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminPassword))

Write-Host "-> requesting admin token (client=requestip)..."
$token = New-AdminToken -Server $AdminUrl -Ctx $Context -User $AdminUser -PlainPass $plainPass
Write-Host ("   ok (token {0}...)." -f $token.Substring(0, [Math]::Min(10,$token.Length)))

# --- register vs update -----------------------------------------------------
Write-Host "-> checking whether '$ProviderName' is already registered..."
$registered = Get-RegisteredProviders -Server $AdminUrl -Ctx $Context -Token $token
$action = if ($registered -contains $ProviderName) { 'update' } else { 'register' }

if ($action -eq 'update') {
  Write-Host "   '$ProviderName' is already registered - this will be an UPDATE (upgrade)." -ForegroundColor Yellow
  Write-Host "   [!] An update RE-EXTRACTS over $providerDir (any provider-local .env is wiped;"
  Write-Host "       credentials in .databrickscfg / DATABRICKS_CONFIG_FILE are safe). A FAILED update"
  Write-Host "       can leave existing services 404ing until a good package is registered."
  if (-not (Confirm-Step "Proceed with UPDATE of '$ProviderName'?" $false)) { Write-Host "Aborted - nothing changed."; exit 0 }
} else {
  Write-Host "   '$ProviderName' is not registered yet - this will be a first-time REGISTER."
  if (-not (Confirm-Step "Proceed with REGISTER of '$ProviderName'?" $true)) { Write-Host "Aborted - nothing changed."; exit 0 }
}

# --- upload -----------------------------------------------------------------
Write-Host "-> uploading $(Split-Path $CdpkPath -Leaf)..."
$itemId = Send-CdpkUpload -Server $AdminUrl -Ctx $Context -Token $token -Path $CdpkPath
Write-Host "   ok (itemID $itemId)."

# --- register / update ------------------------------------------------------
Write-Host "-> ${action}ing the provider..."
$resp = Invoke-RestMethod -Uri "$AdminUrl/$Context/admin/services/types/customdataproviders/$action" `
        -Method Post -Body @{ id = $itemId; token = $token; f = 'json' } @IwrExtra
if ($resp.status -eq 'success') {
  Write-Host "   [ok] $action succeeded." -ForegroundColor Green
} else {
  Write-Host "!! $action did not report success. Server said:" -ForegroundColor Red
  Write-Host ($resp | ConvertTo-Json -Depth 6)
  if ($action -eq 'update') {
    Write-Host "   [!] If this update FAILED, the provider directory may have been removed - existing"
    Write-Host "       services will 404 until a good .cdpk is registered. Re-run with a correct package."
  }
  exit 1
}

# --- restart the ArcGIS Server Windows service ------------------------------
Write-Head "Restart"
Write-Host "  ArcGIS Server must restart to load the ${action}ed provider."
$doRestart = switch ($Restart) {
  'yes' { $true } 'no' { $false }
  default { Confirm-Step "Restart the '$ServiceName' Windows service now?" $false }
}
$restarted = $false
if ($doRestart) {
  $svc = Get-Service -DisplayName $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }
  if (-not $svc) {
    Write-Host "  [warn] service '$ServiceName' not found. Restart manually (Services.msc) or run:" -ForegroundColor Yellow
    Write-Host "         `"$InstallRoot\stopserver.bat`"  then  `"$InstallRoot\startserver.bat`""
  } else {
    Write-Host "-> restarting '$($svc.DisplayName)' (this can take 1-2 minutes)..."
    Restart-Service -InputObject $svc -Force
    $restarted = $true
  }
} else {
  Write-Host "  (not restarted - the provider is uploaded and ${action}ed but WON'T be active until the"
  Write-Host "   '$ServiceName' service restarts.)"
}

# --- verify -----------------------------------------------------------------
$verified = 'unknown'
if ($restarted) {
  Write-Host "-> waiting for the admin API to come back up (up to ~2 min)..."
  $token = $null
  for ($a=0; $a -lt 12; $a++) {
    Start-Sleep -Seconds 10
    try { $token = New-AdminToken -Server $AdminUrl -Ctx $Context -User $AdminUser -PlainPass $plainPass } catch { $token = $null }
    if ($token) { Write-Host ("   [ok] admin API is back (after ~{0}s)." -f (($a+1)*10)); break }
  }
  if ($token) {
    $now = Get-RegisteredProviders -Server $AdminUrl -Ctx $Context -Token $token
    if ($now -contains $ProviderName) { $verified = 'yes'; Write-Host "   [ok] '$ProviderName' is registered." -ForegroundColor Green }
    else { $verified = 'no'; Write-Host "   [warn] '$ProviderName' not in the provider list yet - check the server log." -ForegroundColor Yellow }
  } else { $verified = 'pending'; Write-Host "   [warn] admin API still not answering after ~2 min - check Server Manager." -ForegroundColor Yellow }
}

# scrub the plaintext password from memory
$plainPass = $null; [System.GC]::Collect()

Write-Host ""
Write-Host "============================================================"
if (-not $restarted) {
  Write-Host " $action uploaded - NOT active yet. Restart the '$ServiceName' service to load it."
  exit 0
}
switch ($verified) {
  'yes'     { Write-Host " Done - provider '$ProviderName' ${action}ed and verified active."; $rc = 0 }
  'pending' { Write-Host " $action + restart done - server still starting; provider NOT yet confirmed."; $rc = 2 }
  'no'      { Write-Host " $action done but '$ProviderName' is NOT in the provider list - check the server log."; $rc = 2 }
  default   { Write-Host " $action done - verification INCONCLUSIVE."; $rc = 2 }
}
Write-Host " Next: configure credentials with configure-databricks.ps1, then publish services."
Write-Host "============================================================"
exit $rc
