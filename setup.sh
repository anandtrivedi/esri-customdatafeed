#!/usr/bin/env bash
#
# setup.sh — one front door for deploying/operating the Databricks CDF provider on ArcGIS Server.
#
# It is a ROUTER, not a monolith: it detects the live state of the box (provider registered? config
# present + correct perms? services? standalone or federated? /opt or /app?), prints what it found
# WITH the fix for anything missing, then hands off to the focused scripts you already have —
# register-provider.sh, configure-databricks.sh, publish-service.sh, diagnose-service.sh — or does
# a small permissions toggle itself. State is read live every time (no checkpoint file to go stale).
#
# It collects the ArcGIS admin login ONCE and passes it to the child scripts (password via a
# mode-600 temp file, never on a command line or in the environment), so a full install doesn't
# make you retype it. Run it ON the ArcGIS Server box, as root (simplest) or the arcgis user:
#
#   sudo bash setup.sh          # or: bash setup.sh --help
#
set -uo pipefail

case "${1:-}" in
  -h|--help)
    echo "setup.sh — guided front door for the Databricks CDF provider on ArcGIS Server."
    echo "  Run on the box: sudo bash setup.sh"
    echo "  Detects state (provider / .databrickscfg / services / federation / install root), guides"
    echo "  fixes, then routes to register-provider.sh / configure-databricks.sh / publish-service.sh /"
    echo "  diagnose-service.sh — collecting the ArcGIS admin login once. Read-only until you pick an action."
    exit 0 ;;
esac

for _t in python3 curl; do command -v "$_t" >/dev/null 2>&1 || { echo "!! required tool '$_t' not found."; exit 1; }; done

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CURL=(curl -sk --noproxy 'localhost,127.0.0.1,::1' --connect-timeout 10)
# The provider this repo builds; detection reports it registered only if THIS name is present
# (not merely "some CDF provider"). Read from cdconfig.json if the source is alongside, else default.
EXPECTED_PROVIDER="databricks-geospatial-provider"
if [ -f "$SCRIPT_DIR/nodejs-provider/cdconfig.json" ]; then
  _en=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('name') or '')" "$SCRIPT_DIR/nodejs-provider/cdconfig.json" 2>/dev/null)
  [ -n "$_en" ] && EXPECTED_PROVIDER="$_en"
fi

# Password temp file for the child-script handoff; shredded on any exit.
PASSFILE=""; _INT=0
_cleanup() { [ -n "$PASSFILE" ] && rm -f "$PASSFILE"; }
trap _cleanup EXIT
trap 'exit 143' TERM
# Ctrl-C sets a flag (checked at the menu) so it returns to the menu rather than killing setup;
# a child script's own INT trap exits the child. stty echo guards a Ctrl-C during a hidden read.
trap 'stty echo 2>/dev/null; _INT=1; echo; echo "(interrupted)"' INT

