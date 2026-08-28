#!/usr/bin/env bash
#
# check-both-machines.sh — READ-ONLY. Detects the #1 cause of INTERMITTENT 404 on a
# multi-machine ArcGIS Server site: the CDF provider (.cdpk) is live on one machine but
# MISSING / STALE / not-loaded on another, so a round-robin web adaptor 404s ~half the time.
#
# It enumerates the site's machines, then for EACH machine independently (bypassing the web
# adaptor, hitting that machine's own :6443) checks:
#   1) is the machine reachable on :6443,
#   2) does a direct read-only /query succeed / 404 / 500 on THAT node, and
#   3) prints the exact on-disk one-liner to confirm the provider dir + version per box.
# Makes NO changes. bash + curl + python3 only. Run it on any ArcGIS Server box in the site.
#
# HOW TO RUN (on an ArcGIS Server box, as root or the arcgis user):
#   bash check-both-machines.sh
#
set -uo pipefail

case "${1:-}" in
  -h|--help)
    echo "check-both-machines.sh — read-only per-machine CDF provider parity check."
    echo "  Run on an ArcGIS Server box: bash check-both-machines.sh"
    echo "  Enumerates site machines, probes each machine's own :6443 /query directly, and"
    echo "  prints per-box on-disk verification commands. Finds provider-on-one-machine-only. No changes."
    exit 0 ;;
esac

for t in curl python3; do
  command -v "$t" >/dev/null 2>&1 || { echo "!! required tool '$t' not found"; exit 1; }
done

# loopback-safe curl: skip proxy for localhost, accept ArcGIS self-signed, bounded timeouts.
CURL=(curl -sk --noproxy 'localhost,127.0.0.1,::1' --connect-timeout 8 --max-time 25)

# Password -> mode-600 temp file passed to curl via password@file (never in argv). Trap shreds it.
_tmppass=""; _ptp=""
_cleanup() { rm -f "${_tmppass}" "${_ptp}"; }
trap _cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
# jget <json> <python-expr using d>  -> prints the value (empty on any error)
jget() { RESP="$1" python3 -c "import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: raise SystemExit
print($2)" 2>/dev/null || true; }

echo "============================================================"
echo " Multi-machine CDF provider parity check (READ-ONLY)"
echo "============================================================"
# Reuse setup.sh's auth handoff if present; else prompt.
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
  exit 1
fi
echo "[ok] admin token minted"
echo

# --- federation detection (so a per-machine 500 is read correctly, not as a data failure) ---
FEDERATED="unknown"; OWNINGSYS=""
IRESP=$("${CURL[@]}" "$SERVER/$CTX/rest/info?f=json")
OKINFO=$(jget "$IRESP" "'yes' if (isinstance(d,dict) and 'error' not in d) else 'no'")
if [ "$OKINFO" = "yes" ]; then
  OWNINGSYS=$(jget "$IRESP" 'd.get("owningSystemUrl") or ""')
  [ -n "$OWNINGSYS" ] && FEDERATED="yes" || FEDERATED="standalone"
fi
case "$FEDERATED" in
  yes)        echo "-- Federation: FEDERATED with $OWNINGSYS --"
              echo "   Server tokens are rejected on /query here, so a direct per-machine query 500s on a"
              echo "   HEALTHY node too. To turn per-machine queries into a clean 200-vs-404 signal, supply a"
              echo "   PORTAL token below. Even without one, a 404 (vs 500) on a node still flags a MISSING"
              echo "   provider, and the on-disk check at the end is token-free and definitive." ;;
  standalone) echo "-- Federation: standalone — server tokens are valid for /query --" ;;
  *)          echo "-- Federation: could not determine (network / proxy / login redirect) --" ;;
