#!/usr/bin/env bash
# dependency_scan.sh — supply-chain gate: npm audit (CVE) + license compliance
# + bounded safe-patch auto-upgrade across this repo's npm surfaces.
#
# WHAT IT DOES (task-e1ecb865 / GRAND_PRODUCT supply-chain moat):
#   1. AUDIT    — `npm audit --omit=dev` per target; FAILS on any high/critical
#                 vulnerability in production deps (moderate/low are reported,
#                 never fatal). Needs only package.json + package-lock.json.
#   2. LICENSES — installs each target's prod tree into a throwaway dir
#                 (`npm ci --ignore-scripts --omit=dev`), reads every installed
#                 package's declared license, FAILS on anything outside the
#                 embedded permissive allowlist (extendable via
#                 config/license_allowlist.txt — SPDX ids or `package:<name>`
#                 pins, one per line, `#` comments).
#   3. BUMPS    — (--bump) computes the bounded set of SAFE upgrades: direct
#                 production deps whose in-range "wanted" version differs from
#                 the locked version by a PATCH increment only (same
#                 major.minor, no prereleases), capped at --max-bumps
#                 (default 5). Applies them lockfile-only (`npm update
#                 --package-lock-only <names>`), verifies (`npm ci` +
#                 `npm run lint --if-present`, plus `npm test --if-present`
#                 when DEPSCAN_VERIFY_TESTS=1), and with --pr commits them to
#                 a `deps/auto-patch-<YYYYMMDD>` branch and opens a PR to
#                 `test` (never main — normal flow reviews it into main).
#                 Duplicate-guarded: skips if an open deps/auto-patch* PR
#                 already exists.
#
# OBSERVABILITY: every run writes state/dependency-scan-report.json (gitignored,
# machine-local) and best-effort mirrors a summary row to the master gateway's
# audit trail (audit_log_append via localhost:3100/mcp, source
# "dependency-scan") — same surface local-ci.sh reports to. Gateway down ⇒
# silently skipped, never affects the verdict.
#
# NPM EXECUTION POLICY (CLAUDE.md rule 2): npm never runs on the host. Default
# is a throwaway Docker container (node:22-alpine; override
# DEPSCAN_NODE_IMAGE, e.g. node:22 if a native dep won't build on musl). CI
# runners are the sanctioned exception — set DEPSCAN_HOST_NPM=1 there (the
# self-hosted runner container has Node 22 and, deliberately, no docker
# socket).
#
# Usage:
#   ./scripts/dependency_scan.sh                       # audit + licenses, all targets
#   ./scripts/dependency_scan.sh --targets "runtime"   # subset
#   ./scripts/dependency_scan.sh --bump --dry-run      # show safe patch bumps only
#   ./scripts/dependency_scan.sh --bump                # apply bumps lockfile-only + verify
#   ./scripts/dependency_scan.sh --bump --pr           # …and branch/commit/push/PR to test
#   ./scripts/dependency_scan.sh --bump --skip-scan    # bumps without re-running audit/licenses
#
# Exit codes: 0 clean · 1 high/critical vuln or license violation or failed
# verify · 2 usage error · 3 scan could not run (registry unreachable, bad
# JSON) — fails closed in CI.
#
# Unit suite: scripts/tests/test_dependency_scan.sh sources this file with
# DEPENDENCY_SCAN_LIB_ONLY=1 and exercises the pure functions (audit_verdict,
# check_licenses, select_patch_bumps) hermetically — no Docker, no network.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_IMAGE="${DEPSCAN_NODE_IMAGE:-node:22-alpine}"
MAX_BUMPS_DEFAULT=5

# ── Embedded license allowlist (permissive SPDX ids, case-insensitive) ──────
# Extend per-repo via config/license_allowlist.txt (never edit here for a
# one-off): SPDX ids or `package:<name>` pins, one per line, `#` comments.
DEFAULT_ALLOWLIST='
MIT
MIT-0
ISC
0BSD
BSD-2-Clause
BSD-3-Clause
Apache-2.0
BlueOak-1.0.0
CC0-1.0
CC-BY-3.0
CC-BY-4.0
MPL-2.0
Python-2.0
Unlicense
Zlib
'

