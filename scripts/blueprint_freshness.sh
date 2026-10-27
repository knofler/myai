#!/usr/bin/env bash
# blueprint_freshness.sh — is the canonical blueprint scaffold falling behind?
#
# Reads templates/blueprint/package.json (the SOURCE template every new
# project is scaffolded from — AI/scripts/init_blueprint.sh) and compares
# every pinned dependency's major version against the npm registry's
# "latest" dist-tag, via curl (Docker-only-dev policy: no npm on the host).
#
# This is deliberately about the TEMPLATE, not any individual scaffolded
# project — each scaffolded repo gets its own renovate.json (see
# templates/blueprint/renovate.json) to stay current after it's born. This
# script's job is to stop the template itself from silently drifting so
# every *newly scaffolded* project starts from something already stale.
#
# Usage:
#   AI/scripts/blueprint_freshness.sh [--json] [--pkg <path-to-package.json>]
#
# Exit codes:
#   0  every dependency's pinned major is at (or ahead of) npm's latest major
#   1  at least one dependency is a full major version behind
#   2  not applicable here (no templates/blueprint/package.json found — e.g.
#      run from a scaffolded project rather than the master AI repo) or the
#      registry could not be reached for every package (network unavailable)
#
# Warn-only integration: AI/scripts/local-ci.sh calls this (guarded on the
# file existing) and never lets its result affect local-ci's own pass/fail —
# see the "blueprint freshness" block in local-ci.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_PATH="$AI_ROOT/templates/blueprint/package.json"
JSON_OUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --json)  JSON_OUT=1; shift ;;
    --pkg)   PKG_PATH="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$PKG_PATH" ]; then
  echo "SKIP — no package.json at $PKG_PATH (not applicable outside the master blueprint template)."
  exit 2
fi

command -v curl   >/dev/null 2>&1 || { echo "ERROR: curl not found." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found." >&2; exit 2; }

# name<TAB>pinned-spec, dependencies then devDependencies, in package.json's own order.
DEP_LINES="$(python3 - "$PKG_PATH" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    pkg = json.load(f)
for section in ("dependencies", "devDependencies"):
    for name, spec in pkg.get(section, {}).items():
        print(f"{name}\t{spec}")
PY
)"

if [ -z "$DEP_LINES" ]; then
  echo "SKIP — no dependencies/devDependencies in $PKG_PATH."
  exit 2
fi

# major_of <semver-or-range> — first numeric dot-component, prefix stripped.
major_of() {
  printf '%s' "$1" | sed -E 's/^[[:space:]]*[\^~>=<]*//' | cut -d. -f1
}

behind=0
errors=0
rows=""   # name<TAB>pinned<TAB>pinned_major<TAB>latest<TAB>latest_major<TAB>status

while IFS=$'\t' read -r name spec; do
  [ -n "$name" ] || continue
  pinned_major="$(major_of "$spec")"
  latest="$(curl -sf -m 5 "https://registry.npmjs.org/${name}/latest" \
              | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("version",""))' 2>/dev/null || true)"
  if [ -z "$latest" ]; then
    rows="${rows}${name}\t${spec}\t${pinned_major}\t?\t?\tERR\n"
    errors=$((errors + 1))
    continue
  fi
  latest_major="$(major_of "$latest")"
  if [ -z "$pinned_major" ] || [ -z "$latest_major" ]; then
    rows="${rows}${name}\t${spec}\t${pinned_major}\t${latest}\t${latest_major}\tERR\n"
    errors=$((errors + 1))
    continue
  fi
  if [ "$pinned_major" -lt "$latest_major" ] 2>/dev/null; then
    rows="${rows}${name}\t${spec}\t${pinned_major}\t${latest}\t${latest_major}\tBEHIND\n"
    behind=$((behind + 1))
  else
    rows="${rows}${name}\t${spec}\t${pinned_major}\t${latest}\t${latest_major}\tok\n"
  fi
done <<DEPEOF
$DEP_LINES
DEPEOF

if [ "$JSON_OUT" = 1 ]; then
  printf '%b' "$rows" | python3 -c '
import sys, json
rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    name, pinned, pinned_major, latest, latest_major, status = line.split("\t")
    rows.append({
        "name": name, "pinned": pinned, "pinned_major": pinned_major,
        "latest": latest, "latest_major": latest_major, "status": status,
    })
print(json.dumps(rows, indent=2))
'
else
  printf '%-28s %-14s %-8s %-14s %-8s %s\n' "PACKAGE" "PINNED" "MAJOR" "LATEST" "MAJOR" "STATUS"
  printf '%b' "$rows" | while IFS=$'\t' read -r name spec pinned_major latest latest_major status; do
    [ -n "$name" ] || continue
    printf '%-28s %-14s %-8s %-14s %-8s %s\n' "$name" "$spec" "$pinned_major" "$latest" "$latest_major" "$status"
  done
fi

echo
if [ "$behind" -gt 0 ]; then
  echo "RESULT: $behind dependenc$([ "$behind" -eq 1 ] && echo y || echo ies) a full major behind latest (template: $PKG_PATH)."
  exit 1
fi
if [ "$errors" -gt 0 ]; then
  echo "RESULT: no majors behind, but $errors package(s) could not be checked (registry unreachable)."
  exit 2
fi
echo "RESULT: template is current — every pinned major matches or leads npm's latest."
exit 0
