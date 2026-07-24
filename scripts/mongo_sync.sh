#!/usr/bin/env bash
# mongo_sync.sh — local-first Mongo mode: keep Atlas and the local myai-mongo
# converged in whichever direction the operator has explicitly designated
# PRIMARY, so choosing Atlas never again means the local mirror sits empty
# (task-48dad5c1, follow-up to documentation/MONGO_MIRROR.md "next step").
#
# BUILDS ON mongo_mirror.sh (the dump/restore engine) rather than duplicating
# it. mongo_mirror.sh defaults to the safe Atlas→local backup direction and
# guards local→Atlas (--reverse) behind --yes, because IT assumes Atlas stays
# canonical. mongo_sync.sh removes that assumption: it reads an explicit,
# operator-set PRIMARY designation (state/.mongo_primary — "atlas" by
# default, or "local" once the operator opts into local-first mode via
# `set-primary local`) and syncs PRIMARY → SECONDARY, auto-supplying the
# confirmation mongo_mirror.sh requires for a local→Atlas push (the primary
# flip itself IS that confirmation — never an automatic/silent decision, per
# the 2026-07-04 gateway split-brain lesson).
#
# Usage:
#   ./scripts/mongo_sync.sh                        # sync PRIMARY → SECONDARY (idempotent)
#   ./scripts/mongo_sync.sh --dry-run              # show the resolved plan only, touch nothing
#   ./scripts/mongo_sync.sh status                 # show current primary + last successful sync
#   ./scripts/mongo_sync.sh set-primary atlas|local   # flip local-first mode designation
#   ./scripts/mongo_sync.sh --collections vectors,agents,repos,tasks   # scope a sync run
#
# IDEMPOTENT + RESUMABLE: every run is a full dump→restore convergence of the
# CURRENT primary onto the secondary (same guarantee mongo_mirror.sh already
# gives — --drop per restored collection). A run interrupted mid-flight can
# leave at most the in-progress collection partially restored on the
# secondary; every prior collection in the same run already landed cleanly,
# and simply re-running (cron/launchd already do this on a timer) re-dumps
# and re-restores from the primary's current state — there is no separate
# "resume from where it left off" step needed, because the primary is always
# the same source of truth regardless of how many times the sync is retried.
#
# Library mode (unit tests): MONGO_SYNC_LIB_ONLY=1 sources the pure helpers
# only (current_primary / direction_args_for / direction_label_for) and runs
# nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIRROR="$SCRIPT_DIR/mongo_mirror.sh"

# Per-machine operational state — NOT git-tracked (which mongo is "primary"
# is a local operator decision, same footing as state/.yolo).
PRIMARY_FILE="${MONGO_PRIMARY_FILE:-$REPO_ROOT/state/.mongo_primary}"
SYNC_LOG="${MONGO_SYNC_LOG:-$REPO_ROOT/state/.mongo_sync_last}"

# ── Colours (no green — AI_RULES §13) ─────────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }

# ── current_primary → "atlas" (default) or "local" ────────────────────────────
current_primary() {
  if [ -f "$PRIMARY_FILE" ]; then
    tr -d '[:space:]' < "$PRIMARY_FILE"
  else
    printf 'atlas'
  fi
}

# ── direction_args_for PRIMARY → the mongo_mirror.sh flags for PRIMARY→SECONDARY
# atlas is mongo_mirror.sh's default direction (Atlas→local, no flags needed).
# local means push local→Atlas, which mongo_mirror.sh guards behind --reverse
# --yes — the primary designation supplies that confirmation automatically.
direction_args_for() {
  case "${1:-}" in
    local) printf -- '--reverse --yes' ;;
    *)     printf '' ;;
  esac
}

# ── direction_label_for PRIMARY → human-readable direction for logging ────────
direction_label_for() {
  case "${1:-}" in
    local) printf 'local → Atlas' ;;
    *)     printf 'Atlas → local' ;;
  esac
}

# Sourced by the test suite — stop before the executable body.
[ "${MONGO_SYNC_LIB_ONLY:-0}" = 1 ] && return 0 2>/dev/null

# ── Dispatch subcommands ───────────────────────────────────────────────────────
ACTION="sync"
case "${1:-}" in
  status)      ACTION="status"; shift ;;
  set-primary) ACTION="set-primary"; shift ;;
  -h|--help)   ACTION="help" ;;
esac

if [ "$ACTION" = "help" ]; then
  sed -n '1,32p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ "$ACTION" = "status" ]; then
  p="$(current_primary)"
  echo "== mongo_sync status =="
  c_info "primary:    $p"
  c_info "direction:  $(direction_label_for "$p") (next sync run)"
  if [ -f "$SYNC_LOG" ]; then
    c_info "last sync:  $(cat "$SYNC_LOG")"
  else
    c_info "last sync:  never"
  fi
  exit 0
fi

if [ "$ACTION" = "set-primary" ]; then
  NEW="${1:-}"
  case "$NEW" in
    atlas|local) : ;;
    *) c_err "usage: mongo_sync.sh set-primary <atlas|local>"; exit 2 ;;
  esac
  mkdir -p "$(dirname "$PRIMARY_FILE")"
  printf '%s' "$NEW" > "$PRIMARY_FILE"
  c_ok "primary set to '$NEW' — next 'mongo_sync.sh' run pushes $(direction_label_for "$NEW")"
  if [ "$NEW" = "local" ]; then
    c_warn "LOCAL-FIRST MODE flagged, but the gateway does not switch automatically:"
    c_warn "point MONGODB_URI at the local mongo URI in .env, then rebuild/restart the"
    c_warn "gateway stack (interactive/selfheal op from the master checkout — see"
    c_warn "architecture/ADR-022-local-first-mongo-mode.md) for it to take effect."
  fi
  exit 0
fi

command -v docker >/dev/null 2>&1 || { c_err "docker not found on PATH"; exit 127; }
[ -x "$MIRROR" ] || { c_err "mongo_mirror.sh not found/executable at $MIRROR"; exit 1; }

# Everything else is passed straight through to mongo_mirror.sh (--dry-run,
# --collections, --src/--dst overrides, etc.) alongside the resolved direction.
PASSTHROUGH=()
for a in "$@"; do PASSTHROUGH+=("$a"); done

PRIMARY="$(current_primary)"
# shellcheck disable=SC2207
DIRECTION_ARGS=($(direction_args_for "$PRIMARY"))
DIRECTION_LABEL="$(direction_label_for "$PRIMARY")"

echo "== mongo_sync =="
c_info "designated primary: $PRIMARY  (flip with: mongo_sync.sh set-primary <atlas|local>)"
c_info "direction:          $DIRECTION_LABEL"

if "$MIRROR" "${DIRECTION_ARGS[@]}" "${PASSTHROUGH[@]}"; then
  is_dry=0
  for a in "${PASSTHROUGH[@]}"; do [ "$a" = "--dry-run" ] && is_dry=1; done
  if [ "$is_dry" = 0 ]; then
    mkdir -p "$(dirname "$SYNC_LOG")"
    printf 'primary=%s direction=%s at=%s\n' "$PRIMARY" "$DIRECTION_LABEL" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SYNC_LOG"
    c_ok "sync complete — $SYNC_LOG updated"
  fi
else
  rc=$?
  c_err "sync FAILED (rc=$rc) — $SYNC_LOG left at its previous value (or absent);"
  c_err "re-run to retry — every run re-converges from the current primary's live state"
  exit "$rc"
fi
