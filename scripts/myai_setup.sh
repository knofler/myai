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
# Tests: scripts/tests/test_myai_setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/myai_config.sh
. "$HERE/lib/myai_config.sh"

usage() {
  cat <<'EOF'
Usage: myai setup [--brain <url>] [--yes] [--force] [--json]

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

# ── dispatch ──────────────────────────────────────────────────────────────────

# An explicit URL (flag or env) always wins, interactive or not — no prompt.
if [ -n "$brain_url" ]; then
  _setup_connect_existing "$brain_url"
  exit $?
fi

# --yes with no URL: explicit non-interactive consent → provision new, local-only.
if [ "$assume_yes" = 1 ]; then
  _setup_provision_new "" 0
  exit $?
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
        exit $?
      fi
      _setup_connect_existing "$url"
      exit $?
      ;;
    *)
      _setup_provision_new "" 1
      exit $?
      ;;
  esac
fi

# Fully non-interactive, no flags at all (e.g. auto-triggered from a headless
# stateful command): never block — provision local-only with implied consent,
# same convention as myai_brain_bootstrap's CI fallback.
echo "myai setup: non-interactive session — provisioning a local-only brain (implied consent). Re-run 'myai setup' interactively to review the data-locality statement, or pass --brain <url> to connect an existing one." >&2
_setup_provision_new "" 0
