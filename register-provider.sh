#!/usr/bin/env bash
#
# register-provider.sh — build and register (or update) the Databricks CDF provider.
#
# Companion to publish-service.sh. Where publish-service.sh creates individual Feature
# Services against an ALREADY-registered provider, this script does the one-time (or
# on-upgrade) job before that: it packages the provider as a .cdpk and registers it with
# ArcGIS Server via the admin API — build -> upload -> register/update -> restart -> verify.
#
# Runs on the ArcGIS Server box with only bash + curl + python3 (+ zip and a Node runtime
# when BUILDING). No JSON to hand-edit, works air-gapped. Safe to re-run.
#
# HOW TO RUN
#   Run it ON the ArcGIS Server box, as root (simplest) or the arcgis user:
#       sudo bash register-provider.sh
#   Root can read/write under the ArcGIS install tree and restart the server; a plain
#   user can still build + upload but may not be able to run the bundled Node or restart.
#
# NOTE ON INSTALL ROOT: ArcGIS Server lives under /opt/arcgis by default, but some sites
#   (e.g. hardened .mil boxes) install under /app/arcgis. This script auto-detects both and
#   prompts if it can't decide — the detected root drives the bundled-Node, log, and
#   stop/startserver.sh paths.
#
# NOTE ON UPGRADES: registering a name that already exists is refused by ArcGIS, so for an
#   existing provider this script calls `update` instead of `register`. An update RE-EXTRACTS
#   over the provider directory (wiping any .env inside it), and a FAILED update can delete
#   the live provider dir until a good package is registered — so it always asks first.
#
set -uo pipefail   # deliberately NOT -e: we handle and explain errors ourselves.

# --- --help / -h: print usage and exit (no server calls, no tool requirements) --
case "${1:-}" in
  -h|--help)
    echo "register-provider.sh — build and register/update the Databricks CDF provider."
    echo
    echo "  Run it ON the ArcGIS Server box, as root (simplest) or the arcgis user:"
    echo "      sudo bash register-provider.sh"
    echo
    echo "  It auto-detects the ArcGIS install root (/opt/arcgis or /app/arcgis), builds the"
    echo "  provider .cdpk from ./nodejs-provider (or takes an existing .cdpk), mints an admin"
    echo "  token, then register (first install) or update (upgrade) -> restart -> verify."
    echo
    echo "  Requires: bash, curl, python3 (all present on ArcGIS Server); plus zip and a Node"
    echo "  runtime only when building a fresh .cdpk. Works air-gapped."
    exit 0
    ;;
esac

# --- verify always-required tools (air-gapped: no external downloads) ----------
for _tool in python3 curl; do
  command -v "$_tool" >/dev/null 2>&1 || { echo "!! Required tool '$_tool' not found. Install it before running this script."; exit 1; }
done

PROVIDER_NAME="databricks-geospatial-provider"   # overridden below from cdconfig.json

# Shared curl invocation: -k for ArcGIS's self-signed cert (loopback-safe on the box),
# --noproxy so loopback calls are never routed through an ambient HTTPS_PROXY, and a
# connect timeout. The array means every call inherits these flags. Per-call --max-time
# is appended at each site.
CURL=(curl -sk --noproxy 'localhost,127.0.0.1,::1' --connect-timeout 10)

# Always clean up the password temp file. EXIT covers every exit path; INT/TERM also
# terminate (a trapped signal otherwise replaces the default terminate). SIGKILL can't
# be trapped.
_tmppass=""; MINT_RESP=""
_cleanup() { rm -f "${_tmppass}"; }
trap _cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- prompt helper: ask "Question" "default" VARNAME ---------------------------
ask() {
  local prompt="$1" def="$2" __var="$3" ans=""
  # A failed read = EOF / closed stdin (Ctrl-D, dry pipe, non-interactive run). Abort rather
  # than silently taking the default — this script has destructive confirmations (REGISTER /
  # UPDATE / restart) that must never proceed unattended on EOF.
  if [ -n "$def" ]; then
    if ! read -r -p "  $prompt [$def]: " ans; then echo; echo "!! Input closed (EOF) — aborting; nothing was changed." >&2; exit 130; fi
    ans="${ans:-$def}"
  else
    if ! read -r -p "  $prompt: " ans; then echo; echo "!! Input closed (EOF) — aborting; nothing was changed." >&2; exit 130; fi
  fi
  printf -v "$__var" '%s' "$ans"
}

