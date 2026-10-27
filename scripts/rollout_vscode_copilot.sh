#!/usr/bin/env bash
# rollout_vscode_copilot.sh — give every fleet repo what VS Code chat (GitHub
# Copilot, incl. local Ollama models in agent mode) needs to know the fleet's
# keywords and reach the myai gateway tools, the same way rollout_mcp_bridge.sh
# carries .mcp.json to the fleet.
#
# WHY (2026-10-02, operator): foh (and the rest of the fleet) has a CLAUDE.md
# and an .mcp.json, but VS Code chat reads neither. It reads
# .github/copilot-instructions.md and AGENTS.md (Codex also reads the latter)
# for instructions, and .vscode/mcp.json (VS Code's own MCP schema) for tools.
# Without those, Copilot in VS Code knows no keyword and has no myai bridge —
# `boot` etc. silently does nothing there.
#
# Per repo, idempotent:
#   1. .github/copilot-instructions.md  — generate_tool_instructions.sh
#      (creates from templates/copilot-instructions.md if missing, else
#      regenerates the CRITICAL RULES / boot / keyword blocks in place)
#   2. AGENTS.md keyword section        — generate_tool_instructions.sh
#      (only if the repo already has an AGENTS.md — this script does not
#      invent one; bootstraps the keyword block into it if markerless)
#   3. .vscode/mcp.json                 — `myai mcp vscode <repo>`
#      (deep-merge from templates/vscode-mcp.json, same mechanism as .mcp.json)
#
# Repos: the SAME set rollout_mcp_bridge.sh converges (config/managed_repos.txt
# + config/mcp_repos_extra.txt + CODE-tree discovery, scripts/lib/fleet_mcp_repos.sh)
# so "which repos get the MCP bridge" and "which repos get VS Code wiring"
# can never disagree. A "noai" repo (managed_repos.txt: "NEVER write outside
# AI/" / "AI folder only") is skipped — .github/, AGENTS.md and
# .vscode/ all live outside AI/. Exempt-org repos follow the same rule
# as everything else here: no special-casing, same skip logic.
#
# Usage:
#   scripts/rollout_vscode_copilot.sh              dry-run (default; report only)
#   scripts/rollout_vscode_copilot.sh --apply      write the files
#   scripts/rollout_vscode_copilot.sh --apply --commit
#                                                   also commit on `test` (only;
#                                                   never on main, never pushed —
#                                                   push stays a separate, human
#                                                   `ship it` / git push step)
#   scripts/rollout_vscode_copilot.sh --only <path>
# Exit 0 when every in-scope repo ends converged; 1 if any write/commit failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=scripts/lib/fleet_mcp_repos.sh
. "$ROOT/scripts/lib/fleet_mcp_repos.sh"
CODE_ROOT="$(fleet_code_root "$ROOT")"   # display only: repo paths print relative to it

APPLY=0 COMMIT=0 ONLY="" QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=1 ;;
    --commit)  COMMIT=1 ;;
    --quiet)   QUIET=1 ;;
    --only)    shift; ONLY="$(cd "${1:?--only needs a path}" 2>/dev/null && pwd -P)" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "rollout_vscode_copilot: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

GEN="$ROOT/scripts/generate_tool_instructions.sh"
MCP="$ROOT/scripts/myai_mcp.sh"
COPILOT_TEMPLATE="$ROOT/templates/copilot-instructions.md"
for f in "$GEN" "$MCP" "$COPILOT_TEMPLATE"; do
  [ -e "$f" ] || { echo "rollout_vscode_copilot: missing $f" >&2; exit 1; }
done

MSG="chore(vscode): copilot-instructions.md + AGENTS.md keywords + .vscode/mcp.json

Converged on the ai-management module templates by rollout_vscode_copilot.sh so
VS Code chat (GitHub Copilot, incl. local Ollama agent-mode models) knows the
fleet's keywords and can reach the myai gateway tools (tasks/brain/mailbox/swarm).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"

log() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
DRYFLAG="--dry-run"; [ "$APPLY" = 1 ] && DRYFLAG=""

