#!/usr/bin/env bash
#
# build-release.sh — build ONE versioned, checksummed, universal .cdpk for a GitHub Release.
#
# Maintainer tool (run in the repo, NOT scp'd to a customer box). It produces the artifact that
# lets most operators SKIP building entirely: they download the .cdpk + .sha256 and register it
# with `register-provider.sh` (option 2) or the Server Manager GUI — no git, no npm, no compile.
#
# Why one universal artifact works: the provider has NO required native modules (lz4 is optional
# and falls back), so a .cdpk built on any OS/arch loads on the Linux ArcGIS server. This script
# also reapplies + verifies the GovCloud OAuth allowlist (.mil/.us), so the released .cdpk works
# on commercial AND GovCloud. (The GovCloud patch/guard here is kept IN SYNC with the copy in
# register-provider.sh — update both together.)
#
# Run it on a machine with package-registry access (respects your ~/.npmrc — e.g. the internal
# proxy). GitHub is used only to host the artifact; nothing here needs a CI runner.
#
#   bash build-release.sh                 # build dist/<provider>-v<version>.cdpk (+ .sha256, MANIFEST)
#   bash build-release.sh --help
#
set -uo pipefail

case "${1:-}" in
  -h|--help)
    echo "build-release.sh — build one versioned, checksummed, universal .cdpk for a GitHub Release."
    echo "  Run in the repo on a machine with npm registry access: bash build-release.sh"
    echo "  Output: dist/<provider>-v<version>.cdpk, its .sha256, and MANIFEST.txt, plus the exact"
    echo "  'gh release create' command to publish them. No CI runner needed; no native build."
    exit 0 ;;
esac

for _t in python3 zip npm git; do
  command -v "$_t" >/dev/null 2>&1 || { echo "!! required tool '$_t' not found."; exit 1; }
done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODEJS_DIR="$SCRIPT_DIR/nodejs-provider"
DIST_DIR="$SCRIPT_DIR/dist"
[ -f "$NODEJS_DIR/cdconfig.json" ] || { echo "!! $NODEJS_DIR/cdconfig.json not found — run from the repo root."; exit 1; }

PROVIDER_NAME=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('name') or '')" "$NODEJS_DIR/cdconfig.json")
# ArcGIS validates the UPLOADED .cdpk filename against cdconfig.json's fileName at register time
# ("config fileName does not match uploaded cdpk name"), and the Server Manager GUI can't override
# the upload name — so the artifact MUST be named exactly cdconfig.fileName. Version goes in the
# release tag + manifest, NOT the filename.
CDPK_FILENAME=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('fileName') or ((d.get('name') or '')+'.cdpk'))" "$NODEJS_DIR/cdconfig.json")
VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version') or '')" "$NODEJS_DIR/package.json")
[ -n "$PROVIDER_NAME" ] || { echo "!! could not read provider name from cdconfig.json."; exit 1; }
[ -n "$CDPK_FILENAME" ] || { echo "!! could not read fileName from cdconfig.json."; exit 1; }
[ -n "$VERSION" ] || { echo "!! could not read version from package.json."; exit 1; }
GIT_SHA=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY=""; git -C "$SCRIPT_DIR" diff --quiet 2>/dev/null || GIT_DIRTY=" (working tree DIRTY)"

echo "============================================================"
echo " Build release .cdpk — $PROVIDER_NAME v$VERSION"
echo "============================================================"
echo "  git: ${GIT_SHA}${GIT_DIRTY}"
echo "  node: $(node -v 2>/dev/null)   npm: $(npm -v 2>/dev/null)"
echo

# --- GovCloud OAuth allowlist patch + guard (KEEP IN SYNC with register-provider.sh) ----------
GOVCLOUD_DOMAINS="'.cloud.databricks.mil', '.cloud.databricks.us'"
find_oauth_managers() { find "$1/@databricks/sql" -type f -name OAuthManager.js -path '*DatabricksOAuth*' 2>/dev/null; }
_awsdomains_state() {   # $1 = file -> OK|MISSING|BADPARSE|NOFIND
  F="$1" python3 -c "
import os, re, ast
s = open(os.environ['F']).read()
m = re.search(r'const awsDomains = (\[[^\]]*\])', s)
if not m: print('NOFIND'); raise SystemExit
try: arr = ast.literal_eval(m.group(1))
except Exception: print('BADPARSE'); raise SystemExit
need = {'.cloud.databricks.mil', '.cloud.databricks.us'}
print('OK' if need.issubset(set(arr)) else 'MISSING')
" 2>/dev/null || echo "BADPARSE"
}
patch_govcloud_oauth() {   # $1 = node_modules dir
  local f st any=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    any=1; st=$(_awsdomains_state "$f")
    case "$st" in
      OK)      echo "   [ok] GovCloud allowlist already present in ${f#"$1/"}" ;;
      MISSING)
        sed -i.govbak "s/\(const awsDomains = \[[^]]*\)\]/\1, ${GOVCLOUD_DOMAINS}]/" "$f" && rm -f "$f.govbak"
        if [ "$(_awsdomains_state "$f")" = "OK" ]; then echo "   [ok] widened OAuth allowlist (.mil/.us) in ${f#"$1/"}"
        else echo "   [warn] could not widen ${f#"$1/"} cleanly — the guard will stop the build."; fi ;;
      NOFIND)  echo "   [warn] no 'const awsDomains' in ${f#"$1/"} — driver layout changed; not edited." ;;
      *)       echo "   [warn] could not read the allowlist in ${f#"$1/"}." ;;
    esac
  done <<EOF
