#!/usr/bin/env bash
# runner_selfhosted.sh — manage this host's self-hosted GitHub Actions runners.
#
# WHY: GitHub-hosted minutes on a private repo are metered; self-hosted runners
# consume ZERO billable minutes. Every repo outside an exempt org (config/hosted_runner_orgs.txt) runs CI here
# (CLAUDE.md rule 9 / AI_RULES §21).
#
# ONE PROJECT, N RUNNERS (2026-10-22): every runner, for every repo, is one of
# the generic slots gh-runner-1..8 in docker-compose.yml, in compose project
# `myai` — never its own project or compose file (a runner defined outside that
# file is an orphan there, and `down --remove-orphans` destroys it). Which slot
# holds which repo/instance is per host: ~/.myai/runners/slots.<host>
# (scripts/lib/runner_slots.sh). Every compose call targets ONE slot service;
# nothing here ever runs a project-wide up or down.
#
# Usage:
#   runner_selfhosted.sh up [owner/repo] [--count N | --instance N]
#        start (and register, if new) instances 1..N of that repo's runner.
#        N: --count, else config/gh_runners.txt for this host, else what runs
#        now, else 1. --instance N starts ONLY that one (e.g. add instance 2
#        beside a pre-slot instance 1 that has not been migrated yet). A running
#        instance is never recreated. Then rebalance.
#   runner_selfhosted.sh status [owner/repo]   containers + GitHub online/busy
#   runner_selfhosted.sh check                 one OK/WARN line per runner (boot)
#   runner_selfhosted.sh list                  the slot table
#   runner_selfhosted.sh logs [owner/repo] [--instance N]
#   runner_selfhosted.sh down [owner/repo] [--instance N]   stop (registration kept)
#   runner_selfhosted.sh reset [owner/repo] [--instance N]  deregister + wipe volume
#   runner_selfhosted.sh rebalance             re-split the host budget (docker update)
#   runner_selfhosted.sh migrate [--dry-run] [--timeout SECONDS]
#        move pre-slot runners (service `gh-runner`, any project) into slots
#        WITHOUT re-registering: drain (labels → myai-draining, restored by a
#        trap), wait until GitHub says busy=false, stop the old container, start
#        the slot on the SAME volume, wait for Online, restore the labels, then
#        remove the old container. Any failure rolls back.
#
# Default repo: this checkout's origin. Sizing: config/gh_runner_mem.txt is the
# host's TOTAL runner budget, split by weight (config/gh_runners.txt).
#
# SAFETY: only point a self-hosted runner at a repo you control — on a PUBLIC
# repo a forked PR could execute untrusted code on this machine.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# SELF-COPY GUARD: the long verbs run from a private copy of this file. bash
# reads a script incrementally, so an edit to it during a run corrupts the run
# (2026-10-22: a migrate died with "unexpected EOF" while the file was edited).
if [ -z "${RS_SELF_COPY:-}" ]; then
  case "${1:-}" in
    up|migrate|reset|down|rebalance)
      _rs_copy="$(mktemp "${TMPDIR:-/tmp}/runner_selfhosted.XXXXXX")" \
        && cp "$0" "$_rs_copy" \
        && RS_SELF_COPY="$_rs_copy" RS_HERE="$HERE" RS_SELF="$0" exec bash "$_rs_copy" "$@"
      ;;
  esac
fi
HERE="${RS_HERE:-$HERE}"
SELF="${RS_SELF:-$0}"   # the real path, for messages (under the guard $0 is the copy)
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="${RUNNER_COMPOSE_FILE:-$ROOT/docker-compose.yml}"
PROJECT="myai"
# shellcheck source=/dev/null
. "$HERE/lib/runner_mem.sh"
# shellcheck source=/dev/null
. "$HERE/lib/runner_slots.sh"

ONLINE_WAIT="${RUNNER_ONLINE_WAIT:-90}"
# A migrated runner reuses its registration, so GitHub holds the old
# container's session for a few minutes ("A session for this runner already
# exists … Conflict. Retrying until reconnected") before the new one connects.
MIGRATE_ONLINE_WAIT="${RUNNER_MIGRATE_ONLINE_WAIT:-600}"
POLL="${RUNNER_POLL:-2}"
DRAIN_POLL="${RUNNER_DRAIN_POLL:-15}"
DRAIN_LABEL="myai-draining"
DEFAULT_LABELS="self-hosted,linux,ARM64,myai-local"

