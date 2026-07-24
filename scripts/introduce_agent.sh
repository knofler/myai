#!/usr/bin/env bash
# ============================================================================
# introduce_agent.sh — Generate AI agent instruction files
#
# Usage (from any managed project root):
#   ./AI/scripts/introduce_agent.sh [agent]
#
# Or from the master repo:
#   ./scripts/introduce_agent.sh [agent] [project-path]
#
# Agents: all (default), claude, gemini, copilot, cursor, windsurf,
#         cline, aider, agents-md
#
# Reads agent→file mappings from config/agent_paths.conf
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect if we're in master repo or a managed project
if [ -f "$SCRIPT_DIR/../config/agent_paths.conf" ]; then
  MASTER_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  MASTER_REPO="$SCRIPT_DIR"
fi

AGENT="${1:-all}"
TARGET="${2:-$(pwd)}"

# Detect project structure:
# 1. Target has AI/ subfolder (managed project)
# 2. Target IS the master repo (has config/)
# 3. Target is a subdirectory of the master repo (e.g. workflow/)
if [ -d "$TARGET/AI" ]; then
  AI_DIR="$TARGET/AI"
  PROJECT_ROOT="$TARGET"
elif [ -f "$TARGET/config/agent_paths.conf" ]; then
  AI_DIR="$TARGET"
  PROJECT_ROOT="$TARGET"
elif [ -d "$TARGET" ]; then
  # Subdirectory — just generate files here, no AI/ needed
  PROJECT_ROOT="$TARGET"
else
  echo "Error: $TARGET is not a valid directory."
  exit 1
fi

PATHS_CONF="$MASTER_REPO/config/agent_paths.conf"
if [ ! -f "$PATHS_CONF" ]; then
  echo "Error: config/agent_paths.conf not found in $MASTER_REPO"
  exit 1
fi

PROJECT_NAME=$(basename "$PROJECT_ROOT")
echo "Project: $PROJECT_NAME"
echo "Agent:   $AGENT"
echo ""

# ============================================================================
# Load agent paths from config (compatible with bash 3 / zsh)
# ============================================================================

get_agent_path() {
  local agent="$1"
  grep "^${agent}=" "$PATHS_CONF" | cut -d'=' -f2-
}

list_agents() {
  grep -v '^#' "$PATHS_CONF" | grep -v '^$' | cut -d'=' -f1
}

# ============================================================================
# Core instructions (shared across ALL agents)
# ============================================================================

read -r -d '' CORE_INSTRUCTIONS <<'CORE' || true
## On Session Start

1. Read `AI/state/STATE.md` and `AI/state/AI_AGENT_HANDOFF.md` for current context
2. Read `AI/documentation/AI_RULES.md` for tech mandates
3. Review `AI/documentation/MULTI_AGENT_ROUTING.md` for routing reference

## Specialist Agents (13)

Agent role definitions are in `AI/agents/`. Adopt the relevant specialist role based on the task.

| Agent | Domain |
|-------|--------|
| `solution-architect` | ADRs, system design, tech choices |
| `frontend-specialist` | Next.js, React, Vercel |
| `api-specialist` | Node.js/Python APIs, REST/GraphQL, Render |
| `database-specialist` | MongoDB, Mongoose, Atlas |
| `devops-specialist` | Docker, GitHub Actions, CI/CD |
| `ui-ux-specialist` | Design system, Tailwind, accessibility |
| `security-specialist` | OWASP, auth, secrets, rate limiting |
| `documentation-specialist` | README, API docs, changelogs |
| `product-manager` | Feature specs, user stories, roadmap |
| `qa-specialist` | Testing strategy, unit/integration/E2E |
| `tech-ba` | Requirements, data flows, functional specs |
| `tech-lead` | Code review, standards, cross-lane coherence |
| `project-manager` | Delivery, milestones, blockers, STATE.md |

## Quick Keywords

| Keyword | Action |
|---------|--------|
| `hello` | Show all available keywords as a table |
| `agent mode` | Full multi-agent activation — read state, dispatch all lanes in parallel |
| `session start` | Read state, assess status, identify next priority |
| `status` | Quick summary: done, in-progress, blocked, next priority |
| `plan [feature]` | Break down a feature into specs, stories, and ADR before coding |
| `scaffold [thing]` | Generate boilerplate: scaffold api, scaffold page [name], scaffold schema [name] |
| `review` | Code review (tech-lead) + test coverage check (qa-specialist) |
| `audit` | Security (OWASP) + coverage + standards — all in parallel |
| `ship it` | Commit, push, update state, write handoff, log |
| `wrap up` | Update state + write handoff. No commit. |
| `handoff` | Full handoff: update STATE.md + AI_AGENT_HANDOFF.md for next agent |
| `make prod` | Productionise: Vercel + Atlas + Render deploy |

