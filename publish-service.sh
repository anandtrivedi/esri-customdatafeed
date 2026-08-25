#!/usr/bin/env bash
#
# publish-service.sh — interactive wizard to publish a Databricks CDF Feature Service.
#
# Runs on the ArcGIS Server box with only bash + curl + python3 (all already present).
# No JSON to hand-edit, no MCP client, works air-gapped. Safe to re-run.
#
# It asks one question per field, builds the createService payload itself (python3,
# so no quoting/missing-key mistakes), then creates -> starts -> verifies the service
# and prints the FeatureServer URL. Every failure prints what went wrong in plain English.
#
# HOW TO RUN
#   Run it ON the ArcGIS Server box, as root (simplest) or as the arcgis user:
#       sudo bash publish-service.sh          # or, if already root:  bash publish-service.sh
#   Root is fine — the script only makes authenticated HTTPS calls to the ArcGIS admin
#   API (token auth, no OS privileges needed), and as root it can also read the
#   arcgis-owned .databrickscfg to offer the workspace-profile pick-list. Running as a
#   plain non-root user still works, but the pick-list falls back to typing the name.
#
#   The PROVIDER runs as the 'arcgis' user and reads ~/.databrickscfg at query time, so
#   make sure the config lives where arcgis can read it:
#       sudo chown arcgis:arcgis /home/arcgis/.databrickscfg
#       sudo chmod 600 /home/arcgis/.databrickscfg
#   (or set DATABRICKS_CONFIG_FILE in init_user_param.sh to a path arcgis can read).
#
# NOTE: the ArcGIS admin token is minted once at startup and reused for the whole
#   session. ArcGIS tokens default to ~60 min. If you publish many tables across a
#   very long session and a create/start call later fails with an "invalid/expired
#   token" message, just re-run the script — it mints a fresh token each run.
#
set -uo pipefail   # deliberately NOT -e: we handle and explain errors ourselves.

# --- --help / -h: print usage and exit (no server calls, no tool requirements) --
case "${1:-}" in
  -h|--help)
    echo "publish-service.sh — interactive wizard to publish a Databricks CDF Feature Service."
    echo
    echo "  Run it ON the ArcGIS Server box, as root (simplest) or the arcgis user:"
    echo "      sudo bash publish-service.sh"
    echo
    echo "  It prompts for the ArcGIS admin connection, then for each table: picks the"
    echo "  backend (Lakehouse or Lakebase), builds the createService payload for you, and"
    echo "  creates -> starts -> verifies the service, printing its FeatureServer URL."
    echo "  No JSON to hand-edit, no admin token to mint yourself. Works air-gapped."
    echo
    echo "  Requires: bash, curl, python3 (all present on ArcGIS Server) and a"
    echo "  .databrickscfg readable by the arcgis user (see the repo README, Step 3)."
    exit 0
    ;;
esac

# --- verify required tools are present (air-gapped: no external downloads) ----
for _tool in python3 curl; do
  command -v "$_tool" >/dev/null 2>&1 || { echo "!! Required tool '$_tool' not found. Install it before running this script."; exit 1; }
done

PROVIDER_NAME="databricks-geospatial-provider"

# Shared curl invocation: -k for ArcGIS's self-signed cert (see note at first use),
# --noproxy so loopback calls are never routed through an ambient HTTPS_PROXY, and a
# connect timeout. Using an array means every call inherits these flags — you can't add
# a curl call that forgets them. Per-call --max-time is appended at each site.
CURL=(curl -sk --noproxy 'localhost,127.0.0.1,::1' --connect-timeout 10)

# Feature services successfully published this session (for the end-of-run summary).
PUBLISHED=()

# Always clean up the password temp file. EXIT handles cleanup for every exit path;
# INT/TERM additionally *terminate* the script (trapping a signal otherwise replaces
# the default terminate, so Ctrl-C would fall through into the next prompt — and the
# confirmation prompt defaults to "y"). SIGKILL (kill -9) cannot be trapped.
_tmppass=""; MINT_RESP=""
_cleanup() { rm -f "${_tmppass}"; }
trap _cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- prompt helper: ask "Question" "default" VARNAME ---------------------------
ask() {
  local prompt="$1" def="$2" __var="$3" ans
  if [ -n "$def" ]; then
    read -r -p "  $prompt [$def]: " ans; ans="${ans:-$def}"
  else
    read -r -p "  $prompt: " ans
  fi
  printf -v "$__var" '%s' "$ans"
}

