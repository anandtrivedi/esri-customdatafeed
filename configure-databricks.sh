#!/usr/bin/env bash
#
# configure-databricks.sh — create/update the .databrickscfg the CDF provider reads.
#
# The provider runs as the 'arcgis' OS user and reads ~/.databrickscfg (or $DATABRICKS_CONFIG_FILE)
# at query time. This writes a profile (PAT or OAuth M2M service principal) into that file
# ATOMICALLY, preserving any existing profiles, and leaves it owned by arcgis with mode 600 — the
# exact ownership/permissions the provider needs (a group/world-readable creds file is a finding,
# and a root-owned one the provider can't read). Standalone and air-gapped (bash + python3 only).
#
#   sudo bash configure-databricks.sh        # run as root (writes /home/arcgis/.databrickscfg as arcgis)
#   bash configure-databricks.sh --help
#
set -uo pipefail

case "${1:-}" in
  -h|--help)
    echo "configure-databricks.sh — write a .databrickscfg profile (PAT or OAuth M2M) for the CDF provider."
    echo "  Run on the ArcGIS Server box, ideally as root: sudo bash configure-databricks.sh"
    echo "  Writes the file atomically, owned by arcgis, mode 600, preserving existing profiles."
    exit 0 ;;
esac

command -v python3 >/dev/null 2>&1 || { echo "!! python3 is required."; exit 1; }

# EOF-safe prompt (abort rather than silently default).
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
ask_secret() {   # prompt varname  (hidden input)
  local prompt="$1" __var="$2" ans=""
  trap 'stty echo 2>/dev/null' INT   # Ctrl-C during a hidden read must restore terminal echo
  if ! read -r -s -p "  $prompt: " ans; then stty echo 2>/dev/null; trap - INT; echo; echo "!! Input closed (EOF) — aborting." >&2; exit 130; fi
  trap - INT
  echo
  printf -v "$__var" '%s' "$ans"
}

echo "============================================================"
echo " Configure Databricks connection (.databrickscfg)"
echo "============================================================"
echo

ask "Config file path" "${DATABRICKS_CONFIG_FILE:-/home/arcgis/.databrickscfg}" CFG
ask "Profile name (DEFAULT unless you serve multiple workspaces)" "DEFAULT" PROFILE
while :; do
  ask "Databricks host (e.g. https://your-workspace.cloud.databricks.com)" "" HOST
  [ -n "$HOST" ] && break; echo "   !! Host is required."
done
HOST="${HOST%/}"   # trim any trailing slash

echo "  Auth mode:  1) Personal Access Token (PAT)   2) OAuth M2M (service principal)"
ask "  choose 1-2" "1" AUTHMODE
TOKEN=""; CLIENT_ID=""; CLIENT_SECRET=""
if [ "$AUTHMODE" = "2" ]; then
  AUTH="oauth"
  while :; do ask "Service principal client_id" "" CLIENT_ID; [ -n "$CLIENT_ID" ] && break; echo "   !! client_id is required."; done
  while :; do ask_secret "Service principal client_secret" CLIENT_SECRET; [ -n "$CLIENT_SECRET" ] && break; echo "   !! client_secret is required."; done
else
  AUTH="pat"
  while :; do ask_secret "Personal Access Token (dapi...)" TOKEN; [ -n "$TOKEN" ] && break; echo "   !! token is required."; done
fi
echo

# --- write the profile atomically, preserving other profiles --------------------
# python does the INI merge into a temp file; we then set owner arcgis + mode 600 and atomically
# move it into place. Secrets are passed to python via the environment (not argv) and the temp
# file is created mode 600 from the start, so the raw secret never lands in a world-readable file
# or in a process's argument list.
DEST_DIR=$(dirname "$CFG")
ME=$(id -un 2>/dev/null); MYUID=$(id -u 2>/dev/null)
if [ "$ME" != "arcgis" ] && [ "$MYUID" != "0" ]; then
  echo "!! Run this as root (sudo) or as the arcgis user so $CFG can be owned by arcgis."
  echo "   The provider runs as arcgis and must read it. Nothing was written."
  echo "   Manual fallback: create the profile by hand (see the repo README, Step 3) then:"
  echo "     sudo chown arcgis:arcgis $CFG && sudo chmod 600 $CFG"
  exit 1
