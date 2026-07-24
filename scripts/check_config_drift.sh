#!/usr/bin/env bash
# check_config_drift.sh — content-level config-drift detector for managed repos.
#
# health_check.sh verifies managed repos HAVE the expected framework files
# (existence only — see check_repo() there). It says nothing about whether a
# repo's copy still MATCHES master after someone hand-edits it in place (e.g.
# a repo's .claude/settings.json or a hook script silently diverging). This
# script fills that gap: it diffs exactly the files update_all.sh propagates
# to managed repos against this master repo's canonical copies, so a content
# divergence shows up before it causes a fleet-wide inconsistency.
#
# What's checked per managed repo (mirrors update_all.sh's propagation logic
# exactly — checking anything update_all.sh does NOT propagate would produce
# permanent false-positive drift):
#   1. .claude/settings.json — update_all.sh deep-MERGES this (json_merge.py),
#      it never plain-overwrites, so repo-local additions (statusLine, extra
#      permissions) are expected and are NOT drift. Simulated here via
#      `json_merge.py --check` (dry run, non-mutating): if re-running the
#      real merge would still change the file, framework-owned keys have
#      diverged from what master would produce.
#   2. hooks/** — copied verbatim (`cp -r`) by update_all.sh, so an exact
#      byte diff against master's hooks/ tree is the correct check.
#   3. AI/config/{schedule_ignore,remote_fleet,schedule_priority}.txt and
#      AI/config/session-limits.json — the "framework-owned, always overwrite
#      unconditionally" set update_all.sh copies with plain `cp`; exact byte
#      diff against master's config/ copies.
#
# A file that's simply MISSING from the repo is not reported as drift here —
# that's health_check.sh's job. This script only flags a file that EXISTS in
# the repo but whose content has drifted from master.
#
# Usage:
#   ./scripts/check_config_drift.sh                # all repos in config/managed_repos.txt
#   ./scripts/check_config_drift.sh /path/to/repo  # single repo
#   ./scripts/check_config_drift.sh --status       # print last recorded run, no run
#
# Env overrides (used by scripts/tests/test_check_config_drift.sh for a
# hermetic fixture run — never touch these for a normal invocation):
#   CONFIG_DRIFT_MASTER      canonical master dir (default: this repo)
#   CONFIG_DRIFT_REPOS_FILE  managed-repos list (default: $MASTER/config/managed_repos.txt)
#   CONFIG_DRIFT_STATE       last-run state file (default: ~/.ai-cli-runner/config-drift.state)
#
# Exit: 0 no drift found (or nothing to check) · 1 drift found in >=1 repo
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
JSON_MERGE="$SCRIPT_DIR/lib/json_merge.py"

MASTER_DIR="${CONFIG_DRIFT_MASTER:-$(cd "$SCRIPT_DIR/.." && pwd)}"
REPOS_FILE="${CONFIG_DRIFT_REPOS_FILE:-$MASTER_DIR/config/managed_repos.txt}"
STATE_DIR="$HOME/.ai-cli-runner"
STATE_FILE="${CONFIG_DRIFT_STATE:-$STATE_DIR/config-drift.state}"

RED='\033[0;31m'
GREEN='\033[38;5;208m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

OK=0
DRIFT=0
DRIFTED_REPOS=()

note()  { echo -e "  ${CYAN}·${NC} $1"; }
pass()  { echo -e "  ${GREEN}✓${NC} $1"; ((OK++)); }
drift() { echo -e "  ${RED}✗ DRIFT${NC} $1"; ((DRIFT++)); }

# The 3 always-overwrite .txt files + the one always-overwrite JSON file
# update_all.sh propagates unconditionally to AI/config/ (see the "framework-
# owned, ALWAYS overwrite" comments around update_all.sh:177-211).
CONFIG_TXT_FILES=(schedule_ignore.txt remote_fleet.txt schedule_priority.txt)
CONFIG_JSON_FILES=(session-limits.json)

# check_settings_json <repo_path> — dry-run the real deep-merge and see if it
# would still change the repo's file (drift), leave it alone (clean), or find
# nothing to compare (skipped — existence is health_check's job).
check_settings_json() {
    local repo_path="$1"
    local master_settings="$MASTER_DIR/.claude/settings.json"
    local repo_settings="$repo_path/.claude/settings.json"

    [ -f "$master_settings" ] || return 0
    if [ ! -f "$repo_settings" ]; then
        note ".claude/settings.json not present in repo — skipped (existence is health_check.sh's job)"
        return 0
    fi

    # Same ./scripts -> ./AI/scripts rewrite update_all.sh applies before
    # merging, so the notify-telegram.sh hook command doesn't false-positive.
    local tmp_master
    tmp_master=$(mktemp)
    sed 's|"./scripts/notify-telegram.sh|"./AI/scripts/notify-telegram.sh|g' \
        "$master_settings" > "$tmp_master"

    local out rc=0
    out=$(/usr/bin/python3 "$JSON_MERGE" "$repo_settings" "$tmp_master" --check 2>&1) || rc=$?
    rm -f "$tmp_master"

    case "${rc}:${out}" in
        0:unchanged) pass ".claude/settings.json matches master (framework-owned keys)" ;;
        0:created)   note ".claude/settings.json not present in repo — skipped" ;;
        0:changed)   drift ".claude/settings.json framework-owned keys diverged from master — re-run update_all.sh or inspect manually" ;;
        *)           echo -e "  ${YELLOW}⚠${NC} .claude/settings.json — could not evaluate: $out" ;;
    esac
}

