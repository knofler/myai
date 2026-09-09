#!/usr/bin/env bash
# myai_setup_machine.sh — `myai setup --machine`: THE machine-arrival path.
#
# WHY THIS EXISTS: bringing a Mac back after time away used to mean
# rediscovering, one failure at a time, the same five things every session:
# Dropbox conflict-copy pollution, a stale Docker image, `.git` gone missing
# on repos Dropbox purged, a root-owned npm prefix that EACCES's a fresh
# install, and this machine never having registered as an autonomous runner.
# Each already has a dedicated script (restore_git_metadata.sh,
# npm_prefix_preflight.sh, myai_runner.sh, machine_selfheal.sh) — this is the
# ONE orchestrator that runs all of them in the right order and gives a single
# report of what it fixed vs. what still needs the operator.
#
# Idempotent by design: every step below is safe to re-run on an already-
# healthy machine (it reports OK and moves on). Nothing here ever mutates the
# SHARED myai gateway stack from a non-master checkout (ci-workspaces clone) —
# same rule CLAUDE.md's DEPLOY GUARD states for agents, baked into the script
# itself so a stray `--yes` on a workspace clone can't split-brain the fleet.
#
# Usage:
#   myai setup --machine                 apply the safe/idempotent fixes
#                                         (Dropbox conflicts, npm prefix,
#                                         general self-heal); report git
#                                         re-attach + runner registration +
#                                         Docker rebuild as operator TODOs
#                                         (never applied without consent)
#   myai setup --machine --dry-run       report only, write nothing
#   myai setup --machine --yes           also install the runner and rebuild
#                                         the Docker stack (full consent, the
#                                         two steps that spend resources /
#                                         take time — same opt-in convention
#                                         as `myai setup --yes`)
#   myai setup --machine --install-runner   just the runner-install consent
#   myai setup --machine --rebuild-docker   just the docker-rebuild consent
#   myai setup --machine --json          machine-readable report on stdout
#
# Tests: scripts/tests/test_myai_setup_machine.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

APPLY=1
INSTALL_RUNNER=0
REBUILD_DOCKER=0
AS_JSON=0
QUIET=0

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) APPLY=0; shift ;;
    --install-runner) INSTALL_RUNNER=1; shift ;;
    --rebuild-docker) REBUILD_DOCKER=1; shift ;;
    --yes|-y) INSTALL_RUNNER=1; REBUILD_DOCKER=1; shift ;;
    --json) AS_JSON=1; shift ;;
    --quiet|-q) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai setup --machine: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

FIXED=()
OK=()
NEEDS_OPERATOR=()
SKIPPED=()

note_fixed() { FIXED+=("$1"); }
note_ok() { OK+=("$1"); }
note_needs() { NEEDS_OPERATOR+=("$1"); }
note_skip() { SKIPPED+=("$1"); }

log() {
  [ "$QUIET" = 1 ] && return 0
  [ "$AS_JSON" = 1 ] && return 0
  printf '%s\n' "$*"
}

log "myai setup --machine — $([ "$APPLY" = 1 ] && echo "APPLY" || echo "DRY-RUN")"
log ""

# ── 1. Dropbox conflict-copy cleanup ─────────────────────────────────────────
# Safe by construction (MULTI_MACHINE_WORKFLOW.md "Step 2" — originals are
# always the non-suffixed files): a conflicted-copy or Case-Conflict file is
# never the only copy of anything.
log "1/6 Dropbox conflict cleanup..."
CONFLICT_FILES="$(find "$REPO_ROOT" \( -name "*conflicted copy*" -o -name "*Case-Conflict*" -o -name "*Case Conflict*" \) 2>/dev/null)"
CONFLICT_COUNT=0
if [ -n "$CONFLICT_FILES" ]; then
  CONFLICT_COUNT="$(printf '%s\n' "$CONFLICT_FILES" | grep -c .)"
fi
if [ "$CONFLICT_COUNT" -gt 0 ]; then
  if [ "$APPLY" = 1 ]; then
    printf '%s\n' "$CONFLICT_FILES" | while IFS= read -r f; do [ -n "$f" ] && rm -f "$f" 2>/dev/null; done
    note_fixed "dropbox-conflicts: removed $CONFLICT_COUNT conflicted-copy file(s)"
  else
    note_needs "dropbox-conflicts: $CONFLICT_COUNT conflicted-copy file(s) found — re-run without --dry-run to remove"
  fi
else
  note_ok "dropbox-conflicts: none found"
fi

