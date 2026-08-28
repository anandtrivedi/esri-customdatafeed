#!/usr/bin/env bash
# Functional test for configure-databricks.sh multi-machine handling.
# Mocks curl (admin API) + id (pretend root) via a PATH shim; feeds answers on stdin;
# redirects all writes to temp dirs. Verifies: single-machine unchanged, shared branch,
# per-node branch, idempotent init_user_param.sh edit, and .databrickscfg mode 600.
set -u
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/configure-databricks.sh"
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

WORK=$(mktemp -d)
BIN="$WORK/bin"; mkdir -p "$BIN"
# --- mock curl: canned JSON by endpoint ---
cat > "$BIN/curl" <<'CURL'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in
  *generateToken*)       echo '{"token":"FAKE-TOKEN"}'; exit 0;;
  *admin/machines*)      echo '{"machines":[{"machineName":"NODE-A.test"},{"machineName":"NODE-B.test"}]}'; exit 0;;
  *system/configstore*)  echo '{"type":"FILESYSTEM","connectionString":"/net/arcgis-share/config-store"}'; exit 0;;
esac; done
echo '{}'
CURL
# --- mock id: pretend to be root so the write path runs ---
cat > "$BIN/id" <<'IDD'
#!/usr/bin/env bash
case "${1:-}" in -un) echo root;; -u) echo 0;; *) exec /usr/bin/id "$@";; esac
IDD
# --- mock databricks so the connectivity check is a fast no-op ---
cat > "$BIN/databricks" <<'DB'
#!/usr/bin/env bash
exit 1
DB
chmod +x "$BIN/curl" "$BIN/id" "$BIN/databricks"
export PATH="$BIN:$PATH"

run_case(){ # $1 name  $2 stdin  $3 extra-env(as "k=v k=v")  -> sets OUT
  local env_kv="$3"; OUT="$WORK/$1.out"
  ( eval "export $env_kv"; printf '%b' "$2" | bash "$SCRIPT" ) > "$OUT" 2>&1 || true
}

echo "== Test 1: single-machine (no admin handoff) — must NOT detect multi, must ask plain path =="
CFG1="$WORK/single.databrickscfg"
run_case single "$CFG1\n\nhttps://t1.example.com\n1\ndapiSINGLE\n" ""
grep -q "multi-machine site detected" "$OUT" && no "single: should not print multi-machine" || ok "single: no multi-machine banner"
[ -f "$CFG1" ] && grep -q "t1.example.com" "$CFG1" && ok "single: wrote creds file" || no "single: creds file missing"
[ "$(stat -c '%a' "$CFG1" 2>/dev/null || stat -f '%Lp' "$CFG1" 2>/dev/null)" = "600" ] && ok "single: mode 600" || no "single: not 600"

echo "== Test 2: multi-machine SHARED (admin handoff, FILESYSTEM config-store) =="
PF="$WORK/pass"; printf 'pw' > "$PF"
ROOT2="$WORK/arcgis2"; mkdir -p "$ROOT2/usr"
CFG2="$WORK/shared.databrickscfg"
run_case shared "1\n$CFG2\n\nhttps://t2.example.com\n1\ndapiSHARED\n" \
  "CDF_ADMIN_PASSFILE=$PF CDF_ADMIN_URL=https://localhost:6443 CDF_ADMIN_CTX=arcgis CDF_ADMIN_USER=siteadmin CDF_SERVER_DIR=$ROOT2"
grep -q "multi-machine site detected — 2 machines" "$OUT" && ok "shared: detected 2 machines" || no "shared: detection banner missing"
grep -q "NODE-A.test" "$OUT" && grep -q "NODE-B.test" "$OUT" && ok "shared: listed both machines" || no "shared: machine names missing"
grep -q "/net/arcgis-share/cdf-databricks/.databrickscfg" "$OUT" && ok "shared: derived shared path from config-store" || no "shared: shared path not derived"
[ -f "$CFG2" ] && grep -q "t2.example.com" "$CFG2" && ok "shared: wrote creds to shared path" || no "shared: creds not written"
INIT2="$ROOT2/usr/init_user_param.sh"
# shlex.quote leaves a plain path unquoted; just confirm the assignment names our path
[ -f "$INIT2" ] && grep -Eq "DATABRICKS_CONFIG_FILE=(\"?)$CFG2\1" "$INIT2" && ok "shared: wired DATABRICKS_CONFIG_FILE in init_user_param.sh" || no "shared: init env not wired"
grep -q "check-both-machines.sh" "$OUT" && ok "shared: points to verifier" || no "shared: no verifier pointer"

