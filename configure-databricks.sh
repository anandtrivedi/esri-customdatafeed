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
# MULTI-MACHINE: the provider CODE + service definitions propagate across a multi-machine ArcGIS
# site automatically (shared config-store), but .databrickscfg is a per-machine OS file that does
# NOT — so if only one node has credentials, round-robin traffic 404s on the others. When this
# script is given the ArcGIS admin login (via setup.sh, or the CDF_ADMIN_* env vars) it DETECTS a
# multi-machine site and offers two credential layouts:
#   - SHARED (default): one .databrickscfg on the site's shared storage + DATABRICKS_CONFIG_FILE
#     pointing at it (set once per node in init_user_param.sh) — rotate one file for the whole site.
#   - PER-MACHINE: a .databrickscfg in each node's arcgis home — run this script on every node.
# With no admin login (pure standalone) it behaves exactly as the single-machine tool it always was.
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
    echo "  On a multi-machine site (detected when given the ArcGIS admin login) it offers a shared"
    echo "  credentials file + wires DATABRICKS_CONFIG_FILE so every node reads it."
    exit 0 ;;
esac

command -v python3 >/dev/null 2>&1 || { echo "!! python3 is required."; exit 1; }

# curl is only needed for multi-machine detection (reachable when launched from setup.sh); its
# absence simply means we stay in single-machine mode — exactly the old behavior.
CURL=(curl -sk --noproxy 'localhost,127.0.0.1,::1' --connect-timeout 10 --max-time 30)

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
# jget <json> <python-expr using d>  -> prints the value (empty on any error)
jget() { RESP="$1" python3 -c "import os,json
try: d=json.loads(os.environ['RESP'])
except Exception: raise SystemExit
print($2)" 2>/dev/null || true; }

# Resolve the ArcGIS server dir (for init_user_param.sh). Prefer the value setup.sh hands off; else
# probe the same candidate roots setup.sh uses. INIT_FILE is empty if the install root can't be found.
SERVER_DIR="${CDF_SERVER_DIR:-}"; INIT_FILE=""
resolve_server_dir() {
  if [ -z "$SERVER_DIR" ]; then
    local c ah; local cands=(/opt/arcgis /app/arcgis)
    ah=$(getent passwd arcgis 2>/dev/null | cut -d: -f6); [ -n "$ah" ] && cands+=("$ah/arcgis" "$ah")
    [ -n "${HOME:-}" ] && cands+=("$HOME/arcgis" "$HOME")
    for c in "${cands[@]}"; do
      if [ -e "$c/server/startserver.sh" ] || [ -d "$c/server/framework/runtime/node" ]; then SERVER_DIR="$c/server"; break; fi
    done
  fi
  [ -n "$SERVER_DIR" ] && INIT_FILE="$SERVER_DIR/usr/init_user_param.sh" || INIT_FILE=""
}
resolve_server_dir

# Idempotently set (or replace) `export DATABRICKS_CONFIG_FILE="<val>"` in this node's
# init_user_param.sh. Backs the file up first, preserves owner/mode, atomic same-dir rename. Only
# ever touches the LOCAL node — other nodes get printed instructions.
set_init_env() {   # $1 = value for DATABRICKS_CONFIG_FILE
  local val="$1" dir o g m tmp
  if [ -z "$INIT_FILE" ]; then
    echo "  [warn] ArcGIS install root not found — set this on THIS node by hand and restart it:"
    echo "         echo 'export DATABRICKS_CONFIG_FILE=\"$val\"' | sudo tee -a <install>/server/usr/init_user_param.sh"
    return 1
  fi
  dir=$(dirname "$INIT_FILE")
  [ -d "$dir" ] || { echo "  [warn] $dir does not exist — wrong install root? Set DATABRICKS_CONFIG_FILE by hand."; return 1; }
  if [ -f "$INIT_FILE" ]; then
    o=$(stat -c '%U' "$INIT_FILE" 2>/dev/null || stat -f '%Su' "$INIT_FILE" 2>/dev/null || echo arcgis)
    g=$(stat -c '%G' "$INIT_FILE" 2>/dev/null || stat -f '%Sg' "$INIT_FILE" 2>/dev/null || echo arcgis)
    m=$(stat -c '%a' "$INIT_FILE" 2>/dev/null || stat -f '%Lp' "$INIT_FILE" 2>/dev/null || echo 755)
    cp -p "$INIT_FILE" "$INIT_FILE.cdfbak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  else
    o=arcgis; g=arcgis; m=755
    printf '#!/bin/sh\n' > "$INIT_FILE" 2>/dev/null || { echo "  [warn] cannot create $INIT_FILE — set DATABRICKS_CONFIG_FILE by hand."; return 1; }
  fi
  tmp=$(mktemp "$dir/.init_user_param.cdftmp.XXXXXX") || { echo "  [warn] could not create a temp file in $dir — set DATABRICKS_CONFIG_FILE by hand."; return 1; }
  INIT_FILE="$INIT_FILE" VAL="$val" python3 - "$tmp" <<'PY' || { rm -f "$tmp"; echo "  [warn] failed to update init_user_param.sh — set DATABRICKS_CONFIG_FILE by hand."; return 1; }
import os, sys, re, shlex
src = os.environ["INIT_FILE"]; val = os.environ["VAL"]; out = sys.argv[1]
marker = "# --- Databricks CDF provider (managed by configure-databricks.sh) ---"
pat = re.compile(r'^\s*(export\s+)?DATABRICKS_CONFIG_FILE\s*=')
lines = []
try:
    with open(src) as f: lines = f.readlines()
except Exception:
    lines = []
# Idempotent: drop any prior managed marker + any DATABRICKS_CONFIG_FILE assignment, then re-append
# exactly one block. Running twice yields the same file.
kept = [ln for ln in lines if ln.rstrip("\n") != marker and not pat.match(ln)]
if kept and not kept[-1].endswith("\n"): kept[-1] += "\n"
kept.append(marker + "\n")
# shell-quote the path so an odd shared path (spaces, $, quotes) can't break init_user_param.sh
kept.append("export DATABRICKS_CONFIG_FILE=%s\n" % shlex.quote(val))
with open(out, "w") as f: f.writelines(kept)
PY
  [ "$(id -u 2>/dev/null)" = "0" ] && chown "$o:$g" "$tmp" 2>/dev/null
  chmod "$m" "$tmp" 2>/dev/null || chmod 755 "$tmp" 2>/dev/null
  if mv -f "$tmp" "$INIT_FILE"; then return 0; else rm -f "$tmp"; echo "  [warn] could not place updated init_user_param.sh."; return 1; fi
}

# --- multi-machine detection (only when the ArcGIS admin login was handed off) ----
# Silent unless it finds >=2 machines: this keeps the single-machine experience byte-for-byte
# unchanged. Uses the CDF_ADMIN_* handoff (from setup.sh) — no extra prompts here.
MULTI=0; MACHINE_NAMES=""; MACHINE_COUNT=1; SHARED_CFG=""
detect_topology() {
  local resp tok mresp cresp cs_type cs_conn parent
  resp=$("${CURL[@]}" "$CDF_ADMIN_URL/$CDF_ADMIN_CTX/admin/generateToken" \
    --data-urlencode "username=$CDF_ADMIN_USER" --data-urlencode "password@$CDF_ADMIN_PASSFILE" \
    --data-urlencode "client=requestip" --data-urlencode "f=json" 2>/dev/null)
  tok=$(jget "$resp" 'd.get("token") or ""')
  [ -z "$tok" ] && return 0   # can't detect -> stay single-machine, silently (old behavior)
  mresp=$("${CURL[@]}" "$CDF_ADMIN_URL/$CDF_ADMIN_CTX/admin/machines" --data-urlencode "token=$tok" --data-urlencode "f=json" 2>/dev/null)
  MACHINE_NAMES=$(jget "$mresp" '"\n".join((m.get("machineName") or "") for m in d.get("machines",[]) if m.get("machineName"))')
  MACHINE_COUNT=$(printf '%s' "$MACHINE_NAMES" | awk 'NF{c++} END{print c+0}')
  [ "${MACHINE_COUNT:-1}" -ge 2 ] || return 0
  MULTI=1
  # A multi-machine site REQUIRES its config-store on shared storage. If it's a plain FILESYSTEM
  # path, a dedicated SIBLING dir on the same mount is a valid shared secrets location (Esri: do
  # NOT put secrets inside the config-store / server directories themselves).
  cresp=$("${CURL[@]}" "$CDF_ADMIN_URL/$CDF_ADMIN_CTX/admin/system/configstore" --data-urlencode "token=$tok" --data-urlencode "f=json" 2>/dev/null)
  cs_type=$(jget "$cresp" '(d.get("type") or "").upper()')
  cs_conn=$(jget "$cresp" '(d.get("connectionString") or "")')
  if [ "$cs_type" = "FILESYSTEM" ] && [ "${cs_conn#/}" != "$cs_conn" ]; then   # POSIX absolute path
    parent=$(dirname "${cs_conn%/}")
    SHARED_CFG="$parent/cdf-databricks/.databrickscfg"
  fi
}
# Only attempt detection when the FULL admin handoff is present — gating on the passfile alone
# would let a stale CDF_ADMIN_PASSFILE (with the other vars unset) abort under `set -u`, which
# would break the unchanged single-machine path. All four required, or we stay single-machine.
if [ -n "${CDF_ADMIN_PASSFILE:-}" ] && [ -f "${CDF_ADMIN_PASSFILE:-}" ] \
   && [ -n "${CDF_ADMIN_URL:-}" ] && [ -n "${CDF_ADMIN_CTX:-}" ] && [ -n "${CDF_ADMIN_USER:-}" ] \
   && command -v curl >/dev/null 2>&1; then
  detect_topology
fi

echo "============================================================"
echo " Configure Databricks connection (.databrickscfg)"
echo "============================================================"
echo

# --- choose where credentials live (multi-machine aware) ------------------------
# DEPLOY_MODE: single (unchanged old behavior) | shared (one file on shared storage) | pernode.
DEPLOY_MODE="single"
if [ "$MULTI" = "1" ]; then
  echo "  [multi-machine site detected — $MACHINE_COUNT machines]"
  printf '%s\n' "$MACHINE_NAMES" | sed 's/^/     - /'
  echo "  Provider CODE is shared across the site automatically, but .databrickscfg is a per-machine"
  echo "  file — credentials must reach EVERY machine or round-robin traffic 404s on the ones missing it."
  echo
  echo "  How should credentials be stored?"
  if [ -n "$SHARED_CFG" ]; then
    echo "    1) SHARED file on the site's shared storage (recommended — set once, rotate once)"
    echo "       proposed path: $SHARED_CFG"
    echo "    2) PER-MACHINE file in each node's arcgis home (you re-run this on every node)"
    ask "  choose 1-2" "1" _dm
    case "$_dm" in 2) DEPLOY_MODE="pernode";; *) DEPLOY_MODE="shared";; esac
  else
    echo "  (Could not auto-locate a shared filesystem — the config-store isn't a plain FILESYSTEM path.)"
    echo "    1) I have a shared path all machines mount — let me enter it (recommended if you do)"
    echo "    2) PER-MACHINE file in each node's arcgis home"
    ask "  choose 1-2" "2" _dm
    case "$_dm" in 1) DEPLOY_MODE="shared"; SHARED_CFG="";; *) DEPLOY_MODE="pernode";; esac
  fi
  echo
