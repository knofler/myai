#!/usr/bin/env bash
# boot_machines.sh — parse config/boot_machines.txt (host[:days]) for the
# `boot` routine. Sourced by morning_boot.sh, setup_boot_schedule.sh and
# boot_sync.sh so all three agree on WHICH host boots on WHICH weekday.
#
# bash 3.2-safe (macOS system bash): no associative arrays, no mapfile.
#
#   boot_machines_days <file> <host>   → echo the host's launchd weekday list
#                                        ("1 2 3 4"), "1 2 3 4 5" when the entry
#                                        has no :days suffix. An exact host line
#                                        wins; otherwise the `*` line applies.
#                                        exit 1 + nothing only when neither
#                                        matches. A MISSING file = every host,
#                                        every day (universal default).
#
# UNIVERSAL BOOT (operator directive 2026-09-28): "each separate machine,
# separate agent, single git repo, single brain repo, dropbox ignore to avoid
# conflict, always sync with git and brain and dropbox file, boot is universal
# for all device always." Every Mac runs its own boot against its own local
# Docker stack; git + the brain repo are the sync, never Dropbox. A `*` line
# (committed config: `*:0-6`) is how a new Mac boots with zero config edits.
#   boot_machines_today <file> <host>  → exit 0 if today (date +%w, 0=Sun) is
#                                        one of the host's days.
#   boot_machines_hosts <file>         → echo "host days…" per line (status).

_bm_expand_days() {   # "1-4,6" → "1 2 3 4 6" (validated 0-6, sorted, deduped)
  local spec="$1" part lo hi d out=""
  [ -n "$spec" ] || spec="1-5"
  IFS=',' read -r -a _parts <<<"$spec"
  for part in "${_parts[@]}"; do
    part="$(printf '%s' "$part" | tr -d '[:space:]')"
    case "$part" in
      [0-6]-[0-6]) lo="${part%-*}"; hi="${part#*-}" ;;
      [0-6])       lo="$part"; hi="$part" ;;
      *) echo "boot_machines: bad day spec '$part' (want 0-6, ranges, commas)" >&2; return 1 ;;
    esac
    [ "$lo" -le "$hi" ] || { echo "boot_machines: bad range '$part'" >&2; return 1; }
    d=$lo
    while [ "$d" -le "$hi" ]; do out="$out $d"; d=$((d+1)); done
  done
  printf '%s\n' "$out" | tr ' ' '\n' | grep -v '^$' | sort -un | tr '\n' ' ' | sed 's/ $//'
}

boot_machines_days() {
  local file="$1" host="$2" line entry_host spec wild="" have_wild=0
  [ -f "$file" ] || { _bm_expand_days "0-6"; return $?; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue
    entry_host="${line%%:*}"
    spec=""; case "$line" in *:*) spec="${line#*:}" ;; esac
    if [ "$entry_host" = "$host" ]; then
      _bm_expand_days "$spec"
      return $?
    fi
    if [ "$entry_host" = "*" ] && [ "$have_wild" = 0 ]; then wild="$spec"; have_wild=1; fi
  done < "$file"
  if [ "$have_wild" = 1 ]; then _bm_expand_days "$wild"; return $?; fi
  return 1
}

boot_machines_today() {
  local days today
  days="$(boot_machines_days "$1" "$2")" || return 1
  today="${BOOT_MACHINES_TODAY:-$(date +%w)}"
  case " $days " in *" $today "*) return 0 ;; esac
  return 1
}

boot_machines_hosts() {
  local file="$1" line entry_host spec
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue
    entry_host="${line%%:*}"
    spec=""; case "$line" in *:*) spec="${line#*:}" ;; esac
    printf '%s %s\n' "$entry_host" "$(_bm_expand_days "$spec" 2>/dev/null || echo '?')"
  done < "$file"
}

# Human label for a day list: "1 2 3 4" → "Mon–Thu", "5" → "Fri", "1 3 5" → "Mon,Wed,Fri"
boot_machines_label() {
  local days="$1" names="Sun Mon Tue Wed Thu Fri Sat" first="" last="" prev="" d contiguous=1 out=""
  # shellcheck disable=SC2086  # intentional word-split: "1 2 3 4" → positional days
  set -- $days
  [ $# -gt 0 ] || { echo "never"; return; }
  first=$1; last=${!#}
  for d in "$@"; do
    [ -n "$prev" ] && [ "$d" -ne $((prev+1)) ] && contiguous=0
    prev=$d
  done
  _nm() { echo "$names" | cut -d' ' -f$(( $1 + 1 )); }
  if [ "$contiguous" = 1 ] && [ $# -gt 1 ]; then
    echo "$(_nm "$first")–$(_nm "$last")"
  else
    for d in "$@"; do out="${out:+$out,}$(_nm "$d")"; done
    echo "$out"
  fi
}