# --- mint an ArcGIS admin token -------------------------------------------------
# Sets MINT_RESP to the raw JSON response. MUST be called as a plain statement, NOT in
# $(...): the password temp file is created here via the global _tmppass, and only when
# this runs in the parent shell can the EXIT/INT/TERM trap shred that file if a signal
# lands mid-mint. Only the curl is subshelled. Password never appears in argv (password@file).
mint_token() {   # sets MINT_RESP
  local client="$1" referer="${2:-}"
  _tmppass=$(mktemp); chmod 600 "$_tmppass"; printf '%s' "$ADMIN_PASS" > "$_tmppass"
  if [ -n "$referer" ]; then
    MINT_RESP=$("${CURL[@]}" --max-time 30 "$SERVER/$CTX/admin/generateToken" \
      --data-urlencode "username=$ADMIN_USER" --data-urlencode "password@$_tmppass" \
      --data-urlencode "client=$client" --data-urlencode "referer=$referer" \
      --data-urlencode "f=json")
  else
    MINT_RESP=$("${CURL[@]}" --max-time 30 "$SERVER/$CTX/admin/generateToken" \
      --data-urlencode "username=$ADMIN_USER" --data-urlencode "password@$_tmppass" \
      --data-urlencode "client=$client" --data-urlencode "f=json")
  fi
  rm -f "$_tmppass"; _tmppass=""
}

# --- run a command as the arcgis OS user (the server runs as arcgis) ------------
run_as_arcgis() {
  if [ "$(id -un 2>/dev/null)" = "arcgis" ]; then "$@"; else sudo -u arcgis "$@"; fi
}

# Where this script lives (repo root); the provider source is under nodejs-provider/.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODEJS_DIR="$SCRIPT_DIR/nodejs-provider"

echo "============================================================"
echo " Databricks CDF — Register / Update Provider"
echo "============================================================"
echo

# --- read the provider name from cdconfig.json (source of truth) ----------------
if [ -f "$NODEJS_DIR/cdconfig.json" ]; then
  _pn=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('name') or '')" "$NODEJS_DIR/cdconfig.json" 2>/dev/null)
  [ -n "$_pn" ] && PROVIDER_NAME="$_pn"
fi
echo "  Provider name (from cdconfig.json): $PROVIDER_NAME"
echo

# --- detect the ArcGIS install root (/opt/arcgis vs /app/arcgis) ----------------
echo "-- ArcGIS install root --"
ARCGIS_ROOT=""
_found=()
for _c in /opt/arcgis /app/arcgis; do
  if [ -e "$_c/server/startserver.sh" ] || [ -d "$_c/server/framework/runtime/node" ]; then
    _found+=("$_c")
  fi
done
if [ "${#_found[@]}" -eq 1 ]; then
  ARCGIS_ROOT="${_found[0]}"
  echo "  [ok]   detected: $ARCGIS_ROOT"
elif [ "${#_found[@]}" -gt 1 ]; then
  echo "  Multiple ArcGIS installs found:"
  _i=1; for _p in "${_found[@]}"; do echo "    $_i) $_p"; _i=$((_i+1)); done
  ask "  choose a number" "1" RPICK
  if printf '%s' "$RPICK" | grep -qE '^[1-9][0-9]*$' && [ "$RPICK" -ge 1 ] && [ "$RPICK" -le "${#_found[@]}" ]; then
    ARCGIS_ROOT="${_found[$((RPICK-1))]}"
  fi
fi
if [ -z "$ARCGIS_ROOT" ]; then
  ask "ArcGIS install root (the dir that contains 'server/')" "/opt/arcgis" ARCGIS_ROOT
fi
SERVER_DIR="$ARCGIS_ROOT/server"
BUNDLED_NODE="$SERVER_DIR/framework/runtime/node/bin/node"
BUNDLED_NPM="$SERVER_DIR/framework/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
PROVIDER_DIR="$SERVER_DIR/framework/runtime/customdata/providers/$PROVIDER_NAME"
if [ ! -e "$SERVER_DIR/startserver.sh" ]; then
  echo "  [warn] $SERVER_DIR/startserver.sh not found — restart/verify steps may not work."
  echo "         Double-check the install root if register/update or restart fails."
