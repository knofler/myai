#!/usr/bin/env bash
# mongo_mirror.sh — keep a LOCAL copy of the gateway's memory + registry so
# localhost is not a single point of failure on Atlas.
#
# THE RESILIENCE HOLE THIS CLOSES (handoff follow-up 2026-07-21):
# The gateway runs on shared Atlas (cluster0.example); the local `myai-mongo`
# container is unused by it. So RAG memory (vectors/patterns), the agent/skill/
# repo REGISTRY, tasks, handoffs, budgets — everything except the brain — live
# ONLY in Atlas. Atlas-down or offline => no memory/registry on localhost. (The
# brain is git-backed at ~/.myai/brain + knofler/myai-brain, so it already has a
# local copy; memory/registry do NOT.) This script periodically dumps those
# collections from Atlas and restores them into the local mongo, so a warm local
# mirror is always on disk. Read-side local-first failover is a separate,
# larger gateway change (see documentation/MONGO_MIRROR.md → "next step").
#
# HOW: a throwaway `mongo:7` container (which bundles mongodump/mongorestore) is
# attached to the local mongo's docker network and streams
#   mongodump  --uri=SRC  --archive --gzip  |  mongorestore --uri=DST --archive --gzip --drop
# No host mongo tools required (Docker-only, AI_RULES §1).
#
# DIRECTION: Atlas → local by default (a backup/mirror). `--reverse` (local →
# Atlas) is DANGEROUS (it can overwrite the shared cloud store) and is refused
# unless --yes / MIRROR_ALLOW_PUSH=1 is also given.
#
# Usage:
#   ./scripts/mongo_mirror.sh                       # Atlas → local, whole db
#   ./scripts/mongo_mirror.sh --dry-run             # show the plan, touch nothing
#   ./scripts/mongo_mirror.sh --collections vectors,agents,skills,repos
#   ./scripts/mongo_mirror.sh --src "mongodb+srv://…" --dst "mongodb://…"
#   ./scripts/mongo_mirror.sh --reverse --yes       # local → Atlas (guarded)
#
# Scheduling (forwards to setup_mongo_mirror_schedule.sh — launchd/cron):
#   ./scripts/mongo_mirror.sh --install-schedule [--every-minutes N]  # hourly default
#   ./scripts/mongo_mirror.sh --schedule-status
#   ./scripts/mongo_mirror.sh --uninstall-schedule
#
# Every non-dry run records its outcome (epoch/rc/direction/db/collections) in
# $MYAI_HOME/mongo-mirror.last — `myai doctor` surfaces this as the
# "mongo mirror schedule" check.
#
# Source resolution (first hit wins): --src → $MONGODB_URI → the running
# myai-gateway container's env → root .env → AI/.env.
# Dest default: the local myai-mongo container, reachable inside its docker net
# with the compose default root creds (override with LOCAL_MONGO_USER /
# LOCAL_MONGO_PASS — never hardcode real credentials here).
#
# Library mode (unit tests): MONGO_MIRROR_LIB_ONLY=1 sources the pure helpers
# only (mask_uri / db_from_uri / swap_uri_db / build_ns_includes) and runs nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MONGO_TOOLS_IMAGE="${MONGO_TOOLS_IMAGE:-mongo:7}"
LOCAL_MONGO_CONTAINER="${LOCAL_MONGO_CONTAINER:-myai-mongo}"
LOCAL_MONGO_NETWORK_DEFAULT="myai_myai-net"
# Local root creds default to the docker-compose defaults; override for a
# hardened local store. Not real secrets — kept out of any hardcoded URI literal.
LOCAL_MONGO_USER="${LOCAL_MONGO_USER:-admin}"
LOCAL_MONGO_PASS="${LOCAL_MONGO_PASS:-password}"

# ── Colours (no green — AI_RULES §13) ─────────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }

# ── mask_uri URI → hide credentials for safe logging ──────────────────────────
# mongodb+srv://user:pass@host/db  →  mongodb+srv://***@host/db
mask_uri() {
  # Match through the LAST '@' before the host path so a '@' inside the password
  # is masked too (greedy [^/]* backtracks to the credential separator).
  printf '%s' "${1:-}" | sed -E 's#://[^/]*@#://***@#'
}

# ── db_from_uri URI → the database name in the connection string, or '' ───────
# Reads the path segment after the host, stripping any query string.
db_from_uri() {
  local uri="${1:-}" after
  # Strip scheme + authority (everything up to and including the first '/' that
  # follows the host). If there is no path, echo nothing.
  after="${uri#*://}"          # user:pass@host/db?opts
  case "$after" in
    */*) : ;;                  # has a path
    *)   printf ''; return 0 ;;
  esac
  after="${after#*/}"          # db?opts
  after="${after%%\?*}"        # db
  printf '%s' "$after"
}

