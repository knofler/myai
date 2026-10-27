#!/usr/bin/env bash
# myai_setup.sh — the `myai setup` global first-run wizard
# (plan/PRODUCT_UX_NORTHSTAR.md §"Workflow 1 — global setup").
#
# THE explicit, standalone entrypoint the northstar locks down — distinct from
# the IMPLICIT brain bootstrap `myai init` already runs on every greenfield
# init (scripts/lib/myai_config.sh myai_brain_bootstrap, which only offers a
# remote URL with no explicit connect-vs-new question and no consent
# statement). `myai setup` asks the ONE question up front:
#
#   connect an EXISTING brain (paste a git URL, clone with the user's own git
#   auth, verify), or provision a NEW one (local by default — state the
#   ownership/data-locality deal, get consent, then OFFER an optional private
#   remote; offline is first-class)?
#
# Both machines converge on the same answer via ~/.myai/config, same as
# myai_brain_bootstrap. bin/myai.cjs auto-triggers this from any STATEFUL
# command when ~/.myai/config is missing (needsAutoSetup/autoRunSetup) — but
# never from -v/--help, and never re-triggers once config exists.
#
# Usage:
#   myai setup                          interactive wizard (TTY): one prompt
#   myai setup --brain <url> [--yes]    non-interactive: connect an existing
#                                        brain (no prompt either way)
#   myai setup --yes                    non-interactive: provision NEW,
#                                        local-only — consent implied by the
#                                        explicit flag
#   MYAI_BRAIN_REMOTE=<url> myai setup  same as --brain <url> (matches
#                                        myai_brain_bootstrap's env convention)
#
# Idempotent: a brain already resolvable + a config file on disk short-circuits
# to a status report (exit 0) unless --force.
#
# Onboarding upsell (ADR-023 Slice P2 / ADR-039): connecting to an EXISTING
# brain (path A) is, by definition, a second-or-later machine for that
# identity — the highest-intent moment to mention the managed alternative to a
# self-managed remote. A one-line nudge prints after a successful connect,
# UNLESS the remote already matches the ADR-017 hosted-brain shape (that
# tenant already pays for managed sync) or $MYAI_SUPPRESS_UPSELL=1 is set.
# Never fires on path B (new brain) — a fresh brain has no "second machine"
# signal.
#
# Tests: scripts/tests/test_myai_setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# `myai setup --machine` is a DIFFERENT concern from the brain wizard below
# (machine-local infra bring-up, not brain identity) — dispatch to its own
# script before touching any brain-wizard state, so both live under the one
# `myai setup` entrypoint the machine-arrival docs point at.
for _arg in "$@"; do
  if [ "$_arg" = "--machine" ]; then
    _rest=()
    for _a in "$@"; do [ "$_a" = "--machine" ] || _rest+=("$_a"); done
    exec bash "$HERE/myai_setup_machine.sh" "${_rest[@]}"
  fi
done

# shellcheck source=lib/myai_config.sh
. "$HERE/lib/myai_config.sh"

usage() {
  cat <<'EOF'
Usage: myai setup [--brain <url>] [--yes] [--force] [--json]
       myai setup --machine [--dry-run] [--yes] [--install-runner]
                             [--rebuild-docker] [--json]

The one-question global first-run wizard: connect an EXISTING private brain,
or provision a NEW one (local by default; optional private remote). Persists
the answer into ~/.myai/config so every future command, in every repo,
resolves the same brain.

  --brain <url>   connect an existing brain by git URL (clones it; no prompt
                   either way). Same effect as $MYAI_BRAIN_REMOTE.
  --yes           non-interactive consent — skip prompts; provisions a NEW
                   local-only brain (no remote) unless --brain/
                   $MYAI_BRAIN_REMOTE is also given.
  --force         re-run the wizard even if already set up.
  --json          machine-readable result on stdout.

  Connecting an existing brain to a self-managed remote prints a one-line
  Solo-tier cross-machine-sync tip (never for an already-hosted remote, or a
  paying customer). Set $MYAI_SUPPRESS_UPSELL=1 to turn it off.

  --machine       THE machine-arrival path (a separate concern from the brain
                   question above): idempotently checks/fixes Dropbox conflict
                   files, git re-attach across the repo fleet, the Docker
                   stack, npm's global prefix, and this machine's runner
                   registration — reporting what it fixed vs. what still needs
                   you (e.g. `sudo chown ~/.npm`). See myai_setup_machine.sh
                   -h for its own flags (--dry-run/--yes/--install-runner/
                   --rebuild-docker/--json).

Auto-triggered by any stateful `myai` command when ~/.myai/config is missing
(`myai setup`/`doctor`/`root` themselves never re-trigger it). -v/--help
never block on this.
EOF
}

