#!/bin/bash
set -e

# AI Management Framework - Project Initializer
# Usage: ./scripts/init_ai.sh <target_directory>
#
# Copies framework files from this flat repo into $TARGET/AI/ structure.

TARGET_DIR=$1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"

if [ -z "$TARGET_DIR" ]; then
    echo "Error: No target directory specified."
    echo "Usage: ./scripts/init_ai.sh <target_directory>"
    exit 1
fi

# merge_json() (deep-merge, never clobber) + acquire_repo_lock/release_repo_lock
# (cross-machine mutual exclusion) — shared with update_all.sh so a re-`init`
# on an already-customized repo can't destroy repo-local settings.json
# additions, and can't race a concurrent update_all.sh sync of the same repo.
# shellcheck source=lib/merge_json.sh
. "$REPO_DIR/scripts/lib/merge_json.sh"
# shellcheck source=lib/sync_guard.sh
. "$REPO_DIR/scripts/lib/sync_guard.sh"

# Ensure we are in the root of the master template
if [ ! -f "$REPO_DIR/documentation/AI_RULES.md" ]; then
    echo "Error: documentation/AI_RULES.md not found. Please run this script from the AI management repo root."
    exit 1
fi

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

# Cross-machine mutual exclusion: refuse to race an in-flight update_all.sh
# sync of this SAME repo (both write .claude/settings.json). Best-effort —
# see sync_guard.sh for the staleness/reclaim policy.
if ! acquire_repo_lock "$TARGET_DIR" >/dev/null; then
    echo "Error: $TARGET_DIR is being synced by another process right now (lock held) — retry shortly."
    exit 1
fi
trap 'release_repo_lock "$TARGET_DIR"' EXIT

# Create AI/ directory structure in target
echo "Creating AI/ structure in $TARGET_DIR..."
mkdir -p "$TARGET_DIR/AI/agents"
mkdir -p "$TARGET_DIR/AI/documentation"
mkdir -p "$TARGET_DIR/AI/architecture"
mkdir -p "$TARGET_DIR/AI/design"
mkdir -p "$TARGET_DIR/AI/plan"
mkdir -p "$TARGET_DIR/AI/state"
mkdir -p "$TARGET_DIR/AI/logs"

# Copy framework files into target's AI/
cp -v "$REPO_DIR/documentation/AI_RULES.md"                   "$TARGET_DIR/AI/documentation/"
cp -v "$REPO_DIR/documentation/Instruction.md"                "$TARGET_DIR/AI/documentation/"
cp -v "$REPO_DIR/documentation/global_ai_management_prompt.md" "$TARGET_DIR/AI/documentation/" 2>/dev/null || true
cp -v "$REPO_DIR/documentation/INTEGRATION_GUIDE.md"          "$TARGET_DIR/AI/documentation/"
cp -v "$REPO_DIR/documentation/MULTI_AGENT_ROUTING.md"        "$TARGET_DIR/AI/documentation/"

# Copy all 13 specialist agent definitions into agents/ (single source of truth)
cp -v "$REPO_DIR/agents/"*.md "$TARGET_DIR/AI/agents/"

