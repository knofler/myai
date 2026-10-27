#!/usr/bin/env bash
# mcp_config.sh — shared .mcp.json propagation for a managed/scaffolded repo.
#
# Extracted from scripts/update_all.sh's inline MCP block (task-2001e699) so
# scripts/init_ai.sh (fresh scaffold) and scripts/update_all.sh (fleet sync)
# apply the EXACT same base-template + stack-detection-overlay logic instead
# of two copies that could silently drift apart — the same divergence class
# scripts/lib/merge_json.sh was extracted to prevent for settings.json.
#
# Requires the caller to have already sourced scripts/lib/merge_json.sh and
# set REPO_DIR (the master repo root) before sourcing this file.
# Consumers: scripts/init_ai.sh, scripts/update_all.sh. Sourced, not executed.

# shellcheck source=scripts/lib/mcp_optional.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/mcp_optional.sh"

# sync_mcp_config REPO_PATH — deep-merge templates/mcp.json (base MCP server
# set) into REPO_PATH/.mcp.json, then layer on conditional overlays detected
# from the repo's own files: mcp-web.json for a Next.js/Vercel app,
# mcp-docker.json for a docker-compose project, mcp-api.json for an API
# project. Idempotent (merge_json only rewrites on real change) and safe to
# call before the target is a git repo — the stale .claude/mcp.json cleanup
# below degrades to a plain `rm` when `git ls-files` has no repo to ask.
sync_mcp_config() {
    local repo_path="$1"

    # Claude Code reads .mcp.json at the project root, NOT .claude/mcp.json.
    # Older framework versions wrote .claude/mcp.json by mistake — clean that
    # up here so the canonical location is the only one ever shipped.
    if [ -f "$repo_path/.claude/mcp.json" ]; then
        if (cd "$repo_path" && git ls-files --error-unmatch .claude/mcp.json >/dev/null 2>&1); then
            (cd "$repo_path" && git rm -f .claude/mcp.json >/dev/null)
        else
            rm -f "$repo_path/.claude/mcp.json"
        fi
        echo "  MCP: removed stale .claude/mcp.json (Claude Code reads .mcp.json at root)"
    fi

    [ -f "$REPO_DIR/templates/mcp.json" ] || return 0

    # Base template propagation via deep-merge (json_merge.py):
    #   - shared keys: template wins (canonical updates propagate)
    #   - keys only in existing .mcp.json: preserved (per-repo custom servers
    #     AND any non-mcpServers top-level keys)
    #   - idempotent: file only rewritten when semantically changed
    merge_json "$repo_path/.mcp.json" "$REPO_DIR/templates/mcp.json" "MCP base"

    # Opt-in servers (templates/mcp-optional.json) this host lists in
    # ~/.myai/mcp-optional.conf — none by default (task-b1287c56).
    local opt_overlay
    opt_overlay="$(mktemp -t mcp-optional.XXXXXX)"
    if mcp_optional_overlay "$REPO_DIR/templates/mcp-optional.json" "$opt_overlay"; then
        merge_json "$repo_path/.mcp.json" "$opt_overlay" "MCP optional (opt-in: $(mcp_optional_conf))"
    fi
    rm -f "$opt_overlay"

    # Detect web project (Next.js / Vercel) → add Chrome DevTools MCP
    local is_web=false
    [ -f "$repo_path/next.config.js" ] || [ -f "$repo_path/next.config.ts" ] || [ -f "$repo_path/next.config.mjs" ] && is_web=true
    [ -f "$repo_path/vercel.json" ] && is_web=true
    [ -f "$repo_path/src/app/layout.tsx" ] && is_web=true
    if [ "$is_web" = true ] && [ -f "$REPO_DIR/templates/mcp-web.json" ]; then
        merge_json "$repo_path/.mcp.json" "$REPO_DIR/templates/mcp-web.json" \
            "MCP web overlay (Chrome DevTools)"
    fi

    # Detect Docker project → add Docker MCP
    local is_docker=false
    [ -f "$repo_path/docker-compose.yml" ] || [ -f "$repo_path/docker-compose.yaml" ] && is_docker=true
    if [ "$is_docker" = true ] && [ -f "$REPO_DIR/templates/mcp-docker.json" ]; then
        merge_json "$repo_path/.mcp.json" "$REPO_DIR/templates/mcp-docker.json" \
            "MCP docker overlay"
    fi

    # Detect API project → add OpenAPI MCP
    local is_api=false
    [ -d "$repo_path/src/app/api" ] || [ -d "$repo_path/src/routes" ] || [ -d "$repo_path/routes" ] && is_api=true
    if [ "$is_api" = true ] && [ -f "$REPO_DIR/templates/mcp-api.json" ]; then
        merge_json "$repo_path/.mcp.json" "$REPO_DIR/templates/mcp-api.json" \
            "MCP api overlay (OpenAPI)"
    fi

    return 0
}