esac
# Optional Portal token — makes the federated per-machine query definitive.
PTOK=""
if [ "$FEDERATED" = "yes" ]; then
  echo "  (optional) Enter a PORTAL login for a definitive per-machine query — or press Enter to skip."
  ask "  Portal URL (base, e.g. https://<host>/arcgis)" "${OWNINGSYS:-}" PORTAL_URL
  PUSER=""
  [ -n "$PORTAL_URL" ] && ask "  Portal username (Enter to skip)" "" PUSER
  if [ -n "$PUSER" ]; then
    PPASS=""
    if ! read -r -s -p "  Portal password: " PPASS; then echo; PPASS=""; fi; echo
    [[ "$PORTAL_URL" =~ ^https?:// ]] || PORTAL_URL="https://$PORTAL_URL"
    PREF=$(printf '%s' "$PORTAL_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
    PBASE="${PORTAL_URL%/}"
    _ptp=$(mktemp); chmod 600 "$_ptp"; printf '%s' "$PPASS" > "$_ptp"; unset PPASS
    PGT=$("${CURL[@]}" --max-time 30 "$PBASE/sharing/rest/generateToken" \
      --data-urlencode "username=$PUSER" --data-urlencode "password@$_ptp" \
      --data-urlencode "client=referer" --data-urlencode "referer=$PREF" --data-urlencode "f=json")
    rm -f "$_ptp"; _ptp=""
    PTOK=$(jget "$PGT" 'd.get("token") or ""')
    if [ -n "$PTOK" ]; then QTOKEN="$PTOK"; QREF="$PREF"; echo "  [ok] Portal token minted — per-machine queries will be definitive."
    else echo "  [info] could not mint a Portal token (check URL/login): $(printf '%s' "$PGT" | head -c 140)"; fi
  else
    echo "  (skipped Portal token — per-machine 500s on this federated box stay inconclusive; rely on the on-disk check.)"
  fi
fi
QREF="${QREF:-$SERVER}"
echo

# --- enumerate site machines ----------------------------------------------------
echo "-- Site machines --"
MRESP=$("${CURL[@]}" "$SERVER/$CTX/admin/machines?token=$TOKEN&f=json")
MACHINES=$(jget "$MRESP" '"\n".join((m.get("machineName") or "") for m in d.get("machines",[]) if m.get("machineName"))')
MCOUNT=$(printf '%s\n' "$MACHINES" | grep -c . || true)
echo "  count: ${MCOUNT:-0}"
if [ "${MCOUNT:-0}" -lt 1 ]; then
  echo "  !! could not read the machine list — check the admin token/URL. Raw:"
  printf '%s\n' "$MRESP" | head -c 300; echo
  exit 1
fi
printf '%s\n' "$MACHINES" | sed 's/^/   - /'
if [ "${MCOUNT:-0}" -eq 1 ]; then
  echo
  echo "  Only ONE machine in this site — provider parity across machines is not the issue here."
  echo "  (Intermittent 404 on a single-machine site points elsewhere: min/max instances, provider"
  echo "   init / Databricks connectivity, or a proxy/WAF in front. Run diagnose-service.sh.)"
fi
echo

# --- per-machine direct probe (bypasses the web adaptor / load balancer) --------
# Each ArcGIS Server machine serves its OWN :6443. Hitting the machine directly (not the site LB)
# is the only way to tell WHICH node is healthy. A provider missing on a node yields a resource
# 404; a federated token rejection yields 500 (same on every node, so it cancels out as a signal).
echo "-- Per-machine direct probe (each machine's own :6443 — NOT the load balancer) --"
echo "  (query flavor: $([ -n "$PTOK" ] && echo 'PORTAL token — definitive' || echo 'server token — federated 500s are inconclusive; a 404 still flags a missing provider'))"
echo
probe_machine() {   # $1 = machineName -> prints "code|detail"
  local mc="$1" base r
  base="https://$mc:6443/$CTX"
  # Is the machine's admin API reachable at all on :6443?
  r=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$base/rest/info?f=json" 2>/dev/null || echo "000")
  if [ "$r" = "000" ]; then echo "unreachable|:6443 not reachable from this box (DNS/SG/host firewall?) — run the on-disk check on $mc directly"; return; fi
  # Direct read-only /query against THIS machine.
  local q
  q=$("${CURL[@]}" -G -H "Referer: $QREF" \
      "$base/rest/services/$SVC/FeatureServer/0/query" \
      --data-urlencode "where=1=1" --data-urlencode "resultRecordCount=1" \
      --data-urlencode "returnGeometry=false" \
      --data-urlencode "token=$QTOKEN" --data-urlencode "f=json")
  RESP="$q" python3 -c "
import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: print('unparseable|non-JSON (login redirect / HTML / proxy)'); raise SystemExit
if isinstance(d,dict) and 'error' in d:
    e=d['error'] if isinstance(d['error'],dict) else {}
    print('%s|%s' % (e.get('code',''), str(e.get('message', d['error'])).replace('\n',' ')[:120]))
elif isinstance(d,dict) and 'features' in d:
    print('ok|%d feature(s) returned' % len(d['features']))
else:
    print('unknown|unrecognized response')
" 2>/dev/null || echo "unparseable|could not parse"
}

declare -a M_NAME M_CODE M_DETAIL
i=0
while IFS= read -r mc; do
  [ -z "$mc" ] && continue
  res="$(probe_machine "$mc")"
  M_NAME[$i]="$mc"; M_CODE[$i]="${res%%|*}"; M_DETAIL[$i]="${res#*|}"
  printf '  %-32s [%s] %s\n' "$mc" "${M_CODE[$i]}" "${M_DETAIL[$i]}"
  i=$((i+1))
done <<< "$MACHINES"
echo

# --- verdict --------------------------------------------------------------------
echo "============================================================"
echo " ASSESSMENT"
echo "============================================================"
# Tally the distinct outcome classes across machines.
have_ok=0; have_404=0; have_500=0; have_other=0; have_unreach=0
for idx in "${!M_NAME[@]}"; do
  case "${M_CODE[$idx]}" in
    ok) have_ok=1 ;;
    404) have_404=1 ;;
    500) have_500=1 ;;
    unreachable) have_unreach=1 ;;
    *) have_other=1 ;;
  esac
