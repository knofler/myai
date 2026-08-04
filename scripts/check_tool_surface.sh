#!/usr/bin/env bash
# check_tool_surface.sh — guards the MCP gateway tool surface
# (runtime/src/mcp/tools.ts TOOL_DEFINITIONS) against silent regression.
#
# check_capability_counts.sh already derives an MCP-tool *count* from
# TOOL_DEFINITIONS and fails when a doc claims a different number — but it only
# catches a regression when the total moves. A PR that swaps one tool for
# another (net count unchanged), or removes a tool nobody happened to update a
# doc count for, sails through invisible. This guard tracks the tool-NAME
# surface itself against a committed baseline (scripts/tool_surface_baseline.txt)
# and fails on any name that disappears, regardless of whether the count moved.
#
# Baseline maintenance mirrors check_capability_counts.sh: additions (new
# tools) auto-update the baseline via --fix; without --fix, ANY drift (removed
# OR added-but-not-yet-baselined) fails, forcing the PR author to run --fix and
# commit the reviewed baseline diff — so an accidental removal can't slip
# through silently, and an intentional removal still requires a human to look
# at the baseline diff before it's accepted.
#
# Hermetic: python3 only — no node/Docker/gateway/network. Runs in
# scripts/tests/run_all.sh (via test_check_tool_surface.sh), which
# .github/workflows/script-unit-tests.yml runs on every PR to main.
#
# Usage: scripts/check_tool_surface.sh [--fix] [--root DIR]
#   --fix    rewrite scripts/tool_surface_baseline.txt to match current TOOL_DEFINITIONS
#   --root   scan a different repo root (used by the hermetic test suite)
# Exit: 0 = in sync (or fixed) · 1 = drift found (removed and/or added tools) · 2 = scanner error
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

FIX=0
ROOT="$REPO_ROOT"
while [ $# -gt 0 ]; do
    case "$1" in
        --fix)  FIX=1 ;;
        --root) shift; ROOT="${1:-}"; [ -n "$ROOT" ] || { echo "  ERROR — --root needs a directory" >&2; exit 2; } ;;
        -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "  ERROR — unknown flag: $1 (usage: check_tool_surface.sh [--fix] [--root DIR])" >&2; exit 2 ;;
    esac
    shift
done

if ! command -v python3 >/dev/null 2>&1; then
    echo "  skip — python3 not on PATH"
    exit 0
fi

python3 - "$ROOT" "$FIX" <<'PY'
import os, re, sys

root, fix = sys.argv[1], sys.argv[2] == "1"

def die(msg):
    print(f"  ERROR — {msg}")
    sys.exit(2)

tools_ts = os.path.join(root, "runtime", "src", "mcp", "tools.ts")
if not os.path.exists(tools_ts):
    die("runtime/src/mcp/tools.ts not found — cannot derive tool surface")
src = open(tools_ts, encoding="utf-8").read()
m = re.search(r"^export const TOOL_DEFINITIONS[^\n]*\[(.*?)^\];", src, re.S | re.M)
if not m:
    die("TOOL_DEFINITIONS array not found in runtime/src/mcp/tools.ts")
current = sorted(set(re.findall(r"^\s*name:\s*'([^']+)'", m.group(1), re.M)))
if not current:
    die("no tool names found in TOOL_DEFINITIONS — parser likely broken")

baseline_path = os.path.join(root, "scripts", "tool_surface_baseline.txt")
if not os.path.exists(baseline_path):
    if not fix:
        die(f"{baseline_path} not found — run with --fix to create it")
    baseline = []
else:
    baseline = sorted(
        line.strip() for line in open(baseline_path, encoding="utf-8")
        if line.strip() and not line.lstrip().startswith("#")
    )

current_set, baseline_set = set(current), set(baseline)
removed = sorted(baseline_set - current_set)
added = sorted(current_set - baseline_set)

print(f"  tool surface: {len(current)} tools in TOOL_DEFINITIONS · {len(baseline)} in baseline")

if fix:
    if removed or added:
        os.makedirs(os.path.dirname(baseline_path), exist_ok=True)
        with open(baseline_path, "w", encoding="utf-8") as f:
            f.write("# scripts/tool_surface_baseline.txt — committed snapshot of the tool names in\n")
            f.write("# runtime/src/mcp/tools.ts TOOL_DEFINITIONS. Guarded by check_tool_surface.sh:\n")
            f.write("# any name here that disappears from TOOL_DEFINITIONS fails CI. Regenerate\n")
            f.write("# with: scripts/check_tool_surface.sh --fix (then review the diff).\n")
            for name in current:
                f.write(name + "\n")
        for name in removed:
            print(f"  fixed — removed from baseline: '{name}'")
        for name in added:
            print(f"  fixed — added to baseline: '{name}'")
    print(f"\nRESULT: baseline now matches {len(current)} tools")
    sys.exit(0)

if removed:
    for name in removed:
        print(f"  FAIL — tool removed from TOOL_DEFINITIONS: '{name}' (was in baseline, missing now)")
if added:
    for name in added:
        print(f"  FAIL — tool added to TOOL_DEFINITIONS: '{name}' (not yet in baseline — run --fix)")

if removed or added:
    print(f"\nRESULT: {len(removed)} removed, {len(added)} added — tool surface drifted from baseline")
    print("  fix: scripts/check_tool_surface.sh --fix  (updates the baseline; review the diff before committing)")
    sys.exit(1)

print(f"\nRESULT: tool surface in sync ({len(current)} tools)")
sys.exit(0)
PY