fi
echo "  -> using server dir: $SERVER_DIR"
echo

# --- choose: build a fresh .cdpk, or register an existing one -------------------
echo "-- Package --"
echo "  1) Build a fresh .cdpk from $NODEJS_DIR"
echo "  2) Register an existing .cdpk file"
ask "  choose 1-2" "1" PKGMODE
echo

CDPK_PATH=""
if [ "$PKGMODE" = "2" ]; then
  while :; do
    ask "Path to the .cdpk file" "" CDPK_PATH
    if [ -f "$CDPK_PATH" ]; then break; fi
    echo "   !! File not found — try again."
  done
  case "$CDPK_PATH" in
    *.cdpk) : ;;
    *) echo "   [warn] '$CDPK_PATH' does not end in .cdpk — continuing anyway." ;;
  esac
  # The SELECTED package's own cdconfig.json is the source of truth for the provider name — the
  # repo's cdconfig.json (read earlier) may differ or be absent. Reading it from the archive
  # keeps the register-vs-update decision, the provider directory, and the outage warnings
  # aligned with what actually gets installed.
  _pn_pkg=$(python3 - "$CDPK_PATH" <<'PY' 2>/dev/null || true
import sys, zipfile, json
try:
    z = zipfile.ZipFile(sys.argv[1])
    names = [n for n in z.namelist() if n.rsplit('/', 1)[-1] == 'cdconfig.json']
    names.sort(key=len)   # prefer the shallowest cdconfig.json
    if names:
        print((json.loads(z.read(names[0])) or {}).get('name') or '')
except Exception:
    pass
PY
)
  if [ -n "$_pn_pkg" ]; then
    if [ "$_pn_pkg" != "$PROVIDER_NAME" ]; then
      echo "   [info] the package declares provider name '$_pn_pkg' (repo/default was"
      echo "          '$PROVIDER_NAME') — using the package's name for register/update."
    fi
    PROVIDER_NAME="$_pn_pkg"
    PROVIDER_DIR="$SERVER_DIR/framework/runtime/customdata/providers/$PROVIDER_NAME"
  else
    echo "   [warn] could not read cdconfig.json from '$CDPK_PATH' — using '$PROVIDER_NAME'."
    echo "          If that's wrong, the register-vs-update choice below may be incorrect."
  fi
else
  # --- build the .cdpk ----------------------------------------------------------
  command -v zip >/dev/null 2>&1 || { echo "!! 'zip' is required to build a .cdpk (choose option 2 to register a prebuilt one instead)."; exit 1; }
  [ -f "$NODEJS_DIR/cdconfig.json" ] || { echo "!! $NODEJS_DIR/cdconfig.json not found — run this script from the repo root (it expects ./nodejs-provider)."; exit 1; }

  echo "-> installing dependencies (npm install)..."
  # Prefer the ArcGIS bundled Node so native modules compile against the exact runtime the
  # CDF host uses. Fall back to system npm if the bundled Node isn't usable (e.g. running as
  # a user who can't execute the arcgis-owned, mode-700 binary).
  _npm_ok=0
  if [ -x "$BUNDLED_NODE" ] && [ -f "$BUNDLED_NPM" ]; then
    if ( cd "$NODEJS_DIR" && "$BUNDLED_NODE" "$BUNDLED_NPM" install ); then
      _npm_ok=1; echo "   [ok] installed with the ArcGIS bundled Node."
    else
      echo "   [info] bundled Node install failed (often a permissions issue — try 'sudo -u arcgis',"
      echo "          or run this script as root). Falling back to system npm..."
    fi
  else
    echo "   [info] ArcGIS bundled Node not found at $BUNDLED_NODE — trying system npm..."
  fi
  if [ "$_npm_ok" != "1" ]; then
    if command -v npm >/dev/null 2>&1 && ( cd "$NODEJS_DIR" && npm install ); then
      _npm_ok=1; echo "   [ok] installed with system npm."
      echo "   [warn] built with system Node, not the ArcGIS bundled Node — if the provider fails to"
      echo "          load at register time with a native-module error, rebuild with the bundled Node."
    fi
  fi
  [ "$_npm_ok" = "1" ] || { echo "!! Could not run 'npm install' with either the bundled Node or system npm. Install deps manually, then re-run and choose option 2."; exit 1; }

  # Keep the .env excludes EXACTLY as written. A wildcard like '*.env*' would also strip
  # node_modules files whose names contain ".env" (e.g. @dabh/diagnostics/.../process.env.js),
  # breaking the package with "Cannot find module '../adapters/process.env'" at register time.
  CDPK_PATH="$NODEJS_DIR/$PROVIDER_NAME.cdpk"
  rm -f "$CDPK_PATH"   # don't append to a stale archive
  echo "-> packaging $PROVIDER_NAME.cdpk..."
  if ! ( cd "$NODEJS_DIR" && zip -qr "$PROVIDER_NAME.cdpk" \
        cdconfig.json package.json package-lock.json src/ node_modules/ \
        -x '.env' '.env.*' 'test/*' '*.md' ); then
    echo "!! zip failed — nothing packaged."; exit 1
  fi
  [ -f "$CDPK_PATH" ] || { echo "!! Expected $CDPK_PATH but it wasn't created."; exit 1; }
  echo "   [ok] built $CDPK_PATH"