# ═══════════════════════════ Pure functions (unit-tested) ══════════════════

# audit_verdict <npm-audit-json-file>
# stdout: "critical=N high=N moderate=N low=N info=N total=N"
# rc: 0 no high/critical · 1 high/critical present · 3 malformed/unusable JSON
audit_verdict() {
    python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    v = data["metadata"]["vulnerabilities"]
    counts = {k: int(v.get(k, 0)) for k in ("critical", "high", "moderate", "low", "info")}
except Exception:
    print("error=malformed-audit-json")
    sys.exit(3)
total = v.get("total", sum(counts.values()))
print(" ".join(f"{k}={counts[k]}" for k in ("critical", "high", "moderate", "low", "info")) + f" total={total}")
sys.exit(1 if counts["critical"] + counts["high"] > 0 else 0)
PY
}

# check_licenses <tsv-file> <allowlist-file>
# tsv rows: "<name>@<version>\t<license expression>". Allowlist rows: SPDX id,
# or "package:<name>" pin, `#` comments. SPDX OR-expressions pass if ANY
# alternative is allowed; AND requires all. Missing/UNKNOWN/UNLICENSED fails.
# stdout: one "name@version\tlicense" row per violation. rc: 0 clean · 1 violations.
check_licenses() {
    python3 - "$1" "$2" <<'PY'
import re, sys
allowed, pinned = set(), set()
with open(sys.argv[2]) as f:
    for line in f:
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.lower().startswith("package:"):
            pinned.add(line.split(":", 1)[1].strip().lower())
        else:
            allowed.add(line.lower())

def expr_ok(expr):
    expr = expr.strip()
    while expr.startswith("(") and expr.endswith(")"):
        expr = expr[1:-1].strip()
    if not expr:
        return False
    if re.search(r"\s+OR\s+", expr, re.I):
        return any(expr_ok(p) for p in re.split(r"\s+OR\s+", expr, flags=re.I))
    if re.search(r"\s+AND\s+", expr, re.I):
        return all(expr_ok(p) for p in re.split(r"\s+AND\s+", expr, flags=re.I))
    return expr.strip("()").lower() in allowed

violations = []
with open(sys.argv[1]) as f:
    for line in f:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        namever, _, lic = line.partition("\t")
        name = namever.rsplit("@", 1)[0]
        if name.lower() in pinned:
            continue
        lic = lic.strip()
        if not lic or lic.upper() in ("UNKNOWN", "UNLICENSED") or not expr_ok(lic):
            violations.append((namever, lic or "UNKNOWN"))
for nv, lic in violations:
    print(f"{nv}\t{lic}")
sys.exit(1 if violations else 0)
PY
}

# select_patch_bumps <old-package-lock> <wanted-package-lock> <max-n>
# Compares DIRECT PRODUCTION deps only. Selects entries where the wanted
# version is a pure patch increment (same major.minor, higher patch, plain
# x.y.z on both sides — prereleases never auto-bump). Deterministic
# (alphabetical), bounded to <max-n>; overflow noted on stderr.
# stdout: "name\told\tnew" rows. rc: always 0 (empty output = nothing safe).
select_patch_bumps() {
    python3 - "$1" "$2" "$3" <<'PY'
import json, re, sys
old = json.load(open(sys.argv[1]))
new = json.load(open(sys.argv[2]))
maxn = int(sys.argv[3])
sem = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

def ver(lock, name):
    return (lock.get("packages", {}).get("node_modules/" + name) or {}).get("version")

direct = sorted((old.get("packages", {}).get("", {}) or {}).get("dependencies", {}) or {})
rows = []
for name in direct:
    o, n = ver(old, name), ver(new, name)
    if not o or not n or o == n:
        continue
    mo, mn = sem.match(o), sem.match(n)
    if not mo or not mn:
        continue
    if mo.group(1) != mn.group(1) or mo.group(2) != mn.group(2):
        continue
    if int(mn.group(3)) <= int(mo.group(3)):
        continue
    rows.append((name, o, n))
for name, o, n in rows[:maxn]:
    print(f"{name}\t{o}\t{n}")
if len(rows) > maxn:
    print(f"note: {len(rows) - maxn} further safe patch bump(s) deferred by bound {maxn}", file=sys.stderr)
PY
}