brain_url=""
assume_yes=0
force=0
as_json=0

while [ $# -gt 0 ]; do
  case "$1" in
    --brain) brain_url="${2:?--brain requires a URL}"; shift 2 ;;
    --brain=*) brain_url="${1#*=}"; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    --force) force=1; shift ;;
    --json) as_json=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai setup: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$brain_url" ] || brain_url="${MYAI_BRAIN_REMOTE:-}"

_setup_json_result() {
  # _setup_json_result <mode> <dir> <remote>
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
mode, dir_, remote = sys.argv[1:4]
print(json.dumps({"mode": mode, "brainDir": dir_, "brainRemote": remote or None}))
PY
}

BDIR="$(brain_dir)"

# ── idempotent short-circuit ──────────────────────────────────────────────────
if [ "$force" != 1 ] && brain_is_repo "$BDIR" && [ -f "$(myai_config_path)" ]; then
  existing_remote="$(brain_remote_url "$BDIR" 2>/dev/null || true)"
  if [ "$as_json" = 1 ]; then
    _setup_json_result "already-configured" "$BDIR" "$existing_remote"
  else
    echo "myai: already set up — brain at $BDIR${existing_remote:+ (remote: $existing_remote)}"
    echo "  re-run with --force to redo the wizard"
  fi
  exit 0
fi

# ── consent / data-locality statement (the NEW path only) ────────────────────
_setup_show_consent() {
  cat <<'EOF'

  myAI keeps its memory (the "brain") in ONE private git repo per you — never
  inside a code repo, never shared with anyone else's account. By default it
  lives ONLY on this machine (~/.myai/brain); nothing leaves this machine
  unless YOU wire a remote (your own private GitHub repo, self-hosted git,
  etc). Inspect, back up, or delete it any time (`myai backup` /
  `rm -rf ~/.myai/brain`). A remote is optional — offline is first-class.

EOF
}

# ── onboarding upsell (ADR-023 Slice P2 / ADR-039) ────────────────────────────
# See the file header note above. Fires only for a self-managed remote — a
# remote already shaped like the ADR-017 hosted-brain URL means the tenant
# already pays for managed sync, so a paying customer never gets nagged.
# Routed to stderr in --json mode so stdout stays pure JSON (same discipline
# brain_init's own chatter follows elsewhere in this file).
_setup_maybe_show_upsell() {
  local remote="$1"
  [ -n "$remote" ] || return 0
  [ "${MYAI_SUPPRESS_UPSELL:-0}" = 1 ] && return 0
  _myai_is_hosted_brain_remote "$remote" && return 0
  local msg="myai: tip — connecting an existing brain usually means this is a second machine for this identity. Solo (\$49/mo) replaces your self-managed remote with a managed, hosted one (quota + rotation handled for you) — run 'myai open dashboard' then Pricing."
  if [ "$as_json" = 1 ]; then echo "$msg" >&2
  else echo "$msg"; fi
}

# ── path A: connect an existing brain ─────────────────────────────────────────
_setup_connect_existing() {
  local url="$1"
  # Guardrail (ADR-016 §0.4): a URL that matches THIS repo's own code remote is
  # almost certainly a paste mistake, not a separate private brain — refuse it
  # the same way the "offer a remote" path does for a NEW brain.
  if _myai_is_code_remote "$PWD" "$url"; then
    echo "myai setup: refusing — that URL is this repo's code remote, not a separate private brain. Paste your brain repo's URL instead." >&2
    return 1
  fi
  [ "$as_json" = 1 ] || echo "==> myai setup: connecting to existing brain: $url"
  if [ -e "$BDIR" ] && [ -n "$(ls -A "$BDIR" 2>/dev/null)" ] && ! brain_is_repo "$BDIR"; then
    echo "myai setup: $BDIR exists and is not a brain repo — refusing to clone over it (move it aside first)" >&2
    return 1
  fi
  # --json: stdout must be pure JSON — brain_init's own chatter goes to stderr.
  if [ "$as_json" = 1 ]; then brain_init "$BDIR" --remote "$url" >&2
  else brain_init "$BDIR" --remote "$url"; fi
  if ! brain_is_repo "$BDIR"; then
    echo "myai setup: could not verify a brain at $BDIR after clone — check the URL / your git auth" >&2
    return 1
  fi
  myai_config_set "brain.dir" "$BDIR" >/dev/null
  local verified; verified="$(brain_remote_url "$BDIR" 2>/dev/null || true)"
  [ -n "$verified" ] && myai_config_set "brain.remote" "$verified" >/dev/null
  myai_config_set "setup.mode" "connect" >/dev/null
  myai_config_set "setup.completed_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
  if [ "$as_json" = 1 ]; then
    _setup_json_result "connect" "$BDIR" "$verified"
  else
    echo "myai: connected — brain verified at $BDIR${verified:+ (remote: $verified)}"
  fi
  _setup_maybe_show_upsell "$verified"
}