fi
echo

# --- ArcGIS connection + admin token --------------------------------------------
echo "-- ArcGIS connection --"
ask "Admin URL (on the box use https://localhost:6443)" "https://localhost:6443" SERVER
ask "URL context (arcgis for :6443; the web-adaptor name otherwise)" "arcgis" CTX
ask "Admin username" "siteadmin" ADMIN_USER
if ! read -r -s -p "  Admin password: " ADMIN_PASS; then echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi
echo
echo

echo "-> requesting admin token (client=requestip)..."
mint_token requestip; TOKEN_RESP="$MINT_RESP"
TOKEN=$(printf '%s' "$TOKEN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token') or '')" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "!! No token was returned. The server said:"
  printf '%s\n' "$TOKEN_RESP" | head -c 2000; echo
  echo
  echo "   Common causes:"
  echo "   - HTML / redirect  => you went through the web adaptor; run ON the box with"
  echo "       Admin URL = https://localhost:6443  and context = arcgis."
  echo "   - 'Invalid username or password'  => wrong admin credentials."
  echo "   - connection refused / timeout    => ArcGIS Server not running on that port."
  exit 1
fi
echo "   ok (token ${TOKEN:0:10}...)."
echo

# --- is the provider already registered? (decides register vs update) -----------
echo "-> checking whether '$PROVIDER_NAME' is already registered..."
PROV_JSON=$("${CURL[@]}" --max-time 30 "$SERVER/$CTX/admin/services/types/customdataproviders" \
  --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
ALREADY=$(printf '%s' "$PROV_JSON" | PROVIDER_NAME="$PROVIDER_NAME" python3 -c "
import sys,json,os
target=os.environ['PROVIDER_NAME']
try: d=json.load(sys.stdin)
except Exception: print('unknown'); sys.exit()
names=[]
if isinstance(d,dict):
    for entries in d.values():
        if isinstance(entries,list):
            for e in entries:
                if isinstance(e,dict) and e.get('type')=='provider' and e.get('name'):
                    names.append(e['name'])
print('yes' if target in names else 'no')
" 2>/dev/null)

case "$ALREADY" in
  yes)
    ACTION="update"
    echo "   '$PROVIDER_NAME' is already registered — this will be an UPDATE (upgrade)."
    echo
    echo "   [!] An update RE-EXTRACTS over $PROVIDER_DIR"
    echo "       — any .env inside it is wiped (credentials in .databrickscfg / init_user_param.sh"
    echo "       are safe; they live elsewhere). A FAILED update can delete that dir until a good"
    echo "       package is registered, so existing services may 404 briefly during the upgrade."
    ask "   Proceed with UPDATE of '$PROVIDER_NAME'? (y/N)" "n" GO
    ;;
  no)
    ACTION="register"
    echo "   '$PROVIDER_NAME' is not registered yet — this will be a first-time REGISTER."
    ask "   Proceed with REGISTER of '$PROVIDER_NAME'? (Y/n)" "y" GO
    ;;
  *)
    echo "   [warn] could not read the provider list (unexpected response):"
    printf '%s\n' "$PROV_JSON" | head -c 500; echo
    echo "   Defaulting to REGISTER. If it fails with 'already registered', re-run — it will UPDATE."
    ACTION="register"
    ask "   Proceed with REGISTER of '$PROVIDER_NAME'? (y/N)" "n" GO
    ;;