# --- mint an ArcGIS admin token -------------------------------------------------
# Sets MINT_RESP to the raw JSON response. MUST be called as a plain statement, NOT in
# $(...): the password temp file is created here via the global _tmppass, and only when
# this runs in the parent shell can the EXIT/INT/TERM trap shred that file if a signal
# lands mid-mint. (Inside a command substitution the _tmppass assignment would be
# subshell-local and the parent trap would see nothing.) Only the curl is subshelled —
# it doesn't own the temp file. The password never appears in process args (password@file).
#   mint_token requestip         -> IP-bound token (fine for the admin calls here)
#   mint_token referer <url>     -> referer-bound token (needed for feature-service /query)
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

echo "============================================================"
echo " Databricks CDF — Publish Feature Service"
echo "============================================================"
echo
echo "-- ArcGIS connection --"
ask "Admin URL (on the box use https://localhost:6443)" "https://localhost:6443" SERVER
ask "URL context (arcgis for :6443; the web-adaptor name otherwise)" "arcgis" CTX
ask "Admin username" "siteadmin" ADMIN_USER
read -r -s -p "  Admin password: " ADMIN_PASS; echo
echo

# --- get admin token -----------------------------------------------------------
# NOTE: curl uses -k (skip TLS cert verification) because ArcGIS Server ships with a
# self-signed cert by default. When run as documented — on the box against localhost:6443
# — this is safe (loopback, no network path to intercept). If you run this script from a
# remote host against a routed network address, supply --cacert /path/to/arcgis-ca.pem
# and remove -k for those calls. The admin password itself never appears in process args
# (it goes via a temp file), but an unverified TLS connection can expose it in transit.
echo "-> requesting admin token (client=requestip)..."
mint_token requestip; TOKEN_RESP="$MINT_RESP"
TOKEN=$(printf '%s' "$TOKEN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token') or '')" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "!! No token was returned. The server said:"
  printf '%s\n' "$TOKEN_RESP" | head -c 2000; echo
  echo
  echo "   Common causes:"
  echo "   - HTML / 'Could not access any server machines' / a redirect  => you went through the"
  echo "       web adaptor and admin access is blocked there. Run this ON the box with"
  echo "       Admin URL = https://localhost:6443  and context = arcgis."
  echo "   - 'Invalid username or password'  => wrong admin credentials."
  echo "   - connection refused / timeout    => ArcGIS Server is not running on that port."
  exit 1
fi
echo "   ok (token ${TOKEN:0:10}...)."
echo

# --- PREFLIGHT: verify prerequisites before asking for any service details -----
# Runs on invoke. Hard-stops on things that guarantee failure (no provider
# registered); warns on things it cannot fully confirm (config file permissions).
echo "== Preflight =="
echo "  [ok]   ArcGIS admin reachable, token acquired"

PROV_JSON=$("${CURL[@]}" --max-time 30 "$SERVER/$CTX/admin/services/types/customdataproviders" \
  --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
PROV_PARSE_OK=$(printf '%s' "$PROV_JSON" | python3 -c "import sys,json; json.load(sys.stdin); print('yes')" 2>/dev/null)
PROVS=()
while IFS= read -r line; do [ -n "$line" ] && PROVS+=("$line"); done < <(printf '%s' "$PROV_JSON" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit()
if isinstance(d,dict):
    for entries in d.values():
        if isinstance(entries,list):
            for e in entries:
                if isinstance(e,dict) and e.get('type')=='provider' and e.get('name'):
                    print(e['name'])
" 2>/dev/null)
if [ "${#PROVS[@]}" -eq 1 ]; then
  PROVIDER_NAME="${PROVS[0]}"
  echo "  [ok]   CDF provider registered: $PROVIDER_NAME"
elif [ "${#PROVS[@]}" -gt 1 ]; then
  echo "  [ok]   multiple CDF providers registered:"
  i=1; for p in "${PROVS[@]}"; do echo "           $i) $p"; i=$((i+1)); done
  echo "           0) type a name manually"
  ask "         which provider to use" "1" PPICK
  if printf '%s' "$PPICK" | grep -qE '^[1-9][0-9]*$' && [ "$PPICK" -ge 1 ] && [ "$PPICK" -le "${#PROVS[@]}" ]; then
    PROVIDER_NAME="${PROVS[$((PPICK-1))]}"
  else
    ask "         Provider name" "$PROVIDER_NAME" PROVIDER_NAME
  fi
  echo "         using: $PROVIDER_NAME"
elif [ "$PROV_PARSE_OK" = "yes" ]; then
  echo "  [NOT READY] No custom data provider is registered on this ArcGIS Server."
  echo "              Register the .cdpk first (Server Manager > Server Configuration >"
  echo "              Custom Data Feeds > Add Custom Data Provider), then re-run this."
  exit 1
else
  echo "  [warn] could not list providers (unexpected response) — proceeding with default"
  echo "         '$PROVIDER_NAME'. If publishing fails with 'provider not found', register it."
fi

CFG="${DATABRICKS_CONFIG_FILE:-/home/arcgis/.databrickscfg}"
if [ -f "$CFG" ]; then
  echo "  [ok]   Databricks config found: $CFG"
  # Ownership check — must be arcgis so the provider process can read it.
  CFG_OWNER=$(stat -c '%U' "$CFG" 2>/dev/null || true)
  CFG_PERMS=$(stat -c '%a' "$CFG" 2>/dev/null || true)
  if [ -n "$CFG_OWNER" ] && [ "$CFG_OWNER" != "arcgis" ]; then
    echo "  [WARN] $CFG is owned by '$CFG_OWNER', not 'arcgis' — the provider will fail to read it."
    echo "         Fix: sudo chown arcgis:arcgis $CFG"
  else
    echo "  [ok]   owner: ${CFG_OWNER:-unknown}"
  fi
  if [ -n "$CFG_PERMS" ] && [ "$CFG_PERMS" != "600" ] && [ "$CFG_PERMS" != "400" ]; then
    echo "  [WARN] $CFG permissions are $CFG_PERMS, expected 600 (or 400 for read-only)."
    echo "         Fix: sudo chmod 600 $CFG"
  else
    echo "  [ok]   permissions: ${CFG_PERMS:-unknown}"
  fi
  if [ ! -s "$CFG" ]; then
    echo "  [WARN] $CFG is empty — add a [DEFAULT] profile before publishing."
  fi
else
  echo "  [FAIL] $CFG not found."
  echo "         The provider runs as 'arcgis' and must read this file at query time."
  echo "         Create it:  sudo -u arcgis databricks configure --token"
  echo "         Or copy:    sudo cp ~/.databrickscfg $CFG && sudo chown arcgis:arcgis $CFG && sudo chmod 600 $CFG"
fi
echo

# --- helper: build the createService JSON for the current per-table variables --
build_service_json() {
python3 - <<'PY'
import os, json
g = os.environ.get
params = {
    "workspace":         g("WORKSPACE", ""),
    "warehouseHttpPath": g("WAREHOUSE_PATH", ""),
    "tableName":         g("TABLE", ""),
    "geometryColumn":    g("GEOM_COL", ""),
    "idField":           g("ID_FIELD", ""),
    "geometryFormat":    g("GEOM_FORMAT", ""),
    "timeColumn":        g("TIME_COL", ""),
    "lakebaseHost":      g("LB_HOST", ""),
    "lakebasePort":      g("LB_PORT", ""),
    "lakebaseDatabase":  g("LB_DB", ""),
    "lakebaseSchema":    g("LB_SCHEMA", ""),
    "lakebaseTable":     g("LB_TABLE", ""),
    "maxRecordCount":    g("MAXREC", ""),
    "srid":              g("SRID", ""),
    "editingEnabled":    g("EDITING", ""),
}
svc = {
    "serviceName": os.environ["SERVICE_NAME"],
    "type": "FeatureServer", "capabilities": g("CAPABILITIES", "Query"), "provider": "CUSTOMDATA",
    "clusterName": "default",
    "minInstancesPerNode": 0, "maxInstancesPerNode": 0, "instancesPerContainer": 1,
    "maxWaitTime": 60, "maxStartupTime": 300, "maxIdleTime": 1800, "maxUsageTime": 600,
    "loadBalancing": "ROUND_ROBIN", "isolationLevel": "HIGH",
    "configuredState": "STARTED", "keepAliveInterval": 1800,
    "private": False, "isDefault": False,
    "properties": {"disableCaching": "true"},
    "jsonProperties": {"customDataProviderInfo": {
        "forwardUserIdentity": False,
        "dataProviderName": os.environ["PROVIDER_NAME"],
        "serviceParameters": params,
    }},
    "extensions": [], "frameworkProperties": {}, "datasets": [],
}
print(json.dumps(svc))
PY
}

# --- helper: guess "geometryColumn idField" from `databricks tables get` JSON ---
# Prints two space-separated tokens ('_' when unknown). Best-effort suggestions only.
guess_cols() {
python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('_ _'); sys.exit()
cols=[(c.get('name'),(c.get('type_name') or c.get('type_text') or '').upper()) for c in d.get('columns',[]) if c.get('name')]
geom=''
for n,t in cols:
    if t.startswith('GEOMETRY') or t.startswith('GEOGRAPHY'): geom=n; break
if not geom:
    for h in ['geometry','geog','geom','shape','wkt','wkb','geojson','the_geom','location','point']:
        m=[n for n,_ in cols if h in n.lower()]
        if m: geom=m[0]; break
ints=[n for n,t in cols if any(t.startswith(x) for x in ('INT','LONG','BIGINT','SMALLINT'))]
low={n.lower():n for n in ints}
idc=''
for pref in ('objectid','id'):
    if pref in low: idc=low[pref]; break
if not idc:
    m=[n for n in ints if n.lower().endswith('_id')]
    if m: idc=m[0]
if not idc and ints: idc=ints[0]
print((geom or '_')+' '+(idc or '_'))
"
}

# --- choose backend -----------------------------------------------------------
echo "-- Backend --"
echo "  1) Lakehouse  (Databricks SQL Warehouse — read-only, large-scale query)"
echo "  2) Lakebase   (Databricks Postgres + PostGIS — read + write, editing)"
ask "  choose 1-2" "1" BE
case "$BE" in 2) BACKEND=lakebase;; *) BACKEND=lakehouse;; esac
echo

# initialise every service parameter; the unused backend's fields stay empty
WORKSPACE=""; WAREHOUSE_PATH=""; TABLE=""; GEOM_COL=""; ID_FIELD=""; GEOM_FORMAT=""
TIME_COL=""; MAXREC=""; SRID=""; LB_HOST=""; LB_PORT=""; LB_DB=""; LB_SCHEMA=""; LB_TABLE=""
EDITING=""; CAPABILITIES="Query"

# --- data source: pick workspace (+ warehouse or Lakebase instance) ONCE -------
echo "-- Data source (used for every table you publish this session) --"
# Workspace profile pick-list read from the SAME .databrickscfg the provider uses.
CFG="${DATABRICKS_CONFIG_FILE:-/home/arcgis/.databrickscfg}"
PROFILES=""
[ -r "$CFG" ] && PROFILES=$(grep -oE '^\[[^]]+\]' "$CFG" 2>/dev/null | tr -d '[]' | tr -d '\r')
if [ -n "$PROFILES" ]; then
  echo "  Workspace profiles found in $CFG:"
  declare -a PROFARR=(); n=1
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    echo "    $n) $p"; PROFARR[$n]="$p"; n=$((n+1))
  done <<< "$PROFILES"
  echo "    0) type a different name / use env-var default"
  ask "choose a number" "1" PICK
  # Reject leading zeros (08/09 trigger bash octal error); reject non-numeric and out-of-range.
  if printf '%s' "$PICK" | grep -qE '^[1-9][0-9]*$' && [ -n "${PROFARR[$PICK]:-}" ]; then
    WORKSPACE="${PROFARR[$PICK]}"
  else
    ask "Workspace profile name (blank = env-var default)" "" WORKSPACE
  fi
else
  echo "  (could not read $CFG to list profiles — enter it manually. Use the exact name"
  echo "   inside the brackets in .databrickscfg, DEFAULT if it has a [DEFAULT] section,"
  echo "   or leave blank to use the env-var default workspace.)"
  ask "Databricks workspace profile" "DEFAULT" WORKSPACE
fi
echo "  -> workspace = ${WORKSPACE:-(env-var default)}"

# --- optional Databricks CLI auto-detect (graceful fallback when absent) -------
# If the `databricks` CLI is on PATH and the chosen profile authenticates, use it to
# pick a warehouse by name and to suggest the geometry/id columns. Otherwise, manual.
CLI_OK=0
# Point the CLI at the same config the provider uses. Export when the file EXISTS
# (even if unreadable by the current user) so the CLI reports a clear "permission
# denied" instead of silently falling back to its own default config location.
[ -f "$CFG" ] && export DATABRICKS_CONFIG_FILE="$CFG"
if command -v databricks >/dev/null 2>&1 && [ -n "$WORKSPACE" ]; then
  if timeout 15 databricks current-user me --profile "$WORKSPACE" -o json >/dev/null 2>&1; then
    CLI_OK=1
    echo "  [ok]   Databricks CLI detected + authenticated (profile '$WORKSPACE') — auto-detect on"
  else
    echo "  [info] Databricks CLI present but auth check timed out or failed — falling back to manual entry"
  fi
fi

if [ "$BACKEND" = "lakehouse" ]; then
  WAREHOUSE_PATH=""
  if [ "$CLI_OK" = 1 ]; then
    WIDS=(); WNAMES=()
    while IFS=$'\t' read -r wid wname; do [ -n "$wid" ] && WIDS+=("$wid") && WNAMES+=("$wname"); done < <(timeout 15 databricks warehouses list --profile "$WORKSPACE" -o json 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit()
for w in (d if isinstance(d,list) else []):
    if w.get('id'): print(w['id']+'\t'+(w.get('name') or ''))
" 2>/dev/null)
    if [ "${#WIDS[@]}" -gt 0 ]; then
      echo "  SQL Warehouses (from the Databricks CLI):"
      i=1; for w in "${WNAMES[@]}"; do echo "    $i) $w"; i=$((i+1)); done
      echo "    0) type the http path manually"
      ask "  choose a number" "1" WPICK
      if printf '%s' "$WPICK" | grep -qE '^[1-9][0-9]*$' && [ "$WPICK" -ge 1 ] && [ "$WPICK" -le "${#WIDS[@]}" ]; then
        WAREHOUSE_PATH="/sql/1.0/warehouses/${WIDS[$((WPICK-1))]}"
        echo "  -> $WAREHOUSE_PATH"
      fi
    fi
  fi
  while [ -z "$WAREHOUSE_PATH" ]; do
    ask "SQL Warehouse HTTP path" "/sql/1.0/warehouses/" WAREHOUSE_PATH
    case "$WAREHOUSE_PATH" in ""|*/) echo "   !! Incomplete — include the warehouse id, e.g. /sql/1.0/warehouses/abc123def456."; WAREHOUSE_PATH="";; esac
  done
else
  while :; do ask "Lakebase host (…database.<region>.cloud.databricks.com)" "" LB_HOST; [ -n "$LB_HOST" ] && break; echo "   !! Lakebase host is required."; done
  ask "Lakebase port" "5432" LB_PORT
  while :; do ask "Lakebase database name" "" LB_DB; [ -n "$LB_DB" ] && break; echo "   !! Database name is required."; done
fi
echo

# --- publish loop: one table per pass, reusing connection/workspace/warehouse --
while true; do
  echo "------------------------------------------------------------"
  echo " New feature service"
  echo "------------------------------------------------------------"
  ask "Service name (letters/digits/_ , must start with a letter)" "" SERVICE_NAME
  if ! printf '%s' "$SERVICE_NAME" | grep -qE '^[A-Za-z][A-Za-z0-9_]{0,63}$'; then
    echo "!! '$SERVICE_NAME' is not a valid service name — try again."
    continue
  fi
  if [ "$BACKEND" = "lakehouse" ]; then
    while :; do
      ask "Table (catalog.schema.table)" "" TABLE
      if printf '%s' "$TABLE" | grep -qE '^[^[:space:].]+\.[^[:space:].]+\.[^[:space:].]+$'; then break; fi
      echo "   !! Use a 3-part Unity Catalog name: catalog.schema.table — try again."
    done
    SUG_GEOM=""; SUG_ID=""
    if [ "$CLI_OK" = 1 ]; then
      read -r SUG_GEOM SUG_ID < <(timeout 15 databricks tables get "$TABLE" --profile "$WORKSPACE" -o json 2>/dev/null | guess_cols) || true
      [ "$SUG_GEOM" = "_" ] && SUG_GEOM=""
      [ "$SUG_ID" = "_" ] && SUG_ID=""
      [ -n "$SUG_GEOM$SUG_ID" ] && echo "  (auto-detected from the table — geometry: '${SUG_GEOM:-?}', id: '${SUG_ID:-?}'; press Enter to accept)"
    fi
    while :; do ask "Geometry column" "$SUG_GEOM" GEOM_COL; [ -n "$GEOM_COL" ] && break; echo "   !! Geometry column is required."; done
    echo "  Geometry storage format:  1) WKT   2) WKB   3) GEOJSON   4) GEOMETRY (native)   5) auto-detect"
    ask "  choose 1-5 (5 lets the provider infer it from the column)" "5" GF
    case "$GF" in
      1) GEOM_FORMAT=WKT;; 2) GEOM_FORMAT=WKB;; 3) GEOM_FORMAT=GEOJSON;; 4) GEOM_FORMAT=GEOMETRY;; *) GEOM_FORMAT="";;
    esac
    while :; do ask "ID field (UNIQUE integer <= 2147483647; not a UUID)" "$SUG_ID" ID_FIELD; [ -n "$ID_FIELD" ] && break; echo "   !! ID field is required."; done
    ask "SRID" "4326" SRID
    ask "Time column (optional; blank if none)" "" TIME_COL
    ask "Max record count per page" "2000" MAXREC
    CAPABILITIES="Query"; EDITING=""
  else
    ask "Lakebase schema" "public" LB_SCHEMA
    while :; do ask "Lakebase table name" "" LB_TABLE; [ -n "$LB_TABLE" ] && break; echo "   !! Table name is required."; done
    while :; do ask "Geometry column" "" GEOM_COL; [ -n "$GEOM_COL" ] && break; echo "   !! Geometry column is required."; done
    while :; do ask "ID field (UNIQUE integer <= 2147483647; not a UUID)" "" ID_FIELD; [ -n "$ID_FIELD" ] && break; echo "   !! ID field is required."; done
    ask "SRID" "4326" SRID
    ask "Enable editing (add / update / delete)? (y/n)" "y" ED
    case "$ED" in y|Y|yes|YES) EDITING="true"; CAPABILITIES="Query,Editing";; *) EDITING="false"; CAPABILITIES="Query";; esac
  fi

  echo
  echo "-- Review --"
  printf "  %-13s %s\n" "Service name" "$SERVICE_NAME"
  printf "  %-13s %s\n" "Backend"      "$BACKEND"
  printf "  %-13s %s\n" "Provider"     "$PROVIDER_NAME"
  printf "  %-13s %s\n" "Workspace"    "${WORKSPACE:-(env-var default)}"
  if [ "$BACKEND" = "lakehouse" ]; then
    printf "  %-13s %s\n" "Warehouse"    "$WAREHOUSE_PATH"
    printf "  %-13s %s\n" "Table"        "$TABLE"
    printf "  %-13s %s\n" "Geometry col" "$GEOM_COL"
    printf "  %-13s %s\n" "Geometry fmt" "${GEOM_FORMAT:-(auto-detect)}"
    printf "  %-13s %s\n" "ID field"     "$ID_FIELD"
    printf "  %-13s %s\n" "SRID"         "$SRID"
    printf "  %-13s %s\n" "Time column"  "${TIME_COL:-(none)}"
    printf "  %-13s %s\n" "Max records"  "$MAXREC"
  else
    printf "  %-13s %s\n" "Lakebase"     "$LB_HOST:$LB_PORT/$LB_DB"
    printf "  %-13s %s\n" "Schema.table" "$LB_SCHEMA.$LB_TABLE"
    printf "  %-13s %s\n" "Geometry col" "$GEOM_COL"
    printf "  %-13s %s\n" "ID field"     "$ID_FIELD"
    printf "  %-13s %s\n" "SRID"         "$SRID"
    printf "  %-13s %s\n" "Editing"      "$EDITING"
  fi
  echo
  ask "Proceed and create this service? (y/n)" "y" GO
  case "$GO" in
    y|Y|yes|YES) : ;;
    *) echo "Skipped — '$SERVICE_NAME' not created."
       ask "Publish another table from the same data source? (y/n)" "n" MORE
       case "$MORE" in y|Y|yes|YES) echo; continue;; *) break;; esac ;;
  esac
  echo

  export SERVICE_NAME WORKSPACE WAREHOUSE_PATH TABLE GEOM_COL GEOM_FORMAT ID_FIELD SRID TIME_COL MAXREC \
         LB_HOST LB_PORT LB_DB LB_SCHEMA LB_TABLE EDITING CAPABILITIES PROVIDER_NAME
  SVC=$(build_service_json)

  echo "-> creating service '$SERVICE_NAME'..."
  CREATE=$("${CURL[@]}" --max-time 60 "$SERVER/$CTX/admin/services/createService" \
    --data-urlencode "service=$SVC" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  STATUS=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  OK=0
  if [ "$STATUS" = "success" ]; then
    echo "   created."; OK=1
  elif printf '%s' "$CREATE" | grep -qiE "already exists|already exist in"; then
    echo "   a service named '$SERVICE_NAME' already exists — continuing to start + verify."
    echo "   (If you meant to change its settings, delete it first and re-run.)"; OK=1
  else
    echo "!! createService did not succeed. Response:"
    printf '%s\n' "$CREATE"
    echo "   (Common: a service parameter is wrong, or the name is taken.)"
  fi

  if [ "$OK" = "1" ]; then
    echo
    echo "-> starting service..."
    START_RESP=$("${CURL[@]}" --max-time 30 "$SERVER/$CTX/admin/services/$SERVICE_NAME.FeatureServer/start" \
      --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
    START_STATUS=$(printf '%s' "$START_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status') or '')" 2>/dev/null)
    if [ "$START_STATUS" = "success" ]; then
      echo "   started."
    else
      echo "   [warn] start response status='$START_STATUS' — raw: $(printf '%s' "$START_RESP" | head -c 400)"
    fi
    echo
    # REST query validates tokens more strictly than admin on some servers: a requestip
    # token (fine for create/start) can be refused with "ClientID does not match". Mint a
    # referer-bound token + matching Referer header for the query; fall back to admin token.
    echo "-> sample query (5 rows)..."
    mint_token referer "$SERVER"
    QTOKEN=$(printf '%s' "$MINT_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token') or '')" 2>/dev/null)
    [ -z "$QTOKEN" ] && QTOKEN="$TOKEN"
    # Use -G with --data-urlencode so token and all params are properly URL-encoded.
    # Retry on cold start: a freshly created service can 404 for a few seconds while the
    # provider initializes (maxStartupTime is 300s). Poll up to ~30s before judging failure.
    QPARSE=""; Q=""
    for _attempt in 1 2 3 4 5 6; do
      Q=$("${CURL[@]}" --max-time 60 -G -H "Referer: $SERVER" \
        "$SERVER/$CTX/rest/services/$SERVICE_NAME/FeatureServer/0/query" \
        --data-urlencode "where=1=1" \
        --data-urlencode "outFields=*" \
        --data-urlencode "resultRecordCount=5" \
        --data-urlencode "returnGeometry=true" \
        --data-urlencode "token=$QTOKEN" \
        --data-urlencode "f=json")
      # Parse: valid (possibly empty) FeatureCollection vs error, so an empty table
      # doesn't trip the false-failure diagnostics below.
      QPARSE=$(printf '%s' "$Q" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('unparseable'); sys.exit()
if 'error' in d:
    print('error:' + str(d['error'].get('message', d['error'])))
elif 'features' in d:
    print('ok:' + str(len(d['features'])))
else:
    print('unknown')
" 2>/dev/null || echo "unparseable")
      # Success or a definitive data error → stop. Keep retrying only while the service
      # still looks like it is starting (404 / not found / not yet available).
      case "$QPARSE" in ok:*) break;; esac
      if printf '%s' "$Q" | grep -qiE "Service not found|not available|404"; then
        if [ "$_attempt" -lt 6 ]; then echo "   (service still starting — retry $_attempt/6)"; sleep 5; continue; fi
      fi
      break
    done
    NFEAT=$(printf '%s' "$QPARSE" | sed 's/^ok://;s/[^0-9].*//' | grep -E '^[0-9]+$' || echo "0")
    [[ "$NFEAT" =~ ^[0-9]+$ ]] || NFEAT=0
    echo
    if printf '%s' "$QPARSE" | grep -q '^ok:'; then
      echo "  ============================================================"
      if [ "$NFEAT" -gt 0 ]; then
        echo "   SUCCESS — $NFEAT feature(s). '$SERVICE_NAME' is live."
      else
        echo "   SUCCESS — service is live (table is currently empty; 0 rows returned)."
      fi
      echo "  ============================================================"
      echo "   REST (on box): $SERVER/$CTX/rest/services/$SERVICE_NAME/FeatureServer/0"
      echo "   Via web adaptor: https://<your-host>/<webadaptor>/rest/services/$SERVICE_NAME/FeatureServer/0"
      PUBLISHED+=("$SERVICE_NAME  ->  $SERVER/$CTX/rest/services/$SERVICE_NAME/FeatureServer/0")
    elif printf '%s' "$Q" | grep -qiE "Invalid token|ClientID does not match|Token Required"; then
      echo "  Service CREATED + STARTED; auto-verify inconclusive (a token technicality, not a data problem)."
      echo "  Verify manually with a referer-bound token + a matching 'Referer: $SERVER' header on the query."
    else
      echo "!! Service query returned an error or unexpected response. Raw response:"
      printf '%s\n' "$Q" | head -c 2000; echo
      echo "   - 404 / 'Service not found' => service did not start: wrong tableName/geometryColumn, or the"
      echo "       provider errored initializing it (table/column missing). Fix the value and re-run."
      echo "   - 'No default Databricks workspace configured' => .databrickscfg/workspace issue"
      echo "       (workspace='${WORKSPACE:-(env-var default)}'); restart the server after fixing (profiles cache)."
      echo "   - invalid_client / 401 => SP creds or OIDC unreachable.  SSL => NODE_EXTRA_CA_CERTS in init_user_param.sh."
      echo "   - SELECT / column error => tableName/geometryColumn/idField wrong, or SP lacks USE + SELECT grants."
    fi
  fi

  echo
  ask "Publish another table from the same data source? (y/n)" "n" MORE
  case "$MORE" in y|Y|yes|YES) echo;; *) break;; esac
done
echo
if [ "${#PUBLISHED[@]}" -gt 0 ]; then
  echo "============================================================"
  echo " Published this session (${#PUBLISHED[@]}):"
  for _p in "${PUBLISHED[@]}"; do echo "   $_p"; done
  echo "============================================================"
  echo
fi
echo "Done."
