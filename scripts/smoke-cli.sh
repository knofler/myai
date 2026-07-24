#!/usr/bin/env bash
# smoke-cli.sh — smoke check for the `myai` CLI package skeleton.
#
# Verifies, with zero host build / no npm install required:
#   1. `myai --help`     lists every wired subcommand
#   2. `myai --version`  matches package.json
#   3. `myai doctor`     runs preflight and exits 0
#   4. `npm pack`        produces a publishable tarball (dry-run, nothing written)
#
# Run from the repo root:  ./scripts/smoke-cli.sh
# Used by local-ci.sh / CI as the package smoke gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="bin/myai.cjs"
PASS=0 FAIL=0

ok()   { printf '  [PASS] %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "myai CLI smoke check"
echo "===================="

# 1. --help lists all subcommands
HELP="$(node "$BIN" --help 2>&1 || true)"
for cmd in init up down scan new-app connect schedule doctor; do
  if printf '%s' "$HELP" | grep -q "$cmd"; then ok "--help lists '$cmd'"; else bad "--help missing '$cmd'"; fi
done

# 2. --version matches package.json
PKG_VER="$(node -e 'process.stdout.write(require("./package.json").version)')"
CLI_VER="$(node "$BIN" --version 2>&1 | tr -d '[:space:]')"
if [ "$PKG_VER" = "$CLI_VER" ]; then ok "--version == package.json ($PKG_VER)"; else bad "--version '$CLI_VER' != package.json '$PKG_VER'"; fi

# 3. doctor exits 0
if node "$BIN" doctor >/dev/null 2>&1; then ok "doctor preflight exits 0"; else bad "doctor preflight non-zero exit"; fi

# 3b. doctor --json emits parseable {checks,ok} for CI gating
if node "$BIN" doctor --json 2>/dev/null \
  | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const j=JSON.parse(b);if(!Array.isArray(j.checks)||typeof j.ok!=="boolean")process.exit(1)})' \
  >/dev/null 2>&1; then ok "doctor --json emits {checks,ok}"; else bad "doctor --json not parseable"; fi

# 4. npm pack dry-run produces a tarball
if npm pack --dry-run >/dev/null 2>&1; then ok "npm pack --dry-run succeeds"; else bad "npm pack --dry-run failed"; fi

echo "===================="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || { echo "smoke check FAILED"; exit 1; }
echo "smoke check OK"