ask() {
  local prompt="$1" def="$2" __var="$3" ans=""
  if [ -n "$def" ]; then
    if ! read -r -p "  $prompt [$def]: " ans; then echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi
    ans="${ans:-$def}"
  else
    if ! read -r -p "  $prompt: " ans; then echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi
  fi
  printf -v "$__var" '%s' "$ans"
}
jget() { RESP="$1" python3 -c "import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: raise SystemExit
print($2)" 2>/dev/null || true; }
ask_int() {   # prompt default varname lo hi
  local _p="$1" _d="$2" _v="$3" _lo="$4" _hi="$5" _x=""
  while :; do
    ask "$_p" "$_d" _x
    if printf '%s' "$_x" | grep -qE '^[0-9]+$' && [ "$_x" -ge "$_lo" ] && [ "$_x" -le "$_hi" ]; then printf -v "$_v" '%s' "$_x"; return; fi
    echo "   !! enter a whole number between $_lo and $_hi."
  done
}

echo "============================================================"
echo " Databricks CDF — guided setup for ArcGIS Server"
echo "============================================================"

# --- privilege + install root (local, no login) ---------------------------------
ME=$(id -un 2>/dev/null); MYUID=$(id -u 2>/dev/null)
# Only root or the arcgis user can register/restart. We launch children directly (not wrapped in
# sudo -u arcgis), so "can sudo to arcgis" is NOT sufficient — anything else is treated as limited.
if [ "$ME" = "arcgis" ]; then PRIV="arcgis"
elif [ "$MYUID" = "0" ]; then PRIV="root"
else PRIV="limited"; fi

ARCGIS_ROOT=""; _found=()
# Candidate roots: the classic /opt & /app, PLUS home-directory installs — the Linux installer
# defaults to the installing user's HOME (e.g. /home/arcgis or /home/arcgis/arcgis) when no path
# is given, so also probe the arcgis account's home and the current $HOME.
_cands=(/opt/arcgis /app/arcgis)
_ahome=$(getent passwd arcgis 2>/dev/null | cut -d: -f6)
[ -n "$_ahome" ] && _cands+=("$_ahome" "$_ahome/arcgis")
[ -n "${HOME:-}" ] && _cands+=("$HOME" "$HOME/arcgis")
for _c in "${_cands[@]}"; do
  { [ -e "$_c/server/startserver.sh" ] || [ -d "$_c/server/framework/runtime/node" ]; } || continue
  case " ${_found[*]} " in *" $_c "*) ;; *) _found+=("$_c") ;; esac   # dedupe
done
if [ "${#_found[@]}" -eq 1 ]; then ARCGIS_ROOT="${_found[0]}"
elif [ "${#_found[@]}" -gt 1 ]; then ARCGIS_ROOT="${_found[0]}"; ROOT_AMBIGUOUS=1; fi

echo
echo "== Precheck (Tier 1 — local) =="
echo "  running as        : $ME  (privilege: $PRIV)"
if [ "$PRIV" = "limited" ]; then
  echo "     [warn] not root and can't sudo to arcgis — Register / Full install (which restart the"
  echo "            server) will fail. Re-run with: sudo bash setup.sh"
fi
if [ -n "$ARCGIS_ROOT" ]; then
  echo "  ArcGIS install    : $ARCGIS_ROOT${ROOT_AMBIGUOUS:+  [warn] both /opt and /app exist — using $ARCGIS_ROOT; override below if wrong]}"
else
  echo "  ArcGIS install    : [warn] not found under /opt/arcgis, /app/arcgis, or the arcgis user's home"
  ask "ArcGIS install root (dir containing server/)" "/opt/arcgis" ARCGIS_ROOT
fi
SERVER_DIR="$ARCGIS_ROOT/server"

# tools that only matter for building a .cdpk / CLI niceties
_tool_report=""
for _t in git npm zip databricks; do command -v "$_t" >/dev/null 2>&1 && _tool_report+="$_t " || _tool_report+="(no)$_t "; done
echo "  build/CLI tools   : $_tool_report"
command -v databricks >/dev/null 2>&1 || echo "     [info] Databricks CLI absent — optional; it enables warehouse/column auto-detect and grant help."
command -v npm >/dev/null 2>&1 || echo "     [info] npm absent — you can't BUILD a .cdpk here; register a prebuilt one (register-provider.sh option 2)."

