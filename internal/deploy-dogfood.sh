#!/usr/bin/env bash
###############################################################################
# deploy-dogfood.sh
#
# Full deployment of the Databricks CDF provider on a fresh EC2 instance
# that already has ArcGIS Server 12.0 installed from an AMI.
#
# Usage:
#   ./deploy-dogfood.sh <INSTANCE_IP>
#
# Example:
#   ./deploy-dogfood.sh 54.123.45.67
###############################################################################
set -euo pipefail

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }
hdr()  { echo -e "\n${CYAN}${BOLD}========== $* ==========${NC}\n"; }

# ---------------------------------------------------------------------------
# Arguments & constants
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
    err "Usage: $0 <INSTANCE_IP>"
    exit 1
fi

IP="$1"
SSH_KEY="$HOME/.ssh/AnandTrivediRSAPEM.pem"
SSH_USER="ubuntu"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
SSH_CMD="ssh $SSH_OPTS ${SSH_USER}@${IP}"

ADMIN_USER="siteadmin"
ADMIN_PASS="${ADMIN_PASS:?Set ADMIN_PASS env var}"
ADMIN_PASS_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${ADMIN_PASS}'))")
SERVER_URL="https://localhost:6443"

# Databricks credentials
DB_HOSTNAME="e2-demo-field-eng.cloud.databricks.com"
DB_HTTP_PATH="/sql/1.0/warehouses/0024da9c9e9a4dc2"
DB_TOKEN="${DATABRICKS_TOKEN:?Set DATABRICKS_TOKEN env var}"
LAKEBASE_INSTANCE="cdf-geospatial"
LAKEBASE_HOST="instance-e68b81ba-85e4-4b62-b281-9450875a8ad2.database.cloud.databricks.com"
LAKEBASE_PORT="5432"
LAKEBASE_DB="geospatial"

# Provider paths
PROVIDER_NAME="databricks-geospatial-provider"
PROVIDER_DEPLOY="/opt/arcgis/server/framework/runtime/customdata/providers/${PROVIDER_NAME}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# This script lives in internal/; the provider source is at the repo root (one level up).
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCAL_PROVIDER="${REPO_ROOT}/nodejs-provider"
LICENSE_PATH="/opt/software/licenses/Server_Ent_Adv_AllExt.ecp"

# ---------------------------------------------------------------------------
# Helper: run a command on the remote host
# ---------------------------------------------------------------------------
remote() {
    $SSH_CMD "$@"
}

# ---------------------------------------------------------------------------
# Helper: run a script on the remote host (avoids quoting hell)
# ---------------------------------------------------------------------------
remote_script() {
    $SSH_CMD 'bash -s' <<< "$1"
}

# ---------------------------------------------------------------------------
# Helper: wait for ArcGIS Server to respond
# ---------------------------------------------------------------------------
wait_for_server() {
    local max_wait=${1:-120}
    info "Waiting for ArcGIS Server to respond (max ${max_wait}s)..."
    local script
    read -r -d '' script << 'WAITEOF' || true
elapsed=0
while [ $elapsed -lt MAX_WAIT ]; do
    resp=$(curl -sk 'https://localhost:6443/arcgis/rest/info?f=json' 2>/dev/null || true)
    if echo "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "currentVersion" in d' 2>/dev/null; then
        echo 'SERVER_READY'
        exit 0
    fi
    sleep 3
    elapsed=$((elapsed+3))
    echo "  ... ${elapsed}s elapsed"
done
echo 'TIMEOUT'
exit 1
WAITEOF
    script="${script//MAX_WAIT/$max_wait}"
    remote_script "$script"
    local status=$?
    if [[ $status -ne 0 ]]; then
        err "ArcGIS Server did not respond within ${max_wait}s"
        exit 1
    fi
    ok "ArcGIS Server is responding"
}

# ---------------------------------------------------------------------------
# Helper: get admin token from remote host
# ---------------------------------------------------------------------------
get_remote_token() {
    local token
    token=$($SSH_CMD 'bash -s' << TOKEOF
curl -sk 'https://localhost:6443/arcgis/admin/generateToken' \
  -d 'username=${ADMIN_USER}&password=${ADMIN_PASS_ENCODED}&client=referer&referer=https://localhost:6443&f=json' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))"
TOKEOF
    )
    # Strip whitespace
    token=$(echo "$token" | tr -d '[:space:]')
    if [[ -z "$token" || "$token" == "None" ]]; then
        err "Failed to get admin token"
        exit 1
    fi
    echo "$token"
}

