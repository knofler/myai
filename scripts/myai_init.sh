#!/usr/bin/env bash
# myai_init.sh — the `myai init <path>` Day-2 wrapper.
#
# TWO MODES (ADR-016 §0.2/§0.3, plan MYAI_INIT_ONE_COMMAND_PLAN.md S-INIT-2):
#
#   • GREENFIELD (default for any end-user git repo) — drop ONLY a ~30-line kernel
#     CLAUDE.md + a gitignored .myai-local pointer, and append the .myai-local
#     ignore rule to .gitignore. NO AI/ folder is scaffolded: agents/skills/hooks/
#     rules resolve at runtime from the installed ai-management module,
#     and all state/history/identity lives in the brain + gateway. Also
#     self-registers the repo in the gateway's tenant `repos` roster and seeds
#     one initial P3 onboarding task (`tasks_create`, sourceId
#     "myai-init-seed") when the gateway is reachable — both non-blocking and
#     idempotent, so a fresh repo lands with a roster entry + a first concrete
#     next-step instead of nothing. Idempotent overall — re-init never clobbers
#     a user-edited CLAUDE.md (guarded by --force).
#
#   • MANAGED / MASTER (legacy AI/-scaffold) — the fat scaffold used by the
#     operator's fleet + master repo. Triggered by --managed, by master-repo
#     auto-detect, or when the target already carries an AI/ folder (an existing
#     managed repo re-init). Scaffolds AI/ via init_ai.sh, then drops a portable,
#     self-contained docker-compose stack + .env template and runs the guided
#     first-run wizard (on a TTY). This path is unchanged from before.
#
# TRY_MYAI_REQUIRES: --managed
# (2026-07-16 EXO dogfood gap) TRY_MYAI.md's walkthrough scaffolds+runs the
# legacy AI/ portable stack (docker-compose + .env) that its `myai up`/`down`
# steps assume — since GREENFIELD is now the default and drops no AI/ folder,
# the doc's `myai init` example must always pass --managed or the rest of the
# walkthrough breaks. scripts/check_try_myai_drift.sh enforces this marker.
#
# Idempotent re-init (managed): never clobbers existing project state — AI/.env
# and the repo's own docker-compose.yml (if any) are left untouched; the
# framework-owned stack template (AI/docker-compose.myai.yml) and AI/.env.example
# are refreshed.
#
# Guided first-run wizard (managed path, Independent Edition): when stdin is a TTY
# (and --no-wizard is not passed) `myai init` walks a fresh operator through the
# three things a self-hosted install needs — an ANTHROPIC_API_KEY, an
# edition/profile, and an optional directory to scan — writing the answers into
# AI/.env. Skipped silently in non-interactive contexts. Force it with --wizard.
#
# Zero-prompt (2026-07-16 EXO dogfood gap): the TTY auto-detect above only
# catches a genuinely non-interactive stdin — a scripted/headless caller that
# still has a pty attached (common for agent/CI runners) sees `[ -t 0 ]` as
# true and gets prompted anyway (both the guided wizard AND the brain
# bootstrap's first-run "private remote?" prompt in lib/myai_config.sh). Pass
# --zero-prompt (or export MYAI_ZERO_PROMPT=1 as a standing operator default)
# to force both off regardless of TTY state — never blocks on stdin.
#
# Usage: myai init <path> [--managed|--greenfield] [--force]
#                         [--wizard|--no-wizard] [--zero-prompt]
#    (or:  bash scripts/myai_init.sh <path> [flags])
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$REPO_ROOT/templates"

# ── Colours (no green — operator can't read it; AI_RULES §13) ─────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }

