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

# Password is written to a mode-600 temp file and passed to curl via password@file, so it never
# appears in this process's argv (a concurrent `ps`/`/proc/<pid>/cmdline` can't read it). The
# trap shreds the file on any exit, including Ctrl-C. (Matches publish-service.sh / register-provider.sh.)
_tmppass=""
_cleanup() { rm -f "${_tmppass}"; }
trap _cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ask() {
  local prompt="$1" def="$2" __var="$3" ans=""
  # EOF / closed stdin must abort, not silently take the default.
  if [ -n "$def" ]; then
    if ! read -r -p "  $prompt [$def]: " ans; then echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi
    ans="${ans:-$def}"
  else
    if ! read -r -p "  $prompt: " ans; then echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi
  fi
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
# Auth-input handoff (used by setup.sh): use the CDF_ADMIN_* env vars if present (password from a
# mode-600 file, never argv/env) so a router can collect the login once; else prompt as before.
if [ -n "${CDF_ADMIN_PASSFILE:-}" ] && [ -f "${CDF_ADMIN_PASSFILE:-}" ]; then
  SERVER="${CDF_ADMIN_URL:-https://localhost:6443}"
  CTX="${CDF_ADMIN_CTX:-arcgis}"
  ADMINUSER="${CDF_ADMIN_USER:-siteadmin}"
  PW="$(cat "$CDF_ADMIN_PASSFILE")"
  echo "  (using the ArcGIS connection provided by setup.sh: $ADMINUSER @ $SERVER/$CTX)"
else
  ask "Admin URL" "https://localhost:6443" SERVER
  ask "URL context" "arcgis" CTX
  ask "Admin username" "siteadmin" ADMINUSER
  if ! read -rs -p "  Admin password: " PW; then echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi; echo
fi
ask "Service name (use folder/name if it's in a folder)" "TEST_FeatureService_Databricks" SVC
echo

# --- mint admin (requestip) + query (referer) tokens ----------------------------
# Password goes via a temp file (never argv). Mint BOTH tokens now, while we have the password:
#  - admin token (requestip): the admin API calls below.
#  - query token (referer + matching Referer header): the feature-service /query smoke test,
#    which validates tokens more strictly and rejects a requestip token with HTTP 498.
_tmppass=$(mktemp); chmod 600 "$_tmppass"; printf '%s' "$PW" > "$_tmppass"; unset PW
TRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/generateToken" \
  --data-urlencode "username=$ADMINUSER" --data-urlencode "password@$_tmppass" \
  --data-urlencode "client=requestip" --data-urlencode "f=json")
QRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/generateToken" \
  --data-urlencode "username=$ADMINUSER" --data-urlencode "password@$_tmppass" \
  --data-urlencode "client=referer" --data-urlencode "referer=$SERVER" --data-urlencode "f=json")
rm -f "$_tmppass"; _tmppass=""
TOKEN=$(jget "$TRESP" 'd.get("token") or ""')
QTOKEN=$(jget "$QRESP" 'd.get("token") or ""'); [ -z "$QTOKEN" ] && QTOKEN="$TOKEN"
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

# --- federation detection -------------------------------------------------------
# A FEDERATED ArcGIS Server delegates token validation to its Portal, so a SERVER-minted
# token (even a referer one) is REJECTED on /query — surfacing as HTTP 498/499 OR, on 12.x,
# a generic 500 "Error performing query operation" that wraps an "Invalid token"
# AGSSecurityException. That is a token technicality, NOT a provider/data failure. Detect it
# here so the smoke test and assessment below don't misreport it as a Databricks/grants problem.
# Tri-state: "yes" (owningSystemUrl present), "standalone" (rest/info OK, no owningSystemUrl),
# or "unknown" (rest/info didn't parse — curl error / HTML login redirect / proxy). Only a
# CONFIRMED "standalone" lets a 500 on /query be called a hard failure; "yes" and "unknown"
# both route a 500 to INCONCLUSIVE, so a failed detection can't mask a federated token issue.
FEDERATED="unknown"; OWNINGSYS=""
IRESP=$("${CURL[@]}" "$SERVER/$CTX/rest/info?f=json")
OKINFO=$(jget "$IRESP" "'yes' if (isinstance(d,dict) and 'error' not in d) else 'no'")
if [ "$OKINFO" = "yes" ]; then
  OWNINGSYS=$(jget "$IRESP" 'd.get("owningSystemUrl") or ""')
  if [ -n "$OWNINGSYS" ]; then FEDERATED="yes"; else FEDERATED="standalone"; fi
fi
echo "-- Federation --"
case "$FEDERATED" in
  yes)        echo "  FEDERATED with Portal: $OWNINGSYS"
              echo "  (server-minted tokens are rejected on /query here — a PORTAL token is required to query)" ;;
  standalone) echo "  standalone (not federated) — server tokens are valid for /query" ;;
  *)          echo "  [warn] could not determine federation from rest/info (network / login redirect / proxy?)."
              echo "         Query-token failures below are treated as INCONCLUSIVE, not as data failures." ;;
