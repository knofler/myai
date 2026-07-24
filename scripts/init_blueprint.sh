#!/usr/bin/env bash
# Powerhouse Blueprint provisioner.
#
# Spawns a new project from the canonical reference (knofler/todo-blueprint)
# with the full stack pre-wired: AI framework + Next.js 15 + TS + Tailwind v4
# + Mongo (Docker) + Anthropic SDK + Sentry + GH Actions + Vercel-ready.
#
# Usage:
#   init_blueprint.sh <target-path> [options]
#
# Options:
#   --name <name>           Project name (default: basename of target-path)
#   --gh-create <slug>      gh repo create <slug> (e.g. knofler/my-app) + push
#   --gh-private            Create the GH repo as private (default public)
#   --vercel                vercel link + deploy after gh push (scope: knoflers-projects)
#   --no-ai                 Skip init_ai.sh (just the app stack)
#   --mode <local|clone|template> Provisioning mode (default: local)
#                           local    — copy templates/blueprint/* from THIS repo (offline,
#                                      no network; the canonical self-contained scaffold)
#                           clone    — git clone knofler/todo-blueprint, strip .git, re-init
#                           template — gh repo create --template (requires --gh-create)
#
# Examples:
#   # Local-only scaffold from the bundled blueprint templates (default, offline)
#   init_blueprint.sh ~/code/cms-app
#
#   # Full provisioning (local scaffold + GitHub repo + Vercel)
#   init_blueprint.sh ./new-app --name new-app --gh-create knofler/new-app --gh-private --vercel
#
#   # Clone the live reference repo instead of the bundled templates
#   init_blueprint.sh ./new-app --mode clone --gh-create knofler/new-app
#
#   # Fastest path (GitHub Template API + auto Vercel deploy)
#   init_blueprint.sh ./new-app --mode template --gh-create knofler/new-app --gh-private --vercel
#
# Reads the framework's Docker-only mandate (memory:
# feedback_blueprint_docker_only.md) — the produced repo NEVER assumes
# host npm install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_REPO="knofler/todo-blueprint"
TEMPLATE_BRANCH="main"
BLUEPRINT_DIR="$AI_ROOT/templates/blueprint"

# ── Parse args ────────────────────────────────────────────────────────
TARGET=""
NAME=""
GH_SLUG=""
GH_PRIVATE=""
DO_VERCEL=""
SKIP_AI=""
MODE="local"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)        NAME="$2"; shift 2 ;;
    --gh-create)   GH_SLUG="$2"; shift 2 ;;
    --gh-private)  GH_PRIVATE="--private"; shift ;;
    --vercel)      DO_VERCEL=1; shift ;;
    --no-ai)       SKIP_AI=1; shift ;;
    --mode)        MODE="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | head -25
      exit 0
      ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *)  if [[ -z "$TARGET" ]]; then TARGET="$1"; shift; else echo "Multiple paths given"; exit 1; fi ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: init_blueprint.sh <target-path> [options]"
  echo "Run with -h for full help."
  exit 1
fi

# Expand ~ and resolve to absolute
TARGET="${TARGET/#\~/$HOME}"
TARGET="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
[[ -z "$NAME" ]] && NAME="$(basename "$TARGET")"