# ── set_env_var FILE KEY VALUE ────────────────────────────────────────────────
# Replace `KEY=...` in FILE if present, else append it. Value is written verbatim
# (no quoting) to match the comment-free contract of env.portable.example.
set_env_var() {
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || return 0
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    # awk rewrite (no sed -i — keeps it portable across GNU/BSD).
    awk -v k="$key" -v v="$value" '
      $0 ~ "^" k "=" { print k "=" v; next } { print }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ── edition_from_profile RAW → "edition require_login" ────────────────────────
# Maps the wizard's free-text profile answer to (edition, REQUIRE_LOGIN). Anything
# that isn't an explicit team choice defaults to the self-hosted independent edition.
edition_from_profile() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    team|t) printf 'team true\n' ;;
    *)      printf 'independent false\n' ;;
  esac
}

# ── slugify_ns NAME → collision-safe brain-namespace slug ─────────────────────
# Lower-case, replace any run of disallowed chars with '-', trim leading/trailing
# separators, and ensure it starts with [a-z0-9] (matches the .myai-local schema
# pattern ^[a-z0-9][a-z0-9._-]*$). Empty/degenerate input falls back to 'repo'.
slugify_ns() {
  local raw slug
  raw="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  slug="$(printf '%s' "$raw" | sed -e 's/[^a-z0-9._-]\{1,\}/-/g' -e 's/^[-._]\{1,\}//' -e 's/[-._]\{1,\}$//')"
  [ -n "$slug" ] || slug="repo"
  # Guarantee a valid leading char.
  case "$slug" in [a-z0-9]*) : ;; *) slug="r-$slug" ;; esac
  printf '%s' "$slug"
}

# ── is_kernel_claude FILE → 0 if FILE is a myAI kernel CLAUDE.md ───────────────
# The kernel's first heading is a stable marker ("# myAI kernel"). A user-edited
# or app-authored CLAUDE.md will not carry it, so this distinguishes "our pointer,
# safe to refresh" from "the user's file, never clobber".
is_kernel_claude() {
  [ -f "$1" ] || return 1
  head -n 3 "$1" 2>/dev/null | grep -qE '^#[[:space:]]+myAI kernel'
}

# ── is_master_repo DIR → 0 if DIR is the fat master/control-plane repo ─────────
# The master carries fleet tooling no end-user repo has: update_all.sh +
# managed_repos.txt + the CLAUDE template. Auto-detecting it keeps `myai init`
# from ever slimming the control plane (ADR-016 §0.3).
is_master_repo() {
  [ -f "$1/scripts/update_all.sh" ] && [ -f "$1/config/managed_repos.txt" ] \
    && [ -f "$1/templates/CLAUDE_TEMPLATE.md" ]
}

# Sourced for unit tests (scripts/tests/test_myai_init_wizard.sh) — stop before the
# executable body so the helpers above can be exercised without running init_ai.sh.
[ "${MYAI_INIT_LIB_ONLY:-0}" = 1 ] && return 0 2>/dev/null

# ── Parse args: first non-flag is the target path; collect mode/wizard flags ──
TARGET=""
WIZARD="auto"   # auto → on when interactive; --wizard forces; --no-wizard off
MODE="auto"     # auto → greenfield unless master/managed detected; --managed / --greenfield force
FORCE=0         # --force allows overwriting a NON-kernel (user-edited) CLAUDE.md
ZERO_PROMPT=0   # --zero-prompt (or env MYAI_ZERO_PROMPT=1): never block on stdin
for arg in "$@"; do
  case "$arg" in
    --wizard)      WIZARD="on" ;;
    --no-wizard)   WIZARD="off" ;;
    --managed)     MODE="managed" ;;
    --greenfield)  MODE="greenfield" ;;
    --force)       FORCE=1 ;;
    --zero-prompt) ZERO_PROMPT=1 ;;
    -*)            : ;;  # ignore unknown flags (forward-compat)
    *)             [ -z "$TARGET" ] && TARGET="$arg" ;;
  esac
done

# Env-based operator default (e.g. a scripted/headless caller that always wants
# this) counts the same as passing --zero-prompt on every invocation.
[ "${MYAI_ZERO_PROMPT:-0}" = 1 ] && ZERO_PROMPT=1