# .databrickscfg local checks (existence / owner / perms) — no login needed. In a function so
# re-detection after 'Configure' reflects the new state (existence AND owner/perms, not just presence).
CFG="${DATABRICKS_CONFIG_FILE:-/home/arcgis/.databrickscfg}"
CFG_STATE="absent"
check_config() {
  if [ -f "$CFG" ]; then
    local o p; o=$(stat -c '%U' "$CFG" 2>/dev/null || stat -f '%Su' "$CFG" 2>/dev/null); p=$(stat -c '%a' "$CFG" 2>/dev/null || stat -f '%Lp' "$CFG" 2>/dev/null)
    if [ "$o" = "arcgis" ] && { [ "$p" = "600" ] || [ "$p" = "400" ]; }; then CFG_STATE="ok"; CFG_DETAIL="$CFG (owner $o, mode $p)"
    else CFG_STATE="badperms"; CFG_DETAIL="$CFG (owner ${o:-?}, mode ${p:-?})"; CFG_OWNER="$o"; CFG_PERMS="$p"; fi
  else CFG_STATE="absent"; CFG_DETAIL="not found at $CFG"; fi
}
check_config
if [ "$CFG_STATE" = "ok" ]; then echo "  .databrickscfg    : $CFG_DETAIL [ok]"
elif [ "$CFG_STATE" = "badperms" ]; then
  echo "  .databrickscfg    : $CFG_DETAIL [WARN]"
  [ "${CFG_OWNER:-}" != "arcgis" ] && echo "     -> the provider runs as arcgis and can't read this. Fix: sudo chown arcgis:arcgis $CFG"
  { [ "${CFG_PERMS:-}" != "600" ] && [ "${CFG_PERMS:-}" != "400" ]; } && echo "     -> tighten perms: sudo chmod 600 $CFG"
else
  echo "  .databrickscfg    : not found at $CFG  [needs setup]"
  echo "     -> choose 'Configure the Databricks connection' below."
fi

# --- collect the ArcGIS admin login ONCE (needed for the server-side checks) -----
echo
echo "== ArcGIS admin login (collected once; reused for every action this session) =="
ask "Admin URL (on the box use https://localhost:6443)" "https://localhost:6443" ADMIN_URL
case "$ADMIN_URL" in
  *localhost*|*127.0.0.1*|*::1*) : ;;
  *) echo "     [warn] that's not a loopback URL. This tool skips TLS verification (-k), so send the"
     echo "            admin password to a REMOTE host only over a trusted network. On the box, use"
     echo "            https://localhost:6443 instead." ;;
esac
ask "URL context (arcgis for :6443; the web-adaptor name otherwise)" "arcgis" ADMIN_CTX
ask "Admin username" "siteadmin" ADMIN_USER
trap 'stty echo 2>/dev/null; _INT=1' INT
if ! read -r -s -p "  Admin password: " _pw; then stty echo 2>/dev/null; echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi; echo
PASSFILE=$(mktemp); chmod 600 "$PASSFILE"; printf '%s' "$_pw" > "$PASSFILE"; unset _pw
# Export the handoff so child scripts skip their own connection prompts.
export CDF_ADMIN_URL="$ADMIN_URL" CDF_ADMIN_CTX="$ADMIN_CTX" CDF_ADMIN_USER="$ADMIN_USER" CDF_ADMIN_PASSFILE="$PASSFILE"

TOKEN=""
mint_admin_token() {   # sets TOKEN from the passfile (requestip)
  local resp
  resp=$("${CURL[@]}" --max-time 30 "$ADMIN_URL/$ADMIN_CTX/admin/generateToken" \
    --data-urlencode "username=$ADMIN_USER" --data-urlencode "password@$PASSFILE" \
    --data-urlencode "client=requestip" --data-urlencode "f=json")
  TOKEN=$(jget "$resp" 'd.get("token") or ""')
}