###############################################################################
#                       PHASE 1 — SERVER SETUP
###############################################################################
hdr "PHASE 1: Server Setup"

info "Stopping ArcGIS Server (if running)..."
remote "sudo -u arcgis /opt/arcgis/server/stopserver.sh 2>/dev/null || true"
ok "Server stopped (or was not running)"

info "Deleting old site configuration..."
remote "sudo rm -rf /opt/arcgis/server/usr/config-store /opt/arcgis/server/usr/directories /opt/arcgis/server/usr/logs"
ok "Old site config removed"

info "Starting ArcGIS Server..."
remote "sudo -u arcgis /opt/arcgis/server/startserver.sh"
ok "Start command issued"

wait_for_server 120

info "Creating new ArcGIS Server site..."
# The cluster= empty parameter is critical to avoid "Index 0 out of bounds" error.
SITE_RESULT=$($SSH_CMD 'bash -s' << SITEEOF
curl -sk 'https://localhost:6443/arcgis/admin/createNewSite' \
  --max-time 180 \
  --data-urlencode 'username=${ADMIN_USER}' \
  --data-urlencode 'password=${ADMIN_PASS}' \
  --data-urlencode 'configStoreConnection={"type":"FILESYSTEM","connectionString":"/opt/arcgis/server/usr/config-store"}' \
  --data-urlencode 'directories={"directories":[{"name":"arcgisoutput","physicalPath":"/opt/arcgis/server/usr/directories/arcgisoutput","dirType":"OUTPUT"},{"name":"arcgiscache","physicalPath":"/opt/arcgis/server/usr/directories/arcgiscache","dirType":"CACHE"},{"name":"arcgisjobs","physicalPath":"/opt/arcgis/server/usr/directories/arcgisjobs","dirType":"JOBS"},{"name":"arcgissystem","physicalPath":"/opt/arcgis/server/usr/directories/arcgissystem","dirType":"SYSTEM"}]}' \
  --data-urlencode 'cluster=' \
  --data-urlencode 'f=json'
SITEEOF
)
echo "$SITE_RESULT"

# Check for success status
if echo "$SITE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='success' or 'success' in str(d)" 2>/dev/null; then
    ok "Site creation initiated"
else
    if echo "$SITE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'error' in str(d).lower()" 2>/dev/null; then
        err "Site creation failed: $SITE_RESULT"
        exit 1
    fi
    info "Site creation response received — waiting for completion..."
fi

info "Waiting 45 seconds for site creation to finalize..."
sleep 45

wait_for_server 120

info "Verifying site with token generation..."
TOKEN=$(get_remote_token)
ok "Site created and token verified"

###############################################################################
#                     PHASE 2 — LICENSE ACTIVATION
###############################################################################
hdr "PHASE 2: License Activation"

info "Getting admin token..."
TOKEN=$(get_remote_token)
ok "Token acquired"

info "Authorizing license from ${LICENSE_PATH}..."
LICENSE_RESULT=$($SSH_CMD "bash -s" << LICEOF
curl -sk "https://localhost:6443/arcgis/admin/system/licenses/authorize?token=${TOKEN}&f=json" \
  -F "authorizationFile=@${LICENSE_PATH}"
LICEOF
)
echo "$LICENSE_RESULT"

if echo "$LICENSE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='success' or 'success' in str(d).lower()" 2>/dev/null; then
    ok "License authorized successfully"
else
    if echo "$LICENSE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'already' in str(d).lower() or 'authorized' in str(d).lower()" 2>/dev/null; then
        info "License appears to be already authorized"
    else
        err "License authorization may have failed: $LICENSE_RESULT"
        info "Continuing anyway — check manually if needed"
    fi
fi

###############################################################################
#                   PHASE 3 — DEPLOY CDF PROVIDER
###############################################################################
hdr "PHASE 3: Deploy CDF Provider"

info "Uploading nodejs-provider to remote host (tar over SSH)..."
# Use tar to transfer — avoids scp issues with node_modules symlinks
(cd "$LOCAL_PROVIDER" && tar czf - \
    --exclude='.env' \
    --exclude='logs/*' \
    --exclude='*.cdpk' \
    --exclude='LAKEBASE-vs-DATABRICKS.md' \
    . ) | $SSH_CMD "cat > /tmp/cdf-provider.tar.gz"
ok "Provider uploaded"

