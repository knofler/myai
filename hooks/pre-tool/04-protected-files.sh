#!/bin/bash
set +e
# Hook: Protected File Guard
# Event: PreToolUse (Edit, Write, Bash)
# Blocks deletion of critical framework files and overwrites via Write tool.
#
# BLOCK REASONS GO TO STDERR (>&2): Claude Code surfaces only a failed
# PreToolUse hook's STDERR back to the operator/model. A reason echoed to
# stdout is invisible — the operator sees "No stderr output" and retries blind
# or splits the command until it slips through, defeating the guard (task-4fd69473).

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null)

# Protected files that should never be deleted or emptied
PROTECTED=(
  "STATE.md"
  "AI_AGENT_HANDOFF.md"
  "AI_RULES.md"
  "CLAUDE.md"
  "MULTI_AGENT_ROUTING.md"
  "docker-compose.yml"
  ".gitignore"
)

# ── Bash: block deletion of protected files ─────────────────────────────────
# A protected file is only in danger from a genuine DELETE. We must inspect the
# arguments of an actual `rm` invocation, NOT grep the whole command text —
# otherwise we false-block on things that are not deletions at all:
#   • `docker run --rm ...`  → --rm removes a CONTAINER, not a repo file
#   • a protected filename that merely appears inside an echo, a quoted string,
#     a here-doc body, or a git commit message
# Strategy: split the command into statements on shell separators, then, for
# each statement that ACTUALLY runs a destructive command, check only that
# statement's tokens for a protected basename.
if [ "$TOOL" = "Bash" ] && [ -n "$COMMAND" ]; then
  MATCHED_PF=""

  # True when a single statement is a genuine file deletion:
  #   • command word is `rm` / `*/rm` (after skipping sudo/env-assignment wrappers)
  #   • OR it pipes/execs into rm  (`xargs rm`, `find ... -exec rm`, `-execdir rm`)
  #   • OR it is a `find ... -delete`
  _stmt_is_destructive() {
    local -a t; read -ra t <<< "$1"
    local n=${#t[@]}; [ "$n" -eq 0 ] && return 1
    local i=0
    # skip leading sudo/command/time/nice/env, shell keywords, and VAR=value assigns
    while [ "$i" -lt "$n" ]; do
      case "${t[$i]}" in
        sudo|command|builtin|time|nice|env|then|do|else|"("|"{"|"!") i=$((i+1));;
        *=*) i=$((i+1));;
        *) break;;
      esac
    done
    local first="${t[$i]:-}"
    first="${first#[({]}"          # tolerate `(rm ...` / `{ rm ...`
    case "$first" in rm|*/rm) return 0;; esac
    # rm reached via a wrapper: `xargs rm`, `find -exec rm`, `-execdir rm`
    local j k
    for (( j=0; j<n; j++ )); do
      case "${t[$j]}" in
        xargs|-exec|-execdir)
          k=$((j+1))
          while [ "$k" -lt "$n" ]; do
            case "${t[$k]}" in -*|*=*) k=$((k+1));; *) break;; esac
          done
          case "${t[$k]:-}" in rm|*/rm) return 0;; esac ;;
        -delete) case "$first" in find|*/find) return 0;; esac ;;
      esac
    done
    return 1
  }

  # True when a (known-destructive) statement names a protected file.
  _stmt_hits_protected() {
    local -a t; read -ra t <<< "$1"
    local tok base pf
    for tok in "${t[@]}"; do
      tok="${tok#[\"\'({]}"          # strip one leading quote / ( / {
      tok="${tok%[\"\')]}"           # strip one trailing quote / )  (; already split on)
      [ -z "$tok" ] && continue
      base=$(basename -- "$tok" 2>/dev/null) || continue
      for pf in "${PROTECTED[@]}"; do
        if [ "$base" = "$pf" ]; then MATCHED_PF="$pf"; return 0; fi
      done
    done
    return 1
  }

  # Split on shell statement separators: || && ; |  (and embedded newlines).
  # Pure-bash substitution — avoids the BSD-vs-GNU sed `\n`-in-replacement trap.
  SPLIT="$COMMAND"
  SPLIT="${SPLIT//"||"/$'\n'}"
  SPLIT="${SPLIT//"&&"/$'\n'}"
  SPLIT="${SPLIT//";"/$'\n'}"
  SPLIT="${SPLIT//"|"/$'\n'}"
  while IFS= read -r stmt; do
    [ -z "${stmt//[[:space:]]/}" ] && continue
    if _stmt_is_destructive "$stmt" && _stmt_hits_protected "$stmt"; then
      echo "BLOCKED: Cannot delete protected file: $MATCHED_PF" >&2
      echo "This file is critical to the framework. Edit it instead." >&2
      exit 2
    fi
  done <<< "$SPLIT"
fi

# Check Write tool — block if writing empty/near-empty content to a protected file
if [ "$TOOL" = "Write" ] && [ -n "$FILE_PATH" ]; then
  BASENAME=$(basename "$FILE_PATH")
  for pf in "${PROTECTED[@]}"; do
    if [ "$BASENAME" = "$pf" ]; then
      # Block if content is empty or trivially small (< 10 chars)
      CONTENT_LEN=${#NEW_CONTENT}
      if [ "$CONTENT_LEN" -lt 10 ]; then
        echo "BLOCKED: Cannot overwrite protected file '$pf' with empty/trivial content." >&2
        echo "This file is critical to the framework." >&2
        exit 2
      fi
    fi
  done
fi

exit 0