# ── swap_uri_db URI NEWDB → same URI with its database path replaced ──────────
# Preserves scheme/auth/host and the query string; used to point the local dest
# URI at the same db name the source carries.
swap_uri_db() {
  local uri="${1:-}" newdb="${2:-}" scheme authority rest query
  scheme="${uri%%://*}"
  rest="${uri#*://}"           # authority[/db][?query]
  case "$rest" in
    *\?*) query="?${rest#*\?}"; rest="${rest%%\?*}" ;;
    *)    query="" ;;
  esac
  authority="${rest%%/*}"      # user:pass@host(:port)
  printf '%s://%s/%s%s' "$scheme" "$authority" "$newdb" "$query"
}

# ── build_ns_includes DB CSV → mongorestore --nsInclude flags for a collection list
# Empty CSV → a single "DB.*" (whole database).
build_ns_includes() {
  local db="${1:-}" csv="${2:-}" out="" c
  if [ -z "$csv" ]; then
    printf -- '--nsInclude=%s.*' "$db"
    return 0
  fi
  for c in $(printf '%s' "$csv" | tr ',' ' '); do
    [ -z "$c" ] && continue
    out="$out --nsInclude=$db.$c"
  done
  # $out is already single-space-separated with one leading space — strip it.
  printf '%s' "${out# }"
}

# ── write_last_run RC DIRECTION DB COLLECTIONS → record the run's outcome ─────
# $MYAI_HOME/mongo-mirror.last (default ~/.myai) as key=value lines. Read by
# `myai doctor` (mongo mirror schedule check) and --schedule-status. Best-effort
# — a record failure never fails the mirror itself.
write_last_run() {
  local rc="${1:-1}" direction="${2:-}" db="${3:-}" collections="${4:-}"
  local home="${MYAI_HOME:-$HOME/.myai}"
  mkdir -p "$home" 2>/dev/null || return 0
  {
    printf 'epoch=%s\n' "$(date +%s)"
    printf 'rc=%s\n' "$rc"
    printf 'direction=%s\n' "$direction"
    printf 'db=%s\n' "$db"
    printf 'collections=%s\n' "${collections:-all}"
  } > "$home/mongo-mirror.last" 2>/dev/null || true
  return 0
}

# Sourced by the test suite — stop before the executable body.
[ "${MONGO_MIRROR_LIB_ONLY:-0}" = 1 ] && return 0 2>/dev/null

# ── env_from_file FILE KEY → value of KEY= in FILE (no export), or '' ─────────
env_from_file() {
  local file="$1" key="$2"
  [ -f "$file" ] || { printf ''; return 0; }
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | sed -E "s/^${key}=//" | sed -E 's/^"(.*)"$/\1/'
}

# ── resolve_src → the source (dump-from) MONGODB_URI ──────────────────────────
resolve_src() {
  [ -n "${SRC_URI:-}" ] && { printf '%s' "$SRC_URI"; return 0; }
  [ -n "${MONGODB_URI:-}" ] && { printf '%s' "$MONGODB_URI"; return 0; }
  # The authoritative value is whatever the running gateway actually uses.
  local from_gw
  from_gw="$(docker exec "$GATEWAY_CONTAINER" sh -c 'printf %s "$MONGODB_URI"' 2>/dev/null || true)"
  [ -n "$from_gw" ] && { printf '%s' "$from_gw"; return 0; }
  local v
  v="$(env_from_file "$REPO_ROOT/.env" MONGODB_URI)"
  [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  v="$(env_from_file "$REPO_ROOT/AI/.env" MONGODB_URI)"
  printf '%s' "$v"
}

# ── resolve_network → docker network the local mongo container is attached to ─
resolve_network() {
  local net
  net="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$LOCAL_MONGO_CONTAINER" 2>/dev/null | awk '{print $1}')"
  [ -n "$net" ] && { printf '%s' "$net"; return 0; }
  printf '%s' "$LOCAL_MONGO_NETWORK_DEFAULT"
}

# ── Schedule passthrough (must be the FIRST argument) ─────────────────────────
# `myai mirror --install-schedule …` et al. forward to the launchd/cron
# installer so scheduling needs no separate CLI command.
case "${1:-}" in
  --install-schedule)   shift; exec bash "$SCRIPT_DIR/setup_mongo_mirror_schedule.sh" "$@" ;;
  --uninstall-schedule) exec bash "$SCRIPT_DIR/setup_mongo_mirror_schedule.sh" --uninstall ;;
  --schedule-status)    exec bash "$SCRIPT_DIR/setup_mongo_mirror_schedule.sh" --status ;;
esac

