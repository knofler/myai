#!/bin/bash
set +e
# Hook: Cloud Cost Estimate Guard
# Event: PreToolUse (Bash)
# Warns about potentially expensive cloud operations

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# --- High-cost AWS operations ---
EXPENSIVE_AWS=(
  "aws rds create-db-instance"
  "aws ec2 run-instances"
  "aws eks create-cluster"
  "aws elasticache create-replication-group"
  "aws redshift create-cluster"
  "aws sagemaker create-endpoint"
  "aws ecs create-service"
  "aws elb create-load-balancer"
  "aws elbv2 create-load-balancer"
  "aws ec2 create-nat-gateway"
)

for pattern in "${EXPENSIVE_AWS[@]}"; do
  if echo "$COMMAND" | grep -qiE "$pattern"; then
    echo "COST WARNING: This AWS operation creates billable infrastructure."
    echo "  Command: $pattern"
    echo "  Recommendation: Check pricing first, set budget alerts."

    # Check if infracost is available
    if command -v infracost &>/dev/null; then
      echo "  Tip: Run 'infracost breakdown --path .' for cost estimates."
    fi
    exit 0  # Warn but allow
  fi
done

# --- High-cost Azure operations ---
EXPENSIVE_AZURE=(
  "az vm create"
  "az aks create"
  "az sql server create"
  "az cosmosdb create"
  "az redis create"
  "az appservice plan create"
  "az cognitive-services account create"
)

for pattern in "${EXPENSIVE_AZURE[@]}"; do
  if echo "$COMMAND" | grep -qiE "$pattern"; then
    echo "COST WARNING: This Azure operation creates billable infrastructure."
    echo "  Command: $pattern"
    echo "  Recommendation: Check pricing tier, set spending limits."
    exit 0  # Warn but allow
  fi
done

# --- Terraform with large instance types ---
if echo "$COMMAND" | grep -qE 'terraform\s+apply'; then
  # Check if plan output mentions expensive instance types
  PLAN_FILE=$(find . -name "*.tfplan" -mmin -30 2>/dev/null | head -1)
  if [ -n "$PLAN_FILE" ] && command -v infracost &>/dev/null; then
    echo "TIP: Run 'infracost breakdown --path .' for cost estimate before applying."
  fi
fi

exit 0