# --- live detection (tri-state) --------------------------------------------------
PROV_STATE="unknown"; PROV_NAMES=""; SVC_STATE="unknown"; SVC_COUNT=0; FED_STATE="unknown"; FED_URL=""
detect() {
  mint_admin_token
  if [ -z "$TOKEN" ]; then PROV_STATE="unknown"; SVC_STATE="unknown"; FED_STATE="unknown"; return 1; fi
  # provider
  local presp pout
  presp=$("${CURL[@]}" --max-time 20 "$ADMIN_URL/$ADMIN_CTX/admin/services/types/customdataproviders" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  pout=$(RESP="$presp" python3 -c "
import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: print('err'); raise SystemExit
if not isinstance(d,dict) or 'error' in d: print('err'); raise SystemExit
n=[e['name'] for v in d.values() if isinstance(v,list) for e in v if isinstance(e,dict) and e.get('type')=='provider' and e.get('name')]
print('ok:'+' '.join(n))" 2>/dev/null)
  case "$pout" in
    ok:*) PROV_NAMES="${pout#ok:}"
          # "yes" means OUR provider specifically — not just that some CDF provider exists.
          if printf ' %s ' "$PROV_NAMES" | grep -q " $EXPECTED_PROVIDER "; then PROV_STATE="yes"
          elif [ -n "$PROV_NAMES" ]; then PROV_STATE="other"
          else PROV_STATE="no"; fi ;;
    *) PROV_STATE="unknown" ;;
  esac
  # federation — only trust the result if the response is a dict WITHOUT an error.
  local iresp okinfo
  iresp=$("${CURL[@]}" --max-time 15 -G "$ADMIN_URL/$ADMIN_CTX/rest/info" --data-urlencode "f=json")
  FED_URL=$(jget "$iresp" '(d.get("owningSystemUrl") or "").strip()')
  okinfo=$(jget "$iresp" "'yes' if (isinstance(d,dict) and 'error' not in d) else 'no'")
  if [ "$okinfo" = "yes" ]; then
    [ -n "$FED_URL" ] && FED_STATE="federated" || FED_STATE="standalone"
  else FED_STATE="unknown"; fi
  check_config
  # CDF services (root + folders), count provider==CUSTOMDATA
  local sresp
  sresp=$("${CURL[@]}" --max-time 20 "$ADMIN_URL/$ADMIN_CTX/admin/services" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  local cnt
  cnt=$(RESP="$sresp" ADMIN_URL="$ADMIN_URL" ADMIN_CTX="$ADMIN_CTX" TOKEN="$TOKEN" python3 <<'PY' 2>/dev/null
import os,json,urllib.request,ssl
base=os.environ['ADMIN_URL']+'/'+os.environ['ADMIN_CTX']+'/admin/services'; tok=os.environ['TOKEN']
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
def count(js):
    # The admin /services LIST doesn't carry the provider field (only per-service detail does), so
    # we count feature services total — an exact CDF-only count would need a call per service.
    return sum(1 for s in js.get('services',[]) if str(s.get('type','')).endswith('FeatureServer'))
try: root=json.loads(os.environ['RESP'])
except Exception: print('err'); raise SystemExit
if not isinstance(root,dict) or 'error' in root: print('err'); raise SystemExit
n=count(root)
for f in root.get('folders',[]) or []:
    if f in ('System','Utilities'): continue
    try:
        req=urllib.request.Request(base+'/'+f+'?token='+tok+'&f=json')
        n+=count(json.loads(urllib.request.urlopen(req,context=ctx,timeout=15).read().decode()))
    except Exception: pass
print('ok:%d'%n)
PY
)
  case "$cnt" in ok:*) SVC_COUNT="${cnt#ok:}"; SVC_STATE="ok";; *) SVC_STATE="unknown"; SVC_COUNT=0;; esac
}