die() { echo "FATAL: $*" >&2; exit 1; }

# need_compose_env — compose interpolates the WHOLE file on every call (the app
# services carry mandatory vars + env_file .env), so with no .env beside it
# every slot call fails. Fail fast, once, before touching any runner — a
# worktree without .env is a normal state (2026-10-22: a migrate from one
# rolled back runner by runner instead).
need_compose_env() {
  local envf
  envf="$(dirname "$COMPOSE_FILE")/.env"
  [ -f "$envf" ] && return 0
  die "no .env next to $COMPOSE_FILE — docker compose cannot load that file without it. In a worktree, link the main checkout's: ln -s <main checkout>/.env $envf"
}

# ── args ─────────────────────────────────────────────────────────────────────
VERB="${1:-status}"; [ $# -gt 0 ] && shift
REPO_ARG=""; COUNT=""; INSTANCE=""; DRY=0; DRAIN_TIMEOUT="${RUNNER_DRAIN_TIMEOUT:-3600}"
while [ $# -gt 0 ]; do
  case "$1" in
    --count) [ $# -ge 2 ] || die "--count needs a number"; COUNT="$2"; shift 2 ;;
    --instance) [ $# -ge 2 ] || die "--instance needs a number"; INSTANCE="$2"; shift 2 ;;
    --timeout) [ $# -ge 2 ] || die "--timeout needs seconds"; DRAIN_TIMEOUT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -*) die "unknown flag $1" ;;
    *) REPO_ARG="$1"; shift ;;
  esac
done
for v in "$COUNT" "$INSTANCE" "$DRAIN_TIMEOUT"; do
  case "$v" in ''|*[!0-9]*) [ -z "$v" ] || die "not a number: $v" ;; esac
done

# owner/repo from a slug or clone URL.
norm_slug() {
  local s="$1"
  case "$s" in
    https://github.com/*) s="${s#https://github.com/}" ;;
    git@github.com:*)     s="${s#git@github.com:}" ;;
  esac
  s="${s%.git}"; printf '%s' "${s%/}"
}
default_slug() { norm_slug "$(git -C "$ROOT" remote get-url origin 2>/dev/null)"; }
SLUG="$(norm_slug "${REPO_ARG:-$(default_slug)}")"
case "$VERB" in check|list|rebalance|migrate|help|-h|--help) ;;
  *) case "$SLUG" in */*) ;; *) die "no repo: pass owner/repo (origin of $ROOT not found)" ;; esac ;;
esac

# ── touchpoints ──────────────────────────────────────────────────────────────
need_gh() {
  command -v gh >/dev/null 2>&1 || die "gh CLI not found"
  gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"
}
# gh_runners <slug> → "<id>\t<name>\t<status>\t<busy>\t<custom,labels>" per runner.
gh_runners() {
  gh api --paginate "repos/$1/actions/runners" \
    --jq '.runners[] | [(.id|tostring), .name, .status, (.busy|tostring), ([.labels[] | select(.type=="custom") | .name] | join(","))] | @tsv' 2>/dev/null
}
gh_runner() { gh_runners "$1" | awk -F'\t' -v n="$2" '$2 == n { print; exit }'; }
mint_token() { gh api -X POST "repos/$1/actions/runners/registration-token" --jq .token 2>/dev/null; }
# gh_set_labels <slug> <id> <comma,custom,labels> — replace the custom labels
# (empty → remove them all).
gh_set_labels() {
  if [ -z "$3" ]; then
    gh api -X DELETE "repos/$1/actions/runners/$2/labels" >/dev/null 2>&1
  else
    printf '%s' "$3" | /usr/bin/python3 -c 'import json,sys; print(json.dumps({"labels": [l for l in sys.stdin.read().split(",") if l]}))' \
      | gh api -X PUT "repos/$1/actions/runners/$2/labels" --input - >/dev/null 2>&1
  fi
}
container_running() { docker ps --filter "name=^/$1\$" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
container_exists()  { docker ps -a --filter "name=^/$1\$" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
# vol_runner_name <volume> → the agentName registered in that volume ("" if none).
vol_runner_name() {
  docker run --rm -v "$1:/c" alpine:3 \
    sh -c 'sed -n "s/.*\"agentName\": *\"\([^\"]*\)\".*/\1/p" /c/.runner 2>/dev/null' 2>/dev/null | tr -d '\r'
}
wait_seconds() { sleep "$1"; }

