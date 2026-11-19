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

  CREDENTIALS: the release .cdpk carries none. Either put a .env (with [NAME]
  workspace profiles) at the top level of the package - pass -EnvFile and this
  script adds it to a temporary copy before uploading - or use a per-machine
  .databrickscfg (configure-databricks.ps1). With a .env, ArcGIS keeps copies of the
  package (config store, uploads, backups); this script deletes its upload item after
  a successful register/update.

  NOTE ON UPDATES: registering a name that already exists is refused by ArcGIS,
  so for an existing provider this calls `update`. An update REPLACES the provider
  directory with the uploaded package: a .env must be inside every package you
  upload, or the provider is left without one. A .databrickscfg / DATABRICKS_* machine
  env vars outside the package are unaffected. A FAILED update can leave existing
  services 404ing until a good package is registered, so it always confirms first.

.EXAMPLE
  .\register-provider.ps1
  Interactive: prompts for the .cdpk, admin login, and restart.

.EXAMPLE
  .\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk -AdminUser siteadmin -Restart yes -Yes
  Non-interactive-ish: still prompts for the admin password (secure), skips y/N confirmations.

.EXAMPLE
  .\register-provider.ps1 -CdpkPath .\databricks-geospatial-provider.cdpk -EnvFile .\.env
  Adds .env (your Databricks workspace profiles) to the top level of a temporary copy of the
  package and uploads that copy. The original .cdpk is not modified.
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
  [string]$ServiceName = "ArcGIS Server",
  [string]$EnvFile                   # optional .env added at the top level of a temp copy before upload
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
      if (-not $entry) { Write-Host "  [warn] no cdconfig.json in the package - is it a .cdpk?" -ForegroundColor Yellow; return $null }
      $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
      try { $json = $sr.ReadToEnd() } finally { $sr.Dispose() }
      return ($json | ConvertFrom-Json).name
    } finally { $zip.Dispose() }
  } catch {
    Write-Host "  [warn] could not read cdconfig.json from the package: $($_.Exception.Message)" -ForegroundColor Yellow
    return $null
  }
}

# --- does the package carry a top-level .env? -------------------------------
function Test-CdpkHasEnv([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  try { $zip = [System.IO.Compression.ZipFile]::OpenRead($Path) }
  catch { Write-Host "   [warn] could not open $Path as a zip: $($_.Exception.Message)" -ForegroundColor Yellow; return $false }
  try { return [bool]($zip.Entries | Where-Object { $_.FullName -eq '.env' }) } finally { $zip.Dispose() }
}

# --- copy the package into $Dir and add/replace its top-level .env ---------------
function New-CdpkWithEnv([string]$Path, [string]$EnvPath, [string]$Dir) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $out = Join-Path $Dir ([System.IO.Path]::GetFileName($Path))   # ArcGIS checks the uploaded file name
  Copy-Item -LiteralPath $Path -Destination $out -Force
  $zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Update)
  try {
    foreach ($e in @($zip.Entries | Where-Object { $_.FullName -eq '.env' })) { $e.Delete() }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Resolve-Path -LiteralPath $EnvPath).Path, '.env') | Out-Null
  } finally { $zip.Dispose() }
  return $out
}