# unignore_vscode_mcp <repo> — a repo whose .gitignore blanket-excludes
# .vscode/ (common, to keep personal editor settings out) would otherwise
# have `git add .vscode/mcp.json` silently no-op (ignored paths don't even
# show in `git status --porcelain`) — the file gets written but never
# committed, with no error to notice. Mirrors the fix this script's own repo
# needed: narrow "ignore .vscode/" to "ignore .vscode/*" (a bare ".vscode/"
# excludes the directory itself, and a file inside an excluded directory
# cannot be re-included by a later negation) then add "!.vscode/mcp.json".
# No-op if mcp.json already isn't ignored, or the repo has no .gitignore rule
# to fix.
unignore_vscode_mcp() {
  local repo="$1"
  local gi="$repo/.gitignore"
  git -C "$repo" check-ignore -q .vscode/mcp.json 2>/dev/null || return 0
  [ -f "$gi" ] || return 0
  grep -q '^!\.vscode/mcp\.json$' "$gi" && return 0
  if grep -qx '\.vscode/' "$gi"; then
    sed -i.bak 's#^\.vscode/$#.vscode/*#' "$gi" && rm -f "$gi.bak"
  fi
  printf '\n# myai MCP bridge registration — framework-managed, not personal editor config.\n!.vscode/mcp.json\n' >> "$gi"
}

n_total=0 n_skipped=0 n_failed=0 n_committed=0

while IFS='|' read -r repo flags; do
  [ -n "$repo" ] || continue
  [ -n "$ONLY" ] && [ "$repo" != "$ONLY" ] && continue
  n_total=$((n_total+1))
  short="$repo"; [ -n "$CODE_ROOT" ] && short="${repo#"$CODE_ROOT"/}"

  case ",$flags," in *,noai,*)
    n_skipped=$((n_skipped+1)); log "skip     $short  (AI/-only repo — copilot-instructions.md/.vscode/.mcp.json all live outside AI/)"; continue ;;
  esac

  repo_rc=0
  cp_out="$(bash "$GEN" "$repo/.github/copilot-instructions.md" --init "$COPILOT_TEMPLATE" $DRYFLAG 2>&1)" || repo_rc=1
  log "  copilot  $short  : $(printf '%s' "$cp_out" | tail -1)"

  if [ -f "$repo/AGENTS.md" ]; then
    ag_out="$(bash "$GEN" "$repo/AGENTS.md" --full $DRYFLAG 2>&1)" || repo_rc=1
    log "  agents   $short  : $(printf '%s' "$ag_out" | tail -1)"
  else
    log "  agents   $short  : skip (no AGENTS.md in this repo — not creating one)"
  fi

  vs_out="$(bash "$MCP" vscode "$repo" $DRYFLAG 2>&1)" || repo_rc=1
  log "  vscode   $short  : $(printf '%s' "$vs_out" | tail -1 | sed 's/^ *[·✓!] *//')"

  [ "$repo_rc" = 0 ] || { n_failed=$((n_failed+1)); continue; }
  [ "$APPLY" = 1 ] && [ "$COMMIT" = 1 ] || continue

  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log "         (not a git repo — written, nothing to commit)"; continue; }
  unignore_vscode_mcp "$repo"
  br="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  paths=".github/copilot-instructions.md AGENTS.md .vscode/mcp.json .gitignore"
  changed_paths=""
  for p in $paths; do
    [ -n "$(git -C "$repo" status --porcelain -- "$p" 2>/dev/null)" ] && changed_paths="$changed_paths $p"
  done
  [ -n "$changed_paths" ] || { log "         nothing to commit"; continue; }
  if [ "$br" != test ]; then
    log "         converged, not committed (branch $br — only \`test\` is committed to)"
    continue
  fi
  # shellcheck disable=SC2086
  if cerr="$(git -C "$repo" add -- $changed_paths 2>&1 && git -C "$repo" commit -q -m "$MSG" -- $changed_paths 2>&1)"; then
    n_committed=$((n_committed+1)); log "         committed on $br:$changed_paths"
  else
    n_failed=$((n_failed+1)); log "         commit FAILED: $(printf '%s' "$cerr" | grep -v '^$' | tail -1 | cut -c1-140)"
  fi
done < <(fleet_mcp_repos "$ROOT")

verb="changed"; [ "$APPLY" = 0 ] && verb="would change (pass --apply to write)"
echo "rollout_vscode_copilot: $n_total repos — $verb · $n_skipped skipped · $n_failed failed$( [ "$APPLY" = 1 ] && [ "$COMMIT" = 1 ] && printf ' · %s committed' "$n_committed")"
[ "$n_failed" -eq 0 ]