info "Deploying provider to ${PROVIDER_DEPLOY}..."
$SSH_CMD "bash -s" << DEPLOYEOF
sudo rm -rf '${PROVIDER_DEPLOY}'
sudo mkdir -p '${PROVIDER_DEPLOY}'
sudo tar xzf /tmp/cdf-provider.tar.gz -C '${PROVIDER_DEPLOY}'
sudo chown -R arcgis:arcgis '${PROVIDER_DEPLOY}'
rm -f /tmp/cdf-provider.tar.gz
DEPLOYEOF
ok "Provider files deployed"

info "Creating .env file with Databricks credentials..."
$SSH_CMD "bash -s" << ENVEOF
cat > /tmp/cdf-env << 'INNEREOF'
# Databricks Connection
DATABRICKS_SERVER_HOSTNAME=e2-demo-field-eng.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/0024da9c9e9a4dc2
DATABRICKS_ACCESS_TOKEN=${DB_TOKEN}

# Lakebase — auto-generates OAuth tokens from PAT
LAKEBASE_INSTANCE_NAME=cdf-geospatial

# Connection pool tuning
DATABRICKS_POOL_MIN=2
DATABRICKS_POOL_MAX=10
LAKEBASE_POOL_MIN=2
LAKEBASE_POOL_MAX=10

# Query defaults
DATABRICKS_MAX_RECORD_COUNT=2000
DATABRICKS_QUERY_TIMEOUT=120000
INNEREOF
sudo cp /tmp/cdf-env '${PROVIDER_DEPLOY}/.env'
sudo chown arcgis:arcgis '${PROVIDER_DEPLOY}/.env'
sudo chmod 600 '${PROVIDER_DEPLOY}/.env'
rm -f /tmp/cdf-env
ENVEOF
ok ".env created"

info "Setting env vars in init_user_param.sh..."
$SSH_CMD "bash -s" << INITEOF
INIT_FILE='/opt/arcgis/server/usr/init_user_param.sh'
sudo touch "\$INIT_FILE"
sudo chown arcgis:arcgis "\$INIT_FILE"
sudo chmod 755 "\$INIT_FILE"

# Remove any old Databricks/Lakebase exports
sudo sed -i '/DATABRICKS_SERVER_HOSTNAME/d' "\$INIT_FILE"
sudo sed -i '/DATABRICKS_HTTP_PATH/d' "\$INIT_FILE"
sudo sed -i '/DATABRICKS_ACCESS_TOKEN/d' "\$INIT_FILE"
sudo sed -i '/LAKEBASE_INSTANCE_NAME/d' "\$INIT_FILE"
sudo sed -i '/# Databricks CDF Provider/d' "\$INIT_FILE"

# Append the new exports
{
    echo ''
    echo '# Databricks CDF Provider environment variables'
    echo 'export DATABRICKS_SERVER_HOSTNAME=${DB_HOSTNAME}'
    echo 'export DATABRICKS_HTTP_PATH=${DB_HTTP_PATH}'
    echo 'export DATABRICKS_ACCESS_TOKEN=${DB_TOKEN}'
    echo 'export LAKEBASE_INSTANCE_NAME=${LAKEBASE_INSTANCE}'
} | sudo tee -a "\$INIT_FILE" > /dev/null
INITEOF
ok "init_user_param.sh updated"

info "Restarting ArcGIS Server to pick up provider..."
remote "sudo -u arcgis /opt/arcgis/server/stopserver.sh 2>/dev/null || true"
sleep 5
remote "sudo -u arcgis /opt/arcgis/server/startserver.sh"
ok "Restart command issued"

wait_for_server 120

###############################################################################
#                  PHASE 4 — CREATE FEATURE SERVICES
###############################################################################
hdr "PHASE 4: Create Feature Services"

info "Getting admin token..."
TOKEN=$(get_remote_token)
ok "Token acquired"