# ═══════════════════════════ Impure helpers ════════════════════════════════

# run_npm <host-dir> <sh-command> — Docker by default (CLAUDE.md rule 2);
# DEPSCAN_HOST_NPM=1 runs directly (CI-runner exception).
run_npm() {
    local dir="$1" cmd="$2"
    if [ "${DEPSCAN_HOST_NPM:-0}" = "1" ]; then
        (cd "$dir" && sh -c "$cmd")
    else
        command -v docker >/dev/null 2>&1 || {
            echo "    docker unavailable and DEPSCAN_HOST_NPM!=1 — cannot run npm" >&2
            return 3
        }
        docker run --rm -v "$dir":/app -w /app \
            -e npm_config_cache=/tmp/.npm -e CI=1 \
            "$NODE_IMAGE" sh -lc "$cmd"
    fi
}

# extract_licenses <dir-with-node_modules> — walk installed package roots
# (incl. scoped + nested) and emit "name@version\tlicense" TSV on stdout.
extract_licenses() {
    python3 - "$1" <<'PY'
import json, os, sys

def pkg_dirs(nm):
    for entry in sorted(os.listdir(nm)):
        p = os.path.join(nm, entry)
        if not os.path.isdir(p) or entry.startswith("."):
            continue
        if entry.startswith("@"):
            for sub in sorted(os.listdir(p)):
                q = os.path.join(p, sub)
                if os.path.isdir(q):
                    yield q
        else:
            yield p

def walk(nm):
    for d in pkg_dirs(nm):
        yield d
        inner = os.path.join(d, "node_modules")
        if os.path.isdir(inner):
            yield from walk(inner)

rows = {}
nm = os.path.join(sys.argv[1], "node_modules")
if os.path.isdir(nm):
    for d in walk(nm):
        try:
            meta = json.load(open(os.path.join(d, "package.json")))
        except Exception:
            continue
        name, version = meta.get("name"), meta.get("version")
        if not name or not version:
            continue
        lic = meta.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type", "")
        if not lic:
            ls = meta.get("licenses")
            if isinstance(ls, list):
                lic = " OR ".join(x.get("type", "") if isinstance(x, dict) else str(x) for x in ls)
        rows[f"{name}@{version}"] = (lic or "UNKNOWN").strip() or "UNKNOWN"
for key in sorted(rows):
    print(f"{key}\t{rows[key]}")
PY
}

# gateway_report <level> <message> <attributes-json> — best-effort mirror to
# the master gateway's observability surface: the `logs_record` MCP tool feeds
# the tenant-scoped log store behind the dashboard's /logs live-tail (same
# path the bash task runner threads its lines through). All scan runs share
# correlationId "dependency-scan" so the viewer groups them. Never fatal; a
# down gateway must not change the scan verdict.
gateway_report() {
    command -v curl >/dev/null 2>&1 || return 0
    local level="$1" message="$2" attrs="$3" token="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}" payload
    payload="$(python3 - "$level" "$message" "$attrs" <<'PY'
import json, sys
level, message, attrs = sys.argv[1:4]
try:
    attributes = json.loads(attrs)
except Exception:
    attributes = {"raw": attrs}
print(json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1, "params": {
    "name": "logs_record",
    "arguments": {"correlationId": "dependency-scan", "service": "runner",
                  "level": level, "message": message, "attributes": attributes}}}))
