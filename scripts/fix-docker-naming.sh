#!/bin/bash
set +e
# Fix Docker container naming across ALL managed repos
# Enforces: container_name must use exact folder name as prefix
# Usage: ./scripts/fix-docker-naming.sh [--apply]
#
# Without --apply: dry-run (shows what would change)
# With --apply: actually modifies docker-compose.yml files

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"
DRY_RUN=true

if [ "$1" = "--apply" ]; then
  DRY_RUN=false
  echo "=== APPLYING CHANGES ==="
else
  echo "=== DRY RUN (use --apply to actually change files) ==="
fi
echo ""

FIXED=0
SKIPPED=0
ALREADY_OK=0

while IFS= read -r repo_path || [ -n "$repo_path" ]; do
  [[ -z "$repo_path" ]] || [[ "$repo_path" == \#* ]] && continue
  repo_path="${repo_path/#\~/$HOME}"
  [ ! -d "$repo_path" ] && continue

  COMPOSE="$repo_path/docker-compose.yml"
  [ ! -f "$COMPOSE" ] && continue

  # Prefer `name:` field from docker-compose.yml over folder name
  COMPOSE_NAME=$(grep -m1 '^name:' "$COMPOSE" 2>/dev/null | sed 's/^name:[[:space:]]*//' | tr -d ' "'"'"'' | tr -d '\r')
  if [ -n "$COMPOSE_NAME" ]; then
    PROJECT="$COMPOSE_NAME"
  else
    PROJECT=$(basename "$repo_path")
  fi

  echo "── $PROJECT ($repo_path)"

  # Check current container_name entries
  NAMES=$(grep 'container_name:' "$COMPOSE" 2>/dev/null)
  if [ -z "$NAMES" ]; then
    echo "   No container_name directives — skipping"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Check if all names already comply
  ALL_OK=true
  while IFS= read -r line; do
    NAME=$(echo "$line" | sed 's/.*container_name:[[:space:]]*//' | tr -d ' "'"'"'' | tr -d '\r')
    if [ -n "$NAME" ] && [[ "$NAME" != ${PROJECT}-* ]] && [[ "$NAME" != ${PROJECT}_* ]]; then
      ALL_OK=false
    fi
  done <<< "$NAMES"

  if [ "$ALL_OK" = true ]; then
    echo "   OK — all names use '${PROJECT}-' prefix"
    ALREADY_OK=$((ALREADY_OK + 1))
    continue
  fi

  # Build sed replacements
  # Common patterns: {old-prefix}-app → {PROJECT}-app
  # We detect the current prefix from the first container_name
  FIRST_NAME=$(echo "$NAMES" | head -1 | sed 's/.*container_name:[[:space:]]*//' | tr -d ' "'"'"'' | tr -d '\r')
  # Extract prefix (everything before the last -suffix like -app, -mongo, -api, etc.)
  OLD_PREFIX=$(echo "$FIRST_NAME" | sed 's/-\(app\|mongo\|api\|web\|redis\|worker\|nginx\|express\|mongo-express\)$//')

  if [ -z "$OLD_PREFIX" ] || [ "$OLD_PREFIX" = "$FIRST_NAME" ]; then
    echo "   Cannot detect old prefix from: $FIRST_NAME — manual fix needed"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "   Old prefix: '$OLD_PREFIX' → New prefix: '$PROJECT'"

  if [ "$DRY_RUN" = true ]; then
    echo "   Would replace: container_name: ${OLD_PREFIX}-* → ${PROJECT}-*"
    echo "   Current names:"
    echo "$NAMES" | sed 's/^/     /'
  else
    # Stop containers first
    echo "   Stopping containers..."
    (cd "$repo_path" && docker compose down --remove-orphans 2>/dev/null) || true

    # Remove old containers by name
    docker rm -f $(docker ps -a --filter "name=${OLD_PREFIX}" -q) 2>/dev/null || true

    # Fix docker-compose.yml — replace old prefix with new
    sed -i '' "s/container_name:[[:space:]]*${OLD_PREFIX}-/container_name: ${PROJECT}-/g" "$COMPOSE"
    sed -i '' "s/container_name:[[:space:]]*${OLD_PREFIX}_/container_name: ${PROJECT}-/g" "$COMPOSE"

    echo "   Fixed. New names:"
    grep 'container_name:' "$COMPOSE" | sed 's/^/     /'

    # Also fix any COMPOSE_PROJECT_NAME or network references
    # Update network name if it uses old prefix
    sed -i '' "s/${OLD_PREFIX}-network/${PROJECT}-network/g" "$COMPOSE" 2>/dev/null || true
    sed -i '' "s/${OLD_PREFIX}_network/${PROJECT}-network/g" "$COMPOSE" 2>/dev/null || true
  fi

  FIXED=$((FIXED + 1))
  echo ""
done < "$TRACKING_FILE"

echo ""
echo "=== SUMMARY ==="
echo "  Already compliant: $ALREADY_OK"
echo "  Fixed: $FIXED"
echo "  Skipped (no compose or manual fix needed): $SKIPPED"

if [ "$DRY_RUN" = true ] && [ "$FIXED" -gt 0 ]; then
  echo ""
  echo "Run with --apply to actually make changes:"
  echo "  ./scripts/fix-docker-naming.sh --apply"
fi