# Copy all skills into skills/ (single source of truth)
mkdir -p "$TARGET_DIR/AI/skills"
if [ -d "$REPO_DIR/skills" ]; then
    for skill_dir in "$REPO_DIR/skills"/*/; do
        skill_name=$(basename "$skill_dir")
        mkdir -p "$TARGET_DIR/AI/skills/$skill_name"
        cp -v "$skill_dir"*.md "$TARGET_DIR/AI/skills/$skill_name/" 2>/dev/null || true
    done
    cp -v "$REPO_DIR/skills/README.md" "$TARGET_DIR/AI/skills/" 2>/dev/null || true
    echo "Copied skills to AI/skills/"
fi

# Symlink .claude/agents → agents/ so Claude Code auto-discovers them
mkdir -p "$TARGET_DIR/AI/.claude"
rm -rf "$TARGET_DIR/AI/.claude/agents"
(cd "$TARGET_DIR/AI/.claude" && ln -sf ../agents agents)
echo "Symlinked AI/.claude/agents → AI/agents/"

# Symlink .claude/skills → skills/ so Claude Code auto-discovers them
rm -rf "$TARGET_DIR/AI/.claude/skills"
(cd "$TARGET_DIR/AI/.claude" && ln -sf ../skills skills)
echo "Symlinked AI/.claude/skills → AI/skills/"

# Create initial state files if they don't already exist (don't overwrite project state)
if [ ! -f "$TARGET_DIR/AI/state/STATE.md" ]; then
    cat > "$TARGET_DIR/AI/state/STATE.md" << 'STATEEOF'
# Project State

**Timestamp:** (not yet started)
**Current Agent:** (none)

## 1. Recently Implemented
- Framework initialized.

## 2. Architectural Decisions
- (none yet)

## 3. Blockers / Bugs
- (none)

## 4. Immediate Next Steps
- [ ] Define project requirements
- [ ] Set up Docker + docker-compose
- [ ] Begin implementation
STATEEOF
    echo "Created initial AI/state/STATE.md"
fi

if [ ! -f "$TARGET_DIR/AI/state/AI_AGENT_HANDOFF.md" ]; then
    cat > "$TARGET_DIR/AI/state/AI_AGENT_HANDOFF.md" << 'HANDOFFEOF'
# AI Agent Handoff

> Workspace root: (set this to your project root)

## What you want
(describe the project goal)

## What's already done
- Framework initialized.

## Current task status
- [ ] (define tasks)

## Files to work with
- AI/documentation/AI_RULES.md
- AI/state/STATE.md
HANDOFFEOF
    echo "Created initial AI/state/AI_AGENT_HANDOFF.md"
fi

# Create empty agent logs if they don't exist
[ ! -f "$TARGET_DIR/AI/logs/claude_log.md" ] && echo "# Claude Agent Log" > "$TARGET_DIR/AI/logs/claude_log.md"
[ ! -f "$TARGET_DIR/AI/logs/gemini.md" ] && echo "# Gemini Agent Log" > "$TARGET_DIR/AI/logs/gemini.md"
[ ! -f "$TARGET_DIR/AI/logs/copilot.md" ] && echo "# Copilot Agent Log" > "$TARGET_DIR/AI/logs/copilot.md"

# Copy framework helper scripts into AI/scripts/
# notify-telegram.sh is required by the settings.json Notification hook (the
# hook command is path-rewritten to ./AI/scripts/notify-telegram.sh below).
mkdir -p "$TARGET_DIR/AI/scripts"
for script in remote.sh telegram-setup.sh rotate_state.sh local-ci.sh yolo.sh backfill_embeddings.sh notify-telegram.sh; do
  if [ -f "$REPO_DIR/scripts/$script" ]; then
    cp -v "$REPO_DIR/scripts/$script" "$TARGET_DIR/AI/scripts/"
    chmod +x "$TARGET_DIR/AI/scripts/$script" || true
  fi
done

# ── Install zero-prompt policy + safety hooks at repo root ──────────────
# The framework's zero-prompt policy (bypassPermissions default + 136-pattern
# allow-list + skip-prompt flags) and the PreToolUse/Session/Stop safety hooks
# live in the master's root .claude/settings.json + hooks/. Claude Code reads
# these from <repo-root>/.claude/settings.json and <repo-root>/hooks/.
#
# This mirrors scripts/update_all.sh (the fleet-wide sweep). Without it, a
# freshly-scaffolded repo starts in DEFAULT permission mode (prompts fire) and
# has NO safety hooks until the next update_all run — see AI/LL.
#
# Path rewrite: in master, helper scripts live at ./scripts/; in a scaffolded
# repo they live at ./AI/scripts/. Rewrite the notify-telegram.sh hook command
# so it resolves in the managed-repo layout. (The ./hooks/* commands resolve
# as-is because we copy hooks/ to the repo root.)
mkdir -p "$TARGET_DIR/.claude"
if [ -d "$REPO_DIR/hooks" ]; then
  mkdir -p "$TARGET_DIR/hooks"
  cp -r "$REPO_DIR/hooks/"* "$TARGET_DIR/hooks/" 2>/dev/null || true
  chmod +x "$TARGET_DIR/hooks/"*/*.sh 2>/dev/null || true
  echo "Copied safety hooks → hooks/"
