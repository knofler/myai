#!/usr/bin/env bash
# check_try_myai_drift.sh — guards TRY_MYAI.md against CLI drift.
#
# The EXO dogfood session found TRY_MYAI.md stale about the `--managed` flag
# requirement for the AI/-scaffold walkthrough — only caught by manually
# driving the doc end-to-end. This is the automated equivalent: it treats
# bin/myai.cjs's COMMANDS table (+ the scripts it dispatches to) as the single
# source of truth for real subcommands/flags, and fails when a fenced command
# block in TRY_MYAI.md drifts from it, in either direction:
#
#   1. every `myai <subcommand>` invoked in a fenced block exists in COMMANDS
#   2. every `--flag` used alongside it is documented in that command's `desc`
#      or present in the script it dispatches to (stale/removed flag)
#   3. every flag a script declares required for the doc via a
#      `# TRY_MYAI_REQUIRES: --flag` marker actually appears in a fenced block
#      that invokes that subcommand (newly-added required flag went undocumented)
#
# Hermetic: python3 only, no node/Docker/gateway/network — runs in
# script-unit-tests.yml and release.yml (both call scripts/tests/run_all.sh).
#
# Usage: ./scripts/check_try_myai_drift.sh [myai.cjs] [TRY_MYAI.md] [scripts_dir]
#        (all three default to this repo's real files — override for tests)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

MYAI_CJS="${1:-$REPO_ROOT/bin/myai.cjs}"
TRY_MYAI="${2:-$REPO_ROOT/TRY_MYAI.md}"
SCRIPTS_DIR="${3:-$REPO_ROOT/scripts}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "  skip — python3 not on PATH"
    exit 0
fi

python3 - "$MYAI_CJS" "$TRY_MYAI" "$SCRIPTS_DIR" <<'PY'
import re, sys, os

myai_cjs_path, try_myai_path, scripts_dir = sys.argv[1:4]

PASS = FAIL = 0
def ok(m):  globals().__setitem__("PASS", PASS + 1); print(f"  ok   — {m}")
def bad(m): globals().__setitem__("FAIL", FAIL + 1); print(f"  FAIL — {m}")

for label, p in (("bin/myai.cjs", myai_cjs_path), ("TRY_MYAI.md", try_myai_path)):
    if not os.path.exists(p):
        bad(f"{label} not found at {p}")
if FAIL:
    print(f"\nRESULT: {PASS} passed, {FAIL} failed"); sys.exit(1)

cjs = open(myai_cjs_path).read()

# ── 1. parse the COMMANDS table (single source of truth) ───────────────────
m = re.search(r"const COMMANDS = \[(.*?)\n\];", cjs, re.S)
if not m:
    bad("could not locate 'const COMMANDS = [...]' in bin/myai.cjs")
    print(f"\nRESULT: {PASS} passed, {FAIL} failed"); sys.exit(1)

entries = re.findall(r"\{([^{}]*)\}", m.group(1))
commands = {}  # name -> {script, desc}
for e in entries:
    nm = re.search(r"name:\s*'([^']+)'", e)
    if not nm:
        continue
    sc = re.search(r"script:\s*'([^']+)'", e)
    ds = re.search(r"desc:\s*'((?:\\.|[^'\\])*)'", e)
    desc = ds.group(1).replace("\\'", "'") if ds else ''
    commands[nm.group(1)] = {'script': sc.group(1) if sc else None, 'desc': desc}

if commands:
    ok(f"parsed {len(commands)} subcommands from bin/myai.cjs COMMANDS table")
else:
    bad("parsed at least one subcommand from bin/myai.cjs COMMANDS table")

FLAG_RE = re.compile(r"--[a-zA-Z][a-zA-Z0-9-]*")

# known flags per command = flags mentioned in its desc + flags literally
# present in the script it dispatches to (covers flags desc prose omits).
known_flags = {}
required_flags = {}  # name -> set of flags declared required via marker
for name, info in commands.items():
    flags = set(FLAG_RE.findall(info['desc']))
    if info['script']:
        sp = os.path.join(scripts_dir, info['script'])
        if os.path.exists(sp):
            text = open(sp).read()
            flags |= set(FLAG_RE.findall(text))
            reqs = set()
            for line in re.findall(r"^#\s*TRY_MYAI_REQUIRES:\s*(.+)$", text, re.M):
                reqs |= set(FLAG_RE.findall(line))
            if reqs:
                required_flags[name] = reqs
    known_flags[name] = flags

# ── 2. fenced command blocks in TRY_MYAI.md ─────────────────────────────────
doc = open(try_myai_path).read()
blocks = re.findall(r"```[a-zA-Z0-9]*\n(.*?)```", doc, re.S)
if blocks:
    ok(f"found {len(blocks)} fenced command blocks in TRY_MYAI.md")
else:
    bad("found at least one fenced command block in TRY_MYAI.md")

CMD_RE = re.compile(r"\bmyai\s+([a-zA-Z][\w-]*)")

stale_cmd = stale_flag = False
for block in blocks:
    for line in block.splitlines():
        cm = CMD_RE.search(line)
        if not cm:
            continue
        sub = cm.group(1)
        if sub not in commands:
            bad(f"TRY_MYAI.md references unknown subcommand 'myai {sub}' "
                f"(not in bin/myai.cjs COMMANDS) — line: {line.strip()!r}")
            stale_cmd = True
            continue
        for f in sorted(set(FLAG_RE.findall(line)) - known_flags.get(sub, set())):
            bad(f"TRY_MYAI.md uses '{f}' with 'myai {sub}' but it isn't documented "
                f"in bin/myai.cjs desc or its dispatched script — line: {line.strip()!r}")
            stale_flag = True

if not stale_cmd:
    ok("every 'myai <subcommand>' invocation in TRY_MYAI.md exists in bin/myai.cjs")
if not stale_flag:
    ok("every flag used in TRY_MYAI.md command blocks is recognized by the CLI")

# ── 3. TRY_MYAI_REQUIRES markers are satisfied ──────────────────────────────
missing_required = False
for sub, reqs in required_flags.items():
    covered = set()
    for block in blocks:
        if re.search(rf"\bmyai\s+{re.escape(sub)}\b", block):
            covered |= set(FLAG_RE.findall(block))
    for f in sorted(reqs - covered):
        bad(f"TRY_MYAI.md is missing required flag '{f}' for 'myai {sub}' "
            f"(declared via TRY_MYAI_REQUIRES in scripts/{commands[sub]['script']})")
        missing_required = True

if required_flags and not missing_required:
    ok("all TRY_MYAI_REQUIRES flags are present in TRY_MYAI.md")

print(f"\nRESULT: {PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
PY
