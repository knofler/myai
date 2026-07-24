#!/bin/bash
set +e
# Hook: CloudFormation / Bicep / ARM Template Validation
# Event: PreToolUse (Bash)
# Validates IaC templates before deployment commands

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# --- AWS CloudFormation ---
if echo "$COMMAND" | grep -qE 'aws\s+cloudformation\s+(create-stack|update-stack|deploy)'; then
  # Extract template file
  TEMPLATE=$(echo "$COMMAND" | grep -oP '(--template-body\s+file://|--template-file\s+)\K\S+' 2>/dev/null)

  if [ -n "$TEMPLATE" ] && [ -f "$TEMPLATE" ]; then
    echo "Validating CloudFormation template: $TEMPLATE"
    VALIDATE=$(aws cloudformation validate-template --template-body "file://$TEMPLATE" 2>&1)
    if [ $? -ne 0 ]; then
      echo "BLOCKED: CloudFormation template validation FAILED:"
      echo "$VALIDATE" | tail -5
      exit 2
    fi
    echo "CloudFormation template valid"
  fi
  exit 0
fi

# --- AWS CDK ---
if echo "$COMMAND" | grep -qE 'cdk\s+deploy'; then
  # Check if synth was run recently
  if [ ! -d "cdk.out" ] || [ -z "$(find cdk.out -name '*.template.json' -mmin -30 2>/dev/null)" ]; then
    echo "WARNING: No recent CDK synth output found."
    echo "Best practice: run 'cdk synth' first to review generated templates."
    echo "Then: cdk deploy"
  fi
  exit 0
fi

# --- Azure Bicep ---
if echo "$COMMAND" | grep -qE 'az\s+deployment\s+(group|sub)\s+create'; then
  TEMPLATE=$(echo "$COMMAND" | grep -oP '--template-file\s+\K\S+' 2>/dev/null)

  if [ -n "$TEMPLATE" ] && [ -f "$TEMPLATE" ]; then
    # Validate Bicep file
    if echo "$TEMPLATE" | grep -qE '\.bicep$'; then
      if command -v az &>/dev/null; then
        echo "Validating Bicep template: $TEMPLATE"
        VALIDATE=$(az bicep build --file "$TEMPLATE" 2>&1)
        if [ $? -ne 0 ]; then
          echo "BLOCKED: Bicep template validation FAILED:"
          echo "$VALIDATE" | tail -5
          exit 2
        fi
        echo "Bicep template valid"
      fi
    fi
  fi
  exit 0
fi

# --- Pulumi ---
if echo "$COMMAND" | grep -qE 'pulumi\s+up'; then
  if ! echo "$COMMAND" | grep -qE '--yes'; then
    echo "INFO: Pulumi will show a preview before applying. Good."
  else
    echo "WARNING: Pulumi --yes flag skips preview. Ensure you've reviewed the changes."
  fi
  exit 0
fi

exit 0