fi
# Deep-merge, never overwrite (AI_RULES §14): a raw overwrite here used to
# destroy repo-local settings.json additions (extra hooks, statusLine, custom
# permissions) on every re-`init` of an already-customized repo — the same
# clobber class PR #289 fixed in update_all.sh, just via a callsite that fix
# never touched. merge_json() is idempotent, so a repeat `init` on an
# up-to-date repo is a clean no-op.
if [ -f "$REPO_DIR/.claude/settings.json" ]; then
  _settings_tmp=$(mktemp)
  sed 's|"./scripts/notify-telegram.sh|"./AI/scripts/notify-telegram.sh|g' \
    "$REPO_DIR/.claude/settings.json" > "$_settings_tmp"
  merge_json "$TARGET_DIR/.claude/settings.json" "$_settings_tmp" "settings.json"
  rm -f "$_settings_tmp"
fi

# Copy CLAUDE_TEMPLATE.md as the project's root CLAUDE.md
cp -v "$REPO_DIR/templates/CLAUDE_TEMPLATE.md" "$TARGET_DIR/CLAUDE.md"

# Generate instruction files for all AI agents (Gemini, Copilot)
"$REPO_DIR/scripts/introduce_agent.sh" all "$TARGET_DIR"

# Copy standard project files
cp -v "$REPO_DIR/.gitignore" "$TARGET_DIR/" 2>/dev/null || true
cp -v "$REPO_DIR/.dockerignore" "$TARGET_DIR/" 2>/dev/null || true
cp -v "$REPO_DIR/.env.example" "$TARGET_DIR/" 2>/dev/null || true

echo "-----------------------------------------------"
echo "AI Management files copied to: $TARGET_DIR"
echo ""
echo "Agent instruction files created:"
echo "  Claude Code  -> CLAUDE.md"
echo "  Gemini CLI   -> GEMINI.md"
echo "  Copilot      -> .github/copilot-instructions.md"
echo ""
echo "Agent definitions at: $TARGET_DIR/AI/agents/"

# Add to managed repos tracking file if not already present
ABS_TARGET_DIR=$(cd "$TARGET_DIR" && pwd)
if ! grep -qx "$ABS_TARGET_DIR" "$TRACKING_FILE" 2>/dev/null; then
    echo "$ABS_TARGET_DIR" >> "$TRACKING_FILE"
    echo "Added $ABS_TARGET_DIR to $TRACKING_FILE"
fi

# Navigate to target directory
cd "$TARGET_DIR" || exit

# Initialize git if it's not already a repository
if [ ! -d ".git" ]; then
    git init
    echo "Initialized new Git repository in $TARGET_DIR"
fi

# A developer Mac always has ~/.gitconfig user.name/user.email set, but CI
# runners and other sandboxes commit as nobody — `git commit` then dies with
# "fatal: unable to auto-detect email address" (exit 128). Never override a
# real identity; only supply a local (repo-scoped, not --global) fallback when
# totally unset, so init_ai.sh's own commit works anywhere.
git config user.email >/dev/null 2>&1 || git config user.email "ai-management-init@localhost"
git config user.name  >/dev/null 2>&1 || git config user.name  "AI Management Init"

# Add and commit the management files. Tolerant of a no-op re-init: on a repeat
# `init` with no framework changes there is nothing staged, and `git commit` would
# exit non-zero under `set -e` and abort the run — so guard on a dirty index.
git add AI/ CLAUDE.md
git add .gitignore .dockerignore .env.example 2>/dev/null || true
git add .claude/settings.json hooks/ 2>/dev/null || true
if git diff --cached --quiet 2>/dev/null; then
    echo "Re-init: AI framework already up to date — nothing new to commit."
else
    git commit -m "chore: initialize AI Management Framework with 13 specialist agents and 59 skills"
fi

echo "-----------------------------------------------"
echo "Initialization complete! Project is ready for AI orchestration."
echo "Next step: use the 'Start Work' prompt from the master README."