# ── 2. Git re-attach across the fleet ────────────────────────────────────────
# Delegates to the fleet preflight hook, which itself wraps
# restore_git_metadata.sh --fleet in dry-run (its default) — NEVER auto-applied
# here: a wrong remote guess would reset a repo's index against someone else's
# history, so re-attaching a repo always stays a deliberate, reviewed step.
log "2/6 Git fleet re-attach check..."
PREFLIGHT_HOOK="$REPO_ROOT/hooks/session/26-git-fleet-preflight.sh"
RESTORE_SCRIPT="$REPO_ROOT/scripts/restore_git_metadata.sh"
if [ -x "$PREFLIGHT_HOOK" ] || [ -f "$PREFLIGHT_HOOK" ]; then
  GIT_FLEET_OUT="$(bash "$PREFLIGHT_HOOK" 2>/dev/null)"
  if [ -n "$GIT_FLEET_OUT" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && note_needs "git-reattach: $line"
    done <<EOF_LINES
$GIT_FLEET_OUT
EOF_LINES
  else
    note_ok "git-reattach: whole fleet has .git attached"
  fi
elif [ -f "$RESTORE_SCRIPT" ]; then
  GIT_FLEET_OUT="$(bash "$RESTORE_SCRIPT" --fleet 2>/dev/null)"
  case "$GIT_FLEET_OUT" in
    *"would:"*|*"cannot resolve remote"*|*AMBIGUOUS*)
      note_needs "git-reattach: one or more repos missing .git — run: $RESTORE_SCRIPT --fleet (review), then --apply per repo" ;;
    *) note_ok "git-reattach: whole fleet has .git attached" ;;
  esac
else
  note_skip "git-reattach: restore_git_metadata.sh not found — skipped"
fi