print_state() {
  echo
  echo "== Detected state (Tier 2 — server) =="
  case "$PROV_STATE" in
    yes)   echo "  CDF provider      : '$EXPECTED_PROVIDER' registered [ok]";;
    other) echo "  CDF provider      : '$EXPECTED_PROVIDER' NOT registered (other providers present: $PROV_NAMES)"
           echo "                      -> choose 'Register / update the provider'";;
    no)    echo "  CDF provider      : NOT registered  -> choose 'Register / update the provider'";;
    *)     echo "  CDF provider      : unknown (couldn't read the admin API — bad login / server down / timeout)";;
  esac
  case "$SVC_STATE" in
    ok)  echo "  feature services  : $SVC_COUNT on this server (total; not all are necessarily CDF — use Diagnose for a given one)";;
    *)   echo "  feature services  : unknown";;
  esac
  case "$FED_STATE" in
    federated) echo "  server topology   : FEDERATED (Portal: $FED_URL) — service access is governed by Portal item sharing";;
    standalone)echo "  server topology   : standalone";;
    *)         echo "  server topology   : unknown";;
  esac
  echo "  Databricks config : $CFG_STATE $( [ "$CFG_STATE" = ok ] && echo '[ok]' || echo '[needs attention — see Tier 1 above]')"
}

# child runner: inherits the terminal; treat ANY exit as "re-detect + back to menu". On failure it
# points at the manual fallback — you can always run the script directly or follow the README.
run_child() {   # $1 = script name (relative to SCRIPT_DIR), rest = args
  local s="$1"; shift || true
  if [ ! -f "$SCRIPT_DIR/$s" ]; then
    echo "!! $s not found next to setup.sh — run it from the repo, or follow the manual steps in the README."; return 1
  fi
  echo; echo "-> launching $s ..."; echo "------------------------------------------------------------"
  bash "$SCRIPT_DIR/$s" "$@"; local rc=$?
  echo "------------------------------------------------------------"
  if [ "$rc" -eq 0 ]; then
    echo "-> $s finished (ok)."
  else
    local ref
    case "$s" in
      configure-databricks.sh) ref="README - 'Configure the Databricks connection'";;
      register-provider.sh)    ref="README - 'Register the provider'";;
      publish-service.sh)      ref="README - 'Publish a feature service'";;
      diagnose-service.sh)     ref="README - 'Troubleshooting'";;
      *)                       ref="the matching section in the repo README";;
    esac
    echo "-> $s did NOT complete (status $rc). Nothing is stuck — the menu re-checks the server"
    echo "   state below, so you can fix the one thing it reported and pick this step again."
    echo "   Do it by hand instead: $ref.   (Full output: run  bash $s  directly.)"
  fi
  return "$rc"
}

# Re-enter the ArcGIS admin login mid-session (e.g. after a wrong password) — rewrites the passfile.
relogin() {
  echo "== Re-enter ArcGIS admin login =="
  ask "Admin URL" "$ADMIN_URL" ADMIN_URL
  ask "URL context" "$ADMIN_CTX" ADMIN_CTX
  ask "Admin username" "$ADMIN_USER" ADMIN_USER
  trap 'stty echo 2>/dev/null; _INT=1' INT
  if ! read -r -s -p "  Admin password: " _pw; then stty echo 2>/dev/null; echo; echo "(cancelled)"; trap 'stty echo 2>/dev/null; _INT=1; echo; echo "(interrupted)"' INT; return; fi; echo
  trap 'stty echo 2>/dev/null; _INT=1; echo; echo "(interrupted)"' INT
  printf '%s' "$_pw" > "$PASSFILE"; chmod 600 "$PASSFILE"; unset _pw
  export CDF_ADMIN_URL="$ADMIN_URL" CDF_ADMIN_CTX="$ADMIN_CTX" CDF_ADMIN_USER="$ADMIN_USER"
  echo "  (updated — re-running detection)"
}

# server-ready gate: after a restart the admin API returns before it accepts connections.
wait_server_ready() {
  echo "-> waiting for the ArcGIS admin API to be ready..."
  local i
  for i in $(seq 1 18); do
    mint_admin_token; [ -n "$TOKEN" ] && { echo "   [ok] server ready."; return 0; }
    sleep 10
  done
  echo "   [warn] admin API still not answering after ~3 min."; return 1
}

