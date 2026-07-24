#!/bin/bash
# Install the Connect Hub module into a Next.js project
# Usage: ./scripts/init_connect.sh /path/to/project
#
# What it does:
#   1. Copies model files to src/models/
#   2. Copies API route files to src/app/api/connect/
#   3. Copies page files to src/app/connect/
#   4. Auto-detects DB and auth import paths
#   5. Replaces template placeholders with detected paths
#   6. Adds /connect and /api/connect to middleware protected paths
#   7. Exports new models from models/index.ts barrel
#   8. Reports what was installed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$AI_ROOT/templates/connect"
TARGET="${1:?Usage: init_connect.sh /path/to/project}"

# Validate target
if [ ! -d "$TARGET/src" ]; then
  echo "Error: $TARGET/src not found. Is this a Next.js project?"
  exit 1
fi

echo "Installing Connect Hub into: $TARGET"
echo ""

# --- Auto-detect imports ---

# Find DB connection import
DB_IMPORT="@/lib/db"
if [ -f "$TARGET/src/lib/db.ts" ]; then
  DB_IMPORT="@/lib/db"
elif [ -f "$TARGET/src/lib/database.ts" ]; then
  DB_IMPORT="@/lib/database"
elif [ -f "$TARGET/src/lib/mongoose.ts" ]; then
  DB_IMPORT="@/lib/mongoose"
elif [ -f "$TARGET/src/lib/mongodb.ts" ]; then
  DB_IMPORT="@/lib/mongodb"
fi
echo "  DB import: $DB_IMPORT"

# Find auth import
AUTH_IMPORT="@/lib/api-auth"
if [ -f "$TARGET/src/lib/api-auth.ts" ]; then
  AUTH_IMPORT="@/lib/api-auth"
elif [ -f "$TARGET/src/lib/auth.ts" ]; then
  AUTH_IMPORT="@/lib/auth"
elif [ -f "$TARGET/src/lib/auth-helpers.ts" ]; then
  AUTH_IMPORT="@/lib/auth-helpers"
fi
echo "  Auth import: $AUTH_IMPORT"

# Models path
MODELS_PATH="@/models"
echo "  Models path: $MODELS_PATH"
echo ""

# --- Copy models ---
echo "  Copying models..."
mkdir -p "$TARGET/src/models"
cp "$TEMPLATE_DIR/models/BugReport.ts" "$TARGET/src/models/"
cp "$TEMPLATE_DIR/models/FeatureRequest.ts" "$TARGET/src/models/"
cp "$TEMPLATE_DIR/models/HelpArticle.ts" "$TARGET/src/models/"
echo "    - BugReport.ts"
echo "    - FeatureRequest.ts"
echo "    - HelpArticle.ts"

# --- Copy API routes (with placeholder replacement) ---
echo "  Copying API routes..."
mkdir -p "$TARGET/src/app/api/connect/bugs/[id]"
mkdir -p "$TARGET/src/app/api/connect/features/[id]/vote"
mkdir -p "$TARGET/src/app/api/connect/help/[id]/feedback"
mkdir -p "$TARGET/src/app/api/connect/context"

# Use find to locate all .ts files and process them
while IFS= read -r -d '' f; do
  rel="${f#$TEMPLATE_DIR/api/}"
  dest="$TARGET/src/app/api/$rel"
  mkdir -p "$(dirname "$dest")"
  # Replace placeholders with detected paths
  sed \
    -e "s|__DB_IMPORT__|$DB_IMPORT|g" \
    -e "s|__AUTH_IMPORT__|$AUTH_IMPORT|g" \
    -e "s|__MODELS_PATH__|$MODELS_PATH|g" \
    "$f" > "$dest"
  echo "    - api/$rel"
done < <(find "$TEMPLATE_DIR/api" -name "*.ts" -type f -print0)

# --- Copy pages ---
echo "  Copying pages..."
mkdir -p "$TARGET/src/app/connect/bug"
mkdir -p "$TARGET/src/app/connect/feature"
mkdir -p "$TARGET/src/app/connect/help"

while IFS= read -r -d '' f; do
  rel="${f#$TEMPLATE_DIR/pages/}"
  dest="$TARGET/src/app/$rel"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
  echo "    - $rel"
done < <(find "$TEMPLATE_DIR/pages" -name "*.tsx" -type f -print0)