esac
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
# Did the provider list actually parse? A transient error / bad token / HTML proxy response
# yields empty PROVS that must NOT be read as "no providers registered".
PROV_PARSE_OK=$(RESP="$PRESP" python3 -c "import os,json;json.loads(os.environ['RESP']);print('yes')" 2>/dev/null)
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

# --- live read-only query smoke test --------------------------------------------
# The single most decisive check: does the service actually RETURN data? Admin metadata can look
# perfect (STARTED, provider registered) while every query 404s because the provider failed to
# initialize (bad Databricks creds, missing UC grants, wrong table/geometry column, TLS). This
# does a real, read-only /query with a referer-bound token (never changes anything).
echo "-- Live query smoke test (read-only — returns at most 1 row, changes nothing) --"
# Query up to 4 times, ~6s apart. This separates the two 404 flavors that look identical from
# one shot: a min=0 service with no warm instance can 404 on the FIRST hit then succeed as the
# instance spins up (the classic "404, works on refresh") — vs a PERSISTENT 404, which is a real
# failure (bad Databricks creds, missing grants, wrong table/column, provider init crash).
SMOKE="skipped"; SMOKE_FIRST=""; SMOKE_RECOVERED="no"
smoke_query() {
  local r
  r=$("${CURL[@]}" -G -H "Referer: $SERVER" \
    "$SERVER/$CTX/rest/services/$SVC/FeatureServer/0/query" \
    --data-urlencode "where=1=1" --data-urlencode "resultRecordCount=1" \
    --data-urlencode "returnGeometry=false" \
    --data-urlencode "token=$QTOKEN" --data-urlencode "f=json")
  RESP="$r" python3 -c "
import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: print('unparseable'); raise SystemExit
if isinstance(d,dict) and 'error' in d:
    e=d['error'] if isinstance(d['error'],dict) else {}
    print('error:%s:%s' % (e.get('code',''), str(e.get('message',d['error']))[:160]))
elif isinstance(d,dict) and 'features' in d:
    print('ok:%d' % len(d['features']))
else:
    print('unknown')
" 2>/dev/null || echo "unparseable"
}
if [ "$FOUND" = "yes" ]; then
  for _q in 1 2 3 4; do
    SMOKE=$(smoke_query)
    [ -z "$SMOKE_FIRST" ] && SMOKE_FIRST="$SMOKE"
    case "$SMOKE" in
      ok:*) [ "$_q" -gt 1 ] && SMOKE_RECOVERED="yes"; break ;;              # succeeded (eventually)
      error:498:*|error:499:*) break ;;                                     # token issue — retrying won't help
    esac
    # Keep retrying only while it still looks like a not-yet-available/starting service.
    case "$SMOKE" in
      error:404:*|*Service\ not\ found*|*not\ available*|unparseable|unknown)
        [ "$_q" -lt 4 ] && { echo "  (no data yet — retry $_q/4, giving a min=0 instance time to start)"; sleep 6; } ;;
      *) break ;;                                                            # a definite data error — stop
    esac
  done
  if [ "$SMOKE_RECOVERED" = "yes" ]; then
    echo "  [!] INTERMITTENT 404 CONFIRMED — the first query 404'd, a retry then SUCCEEDED"
    echo "      (features=${SMOKE#ok:}). This is the min=0 'no warm instance' cold-start: set"
    echo "      minInstancesPerNode=1 / maxInstancesPerNode>=2 to keep one warm and stop the 404s."
  else
    case "$SMOKE" in
      ok:*)      echo "  [ok] query returned data (features=${SMOKE#ok:}) — the provider is serving rows." ;;
      error:498:*|error:499:*) echo "  [info] query rejected the token (${SMOKE#error:}). On a FEDERATED site /query"
                 echo "         needs a PORTAL token, not this admin token — a token technicality, not a data"
                 echo "         failure. Verify from a portal/browser client." ;;
      error:500:*)
        if [ "$FEDERATED" != "standalone" ]; then
          echo "  [INCONCLUSIVE] query returned 500 (${SMOKE#error:})."
          if [ "$FEDERATED" = "yes" ]; then
            echo "         This server is FEDERATED — it rejects its own tokens on /query (delegated to"
            echo "         Portal), which surfaces as this generic 500 'Invalid token'."
          else
            echo "         Federation could not be confirmed above, so a 500 here is ambiguous."
          fi
          echo "         This run did NOT verify the data path, and the SAME 500 is how a real provider"
          echo "         error would look. See the ASSESSMENT below for how to tell them apart."
        else
          echo "  [PROBLEM] query FAILED (persisted across retries): ${SMOKE#error:}"
        fi ;;
      error:*)   echo "  [PROBLEM] query FAILED (persisted across retries): ${SMOKE#error:}" ;;
      unparseable) echo "  [info] query returned a non-JSON response (login redirect / HTML / proxy?) — inconclusive." ;;
      *)         echo "  [info] query result inconclusive." ;;
    esac
  fi
