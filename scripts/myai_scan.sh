#!/usr/bin/env bash
# myai_scan.sh — the `myai scan <dir>` engine (Independent Edition, Day 4).
#
# Spider every git repo under a directory, register each in the gateway
# app-directory (repos_card), and seed RAG/MCP awareness (memory_store) so the
# fleet tooling (dashboard /directory, recall_session, memory_context) becomes
# aware of repos a fresh install hasn't seen yet. Fully idempotent — re-runnable.
#
# WHY HOST-SIDE: the gateway runs in Docker and only sees its mounted volumes,
# so its `repos_scan` MCP tool can't walk arbitrary host directories on a clean
# machine (the Independent-Edition use case). This script does the spider on the
# HOST (where the CLI has filesystem access), then pushes each discovery to the
# gateway over MCP — exactly how repo_card.sh / schedule_task.sh talk to it.
#
# Usage:
#   myai scan <dir>              # spider <dir>, upsert cards + seed RAG
#   myai scan <dir> --register   # ALSO self-register discovered repos into the
#                                 # caller's tenant `repos` DB roster (ADR-021
#                                 # Phase 2) + append to managed_repos.txt (kept
#                                 # for the ~30 shell consumers not yet migrated)
#   myai scan <dir> --max-depth N  # search depth (default 4)
#   myai scan <dir> --no-rag     # skip RAG seeding (cards only)
#   myai scan <dir> --no-cards   # skip card upsert (RAG only)
#   myai scan <dir> --dry-run    # discover + print table, NO gateway writes
#   myai scan <dir> --json       # machine-readable JSON instead of a table
#
# Skips vendored/build dirs (node_modules, vendor, .venv, __pycache__, .next, …)
# and does not descend into .git internals.
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp)
# Colours follow AI_RULES §13 — orange = good (never green), yellow = warn,
# red = bad, cyan = info. bash 3.2-safe (macOS default bash).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── colours (AI_RULES §13: never green) ───────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
c_info() { printf '  %s•%s %s\n' "$CYAN" "$RESET" "$1"; }