# Zero-prompt wins over --wizard: force the guided wizard off AND make the
# brain bootstrap's first-run prompt (lib/myai_config.sh _myai_interactive)
# non-interactive too, so neither path can block on stdin regardless of TTY.
if [ "$ZERO_PROMPT" = 1 ]; then
  WIZARD="off"
  export MYAI_NONINTERACTIVE=1
fi

if [ -z "$TARGET" ]; then
  echo "Error: myai init requires a target path." >&2
  echo "Usage: myai init <path> [--managed|--greenfield] [--force] [--wizard|--no-wizard] [--zero-prompt]" >&2
  exit 1
fi

mkdir -p "$TARGET"
ABS_TARGET="$(cd "$TARGET" && pwd)"

# ── Decide the mode ───────────────────────────────────────────────────────────
# Default is GREENFIELD (kernel-only). Fall back to the legacy AI/-scaffold only
# for: an explicit --managed, the fat master repo (auto-detect, ADR-016 §0.3), or
# a repo that already carries an AI/ folder (an existing managed repo re-init).
if [ "$MODE" = "auto" ]; then
  if is_master_repo "$ABS_TARGET" || [ -d "$ABS_TARGET/AI" ]; then
    MODE="managed"
  else
    MODE="greenfield"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# GREENFIELD MODE — kernel CLAUDE.md + gitignored .myai-local, no AI/ folder.