# slot_env <slot> [token] [labels] — export that slot's GH_RUNNER_<n>_* values
# from its state row and its budget share.
slot_env() {
  local s="$1" share
  share="$(rs_share "$s")"
  export "GH_RUNNER_${s}_CONTAINER=$(rs_field "$s" 4)"
  export "GH_RUNNER_${s}_VOLUME=$(rs_field "$s" 5)"
  export "GH_RUNNER_${s}_NAME=$(rs_field "$s" 6)"
  export "GH_RUNNER_${s}_REPO_URL=https://github.com/$(rs_field "$s" 2)"
  export "GH_RUNNER_${s}_TOKEN=${2:-}"
  export "GH_RUNNER_${s}_LABELS=${3:-$DEFAULT_LABELS}"
  export "GH_RUNNER_${s}_MEM=$(printf '%s' "$share" | cut -f1)"
  export "GH_RUNNER_${s}_CPUS=$(printf '%s' "$share" | cut -f2)"
}
# dc_slot <slot> <compose verb…> — compose scoped to project myai + ONE slot.
dc_slot() {
  local s="$1"; shift
  COMPOSE_IGNORE_ORPHANS=1 docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile "gh-runner-$s" "$@" "gh-runner-$s"
}

# wait_online <slug> <name> → 0 once GitHub reports it online.
wait_online() {
  local i=0 tries step
  step="$POLL"; [ "$step" -gt 0 ] 2>/dev/null || step=1
  tries=$((ONLINE_WAIT / step)); [ "$tries" -gt 0 ] || tries=1
  while [ "$i" -lt "$tries" ]; do
    [ "$(gh_runner "$1" "$2" | cut -f3)" = online ] && return 0
    wait_seconds "$POLL"; i=$((i + 1))
  done
  return 1
}

# wait_offline <slug> <name> → best effort: give GitHub up to ONLINE_WAIT to
# notice the old container stopped, so the new one's "online" is really its own.
wait_offline() {
  local i=0 tries step
  step="$POLL"; [ "$step" -gt 0 ] 2>/dev/null || step=1
  tries=$((ONLINE_WAIT / step)); [ "$tries" -gt 0 ] || tries=1
  while [ "$i" -lt "$tries" ]; do
    [ "$(gh_runner "$1" "$2" | cut -f3)" = online ] || return 0
    wait_seconds "$POLL"; i=$((i + 1))
  done
  return 1
}
# wait_listening <container> → 0 once its runner logs "Listening for Jobs" (idle,
# connected) — the runner's own word that it is ready, not just "Up".
wait_listening() {
  local i=0 tries step
  step="$POLL"; [ "$step" -gt 0 ] 2>/dev/null || step=1
  tries=$((ONLINE_WAIT / step)); [ "$tries" -gt 0 ] || tries=1
  while [ "$i" -lt "$tries" ]; do
    docker logs --tail 50 "$1" 2>&1 | grep -q 'Listening for Jobs' && return 0
    wait_seconds "$POLL"; i=$((i + 1))
  done
  return 1
}

# ── verbs ────────────────────────────────────────────────────────────────────
# legacy_rows → "<container>\t<project>" for every pre-slot runner container.
legacy_rows() {
  docker ps -a --filter "label=com.docker.compose.service=gh-runner" \
    --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}' 2>/dev/null
}
# legacy_info <container> → "<owner/repo>\t<volume>" from its env + mount.
legacy_info() {
  local url vol
  url="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n 's/^REPO_URL=//p' | head -1)"
  vol="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/runner/actions-runner"}}{{.Name}}{{end}}{{end}}' "$1" 2>/dev/null)"
  printf '%s\t%s\n' "$(norm_slug "$url")" "$vol"
}

