#!/bin/bash
set +e
# Hook: AWS Auth Check
# Event: SessionStart
# Verifies AWS CLI credentials are valid for IaC operations

if ! command -v aws &>/dev/null; then
  echo "AWS CLI not installed — skipping AWS auth check"
  exit 0
fi

# Check if any AWS config exists
if [ ! -f "$HOME/.aws/credentials" ] && [ -z "$AWS_ACCESS_KEY_ID" ]; then
  echo "AWS: No credentials configured (no ~/.aws/credentials, no env vars)"
  exit 0
fi

# Verify identity with 5s timeout
RESULT=$(timeout 5 aws sts get-caller-identity 2>&1)

if [ $? -eq 0 ]; then
  ACCOUNT=$(echo "$RESULT" | jq -r '.Account' 2>/dev/null)
  ARN=$(echo "$RESULT" | jq -r '.Arn' 2>/dev/null)
  REGION=$(aws configure get region 2>/dev/null || echo "not set")
  echo "AWS: Authenticated"
  echo "  Account: $ACCOUNT"
  echo "  Identity: $ARN"
  echo "  Region: $REGION"
else
  echo "AWS: Authentication FAILED"
  echo "  $RESULT" | tail -2
  echo "  Run: aws configure  OR  export AWS_ACCESS_KEY_ID=..."
fi

exit 0
