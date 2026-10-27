#!/usr/bin/env bash
# selfhosted_runner.sh — shared helpers for the fleet "self-hosted runners only"
# rule (CLAUDE.md CRITICAL RULE 9 / AI_RULES §21).
#
# THE RULE: GitHub-hosted Actions minutes cost money. Every repo MUST run CI on
# the local self-hosted runner (`runs-on: [self-hosted, myai-local]`) and MUST
# NOT carry a `push:` trigger — except repos owned by an EXEMPT org (one whose
# hosted minutes are paid for by a team), listed in config/hosted_runner_orgs.txt.
#
# Sourced by: scripts/rollout_selfhosted_runner.sh, scripts/check_selfhosted_runners.sh,
# scripts/health_check.sh. Pure bash + awk (no network) so it is fast and offline.

# Orgs whose repos may keep hosted runners (space- or comma-separated, compared
# lowercase). $SELFHOSTED_EXEMPT_ORG wins when set (set it empty to exempt
# nothing); else config/hosted_runner_orgs.txt, one org per line (local, not
# shipped — see the .example); else the user-level
# ${MYAI_HOME:-$HOME/.myai}/hosted_runner_orgs.txt, which is what an
# npm-installed package reads (its install root has no config/ file, and one
# placed there would be wiped by the next upgrade); else none, so every repo
# uses self-hosted.
if [ -z "${SELFHOSTED_EXEMPT_ORG+x}" ]; then
    _sh_orgs_file="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)/config/hosted_runner_orgs.txt"
    [ -f "$_sh_orgs_file" ] || _sh_orgs_file="${MYAI_HOME:-$HOME/.myai}/hosted_runner_orgs.txt"
    SELFHOSTED_EXEMPT_ORG=""
    [ -f "$_sh_orgs_file" ] && SELFHOSTED_EXEMPT_ORG="$(grep -vE '^[[:space:]]*(#|$)' "$_sh_orgs_file" | tr '[:upper:]\n' '[:lower:] ' | sed 's/[[:space:]]*$//')"
    unset _sh_orgs_file
fi
# The runner the fleet standardises on (matches ci/runner labels + docker-compose).
# shellcheck disable=SC2034  # exported to the scripts that source this lib
SELFHOSTED_RUNS_ON='[self-hosted, myai-local]'

# sh_repo_owner <repo_path> — echo the lowercased GitHub owner/org parsed from the
# origin remote, or empty when it can't be resolved (no .git, no origin, non-GitHub).
sh_repo_owner() {
    local d="$1" url=""
    [ -e "$d/.git" ] || { printf ''; return 0; }
    url="$(git -C "$d" remote get-url origin 2>/dev/null)" || url=""
    [ -n "$url" ] || { printf ''; return 0; }
    url="${url%.git}"
    case "$url" in
        *github.com:*) url="${url##*github.com:}" ;;   # git@github.com:owner/repo
        *github.com/*) url="${url##*github.com/}" ;;    # https://github.com/owner/repo
        *) printf ''; return 0 ;;
    esac
    printf '%s' "${url%%/*}" | tr '[:upper:]' '[:lower:]'
}

# sh_is_exempt_org <repo_path> — return 0 (exempt) when the repo belongs to an
# exempt org, so callers can `sh_is_exempt_org "$d" && continue`. Unknown owner
# (empty) is treated as NON-exempt: a personal/unknown repo must use self-hosted.
sh_is_exempt_org() {
    local owner
    owner="$(sh_repo_owner "$1")"
    [ -n "$owner" ] || return 1
    case " $(printf '%s' "$SELFHOSTED_EXEMPT_ORG" | tr ',[:upper:]' ' [:lower:]') " in
        *" $owner "*) return 0 ;;
    esac
    return 1
}

# sh_hosted_runner_hits <workflow_file> — print "<lineno>: <text>" for each line
# that names a GitHub-HOSTED runner image (ubuntu/windows/macos -latest or -NN.NN)
# in a runs-on value or a matrix os-list item. Whole-line AND trailing (space-#)
# comments are stripped before matching, so a `# was ubuntu-latest` note on a
# self-hosted line is NOT a false positive.
sh_hosted_runner_hits() {
    local f="$1"
    [ -f "$f" ] || return 0
    awk '
        {
            line = $0
            val = line
            sub(/[[:space:]]#.*/, "", val)        # drop trailing inline comment
            s = val
            sub(/^[[:space:]]+/, "", s)
            if (s ~ /^#/) next                    # whole-line comment
            if (val ~ /runs-on/ || val ~ /^[[:space:]]*-[[:space:]]*["'"'"']?(ubuntu|windows|macos)-/) {
                if (val ~ /(ubuntu|windows|macos)-(latest|[0-9]+(\.[0-9]+)?)/)
                    print NR ": " line
            }
        }
    ' "$f"
}

# sh_workflow_dir <repo_path> — echo the workflows dir if present, else empty.
sh_workflow_dir() {
    local d="$1"
    [ -d "$d/.github/workflows" ] && printf '%s' "$d/.github/workflows"
}