# ══════════════════════════════════════════════════════════════════════════════
if [ "$MODE" = "greenfield" ]; then
  KERNEL_SRC="$TEMPLATES_DIR/CLAUDE_KERNEL.md"
  LOCAL_EXAMPLE="$TEMPLATES_DIR/myai-local.example"
  CLAUDE_DST="$ABS_TARGET/CLAUDE.md"
  LOCAL_DST="$ABS_TARGET/.myai-local"
  GITIGNORE="$ABS_TARGET/.gitignore"

  if [ ! -f "$KERNEL_SRC" ]; then
    echo "Error: kernel template not found: $KERNEL_SRC" >&2
    exit 1
  fi

  echo "==> myai init (greenfield) → $ABS_TARGET"

  # 1. Kernel CLAUDE.md — write when absent; refresh a kernel in place; never
  #    clobber a user-edited/app CLAUDE.md unless --force.
  if [ ! -f "$CLAUDE_DST" ]; then
    cp "$KERNEL_SRC" "$CLAUDE_DST"
    c_ok "Wrote kernel CLAUDE.md"
  elif is_kernel_claude "$CLAUDE_DST"; then
    if cmp -s "$KERNEL_SRC" "$CLAUDE_DST"; then
      c_info "CLAUDE.md kernel already current — left untouched"
    else
      cp "$KERNEL_SRC" "$CLAUDE_DST"
      c_ok "Refreshed kernel CLAUDE.md"
    fi
  elif [ "$FORCE" = 1 ]; then
    cp "$KERNEL_SRC" "$CLAUDE_DST"
    c_warn "Overwrote existing non-kernel CLAUDE.md (--force)"
  else
    c_warn "CLAUDE.md exists and is not a myAI kernel — left untouched (re-run with --force to replace)"
  fi

  # 2. First-run brain bootstrap (S-INIT-3, ADR-016 §0.1/§0.4). Ensures the
  #    one-per-user brain exists at ~/.myai/brain BEFORE we register this repo's
  #    namespace into it (S-INIT-4): creates it on the first-ever run (offering a
  #    PRIVATE remote on a TTY), auto-clones it on a later machine that only
  #    carries ~/.myai/config, and persists the remote+dir in ~/.myai/config so
  #    every machine converges on the same brain. Never wires THIS repo's code
  #    remote as the brain remote. Non-fatal to init. Skip with
  #    MYAI_SKIP_BRAIN_BOOTSTRAP=1 (e.g. the managed/master path, which owns its
  #    brain wiring separately).
  if [ "${MYAI_SKIP_BRAIN_BOOTSTRAP:-0}" != 1 ]; then
    # shellcheck source=lib/myai_config.sh
    . "$SCRIPT_DIR/lib/myai_config.sh"
    myai_brain_bootstrap "$ABS_TARGET" || true
  fi

  # 3. Namespace (S-INIT-4). Register repos/<ns>/ in the brain (idempotent,
  #    collision-safe) and record the resolved id in .myai-local. An existing
  #    .myai-local namespace is AUTHORITATIVE — read it and honor it verbatim so
  #    re-init never renames; a brand-new repo derives from the folder name and
  #    disambiguates against any same-named sibling already in the brain. The id
  #    is brain-canonical, so context_boot in this repo resolves straight to
  #    repos/<ns>/brief.md on brain main.
  # shellcheck source=lib/myai_ns.sh
  . "$SCRIPT_DIR/lib/myai_ns.sh"
  PINNED_NS=""
  if [ -f "$LOCAL_DST" ]; then
    PINNED_NS="$(grep -oE '"namespace"[[:space:]]*:[[:space:]]*"[^"]+"' "$LOCAL_DST" 2>/dev/null \
      | head -1 | sed -E 's/.*"namespace"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  fi
  NS="$(myai_ns_register "$ABS_TARGET" "$(basename "$ABS_TARGET")" "$PINNED_NS")"

  # 4. .myai-local — gitignored pointer. Written only when absent (idempotent:
  #    a later run keeps the recorded namespace, which step 3 just re-registered).
  #    Blurb references the resolved namespace id.
  if [ ! -f "$LOCAL_DST" ]; then
    if [ -f "$LOCAL_EXAMPLE" ]; then
      # Fill namespace/repo/blurb from the example; keep the gateway hint.
      awk -v ns="$NS" '
        /"namespace"[[:space:]]*:/ { printf "  \"namespace\": \"%s\",\n", ns; next }
        /"repo"[[:space:]]*:/      { printf "  \"repo\": \"%s\",\n", ns; next }
        /"blurb"[[:space:]]*:/     { printf "  \"blurb\": \"myAI repo pointer — brain namespace '\''%s'\''. Full identity/state loads via context_boot; this is the degraded-boot cache.\"\n", ns; next }
        { print }
      ' "$LOCAL_EXAMPLE" > "$LOCAL_DST"
    else
      # Minimal valid pointer if the example is missing.
      printf '{\n  "version": 1,\n  "namespace": "%s",\n  "repo": "%s",\n  "gateway": "http://localhost:3100"\n}\n' "$NS" "$NS" > "$LOCAL_DST"
    fi
    c_ok ".myai-local written (namespace: $NS)"
  else
    c_info ".myai-local already exists (namespace: $NS) — left untouched"
  fi

  # 5. .gitignore — append the ignore rule once (idempotent).
  if [ -f "$GITIGNORE" ] && grep -qxF '.myai-local' "$GITIGNORE" 2>/dev/null; then
    c_info ".gitignore already ignores .myai-local"
  else
    # Ensure a trailing newline before appending (command-sub strips a final
    # newline → empty means the file already ends cleanly).
    [ -f "$GITIGNORE" ] && [ -n "$(tail -c1 "$GITIGNORE" 2>/dev/null)" ] && printf '\n' >> "$GITIGNORE"
    printf '# myAI per-repo pointer (identity/gateway hint + degraded-boot cache) — never committed\n.myai-local\n' >> "$GITIGNORE"
    c_ok "Appended .myai-local rule to .gitignore"
  fi

  # 5b. .claude/settings.json — framework-as-module safety wiring (S-INIT-5,
  #     ADR-016 §0.5). Wires the PreToolUse safety hooks (block-push-main,
  #     secret-scan, protected-files, no-local-npm) to resolve from the installed
  #     module via `myai root` at hook-exec time. The hook BODIES stay in the
  #     module — this is the ONLY per-repo pointer, and it fails loud (blocks the
  #     tool) if the module can't be resolved, so a kernel-only repo never runs
  #     without its safety rails. Idempotent: refresh our own wiring in place,
  #     never clobber a user-authored settings.json.
  SETTINGS_SRC="$TEMPLATES_DIR/settings.kernel.json"
  CLAUDE_DIR="$ABS_TARGET/.claude"
  SETTINGS_DST="$CLAUDE_DIR/settings.json"
  if [ -f "$SETTINGS_SRC" ]; then
    mkdir -p "$CLAUDE_DIR"
    if [ ! -f "$SETTINGS_DST" ]; then
      cp "$SETTINGS_SRC" "$SETTINGS_DST"
      c_ok "Wrote .claude/settings.json (module safety hooks via 'myai root')"
    elif grep -q 'myAI kernel settings' "$SETTINGS_DST" 2>/dev/null; then
      if cmp -s "$SETTINGS_SRC" "$SETTINGS_DST"; then
        c_info ".claude/settings.json kernel wiring already current — left untouched"
      else
        cp "$SETTINGS_SRC" "$SETTINGS_DST"
        c_ok "Refreshed .claude/settings.json kernel wiring"
      fi
    else
      c_warn ".claude/settings.json exists and is not myAI kernel wiring — left untouched"
    fi
  fi

  # 5c. .mcp.json — MCP server config from the module's bundled template
  #     (ADR-016 follow-up 2026-07-21: retire update_all as the propagation path
  #     for .mcp.json). Unlike agents/hooks/rules, Claude Code reads a
  #     project-local .mcp.json from DISK at startup — it is NOT resolved from
  #     the module at runtime — so it cannot be a bare pointer; the file itself
  #     must exist in the repo. `myai init` writes it here from templates/mcp.json
  #     and DEEP-MERGES on re-init (json_merge.py): framework-owned servers
  #     (myai/context7/…) stay canonical while any custom servers the
  #     user added survive. Propagation therefore flows through `npm i -g` +
  #     `myai init` (or `myai mcp repo`) — no file-copy from a master checkout.
  MCP_SRC="$TEMPLATES_DIR/mcp.json"
  MCP_DST="$ABS_TARGET/.mcp.json"
  if [ -f "$MCP_SRC" ]; then
    _mcp_rc=0
    _mcp_out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$MCP_DST" "$MCP_SRC" 2>&1) || _mcp_rc=$?
    case "${_mcp_rc}:${_mcp_out}" in
      0:created)   c_ok ".mcp.json written from module template" ;;
      0:changed)   c_ok ".mcp.json refreshed (framework servers canonical, custom preserved)" ;;
      0:unchanged) c_info ".mcp.json already current — left untouched" ;;
      *)           c_warn ".mcp.json left untouched ($_mcp_out)" ;;
    esac
  fi

  # 5d. Self-register into the caller's tenant `repos` DB roster (ADR-021
  #     Phase 2) via the gateway's `repos_upsert` MCP tool — tenantId is
  #     resolved server-side from the caller's credential, so this repo lands
  #     under its OWNER's account instead of the shared managed_repos.txt.
  #     Non-blocking: gateway unreachable (first run before `myai up`, CI,
  #     offline) just skips it — re-running `myai init` later self-heals it.
  GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
  # shellcheck source=lib/gateway.sh
  . "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
  if curl -sf -o /dev/null "${GATEWAY_MCP%/mcp}/health" 2>/dev/null; then
    GIT_REMOTE="$(git -C "$ABS_TARGET" remote get-url origin 2>/dev/null || true)"
    _reg_rc=0
    _reg_out=$(python3 - "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN" "$(basename "$ABS_TARGET")" "$ABS_TARGET" "$NS" "$GIT_REMOTE" <<'PYEOF' 2>&1
import json, sys, urllib.request
mcp, token, name, path, ns, remote = sys.argv[1:7]
args = {"name": name, "path": path, "brainNamespace": ns, "source": "myai-init"}
if remote:
    args["gitRemote"] = remote
body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                    "params": {"name": "repos_upsert", "arguments": args}}).encode()
req = urllib.request.Request(mcp, data=body, headers={
    "content-type": "application/json", "x-gateway-local-token": token})
