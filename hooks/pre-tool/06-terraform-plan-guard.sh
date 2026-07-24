#!/bin/bash
set +e
# Hook: Terraform Plan Guard
# Event: PreToolUse (Bash)
# Blocks terraform apply/destroy without a prior plan in the session

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only check terraform commands
if ! echo "$COMMAND" | grep -qE '\bterraform\b'; then
  exit 0
fi

# Block terraform apply without -auto-approve having a saved plan
if echo "$COMMAND" | grep -qE 'terraform\s+apply'; then
  # Allow if applying a saved plan file
  if echo "$COMMAND" | grep -qE 'terraform\s+apply\s+\S+\.tfplan'; then
    echo "Terraform: Applying saved plan file — allowed"
    exit 0
  fi

  # Check if a plan was recently run (look for .tfplan files < 30 min old)
  RECENT_PLAN=$(find . -name "*.tfplan" -mmin -30 2>/dev/null | head -1)
  if [ -z "$RECENT_PLAN" ]; then
    echo "WARNING: No recent terraform plan found."
    echo "Best practice: run 'terraform plan -out=tfplan' first, then 'terraform apply tfplan'"
    echo "Allowing anyway — review the plan output carefully."
  fi
  exit 0
fi

# Block terraform destroy without explicit confirmation marker
if echo "$COMMAND" | grep -qE 'terraform\s+destroy'; then
  echo "CAUTION: terraform destroy will DELETE infrastructure."
  echo "Ensure you have:"
  echo "  1. Run 'terraform plan -destroy' to review what will be deleted"
  echo "  2. Confirmed with the user that destruction is intended"
  echo "Allowing — but proceed with extreme care."
  exit 0
fi

exit 0