# ── path B: provision a new brain (local by default, optional remote) ────────
# interactive_confirm=1 → show consent, ask to continue, then prompt for an
# optional remote (used by the TTY "new" branch). =0 → non-interactive: show
# the statement (unless --json) but never prompt; $1 is the remote to use, if
# any (from --brain/$MYAI_BRAIN_REMOTE having already been ruled out upstream,
# this is normally empty).
_setup_provision_new() {
  local remote="$1" interactive_confirm="${2:-0}"
  [ "$as_json" = 1 ] || _setup_show_consent
  if [ "$interactive_confirm" = 1 ]; then
    printf '  continue provisioning a new (local) brain? [Y/n]: '
    read -r cont || cont=""
    case "$(printf '%s' "$cont" | tr '[:upper:]' '[:lower:]')" in
      n|no)
        echo "myai setup: cancelled — no brain created. Re-run 'myai setup' when ready." >&2
        return 1
        ;;
    esac
    printf '  optional: private git remote for this brain (leave blank for local-only): '
    read -r remote || remote=""
  fi
  if [ -n "$remote" ] && _myai_is_code_remote "$PWD" "$remote"; then
    echo "myai setup: WARN — that URL is this repo's code remote; the brain must be a SEPARATE private repo. Provisioning local-only instead." >&2
    remote=""
  fi
  # --json: stdout must be pure JSON — brain_init's own chatter goes to stderr.
  if [ "$as_json" = 1 ]; then
    if [ -n "$remote" ]; then brain_init "$BDIR" --remote "$remote" >&2
    else brain_init "$BDIR" >&2; fi
  else
    if [ -n "$remote" ]; then brain_init "$BDIR" --remote "$remote"
    else brain_init "$BDIR"; fi
  fi
  if ! brain_is_repo "$BDIR"; then
    echo "myai setup: could not create the brain at $BDIR" >&2
    return 1
  fi
  myai_config_set "brain.dir" "$BDIR" >/dev/null
  local wired; wired="$(brain_remote_url "$BDIR" 2>/dev/null || true)"
  [ -n "$wired" ] && myai_config_set "brain.remote" "$wired" >/dev/null
  myai_config_set "setup.mode" "new" >/dev/null
  myai_config_set "setup.completed_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
  if [ "$as_json" = 1 ]; then
    _setup_json_result "new" "$BDIR" "$wired"
  else
    echo "myai: provisioned a new brain at $BDIR${wired:+ (remote: $wired)}"
  fi
}

# ── Docker gate (after the brain, before "you're done") ──────────────────────
# The brain is only half of first run: the gateway, Mongo RAG, runner and local
# CI all run in Docker. A colleague once finished this wizard with no Docker
# installed and never got a gateway — nothing told them. So the wizard now ends
# by checking Docker and, when it isn't ready, says what it is, why myAI needs
# it and the exact step for this OS. Interactive: offer to wait, then resume
# straight into `myai up`. Headless/--json: explain on stderr, leave a pending
# marker (bin/myai.cjs re-offers on the next command) and still exit 0 — the
# brain half succeeded. Never installs anything. MYAI_SKIP_DOCKER_GATE=1 skips.
# shellcheck source=scripts/lib/docker_gate.sh
. "$HERE/lib/docker_gate.sh"

_setup_start_stack() {
  # Auto-triggered from `myai up` itself → the parent command starts the stack.
  if [ "${MYAI_SETUP_PARENT:-}" = up ]; then
    echo "  continuing with 'myai up'…"
    return 0
  fi
  # MYAI_SETUP_UP_CMD: test seam (scripts/tests/test_docker_gate.sh) — the
  # command that brings the stack up; defaults to the real `myai up`.
  local up_rc=0
  if [ -n "${MYAI_SETUP_UP_CMD:-}" ]; then bash -c "$MYAI_SETUP_UP_CMD" || up_rc=$?
  else bash "$HERE/myai_up.sh" || up_rc=$?; fi
  if [ "$up_rc" = 0 ]; then
    echo ""
    echo "  ✓ Your myAI stack is running — gateway: http://localhost:${MYAI_MCP_PORT:-3100}/mcp · dashboard: http://localhost:${MYAI_DASHBOARD_PORT:-3210}"
  else
    echo "myai setup: Docker is up but 'myai up' failed — see the output above, then run 'myai up' again." >&2
  fi
}