## State Management

After every significant change, autonomously update `AI/state/STATE.md` with what was done, decisions made, blockers, and next steps. On session end, also update `AI/state/AI_AGENT_HANDOFF.md` with instructions for the next agent.

**NEVER wait for the user to ask you to save state.**

## Critical Rules

- **Docker only**: No local npm/node. Use `docker compose exec` for builds/linting.
- **Pipeline relay design**: Each pipeline stage only needs its predecessor's output. Never concatenate all prior stages.
- **60-second timeout**: Pipeline stages must complete within 1 minute.
- **File ownership**: Follow lane ownership from `AI/documentation/MULTI_AGENT_ROUTING.md`.
- **Multi-agent protocol**: You share state with other AI agents via the file system. `AI/state/` is the single source of truth.
CORE

# ============================================================================
# Generator functions
# ============================================================================

write_instruction_file() {
  local agent_name="$1"
  local rel_path="$2"
  local agent_label="$3"
  local log_file="$4"
  local dot_color="${5:-⚪}"
  local full_path="$PROJECT_ROOT/$rel_path"

  # Create parent directory if needed
  mkdir -p "$(dirname "$full_path")"

  cat > "$full_path" <<EOF
# ${PROJECT_NAME} — AI Agent Instructions

> This file is read automatically by ${agent_label}. Follow these instructions for every session.

---

## YOUR IDENTITY — read first (do NOT impersonate Claude)

You are **${agent_label}**. You are **NOT Claude**. In every banner, status line, log entry, and self-reference:

- Identify yourself as **${agent_label}** — never write "Claude" or "Claude Code" as your own name.
- Your banner/status color is **${dot_color}** — use this dot, not Claude's 🟣.
- Write logs to \`${log_file}\` only — never to \`AI/logs/claude_log.md\`.
- **Do NOT print Claude's org context.** The \`claude-museum\` / "Powerhouse Museum" org label is resolved from Claude's \`CLAUDE_CONFIG_DIR\` and is **Claude-specific** — it does not apply to you. If you have no org of your own, omit the ORG line or set it to "${agent_label}".

> If you are a *different* tool reading this file (some files are shared across tools), identify as **yourself** using this table — never as Claude: Claude 🟣 · Gemini 🔵 · Antigravity 🟠 · Codex 🟢 · Cursor 🟡 · Copilot ⚫ · Windsurf 🩵 · Cline 🟤 · Aider 🔴.

${CORE_INSTRUCTIONS}

---

## Wrap-up banner (MANDATORY on session close — use YOUR identity above)

On \`wrap up\`, end with this banner as the FINAL output. Fill values from git + session context. This is **${agent_label}'s** banner — never copy Claude's:

\`\`\`
╔════════════════════════════════════════════════════════╗
║  ${dot_color}  ${agent_label} — WRAPPED UP
║────────────────────────────────────────────────────────
║  ${dot_color}  AGENT:    ${agent_label}
║  ${dot_color}  REPO:     {folder name}
║  ${dot_color}  BRANCH:   {git branch}
║  ${dot_color}  REMOTE:   {git remote url}
║  ${dot_color}  SESSION:  ${agent_label} ({hostname})
║  ${dot_color}  WRAPPED:  {YYYY-MM-DD HH:MM UTC}
║  ${dot_color}  STATUS:   {one-line summary}
╚════════════════════════════════════════════════════════╝
\`\`\`

---

## Logging

Write session logs to \`${log_file}\` with timestamps.
EOF
  echo "  + $rel_path ($dot_color $agent_label)"
}

generate_claude() {
  local rel_path
  rel_path=$(get_agent_path "claude")
  local full_path="$PROJECT_ROOT/$rel_path"

  if [ -f "$full_path" ]; then
    echo "  = $rel_path (exists, managed by template)"
  elif [ -f "$MASTER_REPO/templates/CLAUDE_TEMPLATE.md" ]; then
    cp "$MASTER_REPO/templates/CLAUDE_TEMPLATE.md" "$full_path"
    echo "  + $rel_path (from template)"
  else
    write_instruction_file "claude" "$rel_path" "Claude Code" "AI/logs/claude_log.md"
  fi
}

generate_gemini() {
  write_instruction_file "gemini" "$(get_agent_path gemini)" "Gemini CLI" "AI/logs/gemini.md" "🔵"
}

generate_copilot() {
  write_instruction_file "copilot" "$(get_agent_path copilot)" "GitHub Copilot" "AI/logs/copilot.md" "⚫"
}

generate_cursor() {
  write_instruction_file "cursor" "$(get_agent_path cursor)" "Cursor" "AI/logs/cursor.md" "🟡"
}

generate_windsurf() {
  write_instruction_file "windsurf" "$(get_agent_path windsurf)" "Windsurf" "AI/logs/windsurf.md" "🩵"
}

generate_cline() {
  write_instruction_file "cline" "$(get_agent_path cline)" "Cline" "AI/logs/cline.md" "🟤"
}

# Codex and Antigravity both read the shared AGENTS.md (cross-tool). A shared
# file can't hardcode one identity, so generate_agents_md carries a generic,
# table-driven identity block. These are thin aliases so `introduce_agent.sh
# codex` / `agy` regenerate AGENTS.md with that block.
generate_codex()       { generate_agents_md; }
generate_antigravity() { generate_agents_md; }

generate_aider() {
  write_instruction_file "aider" "$(get_agent_path aider)" "Aider" "AI/logs/aider.md" "🔴"
  # Also create .aider.conf.yml if it doesn't exist
  if [ ! -f "$PROJECT_ROOT/.aider.conf.yml" ]; then
    cat > "$PROJECT_ROOT/.aider.conf.yml" <<EOF
# Aider configuration — reads project conventions automatically
read: [CONVENTIONS.md, AI/state/STATE.md, AI/documentation/AI_RULES.md]
auto-commits: false
EOF
    echo "  + .aider.conf.yml"
  fi
}

generate_agents_md() {
  local rel_path
  rel_path=$(get_agent_path "agents-md")
  local full_path="$PROJECT_ROOT/$rel_path"
  mkdir -p "$(dirname "$full_path")"

  cat > "$full_path" <<EOF
# ${PROJECT_NAME} — AGENTS.md

> Cross-tool standard. Read by Codex, Antigravity, Cursor and other AGENTS.md-aware tools.

## YOUR IDENTITY — read first (this file is shared; do NOT impersonate Claude)

This file is read by **multiple tools**. Identify as **whichever tool you are** — Codex, Antigravity, Cursor, etc. — **never as Claude**.

- Use **your own** name and color in every banner/status line/log. Color table: Codex 🟢 · Antigravity 🟠 · Cursor 🟡 · Gemini 🔵 · (other) ⚪. Claude's is 🟣 — not yours.
- Write logs to **your own** file under \`AI/logs/\` (e.g. \`AI/logs/codex.md\`, \`AI/logs/antigravity.md\`) — never \`AI/logs/claude_log.md\`.
- **Never print the \`claude-museum\` / "Powerhouse Museum" org label** — it comes from Claude's \`CLAUDE_CONFIG_DIR\` and is Claude-specific. Omit the ORG line, or use your own tool name.

## Wrap-up banner (MANDATORY on session close)

On \`wrap up\`, end with a banner headed **"<YOUR NAME> — WRAPPED UP"** using YOUR color dot, with \`AGENT:\` and \`SESSION:\` set to your name, and \`REPO/BRANCH/REMOTE/WRAPPED\` from git. Never copy Claude's banner (name, org, or 🟣 color) verbatim.

${CORE_INSTRUCTIONS}

---

## Agent Definitions

See \`AI/agents/\` for the 13 specialist role definitions.

## Skills

See \`AI/skills/README.md\` for 60 repeatable playbooks across all specialists.
EOF
  echo "  + $rel_path"
}

# ============================================================================
# Dispatch
# ============================================================================

run_agent() {
  case "$1" in
    claude)    generate_claude ;;
    gemini)    generate_gemini ;;
    copilot)   generate_copilot ;;
    cursor)    generate_cursor ;;
    windsurf)  generate_windsurf ;;
    cline)     generate_cline ;;
    aider)     generate_aider ;;
    agents-md) generate_agents_md ;;
    codex)     generate_codex ;;
    agy|antigravity) generate_antigravity ;;
    *)
      echo "Unknown agent: $1"
      echo ""
      echo "Available agents:"
      for a in $(list_agents); do
        echo "  $a -> $(get_agent_path "$a")"
      done
      exit 1
      ;;
  esac
}

if [ "$AGENT" = "all" ]; then
  for key in $(list_agents); do
    run_agent "$key"
  done
else
  run_agent "$AGENT"
fi

echo ""
echo "Done."
echo ""
echo "Verify: open the agent and type 'hello' or 'agent mode'"