PY
)"
    curl -sf -m 2 -X POST "http://localhost:3100/mcp" \
        -H 'content-type: application/json' \
        -H "x-gateway-local-token: $token" \
        -d "$payload" >/dev/null 2>&1 || true
}

# gh_api <method> <path> [json-data] — GitHub REST via curl; token from
# GH_TOKEN/GITHUB_TOKEN or `gh auth token`. Prints response body.
gh_api() {
    local method="$1" path="$2" data="${3:-}" token
    token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
    [ -n "$token" ] || token="$(gh auth token 2>/dev/null || true)"
    [ -n "$token" ] || { echo "no GitHub token (GH_TOKEN/GITHUB_TOKEN or gh auth)" >&2; return 1; }
    curl -sf -m 20 -X "$method" "https://api.github.com${path}" \
        -H "authorization: Bearer $token" \
        -H "accept: application/vnd.github+json" \
        ${data:+-d "$data"}
}

repo_nwo() {
    if [ -n "${GITHUB_REPOSITORY:-}" ]; then echo "$GITHUB_REPOSITORY"; return; fi
    git -C "$REPO_ROOT" remote get-url origin 2>/dev/null \
        | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##'
}

materialize_allowlist() { # -> path to combined allowlist file
    local f="$WORK/allowlist.txt"
    printf '%s\n' "$DEFAULT_ALLOWLIST" > "$f"
    [ -f "$REPO_ROOT/config/license_allowlist.txt" ] && cat "$REPO_ROOT/config/license_allowlist.txt" >> "$f"
    echo "$f"
}

# ── LIB_ONLY hook: scripts/tests/test_dependency_scan.sh stops here ─────────
if [ "${DEPENDENCY_SCAN_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ═══════════════════════════ Main flow ═════════════════════════════════════

TARGETS=""
DO_BUMP=0
DO_PR=0
DRY_RUN=0
SKIP_SCAN=0
MAX_BUMPS="$MAX_BUMPS_DEFAULT"
PR_BASE="${DEPSCAN_PR_BASE:-test}"

usage() { sed -n '2,56p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --targets)   TARGETS="$2"; shift 2 ;;
        --bump)      DO_BUMP=1; shift ;;
        --pr)        DO_PR=1; DO_BUMP=1; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        --skip-scan) SKIP_SCAN=1; shift ;;
        --max-bumps) MAX_BUMPS="$2"; shift 2 ;;
        -h|--help)   usage 0 ;;
        *) echo "Unknown arg: $1" >&2; usage 2 ;;
    esac
done

# Auto-discover npm surfaces: any candidate dir carrying a package-lock.json.
if [ -z "$TARGETS" ]; then
    for d in . runtime dashboard; do
        [ -f "$REPO_ROOT/$d/package-lock.json" ] && TARGETS="$TARGETS $d"
    done
    TARGETS="${TARGETS# }"
fi
[ -n "$TARGETS" ] || { echo "No targets with package-lock.json found" >&2; exit 2; }

# /tmp (not \$TMPDIR) so the throwaway dirs sit inside Docker Desktop's default
# file-sharing scope on macOS.
WORK="$(mktemp -d /tmp/depscan.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/rows"
OVERALL=0
ROW_N=0
BUMPED_DIRS=""
ALL_BUMPS=""

note_row() { # note_row <dir> <json-fragment>
    ROW_N=$((ROW_N + 1))
    printf '%s\n' "$2" > "$WORK/rows/$(printf '%02d' "$ROW_N")-$1.json"
}