# ---------------------------------------------------------------------------
# Helper: create a feature service
#   Writes service JSON to a temp file on the remote to avoid quoting issues.
# ---------------------------------------------------------------------------
create_service() {
    local service_name="$1"
    local capabilities="$2"
    local table_name="$3"
    local geometry_column="$4"
    local id_field="$5"
    local geometry_format="$6"
    local time_column="$7"
    local lb_host="$8"
    local lb_port="$9"
    local lb_database="${10}"
    local lb_schema="${11}"
    local lb_table="${12}"
    local max_record_count="${13}"
    local srid="${14}"
    local editing_enabled="${15}"

    info "Creating service: ${service_name} (${capabilities})..."

    # Build the service JSON locally
    local service_json
    service_json=$(python3 -c "
import json
svc = {
    'serviceName': '${service_name}',
    'type': 'FeatureServer',
    'capabilities': '${capabilities}',
    'provider': 'CUSTOMDATA',
    'clusterName': 'default',
    'minInstancesPerNode': 0,
    'maxInstancesPerNode': 0,
    'instancesPerContainer': 1,
    'configuredState': 'STARTED',
    'properties': {'disableCaching': 'true'},
    'jsonProperties': {
        'customDataProviderInfo': {
            'dataProviderName': '${PROVIDER_NAME}',
            'serviceParameters': {
                'tableName': '${table_name}',
                'geometryColumn': '${geometry_column}',
                'idField': '${id_field}',
                'geometryFormat': '${geometry_format}',
                'timeColumn': '${time_column}',
                'lakebaseHost': '${lb_host}',
                'lakebasePort': '${lb_port}',
                'lakebaseDatabase': '${lb_database}',
                'lakebaseSchema': '${lb_schema}',
                'lakebaseTable': '${lb_table}',
                'maxRecordCount': '${max_record_count}',
                'srid': '${srid}',
                'editingEnabled': '${editing_enabled}'
            }
        }
    }
}
print(json.dumps(svc))
")

    # Write JSON to a temp file on remote, then use it with curl
    echo "$service_json" | $SSH_CMD "cat > /tmp/cdf-service.json"

    local result
    result=$($SSH_CMD "bash -s" << CURLEOF
SERVICE_JSON=\$(cat /tmp/cdf-service.json)
curl -sk "https://localhost:6443/arcgis/admin/services/createService?token=${TOKEN}&f=json" \
  -H "Referer: https://localhost:6443" \
  --data-urlencode "service=\${SERVICE_JSON}"
rm -f /tmp/cdf-service.json
CURLEOF
    )

    if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='success'" 2>/dev/null; then
        ok "  ${service_name} created successfully"
        return 0
    else
        err "  ${service_name} creation failed: $result"
        return 1
    fi
}

# ---- Lakehouse services (read-only) ----
info "Creating Lakehouse (read-only) services..."

#                    name              caps    tableName                             geomCol    id   geomFmt    time lbHost lbPort lbDb lbSchema lbTable  maxRec srid editing
create_service "CellTowers"          "Query" "atrivedi.geospatial.us_cell_towers"  "geometry" "id" "GEOMETRY" ""   ""     ""     ""   ""       ""       "2000" "4326" ""
create_service "USHighways"          "Query" "atrivedi.geospatial.us_highways"     "geometry" "id" "GEOMETRY" ""   ""     ""     ""   ""       ""       "2000" "4326" ""
create_service "LandParcels"         "Query" "atrivedi.geospatial.us_land_parcels" "geometry" "id" "GEOMETRY" ""   ""     ""     ""   ""       ""       "2000" "4326" ""
create_service "DISACandidates"      "Query" "atrivedi.disa_hr.candidates_geo"     "geometry" "id" "GEOMETRY" ""   ""     ""     ""   ""       ""       "2000" "4326" ""

# ---- Lakebase services (read + write) ----
info "Creating Lakebase (query + editing) services..."

create_service "CellTowersEditable"     "Query,Editing" "" "geometry" "id" "" "" \
    "${LAKEBASE_HOST}" "${LAKEBASE_PORT}" "${LAKEBASE_DB}" "public" "cell_towers" "2000" "4326" "true"

create_service "OverturePlacesLakebase" "Query,Editing" "" "geometry" "id" "" "" \
    "${LAKEBASE_HOST}" "${LAKEBASE_PORT}" "${LAKEBASE_DB}" "public" "overture_places" "2000" "4326" "true"

ok "All service creation requests completed"

info "Waiting 15 seconds for services to initialize..."
sleep 15

###############################################################################
#                   PHASE 5 — VERIFICATION
###############################################################################
hdr "PHASE 5: Verification"

info "Getting fresh admin token..."
TOKEN=$(get_remote_token)
ok "Token acquired"

# ---------------------------------------------------------------------------
# Helper: test a query on a service
# ---------------------------------------------------------------------------
test_query() {
    local service_name="$1"
    info "Testing query on ${service_name}..."

    local result
    result=$($SSH_CMD "bash -s" << QUERYEOF
curl -sk "https://localhost:6443/arcgis/rest/services/${service_name}/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=1&f=json&token=${TOKEN}" \
  -H "Referer: https://localhost:6443" \
  --max-time 60
QUERYEOF
    ) || result='{"error":{"message":"curl or SSH failed"}}'

    if echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
features = d.get('features', [])
if len(features) > 0:
    print(f'  Features returned: {len(features)}')
    attrs = features[0].get('attributes', {})
    keys = list(attrs.keys())[:5]
    print(f'  Sample fields: {keys}')
    sys.exit(0)
elif 'error' in d:
    print(f'  Error: {d[\"error\"].get(\"message\", str(d[\"error\"]))}')
    sys.exit(1)
else:
    print(f'  No features returned (may be empty table)')
    sys.exit(0)
" 2>/dev/null; then
        ok "  ${service_name} -- query succeeded"
        return 0
    else
        err "  ${service_name} -- query failed"
        echo "  Response (first 500 chars): $(echo "$result" | head -c 500)"
        return 1
    fi
}

SERVICES=(
    "CellTowers"
    "USHighways"
    "LandParcels"
    "DISACandidates"
    "CellTowersEditable"
    "OverturePlacesLakebase"
)

PASS=0
FAIL=0
for svc in "${SERVICES[@]}"; do
    if test_query "$svc"; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1))
    fi