with urllib.request.urlopen(req, timeout=10) as r:
    d = json.loads(r.read().decode())
if "error" in d:
    raise RuntimeError(d["error"])
print("ok")
PYEOF
) || _reg_rc=$?
    if [ "$_reg_rc" = 0 ]; then
      c_ok "Self-registered in fleet roster (DB, tenant-scoped)"
    else
      c_warn "Fleet-roster self-registration failed: $_reg_out"
    fi
  else
    c_info "Gateway not reachable — skipped fleet-roster self-registration (run 'myai up' then re-run 'myai init')"
  fi

  # 5e. Seed an initial onboarding "plan" — one P3 task in the fleet queue for
  #     this repo (`tasks_create`) so a brand-new repo lands with a first,
  #     concrete next-step instead of an empty queue. Idempotent: a task with
  #     sourceId "myai-init-seed" is created at most once per repo (checked via
  #     `tasks_list` first) — re-init never duplicates it. Non-blocking, same
  #     as 5d: an unreachable gateway just skips it (self-heals on next init).
  if curl -sf -o /dev/null "${GATEWAY_MCP%/mcp}/health" 2>/dev/null; then
    _seed_rc=0
    _seed_out=$(python3 - "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN" "$(basename "$ABS_TARGET")" <<'PYEOF' 2>&1
import json, sys, urllib.request

mcp, token, name = sys.argv[1:4]
SEED_ID = "myai-init-seed"

def call(tool, args):
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                        "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(mcp, data=body, headers={
        "content-type": "application/json", "x-gateway-local-token": token})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.loads(r.read().decode())
    if "error" in d:
        raise RuntimeError(d["error"])
    text = d.get("result", {}).get("content", [{}])[0].get("text", "{}")
    parsed = json.loads(text) if text else {}
    if isinstance(parsed, dict) and parsed.get("error"):
        raise RuntimeError(parsed["error"])
    return parsed

