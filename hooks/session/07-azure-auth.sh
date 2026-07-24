#!/bin/bash
set +e
# Hook: Azure Auth Check
# Event: SessionStart
# Verifies Azure CLI is authenticated for IaC operations

if ! command -v az &>/dev/null; then
  echo "Azure CLI not installed — skipping Azure auth check"
  exit 0
fi

# Check login status with 5s timeout
RESULT=$(timeout 5 az account show 2>&1)

if [ $? -eq 0 ]; then
  NAME=$(echo "$RESULT" | jq -r '.name' 2>/dev/null)
  SUB_ID=$(echo "$RESULT" | jq -r '.id' 2>/dev/null)
  TENANT=$(echo "$RESULT" | jq -r '.tenantId' 2>/dev/null)
  STATE=$(echo "$RESULT" | jq -r '.state' 2>/dev/null)
  echo "Azure: Authenticated"
  echo "  Subscription: $NAME ($STATE)"
  echo "  Sub ID: $SUB_ID"
  echo "  Tenant: $TENANT"
else
  echo "Azure: Not authenticated"
  echo "  Run: az login"
fi

exit 0