# check_verbatim_tree <repo_path> — byte-diff every file under master's
# hooks/ against the repo's hooks/ (update_all.sh's `cp -r hooks/*`).
check_hooks() {
    local repo_path="$1"
    local master_hooks="$MASTER_DIR/hooks"
    [ -d "$master_hooks" ] || return 0

    local rel any_checked=0
    local drift_before=$DRIFT
    while IFS= read -r -d '' f; do
        rel="${f#"$master_hooks"/}"
        any_checked=1
        if [ ! -f "$repo_path/hooks/$rel" ]; then
            note "hooks/$rel not present in repo — skipped (existence is health_check.sh's job)"
        elif cmp -s "$f" "$repo_path/hooks/$rel"; then
            : # identical — tallied once at the end (avoid a pass-line per file)
        else
            local lines
            lines=$(diff -u "$f" "$repo_path/hooks/$rel" 2>/dev/null | grep -c '^[+-]' || true)
            drift "hooks/$rel content diverged from master (~${lines} changed lines)"
        fi
    done < <(find "$master_hooks" -type f -print0)

    if [ "$any_checked" -eq 1 ] && [ "$DRIFT" -eq "$drift_before" ]; then
        pass "hooks/ tree matches master"
    fi
}

# check_config_files <repo_path> — exact diff of the always-overwrite
# config files against AI/config/.
check_config_files() {
    local repo_path="$1"
    local f master_f repo_f

    for f in "${CONFIG_TXT_FILES[@]}" "${CONFIG_JSON_FILES[@]}"; do
        master_f="$MASTER_DIR/config/$f"
        repo_f="$repo_path/AI/config/$f"
        [ -f "$master_f" ] || continue
        if [ ! -f "$repo_f" ]; then
            note "AI/config/$f not present in repo — skipped (existence is health_check.sh's job)"
            continue
        fi
        if cmp -s "$master_f" "$repo_f"; then
            pass "AI/config/$f matches master"
        else
            drift "AI/config/$f content diverged from master"
        fi
    done
}

# is_kernel_only_repo <repo_path> — ADR-016 §0.2 greenfield `myai init` repo:
# no AI/ folder is CORRECT (framework resolves from the installed npm
# module), so there's nothing propagated here to content-check.
is_kernel_only_repo() {
    local repo_path="$1"
    [ -d "$repo_path/AI" ] && return 1
    [ -f "$repo_path/CLAUDE.md" ] || return 1
    head -n 3 "$repo_path/CLAUDE.md" 2>/dev/null | grep -qE '^#[[:space:]]+myAI kernel'
}

check_repo() {
    local repo_path="$1"
    echo ""
    echo -e "${CYAN}━━━ Checking: ${repo_path} ━━━${NC}"

    if [ ! -d "$repo_path" ]; then
        echo -e "  ${YELLOW}⚠${NC} Directory not found — skipped"
        return 0
    fi

    if is_kernel_only_repo "$repo_path"; then
        note "Kernel-only repo (greenfield 'myai init') — framework resolves from the installed module, nothing propagated to content-check"
        return 0
    fi

    local before=$DRIFT
    check_settings_json "$repo_path"
    check_hooks "$repo_path"
    check_config_files "$repo_path"

    if [ "$DRIFT" -gt "$before" ]; then
        DRIFTED_REPOS+=("$repo_path")
    fi
}

write_state() {
    mkdir -p "$STATE_DIR"
    local drifted_json="[]"
    if [ "${#DRIFTED_REPOS[@]}" -gt 0 ]; then
        drifted_json=$(printf '"%s",' "${DRIFTED_REPOS[@]}")
        drifted_json="[${drifted_json%,}]"
    fi
    cat > "$STATE_FILE" <<EOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","ok":${OK},"drift":${DRIFT},"drifted_repos":${drifted_json}}
EOF
}

print_status() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
        echo ""
    else
        echo "NOT yet run — no $STATE_FILE"
    fi
}

# ─── Main ───

if [ "${1:-}" = "--status" ]; then
    print_status
    exit 0
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Config Drift Check — content vs master          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"

if [ -n "${1:-}" ]; then
    check_repo "$1"
else
    if [ ! -f "$REPOS_FILE" ]; then
        echo -e "${RED}Error: $REPOS_FILE not found.${NC}"
        exit 1
    fi
    while IFS= read -r repo_path || [ -n "$repo_path" ]; do
        [[ -z "$repo_path" ]] && continue
        [[ "$repo_path" == \#* ]] && continue
        repo_path="${repo_path%%#*}"
        repo_path="${repo_path%"${repo_path##*[![:space:]]}"}"
        [ -z "$repo_path" ] && continue
        repo_path="${repo_path/#\~/$HOME}"
        check_repo "$repo_path"
    done < "$REPOS_FILE"
fi

write_state

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Summary                                         ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Matches master:${NC} $OK"
echo -e "  ${RED}Drifted:${NC}        $DRIFT"
echo ""

if [ "$DRIFT" -eq 0 ]; then
    echo -e "  ${GREEN}No content drift found.${NC}"
    exit 0
else
    echo -e "  ${RED}Content drift found in ${#DRIFTED_REPOS[@]} repo(s): ${DRIFTED_REPOS[*]}${NC}"
    echo -e "  Fix: re-run ./scripts/update_all.sh (framework files) and inspect any repo-local hand-edits."
    exit 1
fi