existing = call("tasks_list", {"repo": name, "limit": 50})
tasks = existing.get("tasks", []) if isinstance(existing, dict) else []
if any(t.get("sourceId") == SEED_ID for t in tasks):
    print("skipped-existing")
else:
    call("tasks_create", {
        "repo": name,
        "title": f"Onboard {name} into myAI",
        "description": (
            "Auto-seeded by `myai init`: open this repo in your agent and run "
            "`agent mode` to confirm it boots from the brain via context_boot, "
            "then replace this placeholder with real work."
        ),
        "priority": "P3",
        "source": "manual",
        "sourceId": SEED_ID,
    })
    print("created")
PYEOF
) || _seed_rc=$?
    case "${_seed_rc}:${_seed_out}" in
      0:created)          c_ok "Seeded initial onboarding plan (task in fleet queue)" ;;
      0:skipped-existing) c_info "Initial onboarding plan already seeded — left untouched" ;;
      *)                  c_warn "Initial plan seed failed: $_seed_out" ;;
    esac
  else
    c_info "Gateway not reachable — skipped initial plan seed (run 'myai up' then re-run 'myai init')"
  fi

  # 6. Commit the kernel + .gitignore + settings + .mcp.json (tolerant;
  #    .myai-local is gitignored so it is never committed). A clean re-init has
  #    nothing staged.
  if git -C "$ABS_TARGET" rev-parse --git-dir >/dev/null 2>&1; then
    # Stage each artifact individually and only when it exists: `git add` with
    # ANY missing pathspec stages NOTHING (fatal, rc=128), and .mcp.json is
    # legitimately absent on a python3-free clean box (json_merge.py needs
    # python3) — one missing file must not silently skip the whole init commit
    # and leave the target repo dirty (found by e2e_init_external_repos.sh).
    for _f in CLAUDE.md .gitignore .claude/settings.json .mcp.json; do
      [ -e "$ABS_TARGET/$_f" ] && git -C "$ABS_TARGET" add "$_f" 2>/dev/null || true
    done
    if ! git -C "$ABS_TARGET" diff --cached --quiet 2>/dev/null; then
      git -C "$ABS_TARGET" commit -m "chore(myai): add kernel CLAUDE.md + .claude/settings.json + .mcp.json + gitignore .myai-local" >/dev/null 2>&1 || true
      c_ok "Committed kernel CLAUDE.md + .claude/settings.json + .mcp.json + .gitignore"
    fi
  else
    c_warn "Not a git repo — .myai-local ignore rule written but nothing committed"
  fi

  echo ""
  echo "myai init complete (greenfield) → $ABS_TARGET"
  echo "  Kernel CLAUDE.md + .mcp.json committed; .myai-local gitignored. Framework resolves from the installed module (myai root)."
  echo "  Next: open the repo in your agent and run 'agent mode' — it boots from the brain via context_boot."
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# MANAGED / MASTER MODE — legacy AI/-scaffold (unchanged).
# ══════════════════════════════════════════════════════════════════════════════