done

echo ""
info "Query results: ${PASS} passed, ${FAIL} failed out of ${#SERVICES[@]} services"

# ---------------------------------------------------------------------------
# Test editing on CellTowersEditable
# ---------------------------------------------------------------------------
hdr "PHASE 5b: Edit Verification (CellTowersEditable)"

info "Testing applyEdits — ADD a test feature..."
ADD_RESULT=$($SSH_CMD "bash -s" << ADDEOF
curl -sk "https://localhost:6443/arcgis/rest/services/CellTowersEditable/FeatureServer/0/applyEdits?token=${TOKEN}&f=json" \
  -H "Referer: https://localhost:6443" \
  --max-time 30 \
  --data-urlencode 'adds=[{"geometry":{"x":-77.036,"y":38.897,"spatialReference":{"wkid":4326}},"attributes":{}}]'
ADDEOF
) || ADD_RESULT='{"error":"curl or SSH failed"}'

ADDED_ID=$(echo "$ADD_RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    adds = d.get('addResults', [])
    if adds and adds[0].get('success'):
        print(adds[0]['objectId'])
    else:
        print('')
except:
    print('')
" 2>/dev/null)

if [[ -n "$ADDED_ID" && "$ADDED_ID" != "None" && "$ADDED_ID" != "" ]]; then
    ok "  ADD succeeded — objectId=${ADDED_ID}"

    info "Testing applyEdits — DELETE the test feature (objectId=${ADDED_ID})..."
    DEL_RESULT=$($SSH_CMD "bash -s" << DELEOF
curl -sk "https://localhost:6443/arcgis/rest/services/CellTowersEditable/FeatureServer/0/applyEdits?token=${TOKEN}&f=json" \
  -H "Referer: https://localhost:6443" \
  --max-time 30 \
  --data-urlencode "deletes=[${ADDED_ID}]"
DELEOF
    ) || DEL_RESULT='{"error":"curl or SSH failed"}'

    DEL_SUCCESS=$(echo "$DEL_RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    dels = d.get('deleteResults', [])
    if dels and dels[0].get('success'):
        print('true')
    else:
        print('false')
except:
    print('false')
" 2>/dev/null)

    if [[ "$DEL_SUCCESS" == "true" ]]; then
        ok "  DELETE succeeded — test feature cleaned up"
    else
        err "  DELETE failed: $DEL_RESULT"
    fi
else
    err "  ADD failed: $ADD_RESULT"
    info "  (Editing may require a user with PUBLISH role, not siteadmin)"
fi

###############################################################################
#                       SUMMARY
###############################################################################
hdr "DEPLOYMENT COMPLETE"

echo -e "  ${BOLD}Instance:${NC}      ${IP}"
echo -e "  ${BOLD}REST Services:${NC} https://${IP}:6443/arcgis/rest/services"
echo -e "  ${BOLD}Admin:${NC}         https://${IP}:6443/arcgis/admin"
echo -e "  ${BOLD}Credentials:${NC}   ${ADMIN_USER} / ${ADMIN_PASS}"
echo ""
echo "  Services deployed:"
for svc in "${SERVICES[@]}"; do
    echo -e "    - https://${IP}:6443/arcgis/rest/services/${svc}/FeatureServer"
done
echo ""
echo -e "  ${BOLD}Query tests:${NC}   ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo ""
echo -e "  ${YELLOW}Note:${NC} For editing, use a user with PUBLISH role (siteadmin has ADMINISTER,"
echo "  which does not include features:user:edit privilege)."
echo ""
ok "Done!"
