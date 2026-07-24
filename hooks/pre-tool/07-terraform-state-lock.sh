#!/bin/bash
set +e
# Hook: Terraform State Lock Check
# Event: PreToolUse (Bash)
# Warns if terraform state is locked before apply/plan

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only check terraform plan/apply/destroy
if ! echo "$COMMAND" | grep -qE 'terraform\s+(plan|apply|destroy)'; then
  exit 0
fi

# Check for local lock file
if [ -f ".terraform.tfstate.lock.info" ]; then
  LOCK_INFO=$(cat .terraform.tfstate.lock.info 2>/dev/null)
  LOCK_WHO=$(echo "$LOCK_INFO" | jq -r '.Who // "unknown"' 2>/dev/null)
  LOCK_CREATED=$(echo "$LOCK_INFO" | jq -r '.Created // "unknown"' 2>/dev/null)
  echo "WARNING: Terraform state is LOCKED"
  echo "  Locked by: $LOCK_WHO"
  echo "  Created: $LOCK_CREATED"
  echo "  If stale, unlock with: terraform force-unlock <LOCK_ID>"
  echo "Allowing command — terraform will fail if lock is still held."
fi

# Check for .terraform directory existence (init required)
if echo "$COMMAND" | grep -qE 'terraform\s+(plan|apply)' && [ ! -d ".terraform" ]; then
  echo "WARNING: .terraform directory not found. Run 'terraform init' first."
fi

exit 0