# --- Update middleware ---
echo ""
echo "  Updating middleware..."
MIDDLEWARE="$TARGET/src/middleware.ts"
if [ -f "$MIDDLEWARE" ]; then
  if ! grep -q '"/connect"' "$MIDDLEWARE"; then
    # Try macOS sed first, then GNU sed
    if sed -i '' 's|"/api/projects"|"/connect",\n  "/api/connect",\n  "/api/projects"|' "$MIDDLEWARE" 2>/dev/null; then
      echo "    + Added /connect and /api/connect to protected paths"
    elif sed -i 's|"/api/projects"|"/connect",\n  "/api/connect",\n  "/api/projects"|' "$MIDDLEWARE" 2>/dev/null; then
      echo "    + Added /connect and /api/connect to protected paths"
    else
      echo "    ! Could not auto-update middleware -- add /connect and /api/connect to protected paths manually"
    fi
  else
    echo "    - Middleware already has /connect"
  fi
else
  echo "    ! No middleware.ts found -- add /connect and /api/connect to protected paths manually"
fi

# --- Update model barrel export ---
echo "  Updating model exports..."
INDEX="$TARGET/src/models/index.ts"
if [ -f "$INDEX" ]; then
  if ! grep -q "BugReport" "$INDEX"; then
    cat >> "$INDEX" <<'EXPORTS'

// Connect Hub models
export { default as BugReport } from "./BugReport";
export type { IBugReport, IBugReportDocument, IBugReportModel, BugSeverity, BugStatus } from "./BugReport";
export { BUG_SEVERITIES, BUG_STATUSES } from "./BugReport";

export { default as FeatureRequest } from "./FeatureRequest";
export type { IFeatureRequest, IFeatureRequestDocument, IFeatureRequestModel, FeaturePriority, FeatureStatus } from "./FeatureRequest";
export { FEATURE_PRIORITIES, FEATURE_STATUSES } from "./FeatureRequest";

export { default as HelpArticle } from "./HelpArticle";
export type { IHelpArticle, IHelpArticleDocument, IHelpArticleModel } from "./HelpArticle";
EXPORTS
    echo "    + Added Connect Hub exports to models/index.ts"
  else
    echo "    - Models already exported"
  fi
else
  echo "    ! No models/index.ts found -- create barrel exports manually if needed"
fi

# --- Copy Connect Hub instruction doc ---
echo "  Copying Connect Hub instructions..."
CONNECT_DOC="$AI_ROOT/documentation/CONNECT_HUB.md"
if [ -f "$CONNECT_DOC" ]; then
  # Copy to AI/documentation/ in target project
  TARGET_AI_DIR="$TARGET/AI/documentation"
  if [ -d "$TARGET/AI" ]; then
    mkdir -p "$TARGET_AI_DIR"
    cp "$CONNECT_DOC" "$TARGET_AI_DIR/CONNECT_HUB.md"
    echo "    + Copied CONNECT_HUB.md to AI/documentation/"
  else
    echo "    ! No AI/ folder found — instruction doc not copied"
  fi
fi

echo ""
echo "======================================"
echo "  Connect Hub installed successfully!"
echo "======================================"
echo ""
echo "Files installed:"
echo "  src/models/BugReport.ts"
echo "  src/models/FeatureRequest.ts"
echo "  src/models/HelpArticle.ts"
echo "  src/app/api/connect/bugs/route.ts"
echo "  src/app/api/connect/bugs/[id]/route.ts"
echo "  src/app/api/connect/features/route.ts"
echo "  src/app/api/connect/features/[id]/route.ts"
echo "  src/app/api/connect/features/[id]/vote/route.ts"
echo "  src/app/api/connect/help/route.ts"
echo "  src/app/api/connect/help/[id]/feedback/route.ts"
echo "  src/app/api/connect/context/route.ts"
echo "  src/app/connect/page.tsx"
echo "  src/app/connect/bug/page.tsx"
echo "  src/app/connect/feature/page.tsx"
echo "  src/app/connect/help/page.tsx"
echo ""
echo "Next steps:"
echo "  1. Verify DB connection import in API routes: $DB_IMPORT"
echo "  2. Verify auth import in API routes: $AUTH_IMPORT"
echo "  3. Add 'Connect' nav item to your sidebar/header"
echo "  4. Run type check: docker compose exec app npx tsc --noEmit"
echo "  5. Test: navigate to /connect"
