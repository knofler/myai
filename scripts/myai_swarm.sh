#!/usr/bin/env bash
# myai_swarm.sh — `myai swarm …`: this device's swarm master.
#
#   myai swarm master set [--agent A --profile DIR --repo R]   choose it (asks when no flags)
#   myai swarm master show                                     print the per-device config
#   myai swarm master list                                     detected agents/profiles
#   myai swarm master check                                    OK / WARN / RED (lease + watcher)
#   myai swarm master migrate [--check|--dry-run]              legacy hosts (myai upgrade runs it)
#   myai swarm master [who|take|release|stop …]                scripts/swarm_master.sh verbs
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

[ "${1:-}" = master ] || { usage >&2; exit 2; }
shift
case "${1:-who}" in
  set|show|list|migrate) exec bash "$HERE/swarm_master_set.sh" "$@" ;;
  -h|--help|help) usage ;;
  *) exec bash "$HERE/swarm_master.sh" "$@" ;;
esac