# ensure_instance <slug> <instance> — start (registering if needed) one runner.
ensure_instance() {
  local slug="$1" inst="$2" slot names container volume name labels base token l
  if ! slot="$(rs_find "$slug" "$inst")"; then
    if [ "$inst" = 1 ]; then
      while IFS="$(printf '\t')" read -r l _p; do
        [ -n "$l" ] || continue
        [ "$(legacy_info "$l" | cut -f1)" = "$slug" ] && die "$slug already has a pre-slot runner ($l) — run: $SELF migrate"
      done <<EOF
$(legacy_rows)
EOF
    fi
    slot="$(rs_free_slot)" || die "all $RS_MAX runner slots on $(rs_host) are taken"
    names="$(rs_names "$slug" "$inst")"
    name="$(printf '%s' "$names" | cut -f3)"
    # RUNNER_NAME pins instance 1's GitHub name (e.g. a host registered before
    # the per-host default existed).
    if [ "$inst" = 1 ] && [ -n "${RUNNER_NAME:-}" ]; then name="$RUNNER_NAME"; fi
    rs_put "$slot" "$slug" "$inst" "$(printf '%s' "$names" | cut -f1)" "$(printf '%s' "$names" | cut -f2)" "$name"
  fi
  container="$(rs_field "$slot" 4)"; volume="$(rs_field "$slot" 5)"; name="$(rs_field "$slot" 6)"
  if container_running "$container"; then
    echo "  slot $slot: $container already running ($name) — not recreated"
    return 0
  fi
  # Collision pre-flight: a registered name this host's volume does not own
  # belongs to ANOTHER machine — registering (config.sh --replace) would steal it.
  if [ -n "$(gh_runner "$slug" "$name")" ] && [ "$(vol_runner_name "$volume")" != "$name" ] && [ "${RUNNER_REPLACE:-0}" != 1 ]; then
    die "a runner named '$name' is registered on $slug but volume $volume is not it — another machine owns it. Pick RUNNER_NAME or set RUNNER_REPLACE=1 if certain."
  fi
  labels="${GH_RUNNER_LABELS:-$DEFAULT_LABELS}"
  if [ "$inst" != 1 ] && [ -z "${GH_RUNNER_LABELS:-}" ] && base="$(rs_find "$slug" 1)"; then
    l="$(gh_runner "$slug" "$(rs_field "$base" 6)" | cut -f5)"
    [ -n "$l" ] && labels="self-hosted,linux,ARM64,$l"
  fi
  token="$(mint_token "$slug")"
  [ -n "$token" ] || die "could not mint a registration token (need admin on $slug)"
  slot_env "$slot" "$token" "$labels"
  echo "  slot $slot: starting $container ($name, volume $volume, mem $(rs_share "$slot" | cut -f1), cpus $(rs_share "$slot" | cut -f2))"
  dc_slot "$slot" up -d --build || die "compose up failed for slot $slot"
  wait_online "$slug" "$name" || die "'$name' not Online after ${ONLINE_WAIT}s — check: $SELF logs $slug --instance $inst"
  echo "  ✅ $name Online"
}

do_rebalance() {
  local s c share
  for s in $(rs_rows | cut -f1); do
    c="$(rs_field "$s" 4)"; share="$(rs_share "$s")"
    # every EXISTING slot container — a stopped one too, so a later `docker
    # start` comes up at its share, not at the share it was created with.
    if container_exists "$c"; then
      docker update --memory "$(printf '%s' "$share" | cut -f1)" --memory-swap "$(printf '%s' "$share" | cut -f1)" \
        --cpus "$(printf '%s' "$share" | cut -f2)" "$c" >/dev/null 2>&1 \
        && echo "  $c → mem $(printf '%s' "$share" | cut -f1), cpus $(printf '%s' "$share" | cut -f2)" \
        || echo "  ⚠ could not update $c"
    fi
  done
}