echo "== Test 3: idempotency — re-run shared, init_user_param.sh must have exactly ONE export + ONE marker =="
run_case shared2 "1\n$CFG2\n\nhttps://t2.example.com\n1\ndapiSHARED\n" \
  "CDF_ADMIN_PASSFILE=$PF CDF_ADMIN_URL=https://localhost:6443 CDF_ADMIN_CTX=arcgis CDF_ADMIN_USER=siteadmin CDF_SERVER_DIR=$ROOT2"
n_exp=$(grep -c "DATABRICKS_CONFIG_FILE=" "$INIT2"); n_mark=$(grep -c "managed by configure-databricks.sh" "$INIT2")
[ "$n_exp" = "1" ] && [ "$n_mark" = "1" ] && ok "idempotent: 1 export + 1 marker (got $n_exp/$n_mark)" || no "idempotent: got $n_exp exports / $n_mark markers (want 1/1)"

echo "== Test 4: multi-machine PER-NODE (choose option 2) =="
ROOT4="$WORK/arcgis4"; mkdir -p "$ROOT4/usr"
CFG4="$WORK/pernode.databrickscfg"
run_case pernode "2\n$CFG4\n\nhttps://t4.example.com\n1\ndapiPERNODE\n" \
  "CDF_ADMIN_PASSFILE=$PF CDF_ADMIN_URL=https://localhost:6443 CDF_ADMIN_CTX=arcgis CDF_ADMIN_USER=siteadmin CDF_SERVER_DIR=$ROOT4"
grep -qi "PER-MACHINE" "$OUT" && ok "pernode: took per-machine branch" || no "pernode: wrong branch"
[ -f "$CFG4" ] && grep -q "t4.example.com" "$CFG4" && ok "pernode: wrote local creds" || no "pernode: creds not written"
grep -q "on EACH other machine" "$OUT" || grep -qi "run configure-databricks.sh on EACH" "$OUT" && ok "pernode: instructs repeat on each node" || no "pernode: no per-node instruction"

echo "== Test 5: partial admin handoff (PASSFILE set, URL/CTX/USER unset) must NOT abort under set -u =="
PF5="$WORK/pass5"; printf 'pw' > "$PF5"
CFG5="$WORK/partial.databrickscfg"
run_case partial "$CFG5\n\nhttps://t5.example.com\n1\ndapiPARTIAL\n" "CDF_ADMIN_PASSFILE=$PF5"
grep -q "multi-machine site detected" "$OUT" && no "partial: should stay single-machine" || ok "partial: stayed single-machine (no abort)"
[ -f "$CFG5" ] && grep -q "t5.example.com" "$CFG5" && ok "partial: completed the write (did not abort)" || no "partial: aborted or no write"

echo "== Test 6: shlex-quoted path in init_user_param.sh (space in path) =="
ROOT6="$WORK/arcgis6"; mkdir -p "$ROOT6/usr"; CFG6="$WORK/has space/db.cfg"; mkdir -p "$WORK/has space"
run_case space "1\n$CFG6\n\nhttps://t6.example.com\n1\ndapiSPACE\n" \
  "CDF_ADMIN_PASSFILE=$PF CDF_ADMIN_URL=https://localhost:6443 CDF_ADMIN_CTX=arcgis CDF_ADMIN_USER=siteadmin CDF_SERVER_DIR=$ROOT6"
INIT6="$ROOT6/usr/init_user_param.sh"
if [ -f "$INIT6" ] && sh -n "$INIT6" 2>/dev/null && grep -q "DATABRICKS_CONFIG_FILE=" "$INIT6"; then ok "space: init_user_param.sh is valid shell with quoted path"; else no "space: init file invalid or missing"; fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
rm -rf "$WORK"
[ "$FAIL" = "0" ]
