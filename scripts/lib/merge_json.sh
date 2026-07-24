#!/usr/bin/env bash
# merge_json.sh — shared bash wrapper around json_merge.py's deep-merge.
#
# Extracted from scripts/update_all.sh (PR #289, 2026-07-02) so every JSON
# propagation callsite — not just update_all.sh's — goes through the SAME
# merge-never-clobber policy. Before this extraction, scripts/init_ai.sh had
# its own independent `sed ... > .claude/settings.json` RAW OVERWRITE that
# PR #289 never touched (it only fixed update_all.sh's 5 callsites), so a
# repo re-`init`'d after being customized (extra hooks, statusLine, custom
# MCP servers) still got clobbered — the 19th fleet-wide clobber incident,
# after PR #289 was believed to have killed the bug class for good.
# Consumers: scripts/update_all.sh, scripts/init_ai.sh. Sourced, not executed.
#
# Requires the caller to set REPO_DIR (the master repo root) before sourcing.

# merge_json TARGET MASTER [LABEL] — deep-merge MASTER into TARGET in place.
# Framework-owned keys stay canonical; repo-local additions (statusLine, extra
# hooks, custom MCP servers) survive. Idempotent: TARGET is rewritten ONLY
# when the merged result differs semantically, so a no-change run dirties
# nothing. An invalid/unreadable TARGET is left untouched and reported — the
# merge never falls back to overwriting.
merge_json() {
    # `|| _rc=$?` keeps the nonzero exit from tripping the caller's `set -e`
    # (the PR #256 lesson: a bare failing $(…) assignment kills the whole run).
    local _out _rc=0
    _out=$(/usr/bin/python3 "$REPO_DIR/scripts/lib/json_merge.py" "$1" "$2" 2>&1) || _rc=$?
    case "${_rc}:${_out}" in
        0:changed)   echo "  ${3:-json}: merged (framework keys updated, repo-local additions preserved)" ;;
        0:unchanged) : ;;   # idempotent no-op — say nothing, dirty nothing
        0:created)   echo "  ${3:-json}: created from framework template" ;;
        *)           echo "  ${3:-json}: SKIPPED — $_out" ;;
    esac
    return 0
}