# ── 3. Docker stack rebuild ───────────────────────────────────────────────────
# Never touches the shared gateway stack from a non-master checkout (a
# ci-workspaces clone has no real .env — it would silently rebind the gateway
# to the empty local mongo and split-brain the fleet queue; DEPLOY GUARD).
# Only ever rebuilds with explicit consent (--rebuild-docker / --yes): this is
# the slow, resource-spending step, same opt-in convention as runner install.
log "3/6 Docker stack..."
IS_WORKSPACE_CLONE=0
case "$REPO_ROOT" in
  "$HOME"/ci-workspaces/*) IS_WORKSPACE_CLONE=1 ;;
esac
HAS_REAL_ENV=0
[ -f "$REPO_ROOT/.env" ] && grep -qE '^MONGODB_URI=' "$REPO_ROOT/.env" 2>/dev/null && HAS_REAL_ENV=1

if ! command -v docker >/dev/null 2>&1; then
  note_needs "docker: not installed on this machine — install Docker Desktop, then re-run"
elif ! docker info >/dev/null 2>&1; then
  note_needs "docker: engine not reachable — start Docker Desktop, then re-run"
elif [ "$IS_WORKSPACE_CLONE" = 1 ] || [ "$HAS_REAL_ENV" != 1 ]; then
  note_skip "docker-rebuild: not the master checkout (no real .env) — run this from the master checkout to rebuild the shared stack"
elif [ ! -f "$REPO_ROOT/docker-compose.yml" ]; then
  note_skip "docker-rebuild: no docker-compose.yml at $REPO_ROOT"
elif [ "$REBUILD_DOCKER" = 1 ]; then
  if ( cd "$REPO_ROOT" && docker compose up -d --build ) >/dev/null 2>&1; then
    note_fixed "docker-rebuild: docker compose up -d --build (master checkout)"
  else
    note_needs "docker-rebuild: 'docker compose up -d --build' failed — run it manually from $REPO_ROOT and inspect the error"
  fi
else
  note_needs "docker-rebuild: master checkout detected — re-run with --rebuild-docker (or --yes) to rebuild, or run manually: (cd \"$REPO_ROOT\" && docker compose up -d --build)"
fi

# ── 4. npm cache / global-prefix workaround ──────────────────────────────────
log "4/6 npm prefix..."
NPM_PREFLIGHT="$REPO_ROOT/scripts/npm_prefix_preflight.sh"
if [ -x "$NPM_PREFLIGHT" ] || [ -f "$NPM_PREFLIGHT" ]; then
  if [ "$APPLY" = 1 ]; then
    NPM_OUT="$(bash "$NPM_PREFLIGHT" --fix --quiet 2>&1)"
    NPM_RC=$?
    if [ "$NPM_RC" = 0 ]; then
      case "$NPM_OUT" in
        *"configured npm prefix"*) note_fixed "npm-prefix: $NPM_OUT" ;;
        *) note_ok "npm-prefix: writable" ;;
      esac
    else
      note_needs "npm-prefix: could not auto-fix — sudo chown -R \"\$(whoami)\" \"\$(npm config get prefix)\""
    fi
  else
    if bash "$NPM_PREFLIGHT" --quiet 2>/dev/null; then
      note_ok "npm-prefix: writable"
    else
      note_needs "npm-prefix: not writable — run 'myai setup --machine' without --dry-run to auto-fix, or: sudo chown -R \"\$(whoami)\" \"\$(npm config get prefix)\""
    fi
  fi
else
  note_skip "npm-prefix: npm_prefix_preflight.sh not found — skipped"
fi

# ── 5. Runner registration ────────────────────────────────────────────────────
# Never auto-installed without consent (--install-runner / --yes): a headless
# autonomous worker spends the operator's Claude plan, same rule
# machine_selfheal.sh already follows for the runner it merely reminds about.
log "5/6 Runner registration..."
RUNNER_SCRIPT="$REPO_ROOT/scripts/myai_runner.sh"
if [ -x "$RUNNER_SCRIPT" ] || [ -f "$RUNNER_SCRIPT" ]; then
  RUNNER_STATUS_OUT="$(bash "$RUNNER_SCRIPT" status 2>/dev/null)"
  case "$RUNNER_STATUS_OUT" in
    *"NOT installed"*)
      if [ "$INSTALL_RUNNER" = 1 ]; then
        if bash "$RUNNER_SCRIPT" install --every-minutes 10 >/dev/null 2>&1; then
          note_fixed "runner: installed (every 10 min)"
        else
          note_needs "runner: install failed — run manually: myai runner install --every-minutes 10"
        fi
      else
        note_needs "runner: not registered on this machine — re-run with --install-runner (or --yes), or: myai runner install --every-minutes 10"
      fi
      ;;
    *"INSTALLED"*)
      note_ok "runner: already registered"
      ;;
    *)
      note_skip "runner: could not determine status"
      ;;
  esac
else
  note_skip "runner: myai_runner.sh not found — skipped"
fi

# ── 6. General machine self-heal (everything else session-start already covers) ──
# machine_selfheal.sh is itself fully idempotent/safe to re-run (statusline,
# Docker credsStore hang guard, git-remote SSH->HTTPS fallback, gateway
# split-brain guard, brain remote auto-wire, conflicted-copy pre-commit hook).
# Folding it in here means `setup --machine` is a strict superset of what a
# normal session start self-heals — nothing to duplicate.
log "6/6 General self-heal..."
SELFHEAL="$REPO_ROOT/scripts/machine_selfheal.sh"
if [ -x "$SELFHEAL" ] || [ -f "$SELFHEAL" ]; then
  SELFHEAL_OUT="$(bash "$SELFHEAL" 2>&1)"
  case "$SELFHEAL_OUT" in
    *"applied ->"*)
      APPLIED_LINE="$(printf '%s\n' "$SELFHEAL_OUT" | grep "applied ->" | head -1)"
      note_fixed "selfheal: ${APPLIED_LINE#*applied -> }"
      ;;
    *) note_ok "selfheal: nothing to correct" ;;
  esac
  WARN_LINES="$(printf '%s\n' "$SELFHEAL_OUT" | grep -E '🟠|🔴|⛔' || true)"
  if [ -n "$WARN_LINES" ]; then
    while IFS= read -r w; do
      [ -n "$w" ] && note_needs "selfheal: $w"
    done <<EOF_WARN
$WARN_LINES
EOF_WARN
  fi
else
  note_skip "selfheal: machine_selfheal.sh not found — skipped"
fi

# ── report ────────────────────────────────────────────────────────────────────
if [ "$AS_JSON" = 1 ]; then
  python3 - "$APPLY" <<'PY' ${FIXED[@]+"${FIXED[@]}"} -- ${OK[@]+"${OK[@]}"} -- ${NEEDS_OPERATOR[@]+"${NEEDS_OPERATOR[@]}"} -- ${SKIPPED[@]+"${SKIPPED[@]}"}
import json, sys
apply_mode = sys.argv[1] == "1"
rest = sys.argv[2:]
buckets = [[]]
for a in rest:
    if a == "--":
        buckets.append([])
    else:
        buckets[-1].append(a)
while len(buckets) < 4:
    buckets.append([])
fixed, ok, needs_operator, skipped = buckets[:4]
print(json.dumps({
    "apply": apply_mode,
    "fixed": fixed,
    "ok": ok,
    "needsOperator": needs_operator,
    "skipped": skipped,
}))
PY
else
  log ""
  log "════════════════════════════════════════════════"
  log "fixed:          ${#FIXED[@]}"
  for f in ${FIXED[@]+"${FIXED[@]}"}; do log "  ✓ $f"; done
  log "ok:             ${#OK[@]}"
  for o in ${OK[@]+"${OK[@]}"}; do log "  · $o"; done
  log "needs operator: ${#NEEDS_OPERATOR[@]}"
  for n in ${NEEDS_OPERATOR[@]+"${NEEDS_OPERATOR[@]}"}; do log "  ! $n"; done
  log "skipped:        ${#SKIPPED[@]}"
  for s in ${SKIPPED[@]+"${SKIPPED[@]}"}; do log "  - $s"; done
  [ "$APPLY" != 1 ] && log "" && log "DRY-RUN only — re-run without --dry-run to apply the safe fixes."
fi

[ "${#NEEDS_OPERATOR[@]}" -eq 0 ]