do_up() {
  local n i
  need_compose_env
  need_gh
  n="${COUNT:-$(rs_desired_count "$SLUG")}"
  [ -n "$n" ] || n="$(rs_instances "$SLUG" | tail -1)"
  [ -n "$n" ] || n=1
  if [ -n "$INSTANCE" ]; then
    echo "▶ $SLUG: instance $INSTANCE only on $(rs_host)"
    ensure_instance "$SLUG" "$INSTANCE"
  else
    echo "▶ $SLUG: $n runner(s) on $(rs_host)"
    i=1
    while [ "$i" -le "$n" ]; do ensure_instance "$SLUG" "$i"; i=$((i + 1)); done
  fi
  echo "▶ rebalancing the host budget"
  do_rebalance
}

do_status() {
  local s r c
  echo "── runners on $(rs_host) (project $PROJECT) ──"
  for s in $(rs_rows | cut -f1); do
    r="$(rs_field "$s" 2)"
    [ -z "$REPO_ARG" ] || [ "$r" = "$SLUG" ] || continue
    c="$(rs_field "$s" 4)"
    printf '  slot %s  %-38s %s\n' "$s" "$c" "$(docker ps -a --filter "name=^/$c\$" --format '{{.Status}}' 2>/dev/null | head -1)"
  done
  need_gh
  echo "── registered at GitHub ($SLUG) ──"
  gh_runners "$SLUG" | awk -F'\t' '{ printf "  %s  status=%s  busy=%s  labels=[%s]\n", $2, $3, $4, $5 }'
}

# do_check → one line per runner; rc 0 when every runner is Up AND Online.
do_check() {
  local s r c n st gh ghs rc=0 any=0
  for s in $(rs_rows | cut -f1); do
    any=1
    r="$(rs_field "$s" 2)"; c="$(rs_field "$s" 4)"; n="$(rs_field "$s" 6)"
    if container_running "$c"; then st=up
    elif container_exists "$c"; then st="stopped (start: $SELF up $r)"
    else st=missing; fi
    gh="$(gh_runner "$r" "$n")"
    ghs="not registered"; [ -n "$gh" ] && ghs="$(printf '%s' "$gh" | cut -f3)"
    if [ "$st" = up ] && [ "$ghs" = online ]; then
      echo "OK   $c ($r, $n): up, online, $( [ "$(printf '%s' "$gh" | cut -f4)" = true ] && echo busy || echo idle)"
    elif [ "$st" != up ] && [ "$st" != missing ] && rs_stopped_by_choice "$r"; then
      echo "OK   $c ($r, $n): stopped by choice (config/gh_runners.txt)"
    else
      rc=1
      echo "WARN $c ($r, $n): container $st, github $ghs"
    fi
  done
  if [ "$any" = 0 ]; then
    if [ -n "$(legacy_rows)" ]; then echo "WARN pre-slot runners only — run: $SELF migrate"; else echo "WARN no runners configured on $(rs_host)"; fi
    return 1
  fi
  return "$rc"
}

instances_for_verb() { if [ -n "$INSTANCE" ]; then echo "$INSTANCE"; else rs_instances "$SLUG"; fi; }

do_down() {
  local i s
  need_compose_env
  for i in $(instances_for_verb); do
    s="$(rs_find "$SLUG" "$i")" || { echo "  no instance $i for $SLUG"; continue; }
    slot_env "$s"
    dc_slot "$s" stop || die "could not stop slot $s (is .env present?)"
    dc_slot "$s" rm -f || die "could not remove slot $s"
    echo "  stopped $(rs_field "$s" 4) (registration kept — 'up' restarts it)"
  done
}