esac
case "$GO" in y|Y|yes|YES) : ;; *) echo "Aborted — nothing changed."; exit 0;; esac
echo

# --- upload the .cdpk ------------------------------------------------------------
# The upload endpoint takes the file as multipart (-F). token+f go in the query string here
# (the documented working pattern for uploads) rather than --data-urlencode, which can't be
# mixed with -F. A large package upload gets a generous --max-time.
echo "-> uploading $(basename "$CDPK_PATH")..."
UPLOAD=$("${CURL[@]}" --max-time 600 "$SERVER/$CTX/admin/uploads/upload?token=$TOKEN&f=json" \
  -F "itemFile=@$CDPK_PATH")
ITEMID=$(printf '%s' "$UPLOAD" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('item') or {}).get('itemID') or '')" 2>/dev/null)
if [ -z "$ITEMID" ]; then
  echo "!! Upload did not return an itemID. The server said:"
  printf '%s\n' "$UPLOAD" | head -c 2000; echo
  exit 1
fi
echo "   ok (itemID ${ITEMID})."
echo

# --- rollback safety: snapshot the live provider dir before a destructive update ---------
# An update RE-EXTRACTS over the provider dir, and a FAILED update can leave it deleted until a
# good package is registered — 404ing every existing service. A cheap copy first gives a
# concrete rollback path. (register, i.e. first install, has no live dir to protect.)
BACKUP_DIR=""
if [ "$ACTION" = "update" ] && [ -d "$PROVIDER_DIR" ]; then
  BACKUP_DIR="${PROVIDER_DIR}.bak.$(date +%Y%m%d%H%M%S)"
  echo "-> backing up the current provider dir before update:"
  echo "     $PROVIDER_DIR  ->  $BACKUP_DIR"
  if run_as_arcgis cp -a "$PROVIDER_DIR" "$BACKUP_DIR" 2>/dev/null; then
    echo "   [ok] backup created."
  else
    echo "   [warn] could not create the backup (permissions?) — continuing WITHOUT a rollback copy."
    BACKUP_DIR=""
  fi
fi

# --- register or update ----------------------------------------------------------
echo "-> ${ACTION}ing the provider..."
RESP=$("${CURL[@]}" --max-time 120 "$SERVER/$CTX/admin/services/types/customdataproviders/$ACTION" \
  --data-urlencode "id=$ITEMID" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
STATUS=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','') )" 2>/dev/null)
if [ "$STATUS" = "success" ]; then
  echo "   [ok] $ACTION succeeded."
  [ -n "$BACKUP_DIR" ] && echo "   (pre-update backup kept at $BACKUP_DIR — remove it once the upgrade is confirmed working.)"
else
  echo "!! $ACTION did not report success. The server said:"
  printf '%s\n' "$RESP" | head -c 2000; echo
  if [ "$ACTION" = "update" ]; then
    echo "   [!] If this update FAILED, the provider directory may have been removed — existing"
    echo "       services will 404 until a good .cdpk is registered."
    if [ -n "$BACKUP_DIR" ]; then
      echo "   Rollback — restore the pre-update copy and restart:"
      echo "       sudo -u arcgis cp -a '$BACKUP_DIR' '$PROVIDER_DIR'"
      echo "       sudo -u arcgis $SERVER_DIR/stopserver.sh && sudo -u arcgis $SERVER_DIR/startserver.sh"
    else
      echo "       Re-run with a correct package to restore service."
    fi
  fi
  echo "   (Common: the .cdpk failed provider validation — check the server log for the module error,"
  echo "    e.g. a bad exclude that stripped a node_modules '.env'-named file.)"
  exit 1
fi
echo

# --- restart + verify -----------------------------------------------------------
echo "-- Restart --"
echo "  ArcGIS Server must restart to load the ${ACTION}ed provider."
echo "  Commands: $SERVER_DIR/stopserver.sh  then  $SERVER_DIR/startserver.sh  (as the arcgis user)"
ask "  Restart ArcGIS Server now? (y/N)" "n" DORESTART
RESTARTED=0
case "$DORESTART" in
  y|Y|yes|YES)
    echo "-> stopping..."; run_as_arcgis "$SERVER_DIR/stopserver.sh" || echo "   [warn] stopserver returned nonzero."
    echo "-> starting (this can take 1-2 minutes)..."; run_as_arcgis "$SERVER_DIR/startserver.sh" || echo "   [warn] startserver returned nonzero."
    RESTARTED=1
    ;;
  *)
    echo "  (not restarted — the provider is uploaded and ${ACTION}ed but WON'T be active until you"
    echo "   restart: $SERVER_DIR/stopserver.sh then $SERVER_DIR/startserver.sh)"
    ;;
