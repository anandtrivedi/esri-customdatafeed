#Requires -Version 5.1
<#
.SYNOPSIS
  build-cdpk.ps1 — Windows PowerShell port of build-release.sh. Builds ONE
  versioned, universal Databricks CDF provider package (.cdpk) on Windows.

.DESCRIPTION
  Pure PowerShell — no bash, Git Bash, or WSL. Runs on Windows PowerShell 5.1
  (the Windows Server default) and PowerShell 7+. Use it on a CONNECTED build
  box (one with npm registry access) to produce the .cdpk, then move that single
  file to your ArcGIS Server host and register it with register-provider.ps1.

  NEVER run this on the ArcGIS Server box — its bundled Node may not ship npm, and
  you should not need a compiler there. One .cdpk runs on any platform (the provider
  core is pure JavaScript; the optional lz4 native module falls back cleanly).

  Steps (mirrors build-release.sh):
    1. npm ci in nodejs-provider (reproducible install from package-lock.json;
       respects your .npmrc / internal proxy).
    2. Ensure the GovCloud OAuth allowlist (.mil / .us) is present in
       @databricks/sql, and GUARD — refuse to package if it's missing, so a
       GovCloud (.mil/.us) OAuth-M2M deployment can't ship broken.
    3. Zip src/ + node_modules/ + cdconfig.json + package.json + package-lock.json
       into <cdconfig.fileName> (ArcGIS validates the uploaded name against it).
    4. Write a .sha256 and a MANIFEST.

.PARAMETER SkipInstall
  Reuse the existing node_modules instead of running npm ci (rebuild the .cdpk
  without a fresh install). The GovCloud patch + guard still run.

.EXAMPLE
  .\build-cdpk.ps1
  Full build: npm ci -> GovCloud patch/guard -> package -> sha256 + manifest.

.EXAMPLE
  .\build-cdpk.ps1 -SkipInstall
  Repackage from the current node_modules (no npm ci).
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$OutDir,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# GovCloud OAuth allowlist — KEEP IN SYNC with build-release.sh / register-provider.sh.
$GovCloudDomains = @('.cloud.databricks.mil', '.cloud.databricks.us')

function Get-OAuthManagers([string]$NodeModules) {
  $root = Join-Path $NodeModules '@databricks\sql'
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  Get-ChildItem -LiteralPath $root -Recurse -File -Filter 'OAuthManager.js' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'DatabricksOAuth' }
}

# Returns 'OK' | 'MISSING' | 'NOFIND' for one OAuthManager.js.
function Get-AwsDomainsState([string]$File) {
  $s = Get-Content -LiteralPath $File -Raw
  $m = [regex]::Match($s, 'const awsDomains = \[([^\]]*)\]')
  if (-not $m.Success) { return 'NOFIND' }
  $body = $m.Groups[1].Value
  foreach ($d in $GovCloudDomains) { if ($body -notlike "*$d*") { return 'MISSING' } }
  return 'OK'
}

function Set-GovCloudAllowlist([string]$NodeModules) {
  $files = @(Get-OAuthManagers $NodeModules)
  if ($files.Count -eq 0) {
    Write-Host "   [warn] no @databricks/sql OAuthManager.js found — GovCloud OAuth not applied." -ForegroundColor Yellow
    return
  }
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($NodeModules.Length).TrimStart('\','/')
    switch (Get-AwsDomainsState $f.FullName) {
      'OK'      { Write-Host "   [ok] GovCloud allowlist already present in $rel" -ForegroundColor Green }
      'NOFIND'  { Write-Host "   [warn] no 'const awsDomains' in $rel — driver layout changed; not edited." -ForegroundColor Yellow }
      'MISSING' {
        $add = ($GovCloudDomains | ForEach-Object { "'$_'" }) -join ', '
        $s = Get-Content -LiteralPath $f.FullName -Raw
        # Insert the domains just before the closing ] of the awsDomains array.
        $new = [regex]::Replace($s, '(const awsDomains = \[[^\]]*)\]', "`$1, $add]")
        Set-Content -LiteralPath $f.FullName -Value $new -NoNewline -Encoding UTF8
        if ((Get-AwsDomainsState $f.FullName) -eq 'OK') {
          Write-Host "   [ok] widened OAuth allowlist (.mil/.us) in $rel" -ForegroundColor Green
        } else {
          Write-Host "   [warn] could not widen $rel cleanly — the guard will stop the build." -ForegroundColor Yellow
        }
      }
    }
  }
}

