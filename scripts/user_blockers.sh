#!/usr/bin/env bash
# user_blockers.sh — read/write config/user_blockers.md, the one canonical
# fleet-wide tracker for user-owed credentials/decisions. Replaces re-typing
# the same blocker list into every repo's handoff prose every session.
#
# Usage:
#   ./scripts/user_blockers.sh add <repo> "<blocker>" ["<notes>"]
#   ./scripts/user_blockers.sh resolve <id>
#   ./scripts/user_blockers.sh list [--open]
#
# The table lives between the USER_BLOCKERS_TABLE_START/END markers in
# config/user_blockers.md as a plain markdown table: id | repo | blocker |
# requested | status | notes. Hand-editing the table is fine — this script
# just automates the common add/resolve/list operations.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
FILE="${USER_BLOCKERS_FILE:-$REPO_ROOT/config/user_blockers.md}"
START_MARK="<!-- USER_BLOCKERS_TABLE_START -->"
END_MARK="<!-- USER_BLOCKERS_TABLE_END -->"

today() {
  # Overridable for tests; otherwise real UTC date.
  echo "${USER_BLOCKERS_TODAY:-$(date -u +%Y-%m-%d)}"
}

usage() {
  echo "Usage: $0 add <repo> \"<blocker>\" [\"<notes>\"]" >&2
  echo "       $0 resolve <id>" >&2
  echo "       $0 list [--open]" >&2
  exit 1
}

# Extract just the table body rows (no header/separator, no markers) as raw
# pipe-delimited lines.
table_rows() {
  [ -f "$FILE" ] || return 0
  awk -v s="$START_MARK" -v e="$END_MARK" '
    $0 == s { in_table = 1; next }
    $0 == e { in_table = 0; next }
    in_table && /^\|/ { print }
  ' "$FILE" | tail -n +3  # drop header row + separator row
}

next_id() {
  local max=0 id
  while IFS='|' read -r _ id _; do
    id="$(echo "$id" | tr -d ' ')"
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    (( id > max )) && max=$id
  done < <(table_rows)
  echo $(( max + 1 ))
}

cmd_add() {
  [ $# -ge 2 ] || usage
  local repo="$1" blocker="$2" notes="${3:-}"
  [ -f "$FILE" ] || { echo "$FILE not found" >&2; exit 1; }
  grep -qF "$START_MARK" "$FILE" || { echo "table markers not found in $FILE" >&2; exit 1; }

  local id row tmp
  id="$(next_id)"
  row="| $id | $repo | $blocker | $(today) | open | $notes |"
  tmp="$(mktemp)"

  awk -v mark="$END_MARK" -v row="$row" '
    $0 == mark { print row }
    { print }
  ' "$FILE" > "$tmp" && mv "$tmp" "$FILE"

  echo "added #$id: $repo — $blocker"
}

cmd_resolve() {
  [ $# -ge 1 ] || usage
  local target="$1" tmp status
  [ -f "$FILE" ] || { echo "$FILE not found" >&2; exit 1; }

  status="$(table_rows | awk -v target="$target" 'BEGIN{FS="|"} { id=$2; gsub(/ /,"",id); if (id==target) { s=$6; gsub(/ /,"",s); print s } }')"
  if [ -z "$status" ]; then
    echo "no blocker with id $target" >&2
    exit 1
  fi
  if [ "$status" = "resolved" ]; then
    echo "already resolved #$target"
    return 0
  fi

  tmp="$(mktemp)"
  awk -v target="$target" -v resolved_date="$(today)" -v s="$START_MARK" -v e="$END_MARK" '
    BEGIN { FS="|"; OFS="|" }
    $0 == s { in_table = 1; print; next }
    $0 == e { in_table = 0; print; next }
    in_table && /^\|/ && NF >= 6 {
      id = $2; gsub(/ /, "", id)
      if (id == target) {
        # rebuild row with status=resolved and a resolved-date note appended
        repo=$3; blocker=$4; requested=$5; notes=$7
        gsub(/^ +| +$/, "", repo); gsub(/^ +| +$/, "", blocker)
        gsub(/^ +| +$/, "", requested); gsub(/^ +| +$/, "", notes)
        printf "| %s | %s | %s | %s | resolved | %s (resolved %s) |\n", id, repo, blocker, requested, notes, resolved_date
        next
      }
    }
    { print }
  ' "$FILE" > "$tmp"

  mv "$tmp" "$FILE"
  echo "resolved #$target"
}

cmd_list() {
  local open_only=0
  [ "${1:-}" = "--open" ] && open_only=1
  local line repo blocker requested status notes id
  while IFS='|' read -r _ id repo blocker requested status notes _; do
    id="$(echo "$id" | xargs)"; repo="$(echo "$repo" | xargs)"
    blocker="$(echo "$blocker" | xargs)"; requested="$(echo "$requested" | xargs)"
    status="$(echo "$status" | xargs)"; notes="$(echo "$notes" | xargs)"
    [ "$open_only" -eq 1 ] && [ "$status" != "open" ] && continue
    printf '#%s [%s] %-14s %-45s requested %s%s\n' \
      "$id" "$status" "$repo" "$blocker" "$requested" \
      "$([ -n "$notes" ] && echo " — $notes" || echo "")"
  done < <(table_rows)
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    add) cmd_add "$@" ;;
    resolve) cmd_resolve "$@" ;;
    list) cmd_list "$@" ;;
    *) usage ;;
  esac
}

main "$@"