scan_target() {
    local dir="$1" tdir="$REPO_ROOT/$1"
    local audit_json="$WORK/audit-${dir//\//_}.json"
    local audit_counts="" audit_verdict_s="pass" lic_verdict_s="pass" lic_viol=""

    echo "── [$dir] npm audit (prod deps, gate: high/critical) ──"
    run_npm "$tdir" 'npm audit --omit=dev --json 2>/dev/null; exit 0' > "$audit_json" || true
    audit_counts="$(audit_verdict "$audit_json")"; local rc=$?
    case $rc in
        0) echo "  PASS — $audit_counts" ;;
        1) echo "  FAIL — $audit_counts"; audit_verdict_s="fail"; OVERALL=1 ;;
        *) echo "  ERROR — npm audit produced no usable JSON (registry unreachable?)"
           audit_verdict_s="error"; OVERALL=3 ;;
    esac

    echo "── [$dir] license compliance (prod tree vs allowlist) ──"
    local inst="$WORK/lic-${dir//\//_}"
    mkdir -p "$inst"
    cp "$tdir/package.json" "$tdir/package-lock.json" "$inst/"
    if run_npm "$inst" 'npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error' >/dev/null; then
        extract_licenses "$inst" > "$WORK/licenses-${dir//\//_}.tsv"
        if lic_viol="$(check_licenses "$WORK/licenses-${dir//\//_}.tsv" "$ALLOWLIST")"; then
            echo "  PASS — $(wc -l < "$WORK/licenses-${dir//\//_}.tsv" | tr -d ' ') package(s), all allowlisted"
        else
            echo "  FAIL — non-allowlisted licenses:"
            printf '%s\n' "$lic_viol" | sed 's/^/    /'
            echo "  (extend config/license_allowlist.txt with an SPDX id or package:<name> pin if reviewed+accepted)"
            lic_verdict_s="fail"; OVERALL=1
        fi
    else
        echo "  ERROR — npm ci failed; license tree unavailable"
        lic_verdict_s="error"; OVERALL=3
    fi

    note_row "${dir//\//_}" "$(python3 - "$dir" "$audit_verdict_s" "$audit_counts" "$lic_verdict_s" <<'PY'
import json, sys
d, av, counts, lv = sys.argv[1:5]
c = dict(kv.split("=") for kv in counts.split() if "=" in kv)
print(json.dumps({"dir": d, "audit": {"verdict": av, **{k: int(v) for k, v in c.items() if v.isdigit()}},
                  "licenses": {"verdict": lv}}))
PY
)"
}

bump_target() {
    local dir="$1" tdir="$REPO_ROOT/$1"
    echo "── [$dir] bounded safe patch bumps (max $MAX_BUMPS) ──"
    local wanted="$WORK/wanted-${dir//\//_}"
    mkdir -p "$wanted"
    cp "$tdir/package.json" "$tdir/package-lock.json" "$wanted/"
    if ! run_npm "$wanted" 'npm update --package-lock-only --no-audit --no-fund --loglevel=error' >/dev/null; then
        echo "  ERROR — could not compute wanted versions (registry unreachable?)"; OVERALL=3; return
    fi
    local bumps
    bumps="$(select_patch_bumps "$tdir/package-lock.json" "$wanted/package-lock.json" "$MAX_BUMPS")"
    if [ -n "$bumps" ]; then
        printf '%s\n' "$bumps" | awk -F'\t' '{printf "  %s %s -> %s\n", $1, $2, $3}'
    else
        echo "  no direct-dep patch bumps — in-range 'npm audit fix' still applies"
    fi
    if [ "$DRY_RUN" = 1 ]; then
        echo "  (dry-run — not applied; a real run also applies in-range 'npm audit fix')"; return
    fi
    # In-range security fixes first: audit fix WITHOUT --force never crosses a
    # declared semver range, so it's safe by the same contract as the patch
    # bumps (clears range-fixable advisories in transitive deps too).
    run_npm "$tdir" 'npm audit fix --package-lock-only --omit=dev --no-fund --loglevel=error >/dev/null 2>&1; exit 0' >/dev/null || true
    if [ -n "$bumps" ]; then
        local names
        names="$(printf '%s\n' "$bumps" | cut -f1 | tr '\n' ' ')"
        if ! run_npm "$tdir" "npm update --package-lock-only --no-audit --no-fund --loglevel=error $names" >/dev/null; then
            echo "  FAIL — npm update (lockfile-only) failed"; OVERALL=1; return
        fi
    fi
    if git -C "$REPO_ROOT" diff --quiet -- "$dir/package-lock.json" 2>/dev/null; then
        echo "  lockfile unchanged after audit-fix + bumps — nothing to apply"; return
    fi
    echo "  applied (package-lock.json only: in-range audit fix + patch bumps) — verifying…"
    # Typecheck via tsc directly when available — some repos' `lint` script is
    # interactive in a fresh checkout (e.g. `next lint` with no ESLint config),
    # which would hang/fail a headless verify for a reason unrelated to the bumps.
    local verify='npm ci --no-audit --no-fund --loglevel=error && if [ -f tsconfig.json ] && [ -x node_modules/.bin/tsc ]; then node_modules/.bin/tsc --noEmit; else npm run lint --if-present; fi'
    [ "${DEPSCAN_VERIFY_TESTS:-0}" = "1" ] && verify="$verify && npm test --if-present"
    if run_npm "$tdir" "$verify"; then
        echo "  VERIFIED — npm ci + typecheck/lint$( [ "${DEPSCAN_VERIFY_TESTS:-0}" = "1" ] && echo ' + tests') green"
        BUMPED_DIRS="$BUMPED_DIRS $dir"
        ALL_BUMPS="$ALL_BUMPS$dir: in-range npm audit fix applied\\n"
        [ -n "$bumps" ] && ALL_BUMPS="$ALL_BUMPS$(printf '%s\n' "$bumps" | awk -F'\t' -v d="$dir" '{printf "%s: %s %s -> %s\\n", d, $1, $2, $3}')"
    else
        echo "  FAIL — verify broke after bumps; reverting $dir/package-lock.json"
        git -C "$REPO_ROOT" checkout -- "$dir/package-lock.json" 2>/dev/null || true
        OVERALL=1
    fi
}