# ── stack detection (pure helpers — no args, no env, no gateway) ──────────────
# detect_stack DIR → comma-joined stack labels ("Next.js,React,TypeScript", …).
detect_stack() {
  local r="$1" stack=""
  if [ -f "$r/package.json" ]; then
    grep -q '"next"' "$r/package.json" 2>/dev/null && stack="${stack}Next.js,"
    grep -q '"express"' "$r/package.json" 2>/dev/null && stack="${stack}Express,"
    grep -q '"react"' "$r/package.json" 2>/dev/null && stack="${stack}React,"
    [ -z "$stack" ] && stack="${stack}Node,"
  fi
  [ -f "$r/tsconfig.json" ] && stack="${stack}TypeScript,"
  { [ -f "$r/requirements.txt" ] || [ -f "$r/pyproject.toml" ] || ls "$r"/*.py >/dev/null 2>&1; } && stack="${stack}Python,"
  [ -f "$r/go.mod" ] && stack="${stack}Go,"
  ls "$r"/docker-compose*.y*ml >/dev/null 2>&1 && stack="${stack}Docker,"
  [ -f "$r/Dockerfile" ] && case "$stack" in *Docker*) ;; *) stack="${stack}Docker,";; esac
  echo "${stack%,}"
}
# local_port DIR → http://localhost:<first-published-compose-port> (or nothing).
local_port() {
  local r="$1" compose port
  compose="$(ls "$r"/docker-compose*.y*ml 2>/dev/null | head -1 || true)"
  [ -n "$compose" ] || return 0
  port="$(grep -oE '"?[0-9]{2,5}:[0-9]{2,5}"?' "$compose" 2>/dev/null | head -1 | tr -d '"' | cut -d: -f1 || true)"
  [ -n "$port" ] && echo "http://localhost:$port"
}

# Sourced for tests (scripts/tests/e2e_init_external_repos.sh) — stop before the
# executable body so detect_stack/local_port can be exercised against arbitrary
# repos without spidering $PWD or touching the gateway (mirrors MYAI_INIT_LIB_ONLY
# in myai_init.sh).
[ "${MYAI_SCAN_LIB_ONLY:-0}" = 1 ] && return 0 2>/dev/null

# ── gateway token (host→gateway escape hatch, ADR-010) ────────────────────────
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

# ── args ──────────────────────────────────────────────────────────────────────
DIR=""; MAX_DEPTH=4; DO_REGISTER=0; DO_RAG=1; DO_CARDS=1; DRY_RUN=0; AS_JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-depth) shift; MAX_DEPTH="${1:?--max-depth needs a number}";;
    --register)  DO_REGISTER=1;;
    --no-rag)    DO_RAG=0;;
    --no-cards)  DO_CARDS=0;;
    --dry-run)   DRY_RUN=1;;
    --json)      AS_JSON=1;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    -*)          echo "myai scan: unknown flag: $1" >&2; exit 2;;
    *)           [ -z "$DIR" ] && DIR="$1" || { echo "myai scan: unexpected arg: $1" >&2; exit 2; };;
  esac; shift
done
DIR="${DIR:-$PWD}"
# Expand ~ and resolve to an absolute path.
DIR="${DIR/#\~/$HOME}"
if [ ! -d "$DIR" ]; then echo "myai scan: not a directory: $DIR" >&2; exit 2; fi
DIR="$(cd "$DIR" && pwd)"

[ "$AS_JSON" = 1 ] || {
  printf '%s%smyai scan%s %s%s\n' "$BOLD" "$ORANGE" "$RESET" "$DIR" ""
  c_info "max-depth=$MAX_DEPTH  register=$DO_REGISTER  rag=$DO_RAG  cards=$DO_CARDS  dry-run=$DRY_RUN"
}

# ── spider: find every git repo, skipping vendored/build dirs ─────────────────
# `-name .git -print -prune` prints the .git entry (dir or file) without
# descending into it; the vendored dirs are pruned before we ever reach them.
PRUNE='( -name node_modules -o -name vendor -o -name bower_components -o -name .venv -o -name venv -o -name __pycache__ -o -name .next -o -name .nuxt -o -name .turbo -o -name .cache -o -name .terraform -o -name dist-newstyle )'
# shellcheck disable=SC2086
GIT_PATHS="$(find "$DIR" -maxdepth "$MAX_DEPTH" \( $PRUNE \) -prune -o -name .git -print -prune 2>/dev/null || true)"

REPO_ROOTS=""
if [ -n "$GIT_PATHS" ]; then
  REPO_ROOTS="$(printf '%s\n' "$GIT_PATHS" | while IFS= read -r g; do [ -n "$g" ] && dirname "$g"; done | sort -u)"
fi

if [ -z "$REPO_ROOTS" ]; then
  [ "$AS_JSON" = 1 ] && echo '{"dir":"'"$DIR"'","count":0,"gatewayReachable":false,"dryRun":'"$([ "$DRY_RUN" = 1 ] && echo true || echo false)"',"repos":[]}' || c_warn "No git repositories found under $DIR"
  exit 0
fi

COUNT="$(printf '%s\n' "$REPO_ROOTS" | grep -c . || true)"
[ "$AS_JSON" = 1 ] || c_ok "discovered $COUNT git repo(s)"

# ── build a JSON array of repo metadata (host-side derivation) ─────────────────
META_JSON="$(
  python3 - <<'PYEOF' "$DIR" "$REPO_ROOTS"
import json, os, subprocess, sys
base, roots_blob = sys.argv[1], sys.argv[2]
def git(root, *args):
    try:
        return subprocess.run(["git","-C",root,*args], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""
repos = []
for root in [r for r in roots_blob.splitlines() if r.strip()]:
    name = os.path.basename(root.rstrip("/")) or root
    branch = git(root,"rev-parse","--abbrev-ref","HEAD") or "?"
    last = (git(root,"log","-1","--pretty=%h %s") or "no commits")[:70]
    dirty = git(root,"status","--porcelain")
    dirty_n = len([l for l in dirty.splitlines() if l.strip()]) if dirty else 0
    remote = git(root,"remote","get-url","origin")
    ai = os.path.isdir(os.path.join(root,"AI")) or os.path.isfile(os.path.join(root,"CLAUDE.md"))
    repos.append({"name":name,"path":root,"branch":branch,"last":last,
                  "dirty":dirty_n,"remote":remote,"aiInstalled":ai})
print(json.dumps({"dir":base,"repos":repos}))
PYEOF
)"

# Add stack/localUrl per-repo via the bash detectors (loop, append into JSON).
ENRICHED="["
first=1
while IFS= read -r root; do
  [ -n "$root" ] || continue
  name="$(basename "$root")"
  stack="$(detect_stack "$root")"
  lurl="$(local_port "$root" || true)"
  meta="$(python3 - "$META_JSON" "$root" "$stack" "$lurl" <<'PYEOF'
import json, sys
d = json.loads(sys.argv[1]); root, stack, lurl = sys.argv[2], sys.argv[3], sys.argv[4]
r = next((x for x in d["repos"] if x["path"] == root), None) or {"name": root.rsplit("/",1)[-1], "path": root}
r["stack"] = stack
if lurl: r["localhostUrl"] = lurl
print(json.dumps(r))
PYEOF
)"
  [ "$first" = 1 ] && first=0 || ENRICHED="$ENRICHED,"
  ENRICHED="$ENRICHED$meta"
done <<< "$REPO_ROOTS"
ENRICHED="$ENRICHED]"

# ── register into managed_repos.txt (idempotent) ──────────────────────────────
REGISTERED=0
if [ "$DO_REGISTER" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  MR="$REPO_ROOT/config/managed_repos.txt"
  if [ -f "$MR" ]; then
    # Build a set of existing absolute paths (expand ~).
    added=0
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      # Skip the master repo itself.
      [ "$root" = "$REPO_ROOT" ] && continue
      # Already listed (compare expanded)?
      if grep -vE '^\s*#|^\s*$' "$MR" | sed "s#^~#$HOME#" | grep -qxF "$root"; then continue; fi
      printf '%s\n' "$root" >> "$MR"
      added=$((added+1))
    done <<< "$REPO_ROOTS"
    REGISTERED=$added
    [ "$AS_JSON" = 1 ] || c_ok "registered $added new repo(s) in config/managed_repos.txt"
  else
    [ "$AS_JSON" = 1 ] || c_warn "config/managed_repos.txt not found — skipped --register"
  fi
fi

# ── gateway writes: card upsert + RAG seed ────────────────────────────────────
GW_OK=0
if [ "$DRY_RUN" = 0 ] && { [ "$DO_CARDS" = 1 ] || [ "$DO_RAG" = 1 ]; }; then
  if curl -sf -o /dev/null "${GATEWAY_MCP%/mcp}/health" 2>/dev/null; then
    GW_OK=1
  else
    [ "$AS_JSON" = 1 ] || c_warn "gateway not reachable at $GATEWAY_MCP — cards/RAG skipped (run 'myai up')"
  fi
fi

# One python pass does all MCP calls + renders the final result.
python3 - <<'PYEOF' "$ENRICHED" "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN" "$GW_OK" "$DO_CARDS" "$DO_RAG" "$DRY_RUN" "$AS_JSON" "$DIR" "$DO_REGISTER"
import json, os, sys, urllib.request

enriched, mcp, token, gw_ok, do_cards, do_rag, dry, as_json, base, do_register = sys.argv[1:11]
repos = json.loads(enriched)
gw_ok = gw_ok == "1"; do_cards = do_cards == "1"; do_rag = do_rag == "1"
dry = dry == "1"; as_json = as_json == "1"; do_register = do_register == "1"

ORANGE="\033[1;38;5;208m"; YELLOW="\033[38;5;220m"; RED="\033[38;5;196m"
CYAN="\033[38;5;45m"; DIM="\033[2m"; BOLD="\033[1m"; RESET="\033[0m"

def call(name, args):
    body = json.dumps({"jsonrpc":"2.0","method":"tools/call","id":1,
                       "params":{"name":name,"arguments":args}}).encode()
    req = urllib.request.Request(mcp, data=body, headers={
        "content-type":"application/json","x-gateway-local-token":token})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read().decode())
    if "error" in d: raise RuntimeError(d["error"])
    txt = d["result"]["content"][0]["text"]
    try: return json.loads(txt)
    except Exception: return {"raw": txt}

# Existing cards: only NEW repos get full discovered metadata; already-curated
# cards get a status-only refresh so we never clobber a real description/group.
existing = set()
if gw_ok and do_cards:
    try:
        cl = call("repos_card_list", {})
        for c in (cl.get("cards") if isinstance(cl, dict) else cl) or []:
            if isinstance(c, dict) and c.get("repoName"): existing.add(c["repoName"])
    except Exception:
        pass  # treat as no existing cards — upsert creates them

for r in repos:
    r["carded"] = False; r["seeded"] = False; r["newCard"] = False; r["registered"] = False; r["err"] = None
    if dry or not gw_ok:
        continue
    desc = (f"{r.get('stack') or 'repo'} project" + (" · AI framework installed" if r.get("aiInstalled") else "")).strip()
    try:
        # ADR-021 Phase 2: self-register into the caller's tenant `repos` DB
        # roster (tenantId resolved server-side from the gateway token) — this
        # is what makes a NEW user's scanned repos show up under their own
        # account instead of the shared managed_repos.txt.
        if do_register:
            call("repos_upsert", {
                "name": r["name"], "path": r["path"],
                "gitRemote": r.get("remote") or None,
                "stack": [s for s in (r.get("stack") or "").split(",") if s],
                "source": "scan",
            })
            r["registered"] = True
        if do_cards:
            level = "ok" if r.get("dirty",0)==0 else "warn"
            # Status-only refresh for known cards; full metadata only for NEW repos.
            card = {"repoName": r["name"], "reportedBy": "myai-scan",
                    "lastStatus": f"branch={r.get('branch','?')} · last: {r.get('last','')} · uncommitted={r.get('dirty',0)}",
                    "lastStatusLevel": level}
            if r["name"] not in existing:
                card["description"] = desc
                card["group"] = "discovered"
                if r.get("localhostUrl"): card["localhostUrl"] = r["localhostUrl"]
                r["newCard"] = True
            call("repos_card_upsert", card)
            r["carded"] = True
        if do_rag:
            content = (f"Repository '{r['name']}' discovered by myai scan under {base}. "
                       f"Stack: {r.get('stack') or 'unknown'}. Path: {r['path']}. "
                       f"Branch: {r.get('branch','?')}. Remote: {r.get('remote') or 'none'}. "
                       f"AI framework installed: {bool(r.get('aiInstalled'))}.")
            call("memory_store", {"content": content, "repo": r["name"], "source": "code",
                                  "tags": ["repo-discovery","myai-scan"]})
            r["seeded"] = True
    except Exception as e:
        r["err"] = str(e)[:120]

if as_json:
    print(json.dumps({"dir": base, "count": len(repos),
                      "gatewayReachable": gw_ok, "dryRun": dry, "repos": repos}))
    sys.exit(0)

# ── pretty summary table ──────────────────────────────────────────────────────
def trunc(s, n): s = s or ""; return s if len(s) <= n else s[:n-1]+"…"
hdr = ["#","REPO","STACK","BRANCH","REG"]
rows = []
for i, r in enumerate(repos, 1):
    if dry:           reg = "dry-run"
    elif r["err"]:    reg = "err"
    elif not gw_ok:   reg = "gw-down"
    else:
        bits = []
        if do_register: bits.append("db" if r["registered"] else "·")
        if do_cards: bits.append("card" if r["carded"] else "·")
        if do_rag:   bits.append("rag"  if r["seeded"] else "·")
        reg = "+".join(bits) if bits else "skip"
    rows.append([str(i), trunc(r["name"],26), trunc(r.get("stack") or "-",24),
                 trunc(r.get("branch","?"),16), reg])

widths = [max(len(hdr[c]), *(len(row[c]) for row in rows)) for c in range(len(hdr))]
def fmt(cells, color=""):
    line = "  ".join(c.ljust(widths[i]) for i, c in enumerate(cells))
    return f"{color}{line}{RESET}" if color else line
print()
print(fmt(hdr, BOLD+CYAN))
print(DIM + "  ".join("-"*w for w in widths) + RESET)
for r, row in zip(repos, rows):
    color = RED if r["err"] else ""
    print(fmt(row, color))
    if r["err"]:
        print(f"    {RED}↳ {r['err']}{RESET}")
print()
seeded = sum(1 for r in repos if r["seeded"]); carded = sum(1 for r in repos if r["carded"])
dbreg = sum(1 for r in repos if r["registered"])
errs = sum(1 for r in repos if r["err"])
if dry:
    print(f"{CYAN}dry-run:{RESET} {len(repos)} repo(s) discovered — no gateway writes.")
elif not gw_ok:
    print(f"{YELLOW}gateway offline:{RESET} {len(repos)} discovered, 0 registered. Start it with 'myai up'.")
else:
    msg = f"{ORANGE}done:{RESET} {len(repos)} discovered"
    if do_register: msg += f", {dbreg} DB-registered"
    if do_cards: msg += f", {carded} card(s)"
    if do_rag:   msg += f", {seeded} RAG seed(s)"
    if errs:     msg += f", {RED}{errs} error(s){RESET}"
    print(msg + " → dashboard /directory")
PYEOF