fi

case "$DEPLOY_MODE" in
  shared)
    while :; do
      ask "Config file path (SHARED — must be readable by the arcgis user on ALL nodes)" "$SHARED_CFG" CFG
      [ -n "$CFG" ] && break; echo "   !! a path is required."
    done ;;
  *)   # single (unchanged) and pernode both use the per-host default
    ask "Config file path" "${DATABRICKS_CONFIG_FILE:-/home/arcgis/.databrickscfg}" CFG ;;
esac
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
# would make it a cross-filesystem copy — not atomic). mktemp gives an unpredictable name (no
# symlink-preseeding by a local user), umask 077 makes it 600 from creation; shredded on exit.
_umask_old=$(umask); umask 077
TMP=$(mktemp "$DEST_DIR/.databrickscfg.cdftmp.XXXXXX") || { echo "!! could not create a temp file in $DEST_DIR — nothing was written."; exit 1; }
umask "$_umask_old"
_cleanup() { rm -f "$TMP"; }
trap _cleanup EXIT
chmod 600 "$TMP" || { echo "!! could not secure the temp file (chmod 600 failed) — nothing was written."; exit 1; }

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

# --- multi-machine follow-through -----------------------------------------------
if [ "$DEPLOY_MODE" = "shared" ]; then
  echo
  echo "== Multi-machine (SHARED file): wire DATABRICKS_CONFIG_FILE on EVERY node =="
  if set_init_env "$CFG"; then
    echo "  [ok] THIS node wired: export DATABRICKS_CONFIG_FILE=\"$CFG\"  (in $INIT_FILE)"
  fi
  echo "  The credentials file itself is already written to the shared path — do NOT re-write it per node."
  echo "  On EACH OTHER machine in the site, do this one-time step, then restart THAT machine:"
  echo "     1) add to <install>/server/usr/init_user_param.sh:"
  echo "          export DATABRICKS_CONFIG_FILE=\"$CFG\""
  echo "     2) sudo -u arcgis <install>/server/stopserver.sh && sudo -u arcgis <install>/server/startserver.sh"
  echo "  Machines in this site (you are on ONE of them — repeat on the rest):"
  printf '%s\n' "$MACHINE_NAMES" | sed 's/^/     - /'
  echo "  Future credential rotations: edit ONLY $CFG, then restart each node."
  echo "  [!] On a network share, the arcgis user must map to the SAME uid/gid on every node (or use"
  echo "      ACLs) or a 600 file written here won't be readable elsewhere. If a node still 404s,"
  echo "      check it can READ $CFG as the arcgis user (root-squash/NFS can silently block this)."
  echo "  Verify every node serves data: bash check-both-machines.sh"
elif [ "$DEPLOY_MODE" = "pernode" ]; then
  echo
  echo "== Multi-machine (PER-MACHINE files): repeat on EVERY node =="
  if [ "$CFG" != "/home/arcgis/.databrickscfg" ]; then
    if set_init_env "$CFG"; then echo "  [ok] THIS node wired DATABRICKS_CONFIG_FILE=\"$CFG\" (non-default path)."; fi
  fi
  echo "  This wrote credentials on THIS node only. Run configure-databricks.sh on EACH other machine"
  echo "  (same profile / host / credentials), then restart each:"
  echo "     sudo -u arcgis <install>/server/stopserver.sh && sudo -u arcgis <install>/server/startserver.sh"
  echo "  Machines in this site (you are on ONE of them — repeat on the rest):"
  printf '%s\n' "$MACHINE_NAMES" | sed 's/^/     - /'
  echo "  Verify every node serves data: bash check-both-machines.sh"
fi
echo "Done. Restart ArcGIS Server if the provider was already running (it caches .databrickscfg at first read)."