# Fails the build if any OAuthManager.js is missing the GovCloud domains.
function Assert-GovCloudAllowlist([string]$NodeModules) {
  $files = @(Get-OAuthManagers $NodeModules)
  if ($files.Count -eq 0) {
    Write-Host "   [warn] no @databricks/sql OAuth allowlist found to verify — GovCloud support UNVERIFIED." -ForegroundColor Yellow
    return
  }
  $bad = $false
  foreach ($f in $files) {
    if ((Get-AwsDomainsState $f.FullName) -ne 'OK') {
      $rel = $f.FullName.Substring($NodeModules.Length).TrimStart('\','/')
      Write-Host "!! BUILD GUARD FAILED: $rel — awsDomains must contain BOTH .cloud.databricks.mil and .cloud.databricks.us." -ForegroundColor Red
      $bad = $true
    }
  }
  if ($bad) { throw "This .cdpk would fail OAuth M2M on GovCloud. NOT packaging." }
}

# --- resolve paths ----------------------------------------------------------------------------
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }   # windows/ -> repo root
$NodeDir = Join-Path $RepoRoot 'nodejs-provider'
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist' }
$cdconfigPath = Join-Path $NodeDir 'cdconfig.json'
$pkgPath      = Join-Path $NodeDir 'package.json'
if (-not (Test-Path -LiteralPath $cdconfigPath)) { throw "$cdconfigPath not found — pass -RepoRoot <repo>." }

$cdconfig = Get-Content -LiteralPath $cdconfigPath -Raw | ConvertFrom-Json
$pkg      = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$providerName = $cdconfig.name
$cdpkName     = if ($cdconfig.fileName) { $cdconfig.fileName } else { "$providerName.cdpk" }
$version      = $pkg.version
if (-not $providerName) { throw "could not read provider name from cdconfig.json." }
if (-not $cdpkName)     { throw "could not read fileName from cdconfig.json." }
if (-not $version)      { throw "could not read version from package.json." }
$gitSha = (& git -C $RepoRoot rev-parse --short HEAD 2>$null); if (-not $gitSha) { $gitSha = 'unknown' }

Write-Host "============================================================"
Write-Host " Build .cdpk (Windows) — $providerName v$version"
Write-Host "============================================================"
Write-Host "  git: $gitSha"
Write-Host "  node: $(& node -v 2>$null)   npm: $(& npm -v 2>$null)"
Write-Host ""

# --- reproducible install ---------------------------------------------------------------------
if ($SkipInstall) {
  Write-Host "-> skipping npm ci (-SkipInstall); using existing node_modules." -ForegroundColor Yellow
  if (-not (Test-Path -LiteralPath (Join-Path $NodeDir 'node_modules'))) { throw "no node_modules present and -SkipInstall was given." }
} else {
  Write-Host "-> npm ci (reproducible install from package-lock.json)..."
  Push-Location $NodeDir
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "'npm ci' failed. It needs package-lock.json + registry access (respects .npmrc)." }
  } finally { Pop-Location }
}
$nodeModules = (Resolve-Path -LiteralPath (Join-Path $NodeDir 'node_modules')).Path

Write-Host ""
Write-Host "-> ensuring GovCloud OAuth allowlist (.mil/.us)..."
Set-GovCloudAllowlist   $nodeModules
Assert-GovCloudAllowlist $nodeModules
Write-Host ""

# --- package ----------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$cdpkPath = Join-Path $OutDir $cdpkName
if (Test-Path -LiteralPath $cdpkPath) { Remove-Item -LiteralPath $cdpkPath -Force }
Write-Host "-> packaging $cdpkName ..."

# Same exclusions as build-release.sh / register-provider.sh. A broad '*.env*' would strip real
# node_modules files whose names contain '.env' and break the package, so .env rules are root-only.
function Test-Excluded([string]$rel) {
  if ($rel -eq '.env')                                 { return $true }
  if (($rel -like '.env.*') -and ($rel -notmatch '/')) { return $true }   # root-level dotenv only
  if ($rel -like 'test/*')                             { return $true }
  if ($rel -like '*.md')                               { return $true }
  return $false
}