open_pr() {
    [ -n "$BUMPED_DIRS" ] || { echo "── PR: nothing bumped — skipping ──"; return; }
    local nwo branch date_s
    nwo="$(repo_nwo)"
    [ -n "$nwo" ] || { echo "── PR: cannot determine repo (origin remote) — skipping ──"; return; }
    # Dupe guard — one open auto-patch PR at a time.
    local open_heads
    open_heads="$(gh_api GET "/repos/$nwo/pulls?state=open&base=$PR_BASE&per_page=100" 2>/dev/null \
        | python3 -c 'import json,sys; [print(p["head"]["ref"]) for p in json.load(sys.stdin)]' 2>/dev/null || true)"
    if printf '%s\n' "$open_heads" | grep -q '^deps/auto-patch'; then
        echo "── PR: an open deps/auto-patch* PR already exists — skipping (merge/close it first) ──"
        return
    fi
    date_s="$(date -u +%Y%m%d)"
    branch="deps/auto-patch-$date_s"
    echo "── PR: $branch -> $PR_BASE ──"
    if [ "${CI:-}" = "true" ] || [ "${CI:-}" = "1" ]; then
        git -C "$REPO_ROOT" config user.name  >/dev/null 2>&1 || git -C "$REPO_ROOT" config user.name  "github-actions[bot]"
        git -C "$REPO_ROOT" config user.email >/dev/null 2>&1 || git -C "$REPO_ROOT" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    fi
    local body="Bounded auto-upgrade: safe semver-PATCH bumps of direct production deps (lockfile-only, verified with npm ci + lint$( [ "${DEPSCAN_VERIFY_TESTS:-0}" = "1" ] && echo ' + tests')).\n\n$ALL_BUMPS\nGenerated by scripts/dependency_scan.sh (.github/workflows/dependency-scan.yml)."
    git -C "$REPO_ROOT" checkout -b "$branch" || { echo "  FAIL — branch create"; OVERALL=1; return; }
    local d
    for d in $BUMPED_DIRS; do git -C "$REPO_ROOT" add "$d/package-lock.json"; done
    git -C "$REPO_ROOT" commit -m "chore(deps): bounded auto-upgrade — safe patch bumps ($(echo "$BUMPED_DIRS" | wc -w | tr -d ' ') target(s))" \
        -m "$(printf '%b' "$ALL_BUMPS")" || { echo "  FAIL — commit"; OVERALL=1; return; }
    git -C "$REPO_ROOT" push -u origin "$branch" || { echo "  FAIL — push"; OVERALL=1; return; }
    if gh_api POST "/repos/$nwo/pulls" \
        "$(python3 - "$branch" "$PR_BASE" "$body" <<'PY'
import json, sys
print(json.dumps({"title": "chore(deps): bounded auto-upgrade — safe patch bumps",
                  "head": sys.argv[1], "base": sys.argv[2],
                  "body": sys.argv[3].replace("\\n", "\n")}))
PY
)" >/dev/null; then
        echo "  PR opened: $branch -> $PR_BASE"
    else
        echo "  WARN — branch pushed but PR creation failed (open manually: $branch -> $PR_BASE)"
    fi
}

