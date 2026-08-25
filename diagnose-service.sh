#!/usr/bin/env bash
#
# diagnose-service.sh — one-shot, READ-ONLY health check for a Databricks CDF
# feature service on ArcGIS Server. Makes no changes. bash + curl + python3 only.
#
# It mints its own admin token (hidden password prompt), reports the service's
# machines / provider / definition / status / instance statistics, and then prints a
# plain-English ASSESSMENT of the likely problem(s) so you don't have to interpret it.
#
# HOW TO RUN — on the ArcGIS Server box (as root or the arcgis user):
#   bash diagnose-service.sh
# Admin URLs default to https://localhost:6443, so run it on the box.
#
set -uo pipefail

case "${1:-}" in
  -h|--help)
    echo "diagnose-service.sh — read-only health check for a Databricks CDF feature service."
    echo "  Run on the ArcGIS Server box: bash diagnose-service.sh"
    echo "  Prompts for the admin connection + a service name, mints an admin token, reports"
    echo "  machines/provider/definition/status/instances, and prints an ASSESSMENT. No changes."
    exit 0 ;;
esac

for t in curl python3; do
  command -v "$t" >/dev/null 2>&1 || { echo "!! required tool '$t' not found"; exit 1; }
done

# loopback-safe curl: skip proxy for localhost, skip cert check (ArcGIS self-signed), timeouts
CURL=(curl -sk --noproxy 'localhost,127.0.0.1,::1' --connect-timeout 10 --max-time 30)