do_reset() {
  local i s v n id
  need_compose_env
  need_gh
  for i in $(instances_for_verb); do
    s="$(rs_find "$SLUG" "$i")" || { echo "  no instance $i for $SLUG"; continue; }
    v="$(rs_field "$s" 5)"; n="$(rs_field "$s" 6)"
    slot_env "$s"
    # Local teardown must fully succeed before the GitHub-side deletion, or the
    # volume keeps a .runner whose registration is gone and auth-fails forever.
    dc_slot "$s" stop || die "could not stop slot $s"
    dc_slot "$s" rm -f || die "could not remove slot $s"
    if docker volume inspect "$v" >/dev/null 2>&1; then
      docker volume rm "$v" >/dev/null || die "could not remove volume $v — registration left intact on purpose"
    fi
    id="$(gh_runner "$SLUG" "$n" | cut -f1)"
    [ -n "$id" ] && gh api -X DELETE "repos/$SLUG/actions/runners/$id" >/dev/null 2>&1 && echo "  deregistered $n (id $id)"
    rs_del "$s"
    echo "  reset instance $i ($n)"
  done
}

# ── migrate ──────────────────────────────────────────────────────────────────
R_SLUG=""; R_ID=""; R_LABELS=""; R_ARMED=0
restore_labels() {
  if [ "$R_ARMED" = 1 ]; then
    gh_set_labels "$R_SLUG" "$R_ID" "$R_LABELS" && echo "  labels restored on runner $R_ID: [${R_LABELS}]" \
      || echo "  ⚠ could not restore labels on runner $R_ID ($R_SLUG) — set them back to [${R_LABELS}] by hand"
    R_ARMED=0
  fi
}
rs_cleanup() { if [ -n "${RS_SELF_COPY:-}" ]; then rm -f "$RS_SELF_COPY" 2>/dev/null || true; fi; }
trap 'restore_labels; rs_cleanup' EXIT
trap 'restore_labels; rs_cleanup; exit 130' INT TERM

