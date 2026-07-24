#!/bin/bash
set +e
# Hook: Framework Sync Reminder
# Event: PostToolUse (Edit, Write)
# Reminds to run update_all.sh after editing framework files

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only check Edit and Write tools
if [ "$TOOL" != "Edit" ] && [ "$TOOL" != "Write" ]; then
  exit 0
fi

# Framework files that need syncing when changed
SYNC_PATTERNS=(
  "agents/"
  "skills/"
  "documentation/AI_RULES.md"
  "documentation/MULTI_AGENT_ROUTING.md"
  "documentation/Instruction.md"
  "documentation/INTEGRATION_GUIDE.md"
  "templates/"
  "CLAUDE_TEMPLATE.md"
  "hooks/"
)

NEEDS_SYNC=false
for pattern in "${SYNC_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -q "$pattern"; then
    NEEDS_SYNC=true
    break
  fi
done

if [ "$NEEDS_SYNC" = true ]; then
  echo "REMINDER: Framework file edited — run ./scripts/update_all.sh to sync to managed repos"
fi

exit 0