# --- private/public toggle (reuses the esriEveryone permission lever) ------------
toggle_privacy() {
  local svc mode principal isallowed
  ask "Service name to change (folder/name if foldered)" "" svc
  [ -n "$svc" ] || { echo "  (no service name — skipped)"; return; }
  echo "  1) make PRIVATE (deny anonymous 'esriEveryone')   2) make PUBLIC (allow anonymous)"
  ask "  choose 1-2" "1" mode
  case "$mode" in 2) isallowed="true";; *) isallowed="false";; esac
  mint_admin_token
  local resp st
  resp=$("${CURL[@]}" --max-time 30 -X POST "$ADMIN_URL/$ADMIN_CTX/admin/services/$svc.FeatureServer/permissions/add" \
    --data-urlencode "principal=esriEveryone" --data-urlencode "isAllowed=$isallowed" \
    --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  st=$(jget "$resp" 'd.get("status") or ""')
  if [ "$st" = "success" ]; then
    [ "$isallowed" = "false" ] && echo "  [ok] '$svc' set PRIVATE (anonymous denied)." || echo "  [ok] '$svc' set PUBLIC (anonymous allowed)."
    if [ "$FED_STATE" = "federated" ]; then
      echo "  [!] FEDERATED server — this server-level change is NOT the authoritative control here."
      echo "      To actually change visibility, set the Portal item's sharing:"
      echo "      In Portal ($FED_URL): Content > the '$svc' item > Share >"
      [ "$isallowed" = "false" ] && echo "        UNCHECK 'Everyone (public)' (and 'All org' for fully private)." \
                                 || echo "        CHECK 'Everyone (public)' to make it publicly visible."
      echo "      (Menu option 'F' prints these steps again anytime.)"
    fi
    # confirm with a token-less probe
    local anon as
    anon=$("${CURL[@]}" --max-time 20 -G "$ADMIN_URL/$ADMIN_CTX/rest/services/$svc/FeatureServer/0/query" --data-urlencode "where=1=1" --data-urlencode "resultRecordCount=1" --data-urlencode "f=json")
    as=$(jget "$anon" "'open' if ('features' in d and 'error' not in d) else 'protected'")
    echo "  anonymous probe: ${as:-unknown}"
  else
    echo "  !! could not change permissions (status='${st:-error}'): $(printf '%s' "$resp" | head -c 200)"
  fi
}

