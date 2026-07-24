#!/bin/bash
set +e
# ============================================================
# Generate Project — Workspace Setup Helper
# ============================================================
# Creates the project workspace directory structure for the
# generation pipeline. The actual generation is done by Claude
# Code directly using the `generate [idea]` keyword.
#
# Usage:
#   ./scripts/generate-project.sh "project name" "idea description"
#   ./scripts/generate-project.sh my-app "SaaS dashboard for fitness"
#   ./scripts/generate-project.sh --scan /path/to/project my-app "enhance with notifications"
#   ./scripts/generate-project.sh --status [project-name]
#   ./scripts/generate-project.sh --list
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECTS_DIR="$AI_ROOT/projects"
STAGES_CONFIG="$AI_ROOT/config/generation-stages.json"

# Parse args
PROJECT_NAME=""
IDEA=""
SCAN_PATH=""
STATUS_FLAG=false
LIST_FLAG=false

while [ $# -gt 0 ]; do
  case "$1" in
    --scan) SCAN_PATH="$2"; shift 2 ;;
    --status) STATUS_FLAG=true; PROJECT_NAME="${2:-}"; shift; [ -n "$PROJECT_NAME" ] && shift ;;
    --list) LIST_FLAG=true; shift ;;
    --help)
      echo "Usage:"
      echo "  ./scripts/generate-project.sh <name> \"idea description\""
      echo "  ./scripts/generate-project.sh --scan /path/to/project <name> \"idea\""
      echo "  ./scripts/generate-project.sh --status [project-name]"
      echo "  ./scripts/generate-project.sh --list"
      echo ""
      echo "Or use the 'generate' keyword directly in Claude Code:"
      echo "  generate \"SaaS dashboard for fitness tracking\""
      exit 0
      ;;
    *)
      if [ -z "$PROJECT_NAME" ]; then
        PROJECT_NAME="$1"
      elif [ -z "$IDEA" ]; then
        IDEA="$1"
      fi
      shift
      ;;
  esac
done

# List all projects
if [ "$LIST_FLAG" = true ]; then
  if [ ! -d "$PROJECTS_DIR" ]; then
    echo "No projects directory found."
    exit 0
  fi
  echo "Projects:"
  for dir in "$PROJECTS_DIR"/*/; do
    [ ! -d "$dir" ] && continue
    name=$(basename "$dir")
    manifest="$dir/project.json"
    if [ -f "$manifest" ]; then
      status=$(python3 -c "import json; print(json.load(open('$manifest'))['status'])" 2>/dev/null || echo "unknown")
      completed=$(python3 -c "import json; print(len(json.load(open('$manifest')).get('stages_completed',[])))" 2>/dev/null || echo "?")
      echo "  $name  — $status ($completed/8 stages)"
    else
      echo "  $name  — no manifest"
    fi
  done
  exit 0
fi

# Show status for a specific project
if [ "$STATUS_FLAG" = true ]; then
  if [ -z "$PROJECT_NAME" ]; then
    echo "Usage: ./scripts/generate-project.sh --status <project-name>"
    exit 1
  fi
  manifest="$PROJECTS_DIR/$PROJECT_NAME/project.json"
  if [ ! -f "$manifest" ]; then
    echo "Project not found: $PROJECT_NAME"
    exit 1
  fi
  python3 -c "
import json
m = json.load(open('$manifest'))
print(f\"Project: {m['name']}\")
print(f\"Status:  {m['status']}\")
print(f\"Current: {m['current_stage']}\")
print(f\"Idea:    {m['idea'][:100]}\")
print()
stages = ['idea','plan','brd','gap-analysis','trd','design','build','ship']
completed = m.get('stages_completed', [])
for s in stages:
    icon = 'done' if s in completed else 'pending'
    print(f'  [{icon}] {s}')
"
  exit 0
fi

# Create project workspace
if [ -z "$PROJECT_NAME" ] || [ -z "$IDEA" ]; then
  echo "Usage: ./scripts/generate-project.sh <name> \"idea description\""
  echo "       ./scripts/generate-project.sh --help"
  exit 1
fi

# Slugify project name
SLUG=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g')
PROJECT_DIR="$PROJECTS_DIR/$SLUG"

if [ -d "$PROJECT_DIR" ]; then
  echo "Project already exists: $SLUG"
  echo "  Path: $PROJECT_DIR"
  echo "  Use --status $SLUG to check progress"
  exit 1
fi

# Create directory structure
mkdir -p "$PROJECT_DIR/stages" "$PROJECT_DIR/artifacts" "$PROJECT_DIR/code"

# Run scan if requested
SCAN_REPORT=""
if [ -n "$SCAN_PATH" ]; then
  echo "Scanning existing project: $SCAN_PATH"
  "$SCRIPT_DIR/scan-project.sh" "$SCAN_PATH" --json > /dev/null 2>&1
  SCAN_FILE="$SCAN_PATH/AI/scan-report.json"
  if [ -f "$SCAN_FILE" ]; then
    SCAN_REPORT="$SCAN_FILE"
    echo "Scan report: $SCAN_FILE"
  fi
fi

# Write project manifest
cat > "$PROJECT_DIR/project.json" <<MANIFESTEOF
{
  "name": "$SLUG",
  "idea": $(python3 -c "import json; print(json.dumps('$IDEA'))" 2>/dev/null || echo "\"$IDEA\""),
  "status": "generating",
  "current_stage": "idea",
  "stages_completed": [],
  "stages_failed": [],
  $([ -n "$SCAN_REPORT" ] && echo "\"scan_report\": \"$SCAN_REPORT\"," || true)
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANIFESTEOF

# Create empty stage files
for stage in idea plan brd gap-analysis trd design build ship; do
  STAGE_UPPER=$(echo "$stage" | sed 's/\b./\U&/g' 2>/dev/null || echo "$stage")
  echo "# $STAGE_UPPER

*Pending generation*" > "$PROJECT_DIR/stages/$stage.md"
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  PROJECT CREATED: $SLUG"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Path:   $PROJECT_DIR"
echo "  Stages: $PROJECT_DIR/stages/"
echo "  Config: $STAGES_CONFIG"
echo ""
echo "Next: Use Claude Code to generate content:"
echo "  generate \"$IDEA\""
echo ""
echo "Or generate each stage manually by reading config/generation-stages.json"
echo "and writing to projects/$SLUG/stages/<stage>.md"
