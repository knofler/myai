#!/usr/bin/env bash
# runner_slots.sh — which self-hosted runner lives in which docker-compose slot
# on THIS host, what it is called, and how much of the host's runner budget it
# gets (2026-10-22: more runner capacity, every runner inside project myai).
#
# docker-compose.yml defines generic slots gh-runner-1..RS_MAX (no repo names
# ship there). This lib maps them, per host, in the state file
#   ${MYAI_HOME:-~/.myai}/runners/slots.<host>      (never Dropbox)
# one row per runner, tab-separated:
#   <slot>  <owner/repo>  <instance>  <container>  <volume>  <runner name>
#
# Names: container myai-gh-runner-<repo>[-N]; volume <repo>-gh-runner-config[-N]
# (instance 1 keeps whatever volume already holds its registration); runner
# name myai-<host>[-N].
#
# Sizing: config/gh_runner_mem.txt (scripts/lib/runner_mem.sh) is this host's
# TOTAL runner budget. It is split across the host's runners by weight —
# config/gh_runners.txt `<host|*> <owner/repo> <count> [weight] [stopped]`,
# weight default 1. A trailing `stopped` marks that repo's runners stopped BY
# CHOICE on that host: `check` reports them OK, not WARN.
#
# bash 3.2-safe; safe under `set -euo pipefail`. Touchpoints are plain
# functions so tests can stub them.

RS_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RS_MAX="${RS_MAX:-8}"

rs_host()  { hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || true; }
rs_dir()   { printf '%s/runners' "${MYAI_HOME:-$HOME/.myai}"; }
rs_state() { printf '%s/slots.%s' "$(rs_dir)" "$(rs_host)"; }
rs_conf()  { printf '%s' "${GH_RUNNERS_CONF:-$RS_HERE/../../config/gh_runners.txt}"; }

# rs_repo_name <owner/repo> → repo
rs_repo_name() { printf '%s' "${1##*/}"; }

# rs_rows → the state rows (no comments/blank lines).
rs_rows() {
  local f; f="$(rs_state)"
  [ -f "$f" ] || return 0
  awk -F'\t' '!/^#/ && NF >= 6' "$f"
}

# rs_field <slot> <col> → one field of that slot's row (2 repo … 6 name).
rs_field() { rs_rows | awk -F'\t' -v s="$1" -v c="$2" '$1 == s { print $c; exit }'; }

# rs_find <owner/repo> <instance> → slot (rc 1 when none).
rs_find() {
  local s
  s="$(rs_rows | awk -F'\t' -v r="$1" -v i="$2" '$2 == r && $3 == i { print $1; exit }')"
  [ -n "$s" ] || return 1
  printf '%s' "$s"
}

# rs_instances <owner/repo> → the instance numbers this host runs for <repo>.
rs_instances() { rs_rows | awk -F'\t' -v r="$1" '$2 == r { print $3 }' | sort -n; }

# rs_free_slot → the lowest unused slot number (rc 1 when all RS_MAX are taken).
rs_free_slot() {
  local n=1 used
  used=" $(rs_rows | cut -f1 | tr '\n' ' ') "
  while [ "$n" -le "$RS_MAX" ]; do
    case "$used" in *" $n "*) ;; *) printf '%s' "$n"; return 0 ;; esac
    n=$((n + 1))
  done
  return 1
}

# rs_names <owner/repo> <instance> → "<container>\t<volume>\t<runner name>"
# for a NEW row (an existing row keeps its own values).
rs_names() {
  local repo sfx=""
  repo="$(rs_repo_name "$1")"
  if [ "$2" != 1 ]; then sfx="-$2"; fi
  printf 'myai-gh-runner-%s%s\t%s-gh-runner-config%s\tmyai-%s%s\n' "$repo" "$sfx" "$repo" "$sfx" "$(rs_host)" "$sfx"
}