fi
# Create the parent dir ONLY if missing (don't chown/chmod an existing, possibly shared, dir).
if [ ! -d "$DEST_DIR" ]; then
  if [ "$MYUID" = "0" ]; then install -d -o arcgis -g arcgis -m 700 "$DEST_DIR" || mkdir -p "$DEST_DIR"; else mkdir -p "$DEST_DIR"; fi
fi
# Temp file in the SAME directory so the final placement is an atomic rename (mktemp under /tmp
# would make it a cross-filesystem copy — not atomic). Mode 600 from creation; shredded on exit.
TMP="$DEST_DIR/.databrickscfg.cdftmp.$$"
_cleanup() { rm -f "$TMP"; }
trap _cleanup EXIT
: > "$TMP"; chmod 600 "$TMP"

CFG_PATH="$CFG" PROFILE="$PROFILE" HOST="$HOST" AUTH="$AUTH" TOKEN="$TOKEN" \
CLIENT_ID="$CLIENT_ID" CLIENT_SECRET="$CLIENT_SECRET" OUT="$TMP" python3 - <<'PY' || { echo "!! failed to build the config — nothing was written."; exit 1; }
import os, sys, configparser
g = os.environ.get
# interpolation=None: a '%' in a token/secret (common in base64/URL-encoded values) must NOT be
# treated as interpolation syntax. default_section: make a literal [DEFAULT] an ORDINARY profile
# (Databricks' DEFAULT profile) instead of ConfigParser's magic inherited-defaults section.
cfg = configparser.ConfigParser(interpolation=None, default_section="__CDF_NEVER__")
src = g("CFG_PATH")
if src and os.path.exists(src):
    # Fail CLOSED: if an existing config can't be parsed, refuse rather than overwrite it with
    # only the new profile (that would destroy the operator's other workspaces).
    try:
        got = cfg.read(src)
    except Exception as e:
        sys.stderr.write("refusing to overwrite %s: it exists but could not be parsed (%s)\n" % (src, e)); raise SystemExit(3)
    if not got:
        sys.stderr.write("refusing to overwrite %s: it exists but could not be read\n" % src); raise SystemExit(3)
prof = g("PROFILE")
if not cfg.has_section(prof):
    cfg.add_section(prof)
sect = cfg[prof]
for k in ("token", "client_id", "client_secret"):   # clear prior auth so PAT<->OAuth can't mix
    if k in sect: del sect[k]
sect["host"] = g("HOST")
if g("AUTH") == "oauth":
    sect["client_id"] = g("CLIENT_ID"); sect["client_secret"] = g("CLIENT_SECRET")
else:
    sect["token"] = g("TOKEN")
with open(g("OUT"), "w") as f:
    cfg.write(f)
print("  [ok] profile '%s' prepared (%s auth) for host %s" % (prof, g("AUTH"), g("HOST")))
PY

# --- place it: correct owner + perms, atomic same-dir rename --------------------
[ "$MYUID" = "0" ] && chown arcgis:arcgis "$TMP" 2>/dev/null
chmod 600 "$TMP"
if mv -f "$TMP" "$CFG"; then
  trap - EXIT
  echo "  [ok] wrote $CFG (owner arcgis, mode 600)."
else
  echo "!! could not place the file at $CFG. Place it manually:"
  echo "   sudo install -o arcgis -g arcgis -m 600 <file> $CFG"
  exit 1
fi
echo

# --- optional connectivity check ------------------------------------------------
if command -v databricks >/dev/null 2>&1; then
  echo "-> verifying the profile with the Databricks CLI..."
  # Point the CLI at the file we just wrote (as root, the CLI would otherwise read /root/.databrickscfg).
  if DATABRICKS_CONFIG_FILE="$CFG" timeout 20 databricks current-user me --profile "$PROFILE" -o json >/dev/null 2>&1; then
    echo "   [ok] authenticated to Databricks as profile '$PROFILE'."
  else
    echo "   [warn] the CLI could not authenticate with this profile (bad token/secret, wrong host,"
    echo "          or no network to Databricks). The file was written; fix the value and re-run if needed."
  fi
else
  echo "  (Databricks CLI not installed — skipping the live connectivity check. Use diagnose-service.sh"
  echo "   after publishing a service to confirm the credentials actually work.)"
fi
echo "Done. Restart ArcGIS Server if the provider was already running (it caches .databrickscfg at first read)."
