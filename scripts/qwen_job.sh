#!/usr/bin/env bash
# qwen_job.sh — queue ONE job for the qwen lane (scripts/qwen_lane.sh) with one
# command. The job is a mail to <host>/qwen whose body is JSON; the lane reads
# the files itself, asks the local model once, and mails the answer (kind=done)
# or the failure (kind=blocker) back to the address this job was sent FROM — so
# run it from your own session and the reply lands in your mailbox.
#
# Usage:
#   qwen_job.sh --files '<glob>' [--files '<glob>' ...] --prompt "..." \
#               [--max-lines N] [--model qwen3:8b] [--timeout SECS] [--max-chars N] \
#               [--from <addr>] [--to <addr>] [--dry-run]
#   Globs are relative to the repo root (files outside it are refused by the lane).
#   --from  default: this session's lane address (<host>/<profile>, else <host>/<repo>)
#   --to    default: <host>/qwen
#   --dry-run  print the job JSON, send nothing
#
# Example (the proof job):
#   scripts/qwen_job.sh --files 'state/boot/BOOT_REPORT.*.md' \
#     --prompt "List FAIL/WARN rows that repeat across these boot reports, one line each."
# bash 3.2-safe. Tests: scripts/tests/test_qwen_lane.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_LC="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"

files_json="" prompt="" max_lines="" model="" timeout="" max_chars="" from="" to="" dry=0
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --files)     files_json="$files_json${files_json:+$'\n'}${2:?--files needs a glob}"; shift 2 ;;
    --prompt)    prompt="${2:?--prompt needs text}"; shift 2 ;;
    --max-lines) max_lines="${2:?}"; shift 2 ;;
    --model)     model="${2:?}"; shift 2 ;;
    --timeout)   timeout="${2:?}"; shift 2 ;;
    --max-chars) max_chars="${2:?}"; shift 2 ;;
    --from)      from="${2:?}"; shift 2 ;;
    --to)        to="${2:?}"; shift 2 ;;
    --dry-run)   dry=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "qwen_job: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$prompt" ] || { echo "qwen_job: --prompt is required" >&2; exit 2; }
if [ -z "$to" ]; then
  # A Mac with no local LLM (fleet role profile local_llm=off) sends its jobs to
  # an office Mac's qwen lane instead (config/fleet_roles.txt).
  # shellcheck source=scripts/lib/fleet_role.sh
  . "$SCRIPT_DIR/lib/fleet_role.sh" 2>/dev/null || true
  if command -v fleet_local_llm_allowed >/dev/null 2>&1 && ! fleet_local_llm_allowed && [ -n "$(fleet_qwen_host)" ]; then
    to="$(fleet_qwen_host)/qwen"
  else
    to="$HOST_LC/qwen"
  fi
fi

if [ -z "$from" ]; then
  # shellcheck source=scripts/lib/session_registry.sh
  . "$SCRIPT_DIR/lib/session_registry.sh" 2>/dev/null || true
  prof="$(session_profile 2>/dev/null || echo default)"
  if [ -n "$prof" ] && [ "$prof" != default ]; then from="$HOST_LC/$prof"; else from="$HOST_LC/ai_management"; fi
fi

job="$(FILES="$files_json" PROMPT="$prompt" ML="$max_lines" MODEL="$model" TO_="$timeout" MC="$max_chars" python3 -c '
import json, os
j = {"files": [f for f in os.environ["FILES"].split("\n") if f], "prompt": os.environ["PROMPT"]}
for env_key, key in (("ML", "maxLines"), ("TO_", "timeout"), ("MC", "maxChars")):
    if os.environ.get(env_key):
        j[key] = int(os.environ[env_key])
if os.environ.get("MODEL"):
    j["model"] = os.environ["MODEL"]
print(json.dumps(j))
')" || { echo "qwen_job: could not build the job (numeric flags must be integers)" >&2; exit 2; }

if [ "$dry" = 1 ]; then printf 'to=%s from=%s\n%s\n' "$to" "$from" "$job"; exit 0; fi

TELL_LIB_ONLY=1
# shellcheck source=scripts/tell.sh
. "$SCRIPT_DIR/tell.sh"
subject="qwen job: $(printf '%s' "$prompt" | head -1 | cut -c1-100)"
if mid="$(_tell_mail_send "$to" "$from" "$subject" request "" "$job")"; then
  echo "qwen_job: queued $mid → $to (reply comes back to $from)"
else
  echo "qwen_job: mail_send failed — is the gateway up? (myai status)" >&2; exit 1
fi