esac
echo

if [ "$ACTION" = "update" ]; then
  echo "  Reminder: an update re-extracted the provider dir. If you keep a provider-local .env at"
  echo "  $PROVIDER_DIR/.env, re-create it now (or rely on init_user_param.sh, which survives)."
  echo
fi

# Verify the provider is listed (only meaningful after a restart / when it was already loaded).
echo "-> verifying the provider is registered..."
VERIFIED="unknown"
if [ "$RESTARTED" = "1" ]; then
  # startserver.sh returns BEFORE the admin API is back up (the server needs ~1-2 min more), and
  # the pre-restart token is now invalid. Poll for readiness by re-minting, up to ~2 min, so the
  # verify below reflects reality instead of racing the restart and always warning "not yet".
  echo "   (waiting for the admin API to come back up after restart — up to ~2 min)"
  TOKEN=""
  for _a in $(seq 1 12); do
    mint_token requestip
    TOKEN=$(printf '%s' "$MINT_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token') or '')" 2>/dev/null)
    [ -n "$TOKEN" ] && { echo "   [ok] admin API is back (after ~$(( (_a-1)*10 ))s)."; break; }
    sleep 10
  done
  [ -z "$TOKEN" ] && echo "   [warn] admin API still not answering after ~2 min."
fi
if [ -n "$TOKEN" ]; then
  VER_JSON=$("${CURL[@]}" --max-time 30 "$SERVER/$CTX/admin/services/types/customdataproviders" \
    --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  VER=$(printf '%s' "$VER_JSON" | PROVIDER_NAME="$PROVIDER_NAME" python3 -c "
import sys,json,os
target=os.environ['PROVIDER_NAME']
try: d=json.load(sys.stdin)
except Exception: print('unknown'); sys.exit()
names=[]
if isinstance(d,dict):
    for entries in d.values():
        if isinstance(entries,list):
            for e in entries:
                if isinstance(e,dict) and e.get('type')=='provider' and e.get('name'):
                    names.append(e['name'])
print('yes' if target in names else 'no')
" 2>/dev/null)
  case "$VER" in
    yes) VERIFIED="yes"; echo "   [ok] '$PROVIDER_NAME' is registered." ;;
    no)  VERIFIED="no";  echo "   [warn] '$PROVIDER_NAME' not in the provider list yet."
         [ "$RESTARTED" = "1" ] || echo "          (expected — you haven't restarted yet.)" ;;
    *)   VERIFIED="unknown"; echo "   [warn] could not read the provider list to confirm." ;;
  esac
else
  VERIFIED="pending"
  echo "   [warn] no valid token to verify with (server may still be starting) — check Server Manager,"
  echo "          or re-run diagnose-service.sh shortly to confirm the provider loaded."
fi
echo

# Distinct, honest end states — and a nonzero exit when a restart happened but the provider
# could not be confirmed, so callers/CI don't read the banner as success.
echo "============================================================"
if [ "$RESTARTED" != "1" ]; then
  echo " ${ACTION^} uploaded — NOT active yet. Restart to load it:"
  echo "   sudo -u arcgis $SERVER_DIR/stopserver.sh && sudo -u arcgis $SERVER_DIR/startserver.sh"
  RC=0
else
  case "$VERIFIED" in
    yes)     echo " Done — provider '$PROVIDER_NAME' ${ACTION}ed and verified active."; RC=0 ;;
    pending) echo " ${ACTION^} + restart done — server still starting; provider NOT yet confirmed."; RC=2 ;;
    no)      echo " ${ACTION^} done but '$PROVIDER_NAME' is NOT in the provider list — check the server log."; RC=2 ;;
    *)       echo " ${ACTION^} done — verification INCONCLUSIVE (couldn't read the provider list)."; RC=2 ;;
  esac
fi
echo " Next: publish tables against it with publish-service.sh."
echo "============================================================"
exit "$RC"