# rs_put <slot> <owner/repo> <instance> <container> <volume> <name> — upsert.
rs_put() {
  local f tmp
  f="$(rs_state)"; mkdir -p "$(rs_dir)" 2>/dev/null || return 1
  tmp="$f.tmp.$$"
  { [ -f "$f" ] && awk -F'\t' -v s="$1" '$1 != s' "$f"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6"
  } | sort -n > "$tmp" && mv -f "$tmp" "$f"
}

# rs_del <slot>
rs_del() {
  local f tmp
  f="$(rs_state)"; [ -f "$f" ] || return 0
  tmp="$f.tmp.$$"
  awk -F'\t' -v s="$1" '$1 != s' "$f" > "$tmp" && mv -f "$tmp" "$f"
}

# _rs_conf_row <owner/repo> → "<count> <weight> <state>" from gh_runners.txt
# for this host (exact host row, else `*`); state is "stopped" or "-"; empty
# when the repo has no row.
_rs_conf_row() {
  local conf host
  conf="$(rs_conf)"; [ -f "$conf" ] || return 0
  host="$(rs_host)"
  awk -v h="$host" -v r="$1" '
    /^[[:space:]]*#/ || NF < 3 { next }
    $2 != r { next }
    tolower($1) == h && !ex { ex = $3 " " ($4 == "" ? 1 : $4) " " ($5 == "stopped" ? "stopped" : "-") }
    $1 == "*" && !st { st = $3 " " ($4 == "" ? 1 : $4) " " ($5 == "stopped" ? "stopped" : "-") }
    END { if (ex != "") print ex; else if (st != "") print st }' "$conf"
}

# rs_desired_count <owner/repo> → the configured count for this host (empty = no row).
rs_desired_count() { _rs_conf_row "$1" | awk '{ print $1 }'; }
# rs_weight <owner/repo> → its per-runner weight (default 1).
rs_weight() { local w; w="$(_rs_conf_row "$1" | awk '{ print $2 }')"; printf '%s' "${w:-1}"; }
# rs_stopped_by_choice <owner/repo> → 0 when this host's row marks it `stopped`.
rs_stopped_by_choice() { [ "$(_rs_conf_row "$1" | awk '{ print $3 }')" = stopped ]; }

# _rs_mb <docker size> → megabytes ("16g" → 16384, "512m" → 512).
_rs_mb() {
  printf '%s' "$1" | awk '{
    v = tolower($0); n = v + 0
    if (v ~ /g$/) n = n * 1024; else if (v ~ /k$/) n = n / 1024; else if (v ~ /b$/) n = n / 1048576
    printf "%d", n }'
}

# rs_share <slot> [extra-weight] → "<mem>\t<cpus>" for that slot: the host budget
# (resolve_runner_mem / resolve_runner_cpus) × its weight ÷ the total weight of
# every row in the state file (+ extra-weight for runners about to be added).
# Floors: 512m and 0.5 cpu.
rs_share() {
  local slot="$1" extra="${2:-0}" budget cpus total w r
  if ! command -v resolve_runner_mem >/dev/null 2>&1; then
    # shellcheck source=/dev/null
    . "$RS_HERE/runner_mem.sh"
  fi
  budget="$(_rs_mb "${GH_RUNNER_MEM_LIMIT:-$(resolve_runner_mem)}")"
  cpus="${GH_RUNNER_CPUS:-$(resolve_runner_cpus)}"
  total="$extra"
  for r in $(rs_rows | cut -f2); do total=$((total + $(rs_weight "$r"))); done
  r="$(rs_field "$slot" 2)"
  w="$(rs_weight "$r")"
  [ "$total" -gt 0 ] || total="$w"
  awk -v b="$budget" -v c="$cpus" -v w="$w" -v t="$total" 'BEGIN {
    m = int(b * w / t); if (m < 512) m = 512
    p = c * w / t; if (p < 0.5) p = 0.5
    printf "%dm\t%.1f\n", m, p }'
}
