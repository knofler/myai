#!/usr/bin/env bash
# check_capability_counts.sh — guards README.md / SHOWCASE.md / package.json
# against capability-count drift.
#
# The v0.6.2 release hand-reconciled "64 agents / 136 skills / 124 MCP tools"
# across the docs — and still got agents wrong (64 counted agents/README.md +
# agents/CATALOG.md as agents; agents/CATALOG.md itself says 62). This is the
# automated equivalent of that reconciliation: it derives the shipped truth
# from the artifacts themselves and fails when a current-state count claim in
# the docs disagrees:
#
#   agents    = agents/*.md minus README.md + CATALOG.md
#   skills    = skills/*/ directories
#   mcp_tools = entries in TOOL_DEFINITIONS (runtime/src/mcp/tools.ts),
#               counted as one `inputSchema:` per tool definition
#   hooks     = hooks/**/*.sh files
#
# Scanned claim shapes (per line, per occurrence): "NN agents",
# "NN specialist agents", "NN AI agents", "NN agent definitions", "NN skills",
# "NN skill playbooks", "NN MCP tools", "MCP gateway with NN tools",
# "NN hooks", "NN Claude Code hooks".
#
# Historical prose is exempt (changelog lines must keep their old numbers):
#   • lines containing an arrow (→ or ->) — "MCP tools 39→44" transitions
#   • lines starting with "- [x]" — completed roadmap/changelog entries
#   • claims below 20 — display/subset counts ("Show 5 agents",
#     "All 8 agents"), never capability totals
#
# Hermetic: python3 only — no node/Docker/gateway/network (node on the host
# is banned in this repo anyway). Runs in scripts/tests/run_all.sh (via
# test_check_capability_counts.sh) and as publish_guard.sh step 0, so a
# release cannot ship stale counts.
#
# Usage: scripts/check_capability_counts.sh [--fix] [--root DIR]
#   --fix    rewrite the stale numbers in place (then review + commit the diff)
#   --root   scan a different repo root (used by the hermetic test suite)
# Exit: 0 = in sync (or all fixed) · 1 = drift found · 2 = scanner error
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

FIX=0
ROOT="$REPO_ROOT"
while [ $# -gt 0 ]; do
    case "$1" in
        --fix)  FIX=1 ;;
        --root) shift; ROOT="${1:-}"; [ -n "$ROOT" ] || { echo "  ERROR — --root needs a directory" >&2; exit 2; } ;;
        -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "  ERROR — unknown flag: $1 (usage: check_capability_counts.sh [--fix] [--root DIR])" >&2; exit 2 ;;
    esac
    shift
done

if ! command -v python3 >/dev/null 2>&1; then
    echo "  skip — python3 not on PATH"
    exit 0
fi

python3 - "$ROOT" "$FIX" <<'PY'
import glob, os, re, sys

root, fix = sys.argv[1], sys.argv[2] == "1"
PASS = FAIL = FIXED = 0

def die(msg):
    print(f"  ERROR — {msg}")
    sys.exit(2)

# ── shipped truth, derived from the artifacts themselves ────────────────────
agents_dir = os.path.join(root, "agents")
if not os.path.isdir(agents_dir):
    die("agents/ not found — cannot derive agent count")
agents = len([f for f in glob.glob(os.path.join(agents_dir, "*.md"))
              if os.path.basename(f) not in ("README.md", "CATALOG.md")])

skills_dir = os.path.join(root, "skills")
if not os.path.isdir(skills_dir):
    die("skills/ not found — cannot derive skill count")
skills = len([d for d in os.listdir(skills_dir)
              if os.path.isdir(os.path.join(skills_dir, d))])

tools_ts = os.path.join(root, "runtime", "src", "mcp", "tools.ts")
if not os.path.exists(tools_ts):
    die("runtime/src/mcp/tools.ts not found — cannot derive MCP tool count")
src = open(tools_ts, encoding="utf-8").read()
m = re.search(r"^export const TOOL_DEFINITIONS[^\n]*\[(.*?)^\];", src, re.S | re.M)
if not m:
    die("TOOL_DEFINITIONS array not found in runtime/src/mcp/tools.ts")
mcp_tools = len(re.findall(r"\binputSchema\s*:", m.group(1)))

hooks_dir = os.path.join(root, "hooks")
if not os.path.isdir(hooks_dir):
    die("hooks/ not found — cannot derive hook count")
hooks = sum(len([f for f in files if f.endswith(".sh")])
            for _, _, files in os.walk(hooks_dir))

TRUTH = {"agents": agents, "skills": skills, "MCP tools": mcp_tools, "hooks": hooks}
print(f"  shipped truth: {agents} agents · {skills} skills · {mcp_tools} MCP tools · {hooks} hooks")

# ── claim shapes (group 1 = the number) ──────────────────────────────────────
CLAIMS = [
    ("agents",    re.compile(r"\b(\d+)\+?\s+(?:specialist\s+|AI\s+)?agents\b")),
    ("agents",    re.compile(r"\b(\d+)\s+agent definitions\b")),
    ("skills",    re.compile(r"\b(\d+)\s+skills\b")),
    ("skills",    re.compile(r"\b(\d+)\s+skill playbooks\b")),
    ("MCP tools", re.compile(r"\b(\d+)\s+MCP tools\b")),
    ("MCP tools", re.compile(r"\bMCP gateway with (\d+) tools\b")),
    ("hooks",     re.compile(r"\b(\d+)\s+(?:Claude Code\s+)?hooks\b")),
]
MIN_COUNT = 20  # below this = display/subset count ("Show 5 agents"), never a total

def exempt(line):
    # historical changelog prose keeps its old numbers
    return "→" in line or "->" in line or line.lstrip().startswith("- [x]")

FILES = ["README.md", "SHOWCASE.md", "package.json"]
for fname in FILES:
    path = os.path.join(root, fname)
    if not os.path.exists(path):
        continue
    lines = open(path, encoding="utf-8").read().splitlines(keepends=True)
    changed = False
    for i, line in enumerate(lines, 1):
        if exempt(line):
            continue
        cur = line
        for kind, rx in CLAIMS:
            truth = TRUTH[kind]

            def repl(m, kind=kind, truth=truth, fname=fname, i=i):
                global PASS, FAIL, FIXED
                n, claim = int(m.group(1)), m.group(0)
                if n < MIN_COUNT:
                    return claim
                if n == truth:
                    PASS += 1
                    print(f"  ok   — {fname}:{i} '{claim}'")
                    return claim
                if fix:
                    FIXED += 1
                    new = claim.replace(m.group(1), str(truth), 1)
                    print(f"  fixed — {fname}:{i} '{claim}' → '{new}'")
                    return new
                FAIL += 1
                print(f"  FAIL — {fname}:{i} claims '{claim}' — shipped truth is {truth} {kind}")
                return claim

            cur = rx.sub(repl, cur)
        if cur != line:
            lines[i - 1] = cur
            changed = True
    if fix and changed:
        open(path, "w", encoding="utf-8").write("".join(lines))

if fix:
    print(f"\nRESULT: {PASS} in sync, {FIXED} fixed")
    sys.exit(0)
print(f"\nRESULT: {PASS} in sync, {FAIL} stale")
if FAIL:
    print("  fix: scripts/check_capability_counts.sh --fix  (rewrites the stale numbers in place)")
sys.exit(1 if FAIL else 0)
PY