# --- edit an existing service's instance sizing IN PLACE (no delete/republish) ---
# Changes minInstancesPerNode / maxInstancesPerNode / maxIdleTime via the admin 'edit' endpoint,
# preserving the service's identity, URL, and Portal item — the safe way to fix the min=0
# intermittent-404 or tune warm capacity on an already-published service.
edit_sizing() {
  local svc cur found cmin cmax cidle nmin nmax nidle newjson resp st
  ask "Service name to resize (folder/name if foldered)" "" svc
  [ -n "$svc" ] || { echo "  (no service name — skipped)"; return; }
  mint_admin_token
  cur=$("${CURL[@]}" --max-time 30 "$ADMIN_URL/$ADMIN_CTX/admin/services/$svc.FeatureServer" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  found=$(jget "$cur" "'no' if (not isinstance(d,dict) or d.get('status')=='error' or 'error' in d) else 'yes'")
  [ "$found" = "yes" ] || { echo "  !! service '$svc' not found (or unreadable): $(jget "$cur" 'd.get("messages") or (d.get("error") or {}).get("message") or "?"')"; return; }
  cmin=$(jget "$cur" 'd.get("minInstancesPerNode")'); cmax=$(jget "$cur" 'd.get("maxInstancesPerNode")'); cidle=$(jget "$cur" 'd.get("maxIdleTime")')
  echo "  current: minInstancesPerNode=$cmin  maxInstancesPerNode=$cmax  maxIdleTime=${cidle}s"
  ask_int "new min instances per node (0 = shared pool; 1+ keeps a warm instance)" "${cmin:-1}" nmin 0 50
  while :; do ask_int "new max instances per node (>= min, at least 1)" "${cmax:-2}" nmax 1 100; [ "$nmax" -ge "$nmin" ] && break; echo "   !! max must be >= min ($nmin)."; done
  ask_int "maxIdleTime seconds (how long a warm instance survives idle)" "${cidle:-1800}" nidle 60 86400
  # Modify the FULL service JSON and POST it back to /edit (the endpoint replaces the definition).
  newjson=$(CUR="$cur" NMIN="$nmin" NMAX="$nmax" NIDLE="$nidle" python3 -c "
import os,json
d=json.loads(os.environ['CUR'])
for k in ('status','permissions','iteminfo'):    # drop read-only echoes the edit endpoint rejects
    d.pop(k, None)
d['minInstancesPerNode']=int(os.environ['NMIN']); d['maxInstancesPerNode']=int(os.environ['NMAX']); d['maxIdleTime']=int(os.environ['NIDLE'])
print(json.dumps(d))" 2>/dev/null)
  [ -n "$newjson" ] || { echo "  !! could not build the edited definition."; return; }
  echo "  applying: min=$nmin max=$nmax maxIdleTime=${nidle}s ..."
  resp=$("${CURL[@]}" --max-time 60 "$ADMIN_URL/$ADMIN_CTX/admin/services/$svc.FeatureServer/edit" \
    --data-urlencode "service=$newjson" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  st=$(jget "$resp" 'd.get("status") or ""')
  if [ "$st" = "success" ]; then
    # read back to confirm the change took (the edit usually restarts the service to apply it)
    local vr
    vr=$("${CURL[@]}" --max-time 30 "$ADMIN_URL/$ADMIN_CTX/admin/services/$svc.FeatureServer" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
    echo "  [ok] edited — now: min=$(jget "$vr" 'd.get("minInstancesPerNode")') max=$(jget "$vr" 'd.get("maxInstancesPerNode")') maxIdleTime=$(jget "$vr" 'd.get("maxIdleTime")')s"
    echo "  (identity/URL/Portal item are unchanged — no republish needed.)"
  else
    echo "  !! edit did not succeed (status='${st:-error}'): $(printf '%s' "$resp" | head -c 300)"
    echo "  Manual fallback: in Server Manager, open $svc > Pooling, set Min/Max instances, Save."
  fi
}

# --- federated help: exact steps when the automated verify/lock-down can't apply -
federated_help() {
  echo
  echo "== Federated ArcGIS Enterprise — specific steps =="
  echo "  This server is federated to Portal: ${FED_URL:-<owningSystemUrl>}"
  echo "  On a federated server two things differ from standalone, and the automated checks here"
  echo "  can't fully cover them — do these by hand:"
  echo
  echo "  1) VERIFY a service actually serves data (REST /query needs a PORTAL token, not the"
  echo "     server admin token this tool mints). Either:"
  echo "     a) In Portal ($FED_URL): Content > find the service item > open it > add to a new Map."
  echo "        If the layer draws, the service works."
  echo "     b) Or mint a Portal token and query with it (run on the box; use a PORTAL account):"
  echo "        PT=\$(curl -sk '$FED_URL/sharing/rest/generateToken' \\"
  echo "              --data-urlencode 'username=<portalUser>' --data-urlencode 'password=<pw>' \\"
  echo "              --data-urlencode 'referer=$FED_URL' --data-urlencode 'f=json' \\"
  echo "              | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])')"
  echo "        curl -sk '$ADMIN_URL/$ADMIN_CTX/rest/services/<svc>/FeatureServer/0/query' \\"
  echo "              --data-urlencode 'where=1=1' --data-urlencode 'resultRecordCount=1' \\"
  echo "              --data-urlencode \"token=\$PT\" --data-urlencode 'f=json'"
  echo
  echo "  2) Make a service PRIVATE. On federated, access is governed by PORTAL ITEM SHARING —"
  echo "     the server-level 'esriEveryone' deny (menu option 6) is NOT authoritative here."
  echo "     In Portal ($FED_URL): Content > find the service item > Share >"
  echo "     UNCHECK 'Everyone (public)' (and 'All org' if it should be private). That is the"
  echo "     authoritative control on a federated server."
  echo
}

# --- main loop -------------------------------------------------------------------
detect
while true; do
  print_state
  # state-adaptive default: not fully ready -> full install; provider registered AND config ok -> publish
  DEF="1"
  { [ "$PROV_STATE" != "yes" ] || [ "$CFG_STATE" != "ok" ]; } && DEF="5"
  # Options 2/3/5 change the box and need root or the arcgis user.
  local_note=""; [ "$PRIV" = "limited" ] && local_note="  [needs root/arcgis — re-run with sudo]"
  echo
  echo "== What would you like to do? =="
  echo "  1) Publish a table as a new feature service   $( [ "$PROV_STATE" != yes ] && echo '(needs the provider registered first)')"
  echo "  2) Configure the Databricks connection (.databrickscfg)$local_note"
  echo "  3) Register / update the CDF provider$local_note"
  echo "  4) Diagnose a feature service (read-only)"
  echo "  5) Full first-time setup (configure -> register -> publish)$local_note"
  echo "  6) Make an existing service private / public"
  echo "  9) Change a service's instance sizing (min/max/idle) — no republish"
  echo "  7) Re-run detection      8) Re-enter the ArcGIS admin login$( [ "$FED_STATE" = federated ] && echo '      F) Federated: how to verify / lock down a service' )"
  echo "  q) Quit"
  echo "  (Any step failing? Each maps to a script you can run directly — see the message it prints —"
  echo "   and to a matching manual step in the repo README.)"
  _INT=0
  if ! read -r -p "  choose [$DEF]: " CHOICE; then
    if [ "$_INT" = "1" ]; then _INT=0; echo; continue; fi   # Ctrl-C -> redraw the menu
    break                                                    # real EOF (closed stdin) -> quit
  fi
  CHOICE="${CHOICE:-$DEF}"
  case "$CHOICE" in
    1) run_child publish-service.sh || true; detect ;;
    2) if [ "$PRIV" = "limited" ]; then echo "  !! Configure writes /home/arcgis/.databrickscfg as arcgis — needs root/arcgis. Re-run with sudo."; else run_child configure-databricks.sh || true; fi; detect ;;
    3) if [ "$PRIV" = "limited" ]; then echo "  !! Register restarts the server — needs root/arcgis. Re-run with sudo."; else run_child register-provider.sh || true; fi; detect ;;
    4) run_child diagnose-service.sh || true; detect ;;
    5)
       if [ "$PRIV" = "limited" ]; then echo "  !! Full install needs root/arcgis (writes config, restarts the server). Re-run with sudo."; continue; fi
       echo; echo "== Full first-time setup =="
       echo "  Order matters: configure the connection BEFORE registering, so the provider reads it"
       echo "  when it restarts (it caches .databrickscfg at first read)."
       run_child configure-databricks.sh || { echo "-> configure step did not complete — chain stopped. Fix it (or do Step 3 manually per the README), then re-run."; detect; continue; }
       run_child register-provider.sh   || { echo "-> register step did not complete — chain stopped. Fix it (or do Step 2 manually per the README), then re-run."; detect; continue; }
       wait_server_ready || echo "   (continuing anyway — publish will retry the query)"
       run_child publish-service.sh      || echo "-> publish did not complete — run publish-service.sh again, or see the README's Step 4."
       detect ;;
    6) toggle_privacy; detect ;;
    9) edit_sizing; detect ;;
    7) detect ;;
    8) relogin; detect ;;
    F|f) federated_help ;;
    q|Q|quit|exit) break ;;
    *) echo "  (unrecognized choice)";;
  esac
done
echo
echo "Done. (Credentials removed.)"
