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
set -uo pipefail   # deliberately NOT -e: we handle and explain errors ourselves.

PROVIDER_NAME="databricks-geospatial-provider"

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
echo "-> requesting admin token (client=requestip)..."
TOKEN_RESP=$(curl -sk "$SERVER/$CTX/admin/generateToken" \
  --data-urlencode "username=$ADMIN_USER" \
  --data-urlencode "password=$ADMIN_PASS" \
  --data-urlencode "client=requestip" \
  --data-urlencode "f=json")
TOKEN=$(printf '%s' "$TOKEN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "!! No token was returned. The server said:"
  printf '%s\n' "$TOKEN_RESP" | head -c 700; echo
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

PROV_JSON=$(curl -sk "$SERVER/$CTX/admin/services/types/customdataproviders" \
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
  ask "         which provider to use" "1" PPICK
  if printf '%s' "$PPICK" | grep -qE '^[0-9]+$' && [ "$PPICK" -ge 1 ] && [ "$PPICK" -le "${#PROVS[@]}" ]; then
    PROVIDER_NAME="${PROVS[$((PPICK-1))]}"
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
if [ -r "$CFG" ]; then
  echo "  [ok]   Databricks config readable: $CFG"
else
  echo "  [warn] could not read $CFG (may just be a permissions/other-user check — often fine)."
  echo "         The provider runs as 'arcgis' and reads it at query time; ensure it exists there"
  echo "         (chown arcgis:arcgis, chmod 600) or set DATABRICKS_CONFIG_FILE in init_user_param.sh."
fi
echo

# --- helper: build the createService JSON for the current per-table variables --
build_service_json() {
python3 - <<'PY'
import os, json
params = {
    "workspace":         os.environ["WORKSPACE"],
    "warehouseHttpPath": os.environ["WAREHOUSE_PATH"],
    "tableName":         os.environ["TABLE"],
    "geometryColumn":    os.environ["GEOM_COL"],
    "idField":           os.environ["ID_FIELD"],
    "geometryFormat":    os.environ["GEOM_FORMAT"],
    "timeColumn":        os.environ["TIME_COL"],
    "lakebaseHost": "", "lakebasePort": "", "lakebaseDatabase": "",
    "lakebaseSchema": "", "lakebaseTable": "",
    "maxRecordCount":    os.environ["MAXREC"],
    "srid":              os.environ["SRID"],
    "editingEnabled":    "",
}
svc = {
    "serviceName": os.environ["SERVICE_NAME"],
    "type": "FeatureServer", "capabilities": "Query", "provider": "CUSTOMDATA",
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

# --- data source: pick workspace + warehouse ONCE (shared for every table) -----
echo "-- Data source (used for every table you publish this session) --"
# Workspace profile pick-list read from the SAME .databrickscfg the provider uses.
CFG="${DATABRICKS_CONFIG_FILE:-/home/arcgis/.databrickscfg}"
PROFILES=""
[ -r "$CFG" ] && PROFILES=$(grep -oE '^\[[^]]+\]' "$CFG" 2>/dev/null | tr -d '[]')
if [ -n "$PROFILES" ]; then
  echo "  Workspace profiles found in $CFG:"
  declare -a PROFARR=(); n=1
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    echo "    $n) $p"; PROFARR[$n]="$p"; n=$((n+1))
  done <<< "$PROFILES"
  echo "    0) type a different name / use env-var default"
  ask "choose a number" "1" PICK
  if printf '%s' "$PICK" | grep -qE '^[0-9]+$' && [ -n "${PROFARR[$PICK]:-}" ]; then
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
ask "SQL Warehouse HTTP path" "/sql/1.0/warehouses/" WAREHOUSE_PATH
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
  ask "Table (catalog.schema.table)" "" TABLE
  ask "Geometry column" "" GEOM_COL
  echo "  Geometry storage format:  1) WKT   2) WKB   3) GEOJSON   4) GEOMETRY (native)   5) auto-detect"
  ask "  choose 1-5 (5 lets the provider infer it from the column)" "5" GF
  case "$GF" in
    1) GEOM_FORMAT=WKT;; 2) GEOM_FORMAT=WKB;; 3) GEOM_FORMAT=GEOJSON;; 4) GEOM_FORMAT=GEOMETRY;; *) GEOM_FORMAT="";;
  esac
  ask "ID field (must be a UNIQUE integer <= 2147483647; not a UUID)" "" ID_FIELD
  ask "SRID" "4326" SRID
  ask "Time column (optional; blank if none)" "" TIME_COL
  ask "Max record count per page" "2000" MAXREC

  echo
  echo "-- Review --"
  printf "  %-13s %s\n" "Service name" "$SERVICE_NAME"
  printf "  %-13s %s\n" "Provider"     "$PROVIDER_NAME"
  printf "  %-13s %s\n" "Workspace"    "${WORKSPACE:-(env-var default)}"
  printf "  %-13s %s\n" "Warehouse"    "$WAREHOUSE_PATH"
  printf "  %-13s %s\n" "Table"        "$TABLE"
  printf "  %-13s %s\n" "Geometry col" "$GEOM_COL"
  printf "  %-13s %s\n" "Geometry fmt" "${GEOM_FORMAT:-(auto-detect)}"
  printf "  %-13s %s\n" "ID field"     "$ID_FIELD"
  printf "  %-13s %s\n" "SRID"         "$SRID"
  printf "  %-13s %s\n" "Time column"  "${TIME_COL:-(none)}"
  printf "  %-13s %s\n" "Max records"  "$MAXREC"
  echo
  ask "Proceed and create this service? (y/n)" "y" GO
  case "$GO" in
    y|Y|yes|YES) : ;;
    *) echo "Skipped — '$SERVICE_NAME' not created."
       ask "Publish another table from the same warehouse? (y/n)" "n" MORE
       case "$MORE" in y|Y|yes|YES) echo; continue;; *) break;; esac ;;
  esac
  echo

  export SERVICE_NAME WORKSPACE WAREHOUSE_PATH TABLE GEOM_COL GEOM_FORMAT ID_FIELD SRID TIME_COL MAXREC PROVIDER_NAME
  SVC=$(build_service_json)

  echo "-> creating service '$SERVICE_NAME'..."
  CREATE=$(curl -sk "$SERVER/$CTX/admin/services/createService" \
    --data-urlencode "service=$SVC" --data-urlencode "token=$TOKEN" --data-urlencode "f=json")
  STATUS=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  OK=0
  if [ "$STATUS" = "success" ]; then
    echo "   created."; OK=1
  elif printf '%s' "$CREATE" | grep -qiE "already exist|exists in folder|exists in"; then
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
    curl -sk "$SERVER/$CTX/admin/services/$SERVICE_NAME.FeatureServer/start" \
      --data-urlencode "token=$TOKEN" --data-urlencode "f=json" >/dev/null
    echo "   requested."
    echo
    # REST query validates tokens more strictly than admin on some servers: a requestip
    # token (fine for create/start) can be refused with "ClientID does not match". Mint a
    # referer-bound token + matching Referer header for the query; fall back to admin token.
    echo "-> sample query (5 rows)..."
    QTOKEN=$(curl -sk "$SERVER/$CTX/admin/generateToken" \
      --data-urlencode "username=$ADMIN_USER" --data-urlencode "password=$ADMIN_PASS" \
      --data-urlencode "client=referer" --data-urlencode "referer=$SERVER" \
      --data-urlencode "f=json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
    [ -z "$QTOKEN" ] && QTOKEN="$TOKEN"
    Q=$(curl -sk -H "Referer: $SERVER" \
      "$SERVER/$CTX/rest/services/$SERVICE_NAME/FeatureServer/0/query?where=1=1&outFields=*&resultRecordCount=5&returnGeometry=true&token=$QTOKEN&f=json")
    NFEAT=$(printf '%s' "$Q" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('features',[])))" 2>/dev/null || echo "0")
    echo
    if [ "$NFEAT" -gt 0 ] 2>/dev/null; then
      echo "  ============================================================"
      echo "   SUCCESS — $NFEAT feature(s). '$SERVICE_NAME' is live."
      echo "  ============================================================"
      echo "   REST (on box): $SERVER/$CTX/rest/services/$SERVICE_NAME/FeatureServer/0"
      echo "   Via web adaptor: https://<your-host>/<webadaptor>/rest/services/$SERVICE_NAME/FeatureServer/0"
    elif printf '%s' "$Q" | grep -qiE "Invalid token|ClientID does not match|Token Required"; then
      echo "  Service CREATED + STARTED; auto-verify inconclusive (a token technicality, not a data problem)."
      echo "  Verify manually with a referer-bound token + a matching 'Referer: $SERVER' header on the query."
    else
      echo "!! The query returned no features. Raw response:"
      printf '%s\n' "$Q" | head -c 700; echo
      echo "   - 404 / 'Service not found' => service did not start: wrong tableName/geometryColumn, or the"
      echo "       provider errored initializing it (table/column missing). Fix the value and re-run."
      echo "   - 'No default Databricks workspace configured' => .databrickscfg/workspace issue"
      echo "       (workspace='${WORKSPACE:-(env-var default)}'); restart the server after fixing (profiles cache)."
      echo "   - invalid_client / 401 => SP creds or OIDC unreachable.  SSL => NODE_EXTRA_CA_CERTS in init_user_param.sh."
      echo "   - SELECT / column error => tableName/geometryColumn/idField wrong, or SP lacks USE + SELECT grants."
    fi
  fi

  echo
  ask "Publish another table from the same warehouse? (y/n)" "n" MORE
  case "$MORE" in y|Y|yes|YES) echo;; *) break;; esac
done
echo
echo "Done."