else
  echo "  (skipped — service definition was not found above.)"
fi
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
  # service references a CDF provider that isn't registered -> guaranteed failure.
  # Only assert absence when the provider list ACTUALLY parsed — otherwise a transient error
  # would wrongly be reported as "guaranteed failure".
  if [ "$PROV_PARSE_OK" = "yes" ] && [ -n "$DPNAME" ] && ! printf '%s' "$PROVS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -Fxq "$DPNAME"; then
    echo " * Service references CDF provider '$DPNAME', which is NOT in the registered list above."
    echo "     -> Guaranteed failure. Register that provider (register-provider.sh), or fix the"
    echo "        service's dataProviderName to match a registered provider."
    PROBLEMS=$((PROBLEMS+1))
  elif [ "$PROV_PARSE_OK" != "yes" ] && [ -n "$DPNAME" ]; then
    echo " * NOTE: could not read the registered-provider list (transient error / bad token / proxy)."
    echo "        Cannot confirm whether provider '$DPNAME' is registered — re-run to verify."
  fi
  # not a CDF service -> some advice may not apply
  if [ -n "${PROVIDER:-}" ] && [ "$PROVIDER" != "CUSTOMDATA" ]; then
    echo " * NOTE: provider is '$PROVIDER', not CUSTOMDATA — this may not be a Databricks CDF"
    echo "        service, so some of the advice below may not apply."
  fi
  # min=0 -> POSSIBLE intermittent-404 cause; escalate only when corroborated (multi-machine)
  if [ "$MININST" = "0" ]; then
    if [ "$MACHINE_COUNT" != "1" ] && [ "$MACHINE_COUNT" != "?" ]; then
      echo " * minInstancesPerNode=0 on a MULTI-machine site ($MACHINE_COUNT) -> a plausible intermittent-"
      echo "     404 cause: a round-robin node with no resident instance can 404 while another serves."
      echo "     Confirm against the live query above / the per-machine lines / the log before changing it."
      echo "     -> If corroborated: minInstancesPerNode=1, maxInstancesPerNode>=2 (a warm instance per node)."
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
    if [ "$FEDERATED" = "yes" ]; then
      echo "     -> NOTE: on a FEDERATED server the admin statistics can report max=0/free=0 even"
      echo "        while the FeatureServer metadata and a PORTAL-token /query work fine — don't treat"
      echo "        this 0-instance reading alone as failure; trust the live query result above."
    fi
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
  # Final verdict is anchored on the LIVE query, not just config — config can be perfect while
  # the provider fails to initialize.
  if [ "$SMOKE_RECOVERED" = "yes" ]; then
    echo " * INTERMITTENT 404 CONFIRMED — first query 404'd, a retry succeeded. Root cause is the"
    echo "     min=0 'no warm instance' gap, not a data problem."
    echo "     -> Fix: set minInstancesPerNode=1, maxInstancesPerNode>=2 (per-service) to keep one warm."
    PROBLEMS=$((PROBLEMS+1))
  elif [ "$PROBLEMS" -eq 0 ]; then
    case "$SMOKE" in
      ok:*)
        echo " * HEALTHY — service STARTED, provider registered, and a live read-only query SUCCEEDED"
        echo "     (features=${SMOKE#ok:}). This service is serving data right now." ;;
      error:498:*|error:499:*)
        echo " * Config looks correct; the live query only needs a portal/referer token (a token"
        echo "     technicality on federated sites, not a data problem). Verify from a portal client." ;;
      error:500:*)
        if [ "$FEDERATED" != "standalone" ]; then
          echo " * [INCONCLUSIVE] the live /query returned 500 (${SMOKE#error:}); this run did NOT verify the data path."
          if [ "$FEDERATED" = "yes" ]; then
            echo "     This server is FEDERATED ($OWNINGSYS) — it rejects its own tokens on /query, which"
            echo "     surfaces as a generic 500 'Invalid token'. That 500 is ALSO how a REAL provider error"
            echo "     would look (bad SQL, missing UC grant, provider init crash) — this run can't tell them apart."
          else
            echo "     Federation could not be confirmed from rest/info, so this 500 is ambiguous between a"
            echo "     federated token rejection and a REAL provider error (bad SQL, missing UC grant, init crash)."
          fi
          echo "     Resolve it one of these ways:"
          echo "       - re-query with a PORTAL token (or add-as-layer in Portal): success => provider healthy;"
          echo "       - tail the 'Custom_data_feeds' log: a SELECT returning rows => healthy (token-only issue),"
          echo "         a Databricks/SQL/auth error => the real provider failure to fix."
        else
          echo " * WARNING: ArcGIS config looks fine, BUT the live query FAILED (${SMOKE#error:})."
          echo "     -> THIS is the real failure — provider init / Databricks auth / missing UC grants /"
          echo "        wrong table or geometry column. Tail the log for 'Custom_data_feeds' lines."
          PROBLEMS=$((PROBLEMS+1))
        fi ;;
      error:*)
        echo " * WARNING: ArcGIS config looks fine, BUT the live query FAILED (${SMOKE#error:})."
        echo "     -> THIS is the real failure — provider init / Databricks auth / missing UC grants /"
        echo "        wrong table or geometry column. Tail the log for 'Custom_data_feeds' lines."
        PROBLEMS=$((PROBLEMS+1)) ;;
      *)
        echo " * No blocking ArcGIS-side config problem found (service STARTED; provider registered),"
        echo "     but the live query was inconclusive. If you still get errors: a federated /query"
        echo "     needs a PORTAL token, and provider-side Databricks errors show up in the"
        echo "     'Custom_data_feeds' log lines." ;;
    esac
  fi
fi
echo "============================================================"
echo " done — read-only, no changes were made."
echo "============================================================"
