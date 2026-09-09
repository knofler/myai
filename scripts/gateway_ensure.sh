#!/bin/bash
set +e
# gateway_ensure.sh — keep the RUNNING gateway equal to the BUILT source, so
# "the gateway is up" also means "the gateway is current". Zero model tokens.
#
# WHY THIS EXISTS. "Rebuilt the stale gateway image" appears over and over in
# state/AI_AGENT_HANDOFF.md as a MANUAL step an agent noticed and fixed by
# hand — 2026-08-26 (7-session STALE self-heal blocker), 2026-08-27, 2026-08-28
# (again, at session close). Every one of those cost interactive tokens to
# diagnose and re-derive. Nothing measured image-vs-source freshness, so a
# healthy /health 200 from a two-day-old image looked identical to a current
# one, and MCP tools served stale code while the agent trusted them.
#
# Freshness test: newest mtime under runtime/ (src + Dockerfile + manifests)
# versus the CREATION time of the image the gateway container is actually
# running. mtime — not git — on purpose: an uncommitted local edit makes the
# running image stale just as surely as a merged commit does, and boot should
# say so.
#
# Rebuilds are minutes long, so a SessionStart hook must never run one inline.
# --background detaches it under a lock and logs to
# $MYAI_HOME/logs/gateway-rebuild.log; boot prints one line and moves on, and
# the next boot sees a fresh image. That is the whole point: convergence
# without a human or a model in the loop.
#
# Usage:
#   gateway_ensure.sh                 report only (exit 0 fresh, 3 stale, 4 down)
#   gateway_ensure.sh --apply         rebuild + restart inline if stale/down
#   gateway_ensure.sh --apply --background   detach the rebuild, return at once
#   gateway_ensure.sh --start-docker  also try to start Docker Desktop if down
#   flags: --quiet  --service <name> (default gateway)  --all (gateway+dashboard)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT" || exit 0

APPLY=0 BG=0 QUIET=0 START_DOCKER=0 SERVICES="gateway"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)        APPLY=1 ;;
    --background)   BG=1 ;;
    --quiet)        QUIET=1 ;;
    --start-docker) START_DOCKER=1 ;;
    --all)          SERVICES="gateway dashboard" ;;
    --service)      shift; SERVICES="$1" ;;
    *) ;;
  esac
  shift
done
say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*" >&2; }

MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
LOGDIR="$MYAI_HOME/logs"; mkdir -p "$LOGDIR" 2>/dev/null
LOG="$LOGDIR/gateway-rebuild.log"
LOCK="$MYAI_HOME/.gateway-rebuild.lock"

# ── docker daemon ────────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  if [ "$START_DOCKER" = 1 ] && [ "$(uname -s)" = "Darwin" ] && [ -d /Applications/Docker.app ]; then
    say "gateway: Docker daemon down — starting Docker Desktop…"
    open -ga Docker 2>/dev/null
    i=0
    while [ $i -lt 60 ]; do
      docker info >/dev/null 2>&1 && break
      i=$((i+1)); sleep 2
    done
  fi
fi
if ! docker info >/dev/null 2>&1; then
  say "🔴 gateway: Docker daemon is DOWN — gateway/brain/MCP will all degrade this session. Start Docker Desktop."
  exit 4
fi

# ── compose command ──────────────────────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else say "gateway: no docker compose available"; exit 4; fi

# svc_context <service> — the service's BUILD CONTEXT dir, read from
# docker-compose.yml rather than assumed. The service name is NOT the
# directory: `gateway` builds from ./runtime. Handles both the inline form
# (`build: ./runtime`) and the nested form (`build:` + `context: ./x`).
# Falls back to the service name so a conventional layout still works.
# Directories that are OUTPUTS, not build inputs. Counting these would make
# the image look stale after every `npm test` (coverage/) or every build
# (dist/, .next/), producing a permanent false "STALE" and training everyone
# to ignore the signal.
PRUNE_DIRS='node_modules .next dist .turbo coverage .git __pycache__ .vitest'
# Pruned ONLY at the context root: runtime state the container itself writes
# (runtime/data/audit/*.jsonl grows every request). Matched by -path rather than
# -name so a genuine source dir like src/data/ is still counted as an input.
ROOT_ONLY_PRUNE='data logs tmp .cache'
# PRUNE[] — the find expression, built as an array so it needs no eval and no
# quote gymnastics: ( -name a -o -name b ... ) -prune -o
PRUNE=( \( ); _first=1
for _d in $PRUNE_DIRS; do
  [ "$_first" -eq 1 ] || PRUNE+=( -o )
  PRUNE+=( -name "$_d" ); _first=0
done
PRUNE+=( \) -prune -o )

# ctx_prune <dir> — PRUNE plus the root-only entries resolved against <dir>.
# Sets CTX_PRUNE[] (bash has no array return).
ctx_prune() {
  local dir="$1" d
  CTX_PRUNE=( \( )
  local f=1
  for d in $PRUNE_DIRS; do
    [ "$f" -eq 1 ] || CTX_PRUNE+=( -o )
    CTX_PRUNE+=( -name "$d" ); f=0
  done
  for d in $ROOT_ONLY_PRUNE; do
    CTX_PRUNE+=( -o -path "$dir/$d" )
  done
  CTX_PRUNE+=( \) -prune -o )
}