done

if [ "$have_404" = "1" ] && { [ "$have_ok" = "1" ] || [ "$have_500" = "1" ]; }; then
  echo " * ASYMMETRY DETECTED — at least one machine 404s the query while another does not."
  echo "   That is the classic 'provider live on one node, MISSING/STALE on another' — a round-robin"
  echo "   web adaptor then 404s ~half the requests. Machines that returned [404] need the provider."
  echo "   -> FIX on each 404 machine: register/update the SAME .cdpk there and restart THAT server:"
  echo "        sudo bash register-provider.sh        # choose option 2 (register existing .cdpk)"
  echo "        sudo -u <arcgis-user> <install>/server/stopserver.sh && .../startserver.sh"
elif [ "$have_ok" = "1" ] && [ "$have_404" = "0" ] && [ "$have_500" = "0" ]; then
  echo " * All reachable machines returned data — provider parity looks GOOD across the site."
  echo "   If you still see intermittent 404s, look elsewhere (min/max instances, warehouse"
  echo "   cold-start, or a WAF/proxy in front). Run diagnose-service.sh."
elif [ "$have_500" = "1" ] && [ "$have_ok" = "0" ] && [ "$have_404" = "0" ]; then
  echo " * Every machine returned 500 and none returned 404. On a FEDERATED box that is most likely"
  echo "   the server-token rejection (inconclusive), NOT proof of a provider problem. Re-run with a"
  echo "   PORTAL token for a clean read — OR use the token-free on-disk check below (definitive)."
elif [ "$have_unreach" = "1" ]; then
  echo " * One or more machines were not reachable on :6443 from this box (DNS / security group /"
  echo "   host firewall). The per-machine query couldn't run for those — use the on-disk check below"
  echo "   ON each machine directly (it needs no network to the other node)."
else
  echo " * Mixed / inconclusive per-machine results — use the token-free on-disk check below on EACH"
  echo "   machine; it is the definitive test for whether the provider files are present + same version."
fi
echo

# --- token-free on-disk check (definitive; run ON each machine) -----------------
echo "-- Definitive on-disk check — run this ON EACH machine (SSH to each box) --"
echo "   It needs no token and no network to the other node. Compare the two outputs:"
echo "   a MISSING directory, or a DIFFERENT version, on one machine is your answer."
echo
cat <<'DISK'
   # Adjust the install root if yours differs (/opt/arcgis or /app/arcgis):
   ROOT=/opt/arcgis; PROV=databricks-geospatial-provider
   DIR="$ROOT/server/framework/runtime/customdata/providers/$PROV"
   echo "host: $(hostname)"
   if [ -d "$DIR" ]; then
     echo "  provider dir: PRESENT"
     python3 -c "import json;d=json.load(open('$DIR/cdconfig.json'));print('  version:',d.get('version'),' name:',d.get('name'))" 2>/dev/null \
       || echo "  (cdconfig.json unreadable — provider may be broken/partial on this node)"
     ls -1 "$DIR/node_modules" >/dev/null 2>&1 && echo "  node_modules: present" || echo "  node_modules: MISSING (broken .cdpk on this node)"
   else
     echo "  provider dir: MISSING  <-- this node cannot serve the provider; register + restart here"
   fi
DISK
echo
echo "============================================================"
echo " done — read-only, no changes were made."
echo "============================================================"