# --- delete an upload item (it may hold credentials if the package carries a .env) ---
function Remove-UploadItem([string]$Server,[string]$Ctx,[string]$Token,[string]$ItemId) {
  try {
    $r = Invoke-RestMethod -Uri "$Server/$Ctx/admin/uploads/$ItemId/delete" -Method Post `
         -Body @{ token = $Token; f = 'json' } @IwrExtra
    if ($r.status -eq 'success') { Write-Host "   [ok] deleted upload item $ItemId (ArcGIS keeps uploads until deleted)." -ForegroundColor Green; return }
  } catch {}
  Write-Host "   [warn] could not delete upload item $ItemId - delete it in Server Administrator > uploads; it may contain credentials." -ForegroundColor Yellow
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

  # token+f in the query string (documented working pattern for uploads; can't mix with multipart body).
  # URL-encode the token - ArcGIS tokens can contain +, /, = which would otherwise corrupt the query.
  $tok = [System.Uri]::EscapeDataString($Token)
  $uri = "$Server/$Ctx/admin/uploads/upload?token=$tok&f=json"
  # -TimeoutSec: the PS 5.1 default is 100 s; an 11 MB upload / provider install routinely takes 30-120 s.
  $r = Invoke-RestMethod -Uri $uri -Method Post -ContentType "multipart/form-data; boundary=$boundary" `
       -Body $bodyBytes -TimeoutSec 600 @IwrExtra
  if ($r.item -and $r.item.itemID) { return $r.item.itemID }
  throw "Upload did not return an itemID. Server said: $($r | ConvertTo-Json -Depth 6)"
}

# --- map a service StartName to an icacls-resolvable principal ----------------
# Mirrors configure-databricks.ps1's Set-CfgAcl fix: '.\name' and bare 'name' -> COMPUTER\name,
# and the built-in service identities -> their well-known NT AUTHORITY names (icacls errors 1332
# "No mapping between account names and SIDs" on 'LocalSystem' or 'COMPUTER\LocalSystem').
function Resolve-AclPrincipal([string]$StartName) {
  if ([string]::IsNullOrWhiteSpace($StartName)) { return $null }
  switch -Regex ($StartName) {
    '^(LocalSystem|\.\\LocalSystem|NT AUTHORITY\\System)$'         { return 'NT AUTHORITY\SYSTEM' }
    '^(NT AUTHORITY\\)?NetworkService$|^\.\\NetworkService$'       { return 'NT AUTHORITY\NETWORK SERVICE' }
    '^(NT AUTHORITY\\)?LocalService$|^\.\\LocalService$'           { return 'NT AUTHORITY\LOCAL SERVICE' }
  }
  if ($StartName -like '.\*')                             { return "$env:COMPUTERNAME\" + $StartName.Substring(2) }
  if ($StartName -notmatch '\\' -and $StartName -notmatch '@') { return "$env:COMPUTERNAME\$StartName" }
  return $StartName   # DOMAIN\acct, acct@domain, gMSA (domain\acct$) - leave as-is
}

# --- preflight: guarantee <InstallRoot>\...\customdata\providers exists + is writable -------------
# Oliver's failure (11.5 on D:\): the providers folder was MISSING and the ArcGIS service account
# could not rename the extracted package into place -> cryptic "Unable to rename old path" /
# "Could not find custom data provider configuration file". This resolves the real install root from
# the service image path (so a non-C:\ install needs no -InstallRoot guess), creates the folder if
# absent, and grants the service account Modify. Returns the (possibly corrected) install root.
function Invoke-ProvidersPreflight([string]$Root, [string]$SvcName) {
  $svc = $null
  try { $svc = Get-CimInstance Win32_Service -Filter "DisplayName='$SvcName' OR Name='$SvcName'" -ErrorAction SilentlyContinue | Select-Object -First 1 } catch {}

  # Detect the true install root from the service image path (handles non-C:\ installs like D:\).
  $detected = $null
  if ($svc -and $svc.PathName) {
    $exe = ($svc.PathName -replace '^"([^"]+)".*$', '$1')
    $m = [regex]::Match($exe, '^(?<root>.*\\ArcGIS\\Server)\\', 'IgnoreCase')
    if ($m.Success) { $detected = $m.Groups['root'].Value }
  }

  $customdata = Join-Path $Root 'framework\runtime\customdata'
  if (-not (Test-Path -LiteralPath $customdata)) {
    # -InstallRoot is wrong/default-but-not-C:\ - fall back to the detected root.
    if ($detected -and (Test-Path -LiteralPath (Join-Path $detected 'framework\runtime\customdata'))) {
      Write-Host "  [info] -InstallRoot '$Root' has no customdata tree; using detected install root '$detected'." -ForegroundColor Yellow
      $Root = $detected; $customdata = Join-Path $Root 'framework\runtime\customdata'
    } else {
      Write-Host "  [warn] no '\framework\runtime\customdata' under '$Root'." -ForegroundColor Yellow
      Write-Host "         If register fails with 'Unable to rename old path' or 'Could not find ... configuration" -ForegroundColor Yellow
      Write-Host "         file', re-run with the correct -InstallRoot (e.g. 'D:\Program Files\ArcGIS\Server')." -ForegroundColor Yellow
      return $Root
    }
  } elseif ($detected -and ($detected.TrimEnd('\') -ne $Root.TrimEnd('\'))) {
    # Supplied root is a valid ArcGIS tree, but the running service points elsewhere (e.g. a stale
    # secondary install). Preflight the supplied root but warn - registration uses the live service's root.
    Write-Host "  [warn] the ArcGIS service runs from '$detected' but -InstallRoot is '$Root'." -ForegroundColor Yellow
    Write-Host "         Preflighting '$Root'; if register fails, re-run with -InstallRoot '$detected'." -ForegroundColor Yellow
  }

  $providers = Join-Path $customdata 'providers'
  if (-not (Test-Path -LiteralPath $providers)) {
    Write-Host "  [fix] providers folder missing - creating it: $providers" -ForegroundColor Yellow
    try { New-Item -ItemType Directory -Path $providers -Force | Out-Null }
    catch { Write-Host "  [warn] could not create $providers - $($_.Exception.Message)" -ForegroundColor Yellow; return $Root }
  } else {
    Write-Host "  [ok] providers folder present: $providers" -ForegroundColor Green
  }

  # Grant the ArcGIS Server service account Modify so extraction can rename files into place.
  $acct = Resolve-AclPrincipal ($svc.StartName)
  if ($acct) {
    & icacls "$providers" /grant "${acct}:(OI)(CI)M" /C | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  [ok] granted Modify on providers folder to service account '$acct'." -ForegroundColor Green }
    else { Write-Host "  [warn] icacls grant to '$acct' returned $LASTEXITCODE - grant Modify manually if register fails." -ForegroundColor Yellow }
  } else {
    Write-Host "  [warn] could not determine the ArcGIS service account; ensure it can write to $providers." -ForegroundColor Yellow
  }
  return $Root
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
    $n = 0
    while ($true) {
      $pick = Read-Host "  choose a number [1]"; if ([string]::IsNullOrWhiteSpace($pick)) { $pick = '1' }
      if ([int]::TryParse($pick, [ref]$n) -and $n -ge 1 -and $n -le $found.Count) { break }
      Write-Host "  enter a number from 1 to $($found.Count)." -ForegroundColor Yellow
    }
    $CdpkPath = $found[$n - 1].FullName
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

if ($EnvFile) {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "-EnvFile not found: $EnvFile" }
  Write-Host "  Credentials: $EnvFile will be added as the package's top-level .env (on a temporary copy)."
} elseif (Test-CdpkHasEnv $CdpkPath) {
  Write-Host "  Credentials: the package already contains a top-level .env."
} else {
  Write-Host "  Credentials: the package has NO .env. Services then need a .databrickscfg on each machine" -ForegroundColor Yellow
  Write-Host "               (configure-databricks.ps1) or DATABRICKS_* machine env vars. To use a .env, pass -EnvFile." -ForegroundColor Yellow
}

# --- preflight the providers folder (create if missing, make writable) ------
# Skipped on non-Windows PowerShell (no Win32_Service / icacls) - this script targets Windows.
if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) {
  Write-Head "Providers folder preflight"
  $InstallRoot = Invoke-ProvidersPreflight -Root $InstallRoot -SvcName $ServiceName
}
$providerDir = Join-Path $InstallRoot "framework\runtime\customdata\providers\$ProviderName"

# --- admin connection + token ----------------------------------------------
Write-Head "ArcGIS connection"
if (-not $AdminPassword) { $AdminPassword = Read-Host "  Admin password for '$AdminUser' @ $AdminUrl/$Context" -AsSecureString }
$__pwPtr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminPassword)
try   { $plainPass = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($__pwPtr) }
finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($__pwPtr) }   # don't leak the unmanaged BSTR

Write-Host "-> requesting admin token (client=requestip)..."
$token = New-AdminToken -Server $AdminUrl -Ctx $Context -User $AdminUser -PlainPass $plainPass
Write-Host ("   ok (token {0}...)." -f $token.Substring(0, [Math]::Min(10,$token.Length)))

# --- register vs update -----------------------------------------------------
Write-Host "-> checking whether '$ProviderName' is already registered..."
$registered = Get-RegisteredProviders -Server $AdminUrl -Ctx $Context -Token $token
$action = if ($registered -contains $ProviderName) { 'update' } else { 'register' }

if ($action -eq 'update') {
  Write-Host "   '$ProviderName' is already registered - this will be an UPDATE (upgrade)." -ForegroundColor Yellow
  Write-Host "   [!] An update REPLACES $providerDir with the uploaded package: a .env must be inside"
  Write-Host "       the package, or the provider is left without one (a .databrickscfg / machine env vars"
  Write-Host "       are unaffected). A FAILED update can leave services 404ing until a good package is registered."
  if (-not $EnvFile -and -not (Test-CdpkHasEnv $CdpkPath) -and (Test-Path -LiteralPath (Join-Path $providerDir '.env'))) {
    Write-Host "   [!] $providerDir has a .env but this package does not - the update REMOVES it." -ForegroundColor Red
    Write-Host "       Pass -EnvFile <your .env> to keep using it." -ForegroundColor Red
  }
  if (-not (Confirm-Step "Proceed with UPDATE of '$ProviderName'?" $false)) { Write-Host "Aborted - nothing changed."; exit 0 }
} else {
  Write-Host "   '$ProviderName' is not registered yet - this will be a first-time REGISTER."
  if (-not (Confirm-Step "Proceed with REGISTER of '$ProviderName'?" $true)) { Write-Host "Aborted - nothing changed."; exit 0 }
}

# --- upload (a temp copy with the .env added, if -EnvFile) -----------------------
$tmpDir = $null
$uploadPath = $CdpkPath
try {
  if ($EnvFile) {
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cdf-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $uploadPath = New-CdpkWithEnv -Path $CdpkPath -EnvPath $EnvFile -Dir $tmpDir
    Write-Host "   [ok] added .env at the top level of a temporary copy of the package."
  }
  Write-Host "-> uploading $(Split-Path $uploadPath -Leaf)..."
  $itemId = Send-CdpkUpload -Server $AdminUrl -Ctx $Context -Token $token -Path $uploadPath
  Write-Host "   ok (itemID $itemId)."
} finally {
  if ($tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }   # it holds credentials
}

# --- register / update ------------------------------------------------------
Write-Host "-> ${action}ing the provider..."
try {
  $resp = Invoke-RestMethod -Uri "$AdminUrl/$Context/admin/services/types/customdataproviders/$action" `
          -Method Post -Body @{ id = $itemId; token = $token; f = 'json' } -TimeoutSec 600 @IwrExtra
} catch {
  Write-Host "!! $action request failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "   Upload item $itemId was left on the server - delete it in Server Administrator > uploads once resolved; it may contain credentials."
  exit 1
}
if ($resp.status -eq 'success') {
  Write-Host "   [ok] $action succeeded." -ForegroundColor Green
  Remove-UploadItem -Server $AdminUrl -Ctx $Context -Token $token -ItemId $itemId
} else {
  Write-Host "!! $action did not report success. Server said:" -ForegroundColor Red
  Write-Host ($resp | ConvertTo-Json -Depth 6)
  if ($action -eq 'update') {
    Write-Host "   [!] If this update FAILED, the provider directory may have been removed - existing"
    Write-Host "       services will 404 until a good .cdpk is registered. Re-run with a correct package."
  }
  Write-Host "   Upload item $itemId was left on the server - delete it in Server Administrator > uploads once resolved; it may contain credentials."
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
    Write-Host "  [warn] service '$ServiceName' not found. Restart it manually: Services app (services.msc) > ArcGIS Server > Restart," -ForegroundColor Yellow
    Write-Host "         or pass -ServiceName with the service's name (Get-Service *arcgis*)."
  } else {
    Write-Host "-> restarting '$($svc.DisplayName)' (this can take 1-2 minutes)..."
    try {
      Restart-Service -InputObject $svc -Force
      $restarted = $true
    } catch {
      Write-Host "  [warn] restart did not complete: $($_.Exception.Message)" -ForegroundColor Yellow
      Write-Host "         The provider is ${action}ed but not active until '$ServiceName' restarts - restart it in services.msc." -ForegroundColor Yellow
    }
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
$next = if ($EnvFile -or (Test-CdpkHasEnv $CdpkPath)) { " Next: publish services (the workspace field takes a [NAME] from your .env)." } `
        else { " Next: credentials - re-run with -EnvFile <.env>, or run configure-databricks.ps1 on every machine; then publish." }
if (-not $restarted) {
  Write-Host " $action uploaded - NOT active yet. Restart the '$ServiceName' service to load it."
  Write-Host $next
  exit 0
}
switch ($verified) {
  'yes'     { Write-Host " Done - provider '$ProviderName' ${action}ed and verified active."; $rc = 0 }
  'pending' { Write-Host " $action + restart done - server still starting; provider NOT yet confirmed."; $rc = 2 }
  'no'      { Write-Host " $action done but '$ProviderName' is NOT in the provider list - check the server log."; $rc = 2 }
  default   { Write-Host " $action done - verification INCONCLUSIVE."; $rc = 2 }
}
Write-Host $next
Write-Host "============================================================"
exit $rc