ask() {
  local prompt="$1" def="$2" __var="$3" ans=""
  if [ -n "$def" ]; then read -r -p "  $prompt [$def]: " ans; ans="${ans:-$def}"
  else read -r -p "  $prompt: " ans; fi
  printf -v "$__var" '%s' "$ans"
}
# jget <json> <python-expr using d>  -> prints the value (empty on any error)
jget() { RESP="$1" python3 -c "import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: raise SystemExit
print($2)" 2>/dev/null || true; }

echo "============================================================"
echo " ArcGIS CDF service diagnostic (READ-ONLY — makes no changes)"
echo "============================================================"
ask "Admin URL" "https://localhost:6443" SERVER
ask "URL context" "arcgis" CTX
ask "Admin username" "siteadmin" ADMINUSER
read -rs -p "  Admin password: " PW; echo
ask "Service name (without .FeatureServer)" "TEST_FeatureService_Databricks" SVC
echo

# --- mint admin token -----------------------------------------------------------
TRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/generateToken" \
  --data-urlencode "username=$ADMINUSER" --data-urlencode "password=$PW" \
  --data-urlencode "client=requestip" --data-urlencode "f=json")
unset PW
TOKEN=$(jget "$TRESP" 'd.get("token") or ""')
if [ -z "$TOKEN" ]; then
  echo "!! Could not mint an admin token. The server said:"
  printf '%s\n' "$TRESP" | head -c 600; echo
  echo "   Check the Admin URL / context / username / password and re-run."
  exit 1
fi
echo "[ok] admin token minted"
echo

# --- site machines --------------------------------------------------------------
echo "-- Site machines --"
MRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/machines?token=$TOKEN&f=json")
MACHINE_COUNT=$(jget "$MRESP" 'len(d.get("machines",[]))'); MACHINE_COUNT=${MACHINE_COUNT:-?}
echo "  count: $MACHINE_COUNT"
jget "$MRESP" '"\n".join("   - "+ (m.get("machineName") or "?") for m in d.get("machines",[]))'
echo

# --- registered CDF providers ---------------------------------------------------
echo "-- Registered CDF providers --"
PRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/services/types/customdataproviders?token=$TOKEN&f=json")
PROVS=$(RESP="$PRESP" python3 <<'PY' 2>/dev/null || true
import os,json
d=json.loads(os.environ["RESP"]); found=[]
if isinstance(d, dict):
    for v in d.values():
        if isinstance(v, list):
            for e in v:
                if isinstance(e, dict) and e.get("type")=="provider" and e.get("name"):
                    found.append(e["name"])
print(", ".join(found))
PY
)
echo "  ${PROVS:-(none registered)}"
echo

# --- service definition ---------------------------------------------------------
echo "-- Service definition: $SVC.FeatureServer --"
DRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/services/$SVC.FeatureServer?token=$TOKEN&f=json")
FOUND=$(jget "$DRESP" '"no" if (d.get("status")=="error" or "error" in d) else "yes"'); FOUND=${FOUND:-no}
if [ "$FOUND" != "yes" ]; then
  echo "  !! service not found / error:"
  jget "$DRESP" 'd.get("messages") or (d.get("error") or {}).get("message") or d'
  CSTATE=""; MININST=""; MAXINST=""; IDFIELD=""; TABLE=""; LBTABLE=""
else
  CSTATE=$(jget "$DRESP" 'd.get("configuredState") or ""')
  MININST=$(jget "$DRESP" 'd.get("minInstancesPerNode")')
  MAXINST=$(jget "$DRESP" 'd.get("maxInstancesPerNode")')
  PROVIDER=$(jget "$DRESP" 'd.get("provider") or ""')
  IDFIELD=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("serviceParameters",{}).get("idField") or ""')
  TABLE=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("serviceParameters",{}).get("tableName") or ""')
  LBTABLE=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("serviceParameters",{}).get("lakebaseTable") or ""')
  echo "  configuredState : $CSTATE"
  echo "  provider        : $PROVIDER"
  echo "  minInstances    : $MININST"
  echo "  maxInstances    : $MAXINST"
  [ -n "$TABLE" ]   && echo "  tableName       : $TABLE"
  [ -n "$LBTABLE" ] && echo "  lakebaseTable   : $LBTABLE"
  [ -n "$IDFIELD" ] && echo "  idField         : $IDFIELD"
fi
echo

# --- realtime status ------------------------------------------------------------
echo "-- Service status (realtime) --"
SRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/services/$SVC.FeatureServer/status?token=$TOKEN&f=json")
RTSTATE=$(jget "$SRESP" 'd.get("realTimeState") or ""')
echo "  configuredState: $(jget "$SRESP" 'd.get("configuredState") or "?"')  |  realTimeState: ${RTSTATE:-?}"
echo

# --- per-machine instance statistics --------------------------------------------
echo "-- Instance statistics (run right after a 404 to catch a 0-instance node) --"
STRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/services/$SVC.FeatureServer/statistics?token=$TOKEN&f=json")
RESP="$STRESP" python3 <<'PY' 2>/dev/null || echo "  (could not read statistics)"
import os,json
d=json.loads(os.environ["RESP"])
pm=d.get("perMachine") or []
for m in pm:
    print("  %-28s max=%s busy=%s free=%s init=%s notCreated=%s" % (
        m.get("machineName","?"), m.get("max"), m.get("busy"),
        m.get("free"), m.get("initializing"), m.get("notCreated")))
s=d.get("summary") or {}
if s:
    print("  summary:", {k: s.get(k) for k in ("max","busy","free","initializing","notCreated")})
if not pm and not s:
    print("  raw:", json.dumps(d)[:500])
PY
FREE_TOTAL=$(jget "$STRESP" 'sum((m.get("free") or 0) for m in (d.get("perMachine") or [])) if d.get("perMachine") else (d.get("summary") or {}).get("free")')
BUSY_TOTAL=$(jget "$STRESP" 'sum((m.get("busy") or 0) for m in (d.get("perMachine") or [])) if d.get("perMachine") else (d.get("summary") or {}).get("busy")')
echo

# --- ASSESSMENT -----------------------------------------------------------------
echo "============================================================"
echo " ASSESSMENT — likely problem(s) and what to do"
echo "============================================================"
PROBLEMS=0

if [ "$FOUND" != "yes" ]; then
  echo " * Service not found under '$SVC'."
  echo "     -> Check the exact name (and folder). If the name is right, the provider may not"
  echo "        be registered or failed to load — confirm the .cdpk is registered and re-check."
  PROBLEMS=$((PROBLEMS+1))
else
  # stopped?
  if [ "$CSTATE" != "STARTED" ] || { [ -n "$RTSTATE" ] && [ "$RTSTATE" != "STARTED" ]; }; then
    echo " * Service is NOT started (configured=$CSTATE, realtime=${RTSTATE:-?}) -> it 404s every time."
    echo "     -> Start it (Server Manager ▶, or admin /start)."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # min instances 0 -> intermittent 404
  if [ "$MININST" = "0" ]; then
    echo " * minInstancesPerNode = 0 -> no resident instance is kept."
    echo "     -> This is the classic 'intermittent 404, works on refresh': the instance is"
    echo "        evicted from the shared pool (or a round-robin node has none) and must reload."
    echo "     -> Fix: set minInstancesPerNode=1 and maxInstancesPerNode>=2 (dedicated, warm)."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # multi-machine amplifier
  if [ "$MACHINE_COUNT" != "1" ] && [ "$MACHINE_COUNT" != "?" ]; then
    echo " * Multi-machine site ($MACHINE_COUNT machines)."
    echo "     -> With min=0 the load balancer can round-robin to a node with no instance -> 404."
    echo "        min>=1 keeps a warm instance on EVERY node; also confirm the service is"
    echo "        started site-wide (per-machine stats above should all show instances)."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # all busy
  if [ -n "${FREE_TOTAL:-}" ] && [ "${FREE_TOTAL:-x}" = "0" ] && [ -n "${BUSY_TOTAL:-}" ] && [ "${BUSY_TOTAL:-0}" != "0" ]; then
    echo " * No free instances (free=0, busy=$BUSY_TOTAL) -> requests queue/time out under load."
    echo "     -> Raise maxInstancesPerNode."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # idField sanity note (can't verify uniqueness from here)
  if [ -n "$IDFIELD" ]; then
    echo " * idField = '$IDFIELD' — verify it is a UNIQUE integer per row (ArcGIS OBJECTID)."
    echo "     -> If it repeats (e.g. mmsi on a raw event table) features silently collide/drop"
    echo "        in clients — that is NOT a 404, but corrupts the map. Use a unique row id/view."
  fi
  if [ "$PROBLEMS" -eq 0 ]; then
    echo " * No obvious ArcGIS-side config problem: service is STARTED with a warm instance."
    echo "     -> If you still get errors, tail the provider log for 'Custom_data_feeds' lines"
    echo "        (Databricks auth/connectivity), and remember a federated /query needs a PORTAL"
    echo "        token (a server/admin token returns 'Invalid token', not a 404)."
  fi
fi
echo "============================================================"
echo " done — read-only, no changes were made."
echo "============================================================"