$(find_oauth_managers "$1")
EOF
  [ "$any" = "1" ] || echo "   [warn] no @databricks/sql OAuthManager.js found — GovCloud OAuth not applied."
}
guard_govcloud_oauth() {   # $1 = node_modules dir
  local f any=0 bad=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    any=1
    [ "$(_awsdomains_state "$f")" = "OK" ] || { echo "!! BUILD GUARD FAILED: ${f#"$1/"} — awsDomains must contain BOTH .cloud.databricks.mil and .cloud.databricks.us."; bad=1; }
  done <<EOF
$(find_oauth_managers "$1")
EOF
  [ "$bad" = "1" ] && { echo "   This .cdpk would fail OAuth M2M on GovCloud. NOT packaging."; exit 1; }
  [ "$any" = "0" ] && echo "   [warn] no @databricks/sql OAuth allowlist found to verify — GovCloud support UNVERIFIED."
  return 0
}

# --- reproducible install ---------------------------------------------------------------------
echo "-> npm ci (reproducible install from package-lock.json)..."
if ! ( cd "$NODEJS_DIR" && npm ci ); then
  echo "!! 'npm ci' failed. It needs package-lock.json + registry access (respects ~/.npmrc). Aborting."
  exit 1
fi
echo
echo "-> ensuring GovCloud OAuth allowlist (.mil/.us)..."
patch_govcloud_oauth "$NODEJS_DIR/node_modules"
guard_govcloud_oauth "$NODEJS_DIR/node_modules"
echo

# --- package ----------------------------------------------------------------------------------
mkdir -p "$DIST_DIR"
# Canonical name (== cdconfig.fileName) so it registers via the GUI and the script without a
# rename. The version is carried by the GitHub release tag + MANIFEST, not the filename.
CDPK_NAME="$CDPK_FILENAME"
CDPK_PATH="$DIST_DIR/$CDPK_NAME"
rm -f "$CDPK_PATH"
echo "-> packaging $CDPK_NAME ..."
# Same exact excludes as register-provider.sh / README (a broad '*.env*' would strip real
# node_modules files whose names contain '.env' and break the package).
if ! ( cd "$NODEJS_DIR" && zip -qr "$CDPK_PATH" \
      cdconfig.json package.json package-lock.json src/ node_modules/ \
      -x '.env' '.env.*' 'test/*' '*.md' ); then
  echo "!! zip failed."; exit 1
fi
[ -f "$CDPK_PATH" ] || { echo "!! expected $CDPK_PATH but it wasn't created."; exit 1; }

# --- checksum ---------------------------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$CDPK_PATH" | awk '{print $1}')
else SUM=$(shasum -a 256 "$CDPK_PATH" | awk '{print $1}'); fi
printf '%s  %s\n' "$SUM" "$CDPK_NAME" > "$CDPK_PATH.sha256"
SIZE=$(ls -lh "$CDPK_PATH" | awk '{print $5}')

# --- verify the packaged artifact actually carries the GovCloud allowlist (belt + suspenders) -
PKG_GOV=$(python3 - "$CDPK_PATH" <<'PY' 2>/dev/null || true
import sys, re, ast, zipfile
z = zipfile.ZipFile(sys.argv[1]); need = {'.cloud.databricks.mil', '.cloud.databricks.us'}; ok = None
for n in z.namelist():
    if n.endswith('OAuthManager.js') and 'DatabricksOAuth' in n:
        m = re.search(r'const awsDomains = (\[[^\]]*\])', z.read(n).decode('utf-8','replace'))
        try: arr = set(ast.literal_eval(m.group(1))) if m else set()
        except Exception: arr = set()
        ok = need.issubset(arr) if ok is None else (ok and need.issubset(arr))
print('yes' if ok else ('none' if ok is None else 'no'))
PY
)

# --- manifest ---------------------------------------------------------------------------------
MANIFEST="$DIST_DIR/MANIFEST-v${VERSION}.txt"
{
  echo "provider:        $PROVIDER_NAME"
  echo "version:         $VERSION"
  echo "artifact:        $CDPK_NAME"
  echo "sha256:          $SUM"
  echo "size:            $SIZE"
  echo "git:             ${GIT_SHA}${GIT_DIRTY}"
  echo "built (UTC):     $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "node used:       $(node -v 2>/dev/null)"
  echo "govcloud oauth:  allowlist includes .mil/.us -> $PKG_GOV"
  echo "native modules:  none required (lz4 optional, not compiled; falls back to pure JS)"
  echo "tested ArcGIS:   FILL IN (e.g. 11.4, 12.0) — smoke-test on each before publishing"
  echo "install:         download the .cdpk, verify sha256, then register-provider.sh option 2"
  echo "                 (auto-verifies the .sha256) or Server Manager > Add Custom Data Provider."
} > "$MANIFEST"

echo "   [ok] $CDPK_NAME ($SIZE)"
echo "   [ok] sha256: $SUM"
echo "   [ok] packaged GovCloud allowlist present: $PKG_GOV"
echo
echo "============================================================"
echo " Artifacts in dist/:"
echo "   $CDPK_NAME"
echo "   $CDPK_NAME.sha256"
echo "   $(basename "$MANIFEST")"
echo
echo " Fill in 'tested ArcGIS' in the manifest, then publish (GitHub only hosts the file):"
echo "   gh release create v${VERSION} \\"
echo "     \"$CDPK_PATH\" \\"
echo "     \"$CDPK_PATH.sha256\" \\"
echo "     \"$MANIFEST\" \\"
echo "     --title \"$PROVIDER_NAME v${VERSION}\" --notes \"Prebuilt CDF provider package.\""
echo "============================================================"