# Collect the files to include: the three manifests, plus src/ and node_modules/ recursively.
$include = @('cdconfig.json','package.json','package-lock.json') | ForEach-Object { Join-Path $NodeDir $_ } | Where-Object { Test-Path -LiteralPath $_ }
foreach ($sub in @('src','node_modules')) {
  $p = Join-Path $NodeDir $sub
  if (Test-Path -LiteralPath $p) { $include += (Get-ChildItem -LiteralPath $p -Recurse -File -Force | ForEach-Object { $_.FullName }) }
}

Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
$prefixLen = $NodeDir.TrimEnd('\','/').Length + 1
$zip = [System.IO.Compression.ZipFile]::Open($cdpkPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $count = 0
  foreach ($full in $include) {
    $rel = $full.Substring($prefixLen).Replace('\','/')
    if (Test-Excluded $rel) { continue }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
  }
} finally { $zip.Dispose() }
if (-not (Test-Path -LiteralPath $cdpkPath)) { throw "expected $cdpkPath but it wasn't created." }
Write-Host "   [ok] wrote $count entries."

# --- checksum ---------------------------------------------------------------------------------
$sum = (Get-FileHash -LiteralPath $cdpkPath -Algorithm SHA256).Hash.ToLower()
"$sum  $cdpkName" | Set-Content -LiteralPath "$cdpkPath.sha256" -Encoding ASCII
$sizeMB = "{0:N1} MB" -f ((Get-Item -LiteralPath $cdpkPath).Length / 1MB)

# --- verify the packaged artifact carries the GovCloud allowlist (belt + suspenders) ----------
$pkgGov = 'none'
$zr = [System.IO.Compression.ZipFile]::OpenRead($cdpkPath)
try {
  $any = $false; $ok = $true
  foreach ($e in $zr.Entries) {
    if ($e.FullName.EndsWith('OAuthManager.js') -and $e.FullName -match 'DatabricksOAuth') {
      $any = $true
      $sr = New-Object IO.StreamReader($e.Open()); $txt = $sr.ReadToEnd(); $sr.Close()
      $m = [regex]::Match($txt, 'const awsDomains = \[([^\]]*)\]')
      foreach ($d in $GovCloudDomains) { if (-not ($m.Success -and $m.Groups[1].Value -like "*$d*")) { $ok = $false } }
    }
  }
  if ($any) { $pkgGov = if ($ok) { 'yes' } else { 'no' } }
} finally { $zr.Dispose() }

# --- manifest ---------------------------------------------------------------------------------
$manifest = Join-Path $OutDir "MANIFEST-v$version.txt"
@(
  "provider:        $providerName"
  "version:         $version"
  "artifact:        $cdpkName"
  "sha256:          $sum"
  "size:            $sizeMB"
  "git:             $gitSha"
  "built (UTC):     $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
  "node used:       $(& node -v 2>$null)"
  "govcloud oauth:  allowlist includes .mil/.us -> $pkgGov"
  "native modules:  none required (lz4 optional, not compiled; falls back to pure JS)"
  "built on:        PowerShell $($PSVersionTable.PSVersion)"
  "install:         copy the .cdpk to the ArcGIS Server host, verify sha256, then"
  "                 register-provider.ps1 -CdpkPath <file>  (or Server Manager > Add Custom Data Provider)."
) | Set-Content -LiteralPath $manifest -Encoding UTF8

Write-Host "   [ok] $cdpkName ($sizeMB)"
Write-Host "   [ok] sha256: $sum"
Write-Host "   [ok] packaged GovCloud allowlist present: $pkgGov"
Write-Host ""
Write-Host "============================================================"
Write-Host " Artifacts in $OutDir :"
Write-Host "   $cdpkName"
Write-Host "   $cdpkName.sha256"
Write-Host "   $(Split-Path -Leaf $manifest)"
Write-Host ""
Write-Host " Next: copy $cdpkName to the ArcGIS Server host and register it:"
Write-Host "   .\register-provider.ps1 -CdpkPath .\$cdpkName"
Write-Host "============================================================"