# 1. Scaffold the AI/ framework (state-preserving — see init_ai.sh guards).
echo "==> Scaffolding AI/ framework into $TARGET (managed mode)"
"$SCRIPT_DIR/init_ai.sh" "$TARGET"

# 2. Drop the portable myAI stack compose (framework-owned location — always
#    refreshed; it is a template, not project state).
if [ -f "$TEMPLATES_DIR/docker-compose.portable.yml" ]; then
  cp "$TEMPLATES_DIR/docker-compose.portable.yml" "$ABS_TARGET/AI/docker-compose.myai.yml"
  echo "==> Wrote portable stack → AI/docker-compose.myai.yml"

  # Convenience: surface it at the repo root only when the repo has no compose of
  # its own — never clobber an app's existing docker-compose.yml.
  if [ ! -f "$ABS_TARGET/docker-compose.yml" ]; then
    cp "$TEMPLATES_DIR/docker-compose.portable.yml" "$ABS_TARGET/docker-compose.yml"
    echo "==> Wrote portable stack → docker-compose.yml (repo had none)"
  else
    echo "==> Repo already has docker-compose.yml — left untouched (stack at AI/docker-compose.myai.yml)"
  fi
fi

# 3. Drop the .env template (refreshed) and create AI/.env from it only if absent
#    (idempotent — never overwrite operator secrets on re-init).
if [ -f "$TEMPLATES_DIR/env.portable.example" ]; then
  cp "$TEMPLATES_DIR/env.portable.example" "$ABS_TARGET/AI/.env.example"
  echo "==> Wrote env template → AI/.env.example"
  if [ ! -f "$ABS_TARGET/AI/.env" ]; then
    cp "$TEMPLATES_DIR/env.portable.example" "$ABS_TARGET/AI/.env"
    echo "==> Created AI/.env from template (fill in your values)"
  else
    echo "==> AI/.env already exists — left untouched"
  fi
fi