_setup_docker_gate() {
  [ "${MYAI_SKIP_DOCKER_GATE:-0}" = 1 ] && return 0
  local state; state="$(docker_gate_state)"
  if [ "$state" = ok ]; then
    docker_gate_clear_pending
    [ "$as_json" = 1 ] || echo "myai: Docker is ready — next: 'myai up' starts your local stack."
    return 0
  fi
  if [ "$as_json" = 1 ] || ! _myai_interactive; then
    docker_gate_explain "$state" >&2
    docker_gate_mark_pending
    echo "myai setup: your brain is ready; the local stack is waiting on Docker. Once Docker is running, run 'myai up'." >&2
    return 0
  fi
  docker_gate_explain "$state"
  if [ "$state" = not-running ] && docker_gate_try_start; then
    echo "  Starting Docker Desktop for you…"
  fi
  printf '\n  Press Enter and I will wait here and carry on the moment Docker is up (or type s to skip): '
  local ans=""; read -r ans || ans=s
  case "$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')" in
    s|skip|n|no)
      docker_gate_mark_pending
      echo "  Skipped — your brain is ready. Install/start Docker, then run 'myai up'."
      return 0 ;;
  esac
  printf '  waiting for Docker (Ctrl-C to stop; resume later with myai up)'
  docker_gate_mark_pending   # survives a Ctrl-C mid-wait
  if docker_gate_wait; then
    docker_gate_clear_pending
    echo "  Docker is up — starting your myAI stack now…"
    _setup_start_stack
  else
    echo "  Still no Docker after ${MYAI_DOCKER_WAIT_TIMEOUT:-900}s — your brain is ready; run 'myai up' once Docker is running."
  fi
  return 0
}

# _setup_finish <rc> — every brain path ends here: on success, run the Docker
# gate; the exit code is always the brain path's own.
# ── swarm master (operator rule 2026-10-22) — every device has exactly one,
# chosen at install. Interactive: ask now (scripts/swarm_master_set.sh lists
# the agents/profiles detected here). Otherwise: a one-line hint. Never fails
# setup — boot and `myai doctor` show RED until it is chosen.
_setup_swarm_master() {
  local sms="$HERE/swarm_master_set.sh"
  [ -f "$sms" ] || return 0
  export SWARM_DIR="${SWARM_DIR:-${MYAI_HOME:-$HOME/.myai}/swarm}"
  bash "$sms" show >/dev/null 2>&1 && return 0
  if [ "$assume_yes" != 1 ] && _myai_interactive; then
    echo ""
    echo "  Every device has exactly one swarm master — the agent that coordinates the others here."
    bash "$sms" set || echo "  (skipped — choose later with: myai swarm master set)"
  else
    echo "myai setup: no swarm master on this device yet — choose one with: myai swarm master set" >&2
  fi
  return 0
}

_setup_finish() {
  local rc="$1"
  [ "$rc" = 0 ] && _setup_docker_gate
  [ "$rc" = 0 ] && _setup_swarm_master
  exit "$rc"
}

# ── dispatch ──────────────────────────────────────────────────────────────────

# An explicit URL (flag or env) always wins, interactive or not — no prompt.
if [ -n "$brain_url" ]; then
  _setup_connect_existing "$brain_url"
  _setup_finish $?
fi

# --yes with no URL: explicit non-interactive consent → provision new, local-only.
if [ "$assume_yes" = 1 ]; then
  _setup_provision_new "" 0
  _setup_finish $?
fi

if _myai_interactive; then
  echo ""
  echo "  myAI setup — one question: do you already have a myAI brain to connect,"
  echo "  or should we provision a new one?"
  printf '  connect an existing brain? [y/N]: '
  read -r ans || ans=""
  case "$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')" in
    y|yes)
      printf '  private brain git URL: '
      read -r url || url=""
      if [ -z "$url" ]; then
        echo "myai setup: no URL given — provisioning a new brain instead" >&2
        _setup_provision_new "" 1
        _setup_finish $?
      fi
      _setup_connect_existing "$url"
      _setup_finish $?
      ;;
    *)
      _setup_provision_new "" 1
      _setup_finish $?
      ;;
  esac
fi

# Fully non-interactive, no flags at all (e.g. auto-triggered from a headless
# stateful command): never block — provision local-only with implied consent,
# same convention as myai_brain_bootstrap's CI fallback.
echo "myai setup: non-interactive session — provisioning a local-only brain (implied consent). Re-run 'myai setup' interactively to review the data-locality statement, or pass --brain <url> to connect an existing one." >&2
_setup_provision_new "" 0
_setup_finish $?
