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
ask "Service name (use folder/name if it's in a folder)" "TEST_FeatureService_Databricks" SVC
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
  echo "   Note: the admin API is normally only on :6443 with context 'arcgis' — not through a"
  echo "         web adaptor. On a federated box, siteadmin must still be enabled for admin login."
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
  # It may be in a FOLDER (root path won't find it). List folders so the operator can retry.
  FRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/services?token=$TOKEN&f=json")
  FOLDERS=$(jget "$FRESP" '", ".join(f for f in d.get("folders",[]) if f and f!="/")')
  if [ -n "$FOLDERS" ]; then
    echo "  Folders on this server: $FOLDERS"
    echo "  (if your service lives in one of those, re-run and enter it as  folder/name)"
  fi
  CSTATE=""; MININST=""; MAXINST=""; IDFIELD=""; TABLE=""; LBTABLE=""; PROVIDER=""; DPNAME=""
else
  CSTATE=$(jget "$DRESP" 'd.get("configuredState") or ""')
  MININST=$(jget "$DRESP" 'd.get("minInstancesPerNode")')
  MAXINST=$(jget "$DRESP" 'd.get("maxInstancesPerNode")')
  PROVIDER=$(jget "$DRESP" 'd.get("provider") or ""')
  DPNAME=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("dataProviderName") or ""')
  IDFIELD=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("serviceParameters",{}).get("idField") or ""')
  TABLE=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("serviceParameters",{}).get("tableName") or ""')
  LBTABLE=$(jget "$DRESP" '(d.get("jsonProperties") or {}).get("customDataProviderInfo",{}).get("serviceParameters",{}).get("lakebaseTable") or ""')
  echo "  configuredState : $CSTATE"
  echo "  provider        : $PROVIDER"
  [ -n "$DPNAME" ] && echo "  dataProvider    : $DPNAME"
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
# only trust the instance-count branches below if both totals came back as real numbers
STATS_NUM=0
if printf '%s' "${FREE_TOTAL:-}" | grep -qE '^[0-9]+$' && printf '%s' "${BUSY_TOTAL:-}" | grep -qE '^[0-9]+$'; then STATS_NUM=1; fi
echo

# --- ASSESSMENT -----------------------------------------------------------------
echo "============================================================"
echo " ASSESSMENT — likely problem(s) and what to do"
echo "============================================================"
PROBLEMS=0

if [ "$FOUND" != "yes" ]; then
  echo " * Service not found under '$SVC'."
  echo "     -> If it's in a FOLDER, re-run and enter it as folder/name (folders listed above)."
  echo "     -> If the name is right, the provider may not be registered or failed to load —"
  echo "        confirm the .cdpk is registered and re-check."
  PROBLEMS=$((PROBLEMS+1))
else
  # not started -> 404s every time
  if [ "$CSTATE" != "STARTED" ] || { [ -n "$RTSTATE" ] && [ "$RTSTATE" != "STARTED" ]; }; then
    echo " * Service is NOT started (configured=$CSTATE, realtime=${RTSTATE:-?}) -> it 404s every time."
    echo "     -> Start it (Server Manager ▶, or admin /start)."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # service references a CDF provider that isn't registered -> guaranteed failure
  if [ -n "$DPNAME" ] && ! printf '%s' "$PROVS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -Fxq "$DPNAME"; then
    echo " * Service references CDF provider '$DPNAME', which is NOT in the registered list above."
    echo "     -> Guaranteed failure. Register that provider (register-provider.sh), or fix the"
    echo "        service's dataProviderName to match a registered provider."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # not a CDF service -> some advice may not apply
  if [ -n "${PROVIDER:-}" ] && [ "$PROVIDER" != "CUSTOMDATA" ]; then
    echo " * NOTE: provider is '$PROVIDER', not CUSTOMDATA — this may not be a Databricks CDF"
    echo "        service, so some of the advice below may not apply."
  fi
  # min=0 -> POSSIBLE intermittent-404 cause; escalate only when corroborated (multi-machine)
  if [ "$MININST" = "0" ]; then
    if [ "$MACHINE_COUNT" != "1" ] && [ "$MACHINE_COUNT" != "?" ]; then
      echo " * minInstancesPerNode=0 on a MULTI-machine site ($MACHINE_COUNT) -> likely the intermittent"
      echo "     404 cause: a round-robin node with no resident instance 404s while another serves."
      echo "     -> Fix: minInstancesPerNode=1, maxInstancesPerNode>=2 (a warm instance on every node)."
      PROBLEMS=$((PROBLEMS+1))
    else
      echo " * minInstancesPerNode=0 -> no instance is kept resident. This CAN cause intermittent"
      echo "     '404, works on refresh' UNDER shared-pool pressure (many min=0 services vs pool size),"
      echo "     but on a quiet single-machine box it may be perfectly healthy."
      echo "     -> If you see that symptom, set min=1/max>=2; also check the shared-instance pool size"
      echo "        vs how many services use it. Don't 'fix' this if you aren't seeing the symptom."
    fi
  # multi-machine with min>=1 = healthy topology (informational, NOT a problem)
  elif [ "$MACHINE_COUNT" != "1" ] && [ "$MACHINE_COUNT" != "?" ]; then
    echo " * Multi-machine site ($MACHINE_COUNT machines) with min>=1 — healthy topology."
    echo "     -> Just confirm the service is started on ALL nodes (each per-machine line above"
    echo "        should show instances); a node stuck at 0 would 404 via round-robin."
  fi
  # STARTED but zero live instances right now (arms the log-tail advice for the init-failure case)
  if [ "$STATS_NUM" = "1" ] && [ "$FREE_TOTAL" = "0" ] && [ "$BUSY_TOTAL" = "0" ]; then
    echo " * No instance is running right now (free=0, busy=0)."
    echo "     -> Normal for a min=0 service that's idle. BUT if requests are actively 404ing, the"
    echo "        provider is failing to INITIALIZE (Databricks auth/connectivity, wrong table/column)"
    echo "        -> tail the log for 'Custom_data_feeds' lines to see the real error."
  fi
  # no free but busy -> under load
  if [ "$STATS_NUM" = "1" ] && [ "$FREE_TOTAL" = "0" ] && [ "$BUSY_TOTAL" != "0" ]; then
    echo " * No free instances (free=0, busy=$BUSY_TOTAL) -> requests queue/time out under load."
    echo "     -> Raise maxInstancesPerNode."
    PROBLEMS=$((PROBLEMS+1))
  fi
  # idField uniqueness reminder (can't verify from here)
  if [ -n "$IDFIELD" ]; then
    echo " * idField = '$IDFIELD' — verify it is a UNIQUE integer per row (ArcGIS OBJECTID)."
    echo "     -> If it repeats (e.g. mmsi on a raw event table) features silently collide/drop"
    echo "        in clients — that is NOT a 404, but corrupts the map. Use a unique row id/view."
  fi
  if [ "$PROBLEMS" -eq 0 ]; then
    echo " * No blocking ArcGIS-side config problem found (service STARTED; provider registered)."
    echo "     -> If you still get errors: a federated /query needs a PORTAL token (a server/admin"
    echo "        token returns 'Invalid token', not a 404), and provider-side Databricks errors"
    echo "        show up in the 'Custom_data_feeds' log lines."
  fi
fi
echo "============================================================"
echo " done — read-only, no changes were made."
echo "============================================================"