ALLOWLIST="$(materialize_allowlist)"
echo "Dependency scan — targets:$(printf ' %s' $TARGETS) (npm via $( [ "${DEPSCAN_HOST_NPM:-0}" = "1" ] && echo 'host — CI-runner exception' || echo "docker $NODE_IMAGE"))"

if [ "$SKIP_SCAN" = 0 ]; then
    for t in $TARGETS; do scan_target "$t"; done
fi
if [ "$DO_BUMP" = 1 ]; then
    for t in $TARGETS; do bump_target "$t"; done
    [ "$DO_PR" = 1 ] && [ "$DRY_RUN" = 0 ] && open_pr
fi

# ── Report: local JSON (gitignored) + gateway observability mirror ──────────
REPORT_FILE="${DEPSCAN_REPORT:-}"
if [ -z "$REPORT_FILE" ]; then
    for d in state AI/state; do
        [ -d "$REPO_ROOT/$d" ] && { REPORT_FILE="$REPO_ROOT/$d/dependency-scan-report.json"; break; }
    done
fi
REPO_NAME="$(repo_nwo)"; REPO_NAME="${REPO_NAME##*/}"; [ -n "$REPO_NAME" ] || REPO_NAME="$(basename "$REPO_ROOT")"
SUMMARY="$(python3 - "$WORK/rows" "$OVERALL" "$(hostname -s 2>/dev/null || echo unknown)" "$REPO_NAME" "$ALL_BUMPS" <<'PY'
import json, os, sys
from datetime import datetime, timezone
rows_dir, overall, host, repo, bumps = sys.argv[1:6]
rows = []
for f in sorted(os.listdir(rows_dir)):
    try:
        rows.append(json.load(open(os.path.join(rows_dir, f))))
    except Exception:
        pass
print(json.dumps({
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "host": host, "repo": repo,
    "overall": {"0": "pass", "1": "fail"}.get(overall, "error"),
    "targets": rows,
    "bumps_applied": [b for b in bumps.replace("\\n", "\n").splitlines() if b.strip()],
}, sort_keys=True))
PY
)"
if [ -n "$REPORT_FILE" ]; then
    printf '%s\n' "$SUMMARY" > "$REPORT_FILE" 2>/dev/null \
        && echo "Report: $REPORT_FILE" || true
fi
case "$OVERALL" in
    0) LEVEL=info;  VERDICT_S=pass ;;
    1) LEVEL=error; VERDICT_S=fail ;;
    *) LEVEL=warn;  VERDICT_S=error ;;
esac
gateway_report "$LEVEL" "dependency-scan [$REPO_NAME] $VERDICT_S — targets:$(printf ' %s' $TARGETS)" "$SUMMARY"

case "$OVERALL" in
    0) echo "RESULT: PASS — no high/critical vulns, licenses clean" ;;
    1) echo "RESULT: FAIL — see findings above" ;;
    *) echo "RESULT: ERROR — scan could not complete (rc $OVERALL)" ;;
esac
exit "$OVERALL"