svc_context() {
  local svc="$1" ctx
  ctx="$(awk -v svc="$svc" '
    $0 ~ "^  " svc ":[[:space:]]*$" { inblk=1; next }
    inblk && /^  [a-zA-Z0-9_-]+:[[:space:]]*$/ { inblk=0 }
    inblk && $1 == "build:" && NF > 1 { print $2; exit }
    inblk && $1 == "context:" && NF > 1 { print $2; exit }
  ' "$ROOT/docker-compose.yml" 2>/dev/null | head -1)"
  ctx="${ctx#./}"
  [ -n "$ctx" ] || ctx="$svc"
  printf '%s\n' "$ctx"
}

# scan_ctx <dir> <ref_epoch> — ONE walk over the build context; prints
#   "<newest_epoch> <count_newer_than_ref> <newest_file>"
# Deliberately does NOT use `find -newermt "@<epoch>"`: BSD/macOS find cannot
# parse the @epoch form ("find: Can't parse date/time: @1787840259") and, with
# stderr discarded, silently returns ZERO matches — which read as "image is
# current" and would have made this whole check a no-op on the operator's Macs.
# Same GNU-vs-BSD class of bug AI_RULES §4 records for `stat`. Comparing
# stat(1) mtimes numerically in shell is portable on both.
scan_ctx() {
  local dir="$1" ref="$2" f mt newest=0 newest_f="" cnt=0
  ctx_prune "$dir"
  while IFS= read -r f; do
    mt="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)"
    case "$mt" in ''|*[!0-9]*) continue ;; esac
    if [ "$mt" -gt "$newest" ]; then newest="$mt"; newest_f="$f"; fi
    [ "$mt" -gt "$ref" ] && cnt=$((cnt+1))
  done <<INNER
$(find "$dir" "${CTX_PRUNE[@]}" -type f -print 2>/dev/null)
INNER
  printf '%s %s %s\n' "$newest" "$cnt" "$newest_f"
}

image_epoch() {   # image_epoch <container>
  local c="$1" img created
  img="$(docker inspect "$c" --format '{{.Image}}' 2>/dev/null)" || return 1
  [ -n "$img" ] || return 1
  created="$(docker image inspect "$img" --format '{{.Created}}' 2>/dev/null)" || return 1
  [ -n "$created" ] || return 1
  python3 - "$created" <<'PY' 2>/dev/null
import datetime,sys
s=sys.argv[1].split('.')[0].rstrip('Z')
print(int(datetime.datetime.fromisoformat(s).replace(tzinfo=datetime.timezone.utc).timestamp()))
PY
}

STALE="" DOWN=""
for svc in $SERVICES; do
  cname="myai-$svc"
  ctx="$ROOT/$(svc_context "$svc")"
  [ -d "$ctx" ] || continue
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$cname"; then
    DOWN="$DOWN $svc"; continue
  fi
  ie="$(image_epoch "$cname")"
  case "$ie" in ''|*[!0-9]*) continue ;; esac
  scan="$(scan_ctx "$ctx" "$ie")"
  se="${scan%% *}"; rest="${scan#* }"; cnt="${rest%% *}"; newest_f="${rest#* }"
  case "$se" in ''|*[!0-9]*) continue ;; esac
  if [ "$se" -gt "$ie" ]; then
    STALE="$STALE $svc"
    say "⚠️  gateway: '$svc' image is STALE — ${cnt} source file(s) newer than the running image (built $(date -r "$ie" '+%d %b %H:%M' 2>/dev/null); newest ${newest_f#$ROOT/} $(date -r "$se" '+%d %b %H:%M' 2>/dev/null))."
  fi
done

STALE="${STALE# }"; DOWN="${DOWN# }"
[ -z "$STALE" ] && [ -z "$DOWN" ] && { say "gateway: fresh (image >= source)"; exit 0; }
[ -n "$DOWN" ] && say "⚠️  gateway: not running: $DOWN"

if [ "$APPLY" != 1 ]; then
  say "    fix: ./scripts/gateway_ensure.sh --apply   (or --apply --background)"
  exit 3
fi

TARGETS="$(printf '%s %s\n' "$STALE" "$DOWN" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')"
TARGETS="${TARGETS% }"

do_rebuild() {
  {
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') rebuild: $TARGETS ==="
    # shellcheck disable=SC2086
    $DC build $TARGETS && $DC up -d $TARGETS
    echo "=== rc=$? done $(date '+%H:%M:%S') ==="
  } >>"$LOG" 2>&1
}

if [ "$BG" = 1 ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    now="$(date +%s)"
    mt="$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null)"
    case "$mt" in ''|*[!0-9]*) mt="$now" ;; esac
    if [ $(( now - mt )) -gt 1800 ]; then rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null; fi
  fi
  if [ -d "$LOCK" ] && [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    say "gateway: rebuild already running (pid $(cat "$LOCK/pid")) — see $LOG"
    exit 3
  fi
  ( do_rebuild; rmdir "$LOCK" 2>/dev/null ) >/dev/null 2>&1 &
  echo $! > "$LOCK/pid" 2>/dev/null
  say "🔧 gateway: rebuilding [$TARGETS] in the BACKGROUND (pid $!) — log: $LOG"
  exit 0
fi

say "🔧 gateway: rebuilding [$TARGETS] …"
do_rebuild
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'myai-gateway'; then
  say "gateway: rebuilt + up"
  exit 0
fi
say "🔴 gateway: rebuild finished but container is not running — see $LOG"
exit 3