if [[ -e "$TARGET" && -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
  echo "ERROR: $TARGET already exists and is not empty. Aborting."
  exit 1
fi

if [[ "$MODE" != "local" && "$MODE" != "clone" && "$MODE" != "template" ]]; then
  echo "ERROR: --mode must be 'local', 'clone', or 'template' (got '$MODE')"
  exit 1
fi
if [[ "$MODE" == "template" && -z "$GH_SLUG" ]]; then
  echo "ERROR: --mode template requires --gh-create <owner/name>"
  exit 1
fi
if [[ "$MODE" == "local" && ! -d "$BLUEPRINT_DIR" ]]; then
  echo "ERROR: bundled blueprint templates not found at $BLUEPRINT_DIR"
  echo "       Run from the master AI repo, or use --mode clone."
  exit 1
fi

echo "──────────────────────────────────────────────────"
echo "  Powerhouse Blueprint init"
echo "──────────────────────────────────────────────────"
echo "  target:      $TARGET"
echo "  project:     $NAME"
echo "  mode:        $MODE"
if [[ "$MODE" == "local" ]]; then
  echo "  source:      $BLUEPRINT_DIR (bundled blueprint templates)"
else
  echo "  template:    https://github.com/$TEMPLATE_REPO (branch: $TEMPLATE_BRANCH)"
fi
[[ -n "$GH_SLUG" ]] && echo "  gh repo:     $GH_SLUG $GH_PRIVATE"
[[ -n "$DO_VERCEL" ]] && echo "  vercel:      will deploy (scope: knoflers-projects)"
echo "──────────────────────────────────────────────────"
echo

# ── 1. Provision the project files ───────────────────────────────────
if [[ "$MODE" == "local" ]]; then
  echo "→ Copying bundled blueprint templates (local mode, offline)…"
  mkdir -p "$TARGET"
  # Copy everything incl. dotfiles (.github, .env.example, .gitignore, …).
  # `cp -a "$BLUEPRINT_DIR/." "$TARGET/"` preserves the dot-prefixed entries.
  cp -a "$BLUEPRINT_DIR/." "$TARGET/"
  chmod +x "$TARGET/dev" 2>/dev/null || true
elif [[ "$MODE" == "template" ]]; then
  echo "→ gh repo create --template ${TEMPLATE_REPO} → ${GH_SLUG}…"
  gh repo create "$GH_SLUG" --template "$TEMPLATE_REPO" $GH_PRIVATE --clone --description "Generated from Powerhouse Blueprint — $NAME" 2>&1 | tail -3
  # gh clones into ./<repo-name> next to cwd; move into target if different
  CLONED_DIR="$(pwd)/$(basename "$GH_SLUG")"
  if [[ "$CLONED_DIR" != "$TARGET" ]]; then
    mkdir -p "$(dirname "$TARGET")"
    mv "$CLONED_DIR" "$TARGET"
  fi
  # Strip template-only stale state so the new project starts clean
  rm -rf "$TARGET/AI/state" "$TARGET/AI/logs" "$TARGET/.vercel"
else
  echo "→ Cloning template (clone mode)…"
  mkdir -p "$TARGET"
  git clone --depth 1 --branch "$TEMPLATE_BRANCH" "git@github.com:${TEMPLATE_REPO}.git" "$TARGET" >/dev/null 2>&1 || {
    # Fall back to https if ssh fails (e.g. on a fresh machine without ssh keys)
    git clone --depth 1 --branch "$TEMPLATE_BRANCH" "https://github.com/${TEMPLATE_REPO}.git" "$TARGET"
  }
  rm -rf "$TARGET/.git" "$TARGET/.vercel" "$TARGET/AI/state" "$TARGET/AI/logs"
fi

# ── 2. Rename project in templated files ─────────────────────────────
echo "→ Rewriting project name → ${NAME}…"
# Title-case the slug for the display name (my-app → "My App")
DISPLAY_NAME="$(echo "$NAME" | awk -F'[-_]' '{for(i=1;i<=NF;i++){$i=toupper(substr($i,1,1)) substr($i,2)} print}' OFS=' ')"

if [[ "$MODE" == "local" ]]; then
  # The bundled templates use __PROJECT_NAME__ / __DISPLAY_NAME__ placeholders.
  # Substitute them across every text file in the copied tree (skip binaries/.git).
  echo "  substituting placeholders __PROJECT_NAME__=${NAME}, __DISPLAY_NAME__=${DISPLAY_NAME}…"
  # find -exec sed over every text file (the scaffold has no binaries). Portable
  # across bash/zsh — avoids null-delimited read loops that zsh handles differently.
  find "$TARGET" -type f -not -path '*/.git/*' -exec \
    sed -i.bak "s/__PROJECT_NAME__/${NAME}/g; s/__DISPLAY_NAME__/${DISPLAY_NAME}/g" {} +
else
  # package.json: "name": "todo-blueprint" → new name
  sed -i.bak "s/\"name\": \"todo-blueprint\"/\"name\": \"$NAME\"/" "$TARGET/package.json"
  # docker-compose.yml: container_name + db default
  sed -i.bak "s/todo-blueprint-app/${NAME}-app/g; s/todo-blueprint-mongo/${NAME}-mongo/g; s/todo-blueprint/${NAME}/g" "$TARGET/docker-compose.yml"
  # README + BLUEPRINT_HOOKUP — replace todo-blueprint mentions
  sed -i.bak "s/todo-blueprint/${NAME}/g" "$TARGET/README.md" "$TARGET/BLUEPRINT_HOOKUP.md" 2>/dev/null || true
  # dev script: container name + default URLs
  sed -i.bak "s/todo-blueprint-app/${NAME}-app/g; s/todo-blueprint/${NAME}/g" "$TARGET/dev"
  # .env.example
  sed -i.bak "s/todo-blueprint/${NAME}/g" "$TARGET/.env.example"
  # app/lib/branding.ts — display name shown on the default landing page
  if [[ -f "$TARGET/app/lib/branding.ts" ]]; then
    sed -i.bak "s/Todo Blueprint/${DISPLAY_NAME}/g" "$TARGET/app/lib/branding.ts"
  fi
fi
# clean up .bak files
find "$TARGET" -name '*.bak' -delete

# ── 2a. .dockerignore — FIRST CONDITION: node_modules must never enter the ──
# build context or sync to Dropbox (AI_RULES §12). Guarantee a compliant file
# even if the template repo's drifted; node_modules must be the top entry.
if [[ ! -f "$TARGET/.dockerignore" ]] || ! grep -q "node_modules" "$TARGET/.dockerignore"; then
  if [[ -f "$AI_ROOT/templates/.dockerignore" ]]; then
    cp "$AI_ROOT/templates/.dockerignore" "$TARGET/.dockerignore"
  else
    printf 'node_modules/\n**/node_modules/\n.next/\ndist/\nbuild/\ncoverage/\n.git/\n.env\nDockerfile\ndocker-compose.yml\n' > "$TARGET/.dockerignore"
  fi
  echo "  ✓ .dockerignore enforced (node_modules excluded)"
fi

# ── 3. Refresh AI framework (latest from master) ─────────────────────
if [[ -z "$SKIP_AI" ]]; then
  echo "→ Refreshing AI framework from master…"
  "$AI_ROOT/scripts/init_ai.sh" "$TARGET" 2>&1 | tail -3
fi

# ── 3a. Generate package-lock.json via Docker ────────────────────────
# CI needs a lockfile to use actions/setup-node's npm cache + reproducible
# installs. Docker-only-dev policy means the host never runs npm install,
# so use a throwaway node container with --package-lock-only to write the
# lockfile to the host bind mount without polluting node_modules.
# Lesson source: AI/LL/2026-05-17_ai-review-session.md §2.7 (Gap #7).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "→ Generating package-lock.json via Docker (host stays clean)…"
  docker run --rm -v "$TARGET":/app -w /app node:20-bookworm-slim \
    npm install --package-lock-only --legacy-peer-deps --no-audit --no-fund \
    >/dev/null 2>&1 \
    && echo "  ✓ package-lock.json written" \
    || echo "  (skipped — fix later via './dev shell' + 'npm install --package-lock-only')"
fi

# ── 4. git init + initial commit (local/clone) OR commit naming-fix (template) ──
cd "$TARGET"
LOGIN=$(gh api user --jq .login 2>/dev/null || echo "$(whoami)")
USER_ID=$(gh api user --jq .id 2>/dev/null || echo "0")

if [[ "$MODE" == "local" || "$MODE" == "clone" ]]; then
  echo "→ git init + initial commit…"
  git init -q
  git branch -M main
  git config user.email "${USER_ID}+${LOGIN}@users.noreply.github.com"
  git config user.name "$LOGIN"
  git add -A
  if [[ "$MODE" == "local" ]]; then SOURCE_DESC="bundled blueprint templates (templates/blueprint/)"; else SOURCE_DESC="$TEMPLATE_REPO@$TEMPLATE_BRANCH"; fi
  git commit -q -m "chore: initialise from Powerhouse Blueprint

Generated by AI/scripts/init_blueprint.sh (mode: $MODE)
Source:  $SOURCE_DESC
Project: $NAME

Next: cp .env.example .env.local && ./dev"
  git branch test
else
  # Template mode — the repo already has git history from gh create --template.
  # Commit the project-name renames as a follow-up commit.
  git config user.email "${USER_ID}+${LOGIN}@users.noreply.github.com"
  git config user.name "$LOGIN"
  if git diff --quiet && git diff --cached --quiet; then
    echo "→ No rename diffs to commit (template name happened to match)"
  else
    git add -A
    git commit -q -m "chore: rename template references to $NAME"
  fi
  git branch test 2>/dev/null || true
fi

# ── 5. Optional: GitHub repo + push (local/clone — template mode already pushed) ──
if [[ -n "$GH_SLUG" && ( "$MODE" == "local" || "$MODE" == "clone" ) ]]; then
  echo "→ gh repo create ${GH_SLUG} ${GH_PRIVATE}…"
  gh repo create "$GH_SLUG" $GH_PRIVATE --source="$TARGET" --remote=origin \
    --description "Generated from Powerhouse Blueprint — $NAME" 2>&1 | tail -3
  git push -u origin main 2>&1 | tail -2
  git push -u origin test 2>&1 | tail -2
elif [[ -n "$GH_SLUG" && "$MODE" == "template" ]]; then
  # Template mode created the remote already; push any rename commit + test branch
  git push origin main 2>&1 | tail -2 || true
  git push -u origin test 2>&1 | tail -2 || true
fi

# ── 6. Optional: Vercel link + deploy ────────────────────────────────
# Defaults to the user's PERSONAL scope (knoflers-projects). The
# Powerhouse Enterprise team has SSO/Deployment Protection on by default
# which makes preview URLs unviewable. Test repos belong on personal.
# Override with --vercel-scope <team> when you specifically want a team.
VERCEL_SCOPE="${VERCEL_SCOPE:-knoflers-projects}"
# Pull personal Sentry DSN from master .env if available (gitignored, never committed).
# This bakes error tracking into the first deploy. For persistence across future
# deploys, the user runs `scripts/setup_sentry.sh --vercel` after `vercel link`.
MASTER_SENTRY_DSN=""
if [[ -f "$AI_ROOT/.env" ]]; then
  MASTER_SENTRY_DSN="$(grep -E '^SENTRY_DSN=' "$AI_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
fi
if [[ -n "$DO_VERCEL" ]]; then
  if command -v vercel >/dev/null 2>&1; then
    echo "→ vercel deploy (scope: $VERCEL_SCOPE)…"
    vercel deploy --yes --prod=false --scope "$VERCEL_SCOPE" \
      --build-env MONGODB_URI=mongodb://stub \
      --build-env "NEXT_PUBLIC_SENTRY_DSN=${MASTER_SENTRY_DSN}" 2>&1 | tail -5
    if [[ -n "$MASTER_SENTRY_DSN" ]]; then
      echo "→ Sentry DSN baked into this deploy. For persistence across future"
      echo "  deploys, add this repo to scripts/setup_sentry.sh PERSONAL_REPOS"
      echo "  and run: ./scripts/setup_sentry.sh --vercel"
    fi
  else
    echo "→ vercel CLI not found — skip. Install with 'npm i -g vercel' if needed."
  fi
fi

# ── 7. Onboarding marker — tells the new project's `agent mode` to ask for the app idea ──
# When the user `cd`s into the new repo and runs `agent mode`, the project's
# CLAUDE.md step 0e detects this marker, prompts "what do you want to build?",
# captures the answer to AI/state/APP_IDEA.md, deletes the marker, then runs
# the autonomous 8-stage generate pipeline (idea → plan → brd → trd → design
# → build → ship).
mkdir -p "$TARGET/AI/state"
{
  printf 'scaffolded_at: %s\n' "$(date -u +%FT%TZ)"
  printf 'mode:          %s\n' "$MODE"
  if [[ "$MODE" == "local" ]]; then
    printf 'source:        templates/blueprint (bundled)\n'
  else
    printf 'template:      %s@%s\n' "$TEMPLATE_REPO" "$TEMPLATE_BRANCH"
  fi
  printf 'project:       %s\n' "$NAME"
  [[ -n "$GH_SLUG" ]] && printf 'gh_repo:       %s\n' "$GH_SLUG"
} > "$TARGET/AI/state/.awaiting-app-idea"

echo
echo "──────────────────────────────────────────────────"
echo "  ✓ Blueprint provisioned at $TARGET"
echo "──────────────────────────────────────────────────"
echo "  Local dev:    cd $TARGET && ./dev"
if [[ -f "$TARGET/AI/documentation/BLUEPRINT_HOOKUP.md" ]]; then
  echo "  Hookups:      cat $TARGET/AI/documentation/BLUEPRINT_HOOKUP.md"
elif [[ -f "$TARGET/BLUEPRINT_HOOKUP.md" ]]; then
  echo "  Hookups:      cat $TARGET/BLUEPRINT_HOOKUP.md"
fi
[[ -n "$GH_SLUG" ]] && echo "  GitHub:       https://github.com/$GH_SLUG"
echo "──────────────────────────────────────────────────"
echo
echo "  ▶ NEXT STEPS"
echo "    1. cd $TARGET"
echo "    2. claude              # open Claude Code in the new repo"
echo "    3. agent mode          # the new project will ask: \"what app to build?\""
echo "    4. Describe your app — the project's agent runs Plan→BRD→TRD→Design→Build autonomously"
echo "──────────────────────────────────────────────────"
