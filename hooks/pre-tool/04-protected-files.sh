#!/bin/bash
set +e
# Hook: Protected File Guard
# Event: PreToolUse (Edit, Write, Bash)
# Blocks deletion of critical framework files and overwrites via Write tool

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

# Check Bash commands for rm/delete of protected files
if [ "$TOOL" = "Bash" ] && [ -n "$COMMAND" ]; then
  if echo "$COMMAND" | grep -qE '\brm\b'; then
    for pf in "${PROTECTED[@]}"; do
      # Match exact basename (not substrings)
      if echo "$COMMAND" | grep -qE "(^|/|[[:space:]])${pf}([[:space:]]|$)"; then
        echo "BLOCKED: Cannot delete protected file: $pf"
        echo "This file is critical to the framework. Edit it instead."
        exit 2
      fi
    done
  fi
fi

# Check Write tool — block if writing empty/near-empty content to a protected file
if [ "$TOOL" = "Write" ] && [ -n "$FILE_PATH" ]; then
  BASENAME=$(basename "$FILE_PATH")
  for pf in "${PROTECTED[@]}"; do
    if [ "$BASENAME" = "$pf" ]; then
      # Block if content is empty or trivially small (< 10 chars)
      CONTENT_LEN=${#NEW_CONTENT}
      if [ "$CONTENT_LEN" -lt 10 ]; then
        echo "BLOCKED: Cannot overwrite protected file '$pf' with empty/trivial content."
        echo "This file is critical to the framework."
        exit 2
      fi
    fi
  done
fi

exit 0