# migrate_one <old container> <old project>
migrate_one() {
  local old="$1" proj="$2" info slug vol name gh id labels slot names waited=0 container
  info="$(legacy_info "$old")"; slug="$(printf '%s' "$info" | cut -f1)"; vol="$(printf '%s' "$info" | cut -f2)"
  [ -n "$slug" ] && [ -n "$vol" ] || { echo "  ⚠ $old: cannot read its repo/volume — skipped"; return 1; }
  name="$(vol_runner_name "$vol")"
  [ -n "$name" ] || { echo "  ⚠ $old: volume $vol holds no registration — skipped"; return 1; }
  if rs_find "$slug" 1 >/dev/null; then echo "  ⚠ $old: $slug instance 1 already has a slot — skipped"; return 1; fi
  names="$(rs_names "$slug" 1)"; container="$(printf '%s' "$names" | cut -f1)"
  if [ "$DRY" = 1 ]; then
    echo "  would move $old (project $proj, $slug, runner $name, volume $vol, $(container_running "$old" && echo running || echo STOPPED — stays stopped)) → $container in project $PROJECT"
    return 0
  fi
  # A STOPPED runner was stopped on purpose: move it without starting it (no
  # job can be running, so no drain) — the slot container is created, not run.
  if ! container_running "$old"; then
    slot="$(rs_free_slot)" || { echo "  ⚠ no free slot"; return 1; }
    rs_put "$slot" "$slug" 1 "$container" "$vol" "$name"
    slot_env "$slot"
    if dc_slot "$slot" up --no-start && container_exists "$container"; then
      docker rm "$old" >/dev/null 2>&1 || echo "  ⚠ could not remove $old — remove it by hand"
      if [ "$proj" != "$PROJECT" ]; then docker network rm "${proj}_default" >/dev/null 2>&1 || true; fi
      echo "  ✅ $old was stopped — moved to $container in slot $slot, still stopped (start: $SELF up $slug)"
      return 0
    fi
    rs_del "$slot"; echo "  ✗ could not create $container — $old left untouched"; return 1
  fi
  gh="$(gh_runner "$slug" "$name")"
  [ -n "$gh" ] || { echo "  ⚠ $old: runner '$name' is not registered on $slug — skipped"; return 1; }
  id="$(printf '%s' "$gh" | cut -f1)"; labels="$(printf '%s' "$gh" | cut -f5)"
  echo "▶ $old → $container ($slug, runner $name, volume $vol)"
  # 1. drain: no label any workflow asks for, so GitHub assigns it nothing new.
  R_SLUG="$slug"; R_ID="$id"; R_LABELS="$labels"; R_ARMED=1
  gh_set_labels "$slug" "$id" "$DRAIN_LABEL" || { restore_labels; echo "  ⚠ could not drain $name — skipped"; return 1; }
  echo "  draining (labels [$labels] → [$DRAIN_LABEL])"
  # 2. never kill a job: wait until GitHub reports it idle.
  while [ "$(gh_runner "$slug" "$name" | cut -f4)" != false ]; do
    if [ "$waited" -ge "$DRAIN_TIMEOUT" ]; then
      restore_labels; echo "  ⚠ $name still busy (or unreadable) after ${DRAIN_TIMEOUT}s — left as is"; return 1
    fi
    wait_seconds "$DRAIN_POLL"; waited=$((waited + (DRAIN_POLL > 0 ? DRAIN_POLL : 1)))
  done
  echo "  idle — switching"
  # 3. stop old, start the slot on the SAME volume (no re-registration).
  slot="$(rs_free_slot)" || { restore_labels; echo "  ⚠ no free slot"; return 1; }
  rs_put "$slot" "$slug" 1 "$container" "$vol" "$name"
  docker stop -t 60 "$old" >/dev/null 2>&1 || { rs_del "$slot"; restore_labels; echo "  ⚠ could not stop $old"; return 1; }
  wait_offline "$slug" "$name" || echo "  (GitHub still shows $name online — continuing; the listening check below decides)"
  slot_env "$slot" "" "self-hosted,linux,ARM64${labels:+,$labels}"
  echo "  waiting up to ${MIGRATE_ONLINE_WAIT}s for $container to connect (GitHub may hold the old session for a few minutes)"
  if dc_slot "$slot" up -d && container_running "$container" \
     && ONLINE_WAIT="$MIGRATE_ONLINE_WAIT" wait_listening "$container" \
     && ONLINE_WAIT="$MIGRATE_ONLINE_WAIT" wait_online "$slug" "$name"; then
    restore_labels
    docker rm "$old" >/dev/null 2>&1 || echo "  ⚠ could not remove $old — remove it by hand"
    if [ "$proj" != "$PROJECT" ]; then docker network rm "${proj}_default" >/dev/null 2>&1 || true; fi
    echo "  ✅ $container Online in slot $slot (old $old removed)"
    return 0
  fi
  echo "  ✗ $container did not come Online within ${MIGRATE_ONLINE_WAIT}s — rolling back. Its last log lines:"
  docker logs --tail 12 "$container" 2>&1 | sed 's/^/      /'
  dc_slot "$slot" rm -sf >/dev/null 2>&1 || true
  rs_del "$slot"
  docker start "$old" >/dev/null 2>&1 || echo "  ⚠ could not restart $old — start it by hand"
  restore_labels
  return 1
}

do_migrate() {
  local rows c p rc=0
  if [ "$DRY" = 0 ]; then need_compose_env; need_gh; fi
  rows="$(legacy_rows)"
  [ -n "$rows" ] || { echo "nothing to migrate — no pre-slot runner containers on $(rs_host)"; return 0; }
  while IFS="$(printf '\t')" read -r c p; do
    [ -n "$c" ] || continue
    migrate_one "$c" "$p" || rc=1
  done <<EOF
$rows
EOF
  if [ "$DRY" = 0 ]; then echo "▶ rebalancing the host budget"; do_rebalance; fi
  return "$rc"
}

case "$VERB" in
  up) do_up ;;
  status) do_status ;;
  check) do_check ;;
  list) rs_rows | awk -F'\t' 'BEGIN { print "slot\trepo\tinstance\tcontainer\tvolume\tname" } { print }' ;;
  logs) need_compose_env; s="$(rs_find "$SLUG" "${INSTANCE:-1}")" || die "no instance ${INSTANCE:-1} for $SLUG"; slot_env "$s"; dc_slot "$s" logs -f --tail=100 ;;
  down) do_down ;;
  reset) do_reset ;;
  rebalance) do_rebalance ;;
  migrate) do_migrate ;;
  help|-h|--help) sed -n '2,38p' "$SELF" | sed 's/^# \{0,1\}//' ;;
  *) sed -n '2,38p' "$SELF" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