# ── Parse args ────────────────────────────────────────────────────────────────
DRY_RUN=0
REVERSE=0
CONFIRM_PUSH="${MIRROR_ALLOW_PUSH:-0}"
SRC_URI=""
DST_URI=""
DB_OVERRIDE=""
COLLECTIONS=""
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-myai-gateway}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --reverse)     REVERSE=1 ;;
    --yes|-y)      CONFIRM_PUSH=1 ;;
    --src)         SRC_URI="${2:-}"; shift ;;
    --dst)         DST_URI="${2:-}"; shift ;;
    --db)          DB_OVERRIDE="${2:-}"; shift ;;
    --collections) COLLECTIONS="${2:-}"; shift ;;
    -h|--help)
      sed -n '1,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) c_warn "unknown argument: $1" ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || { c_err "docker not found on PATH"; exit 127; }

# ── Resolve source + dest ─────────────────────────────────────────────────────
ATLAS_URI="$(resolve_src)"
if [ -z "$ATLAS_URI" ]; then
  c_err "could not resolve a source MONGODB_URI (pass --src, or set MONGODB_URI, or start the gateway)"
  exit 1
fi

DB="$DB_OVERRIDE"
[ -z "$DB" ] && DB="$(db_from_uri "$ATLAS_URI")"
[ -z "$DB" ] && DB="${MONGODB_NAME:-myai}"

# Default local dest = the myai-mongo container on its own docker network, with
# the same db name as the source carries.
if [ -z "$DST_URI" ]; then
  DST_URI="mongodb://${LOCAL_MONGO_USER}:${LOCAL_MONGO_PASS}@${LOCAL_MONGO_CONTAINER}:27017/${DB}?authSource=admin"
fi

# Direction: default Atlas(src) → local(dst). --reverse swaps them.
FROM_URI="$ATLAS_URI"
TO_URI="$DST_URI"
DIRECTION="Atlas → local"
if [ "$REVERSE" = 1 ]; then
  FROM_URI="$DST_URI"
  TO_URI="$ATLAS_URI"
  DIRECTION="local → Atlas (PUSH)"
fi

if [ "$(mask_uri "$FROM_URI")" = "$(mask_uri "$TO_URI")" ] && [ "$FROM_URI" = "$TO_URI" ]; then
  c_err "source and destination are identical — refusing to mirror a db onto itself"
  exit 1
fi

# Guard the dangerous direction.
if [ "$REVERSE" = 1 ] && [ "$CONFIRM_PUSH" != 1 ]; then
  c_err "--reverse pushes LOCAL data into Atlas and can overwrite the shared cloud store."
  c_err "Re-run with --yes (or MIRROR_ALLOW_PUSH=1) if that is truly intended."
  exit 2
fi

NETWORK="$(resolve_network)"
NS_INCLUDES="$(build_ns_includes "$DB" "$COLLECTIONS")"

# ── Report the plan ───────────────────────────────────────────────────────────
echo "== mongo_mirror =="
c_info "direction:   $DIRECTION"
c_info "database:    $DB"
c_info "collections: ${COLLECTIONS:-<all>}"
c_info "from:        $(mask_uri "$FROM_URI")"
c_info "to:          $(mask_uri "$TO_URI")"
c_info "network:     $NETWORK"
c_info "tools image: $MONGO_TOOLS_IMAGE"

# The pipeline: dump the source db as a gzip archive to stdout, restore it into
# the destination with --drop (clean mirror of each restored collection). We do
# NOT pass mongodump --db: the source URI already carries the database path
# (mongodump errors if --db is given alongside a db in the connection string),
# and --nsInclude on restore scopes exactly which collections land.
PIPE="mongodump --uri=\"\$FROM\" --archive --gzip --quiet | mongorestore --uri=\"\$TO\" --archive --gzip --drop $NS_INCLUDES --quiet"

if [ "$DRY_RUN" = 1 ]; then
  echo
  c_info "[dry-run] would run (in a throwaway $MONGO_TOOLS_IMAGE container on $NETWORK):"
  printf '    %s\n' "$PIPE"
  c_info "[dry-run] nothing dumped or written."
  exit 0
fi

echo
c_info "mirroring… (a throwaway $MONGO_TOOLS_IMAGE container streams dump→restore)"
if docker run --rm --network "$NETWORK" \
    -e FROM="$FROM_URI" -e TO="$TO_URI" -e DB="$DB" \
    "$MONGO_TOOLS_IMAGE" sh -c "$PIPE"; then
  write_last_run 0 "$DIRECTION" "$DB" "$COLLECTIONS"
  c_ok "mirror complete — local copy of '$DB' refreshed (${COLLECTIONS:-all collections})"
else
  rc=$?
  write_last_run "$rc" "$DIRECTION" "$DB" "$COLLECTIONS"
  c_err "mirror FAILED (rc=$rc) — local copy may be partial; re-run when the source is reachable"
  exit "$rc"
fi