# ── Guided first-run wizard ───────────────────────────────────────────────────
run_wizard() {
  local env_file="$ABS_TARGET/AI/.env"
  [ -f "$env_file" ] || { c_warn "AI/.env not found — skipping wizard"; return 0; }

  echo
  printf '%s%smyAI guided setup%s — Independent Edition\n' "$BOLD" "$ORANGE" "$RESET"
  printf '  %sThree quick questions. Press Enter to accept the [default] / skip.%s\n' "$DIM" "$RESET"
  echo

  # 1) ANTHROPIC_API_KEY (bring-your-own; blank → use the Claude CLI login)
  local key
  printf '  %s1.%s Anthropic API key (sk-ant-…). Leave blank to use your Claude CLI login.\n' "$BOLD" "$RESET"
  printf '     key: '
  read -rs key || key=""
  echo
  if [ -n "$key" ]; then
    set_env_var "$env_file" "ANTHROPIC_API_KEY" "$key"
    c_ok "ANTHROPIC_API_KEY written to AI/.env"
  else
    c_info "No key entered — the runner will use your Claude CLI login (run 'claude' once to log in)."
  fi
  echo

  # 2) Edition / profile (independent = solo, no login wall; team = multi-tenant)
  local profile edition require_login
  printf '  %s2.%s Profile: [%sindependent%s] solo self-hosted (no login)  /  team (multi-tenant login)\n' \
    "$BOLD" "$RESET" "$ORANGE" "$RESET"
  printf '     profile [independent]: '
  read -r profile || profile=""
  read -r edition require_login <<<"$(edition_from_profile "$profile")"
  set_env_var "$env_file" "MYAI_EDITION" "$edition"
  set_env_var "$env_file" "REQUIRE_LOGIN" "$require_login"
  c_ok "Profile set to '$edition' (REQUIRE_LOGIN=$require_login) — wires the dashboard /welcome flow"
  echo

  # 3) Scan directory (where your repos live; recorded for `myai scan` after up)
  local scan_dir
  printf '  %s3.%s Directory of repos to register once the stack is up (optional).\n' "$BOLD" "$RESET"
  printf '     scan dir [skip]: '
  read -r scan_dir || scan_dir=""
  if [ -n "$scan_dir" ]; then
    # Expand a leading ~ for convenience.
    case "$scan_dir" in "~"|"~/"*) scan_dir="${scan_dir/#\~/$HOME}" ;; esac
    if [ -d "$scan_dir" ]; then
      set_env_var "$env_file" "MYAI_SCAN_DIR" "$scan_dir"
      c_ok "Scan dir recorded — after 'myai up', run:  myai scan \"$scan_dir\" --register"
    else
      c_warn "Directory '$scan_dir' not found — skipped (you can run 'myai scan <dir>' later)."
    fi
  else
    c_info "No scan dir — register repos any time with 'myai scan <dir>'."
  fi
  echo
}

# Decide whether to run the wizard: explicit flags win; otherwise auto-detect TTY.
case "$WIZARD" in
  off)
    [ "$ZERO_PROMPT" = 1 ] && c_info "--zero-prompt active — skipped guided wizard (never blocks on stdin)"
    ;;
  on)
    if [ -t 0 ]; then run_wizard
    else c_warn "--wizard requested but stdin is not a TTY — skipping prompts."; fi
    ;;
  auto)
    [ -t 0 ] && run_wizard || true
    ;;
esac

# 4. Commit the portable-stack drops (tolerant of a no-op re-init). init_ai.sh
#    already committed AI/ + CLAUDE.md; this picks up the compose additions.
#    NOTE: AI/.env is gitignored, so wizard answers (incl. the key) are NOT
#    committed — they stay local to the operator's machine.
if git -C "$ABS_TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ABS_TARGET" add -A 2>/dev/null || true
  if ! git -C "$ABS_TARGET" diff --cached --quiet 2>/dev/null; then
    git -C "$ABS_TARGET" commit -m "chore: add portable myai docker-compose + .env template" >/dev/null 2>&1 || true
    echo "==> Committed portable stack + env template"
  fi
fi

echo ""
echo "myai init complete → $ABS_TARGET"
echo "  Next: cd $ABS_TARGET  →  set MYAI_HOME in AI/.env  →  myai up"
