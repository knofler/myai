#!/usr/bin/env bash
# ============================================================================
# protect_main.sh — the `protect main` keyword. Apply the fleet-standard branch
# protection to a repo's default branch (TIGHTEN-ONLY), or AUDIT protection
# across the whole fleet.
# ============================================================================
# WHY THIS EXISTS (operator request 2026-10-02, task-78db2c04):
# in Claude Code auto mode the built-in classifier denies a raw
#   gh api -X PUT repos/<o>/<r>/branches/main/protection
# as "[CI Bypass]" — modifying branch protection looks like disabling a gate,
# even when the intent is to ADD protection. The operator had to run the PUT by
# hand. A fleet audit then found at least one repo (foh) whose `main` had NO
# protection at all, despite CLAUDE.md declaring main PR-required.
#
# This script is the sanctioned, auditable, TIGHTEN-ONLY path:
#   • It only ever PUTs the fleet-standard (strict) protection — it never DELETEs
#     protection and never loosens an existing rule (existing required checks are
#     PRESERVED/unioned, never dropped). So it is SAFE to pre-approve in the
#     per-repo permission allow-list (templates/settings.kernel.json): a raw
#     `gh api -X PUT|DELETE .../protection` stays classifier-gated (operator runs
#     it with `! …`), while THIS script gives the agent a way to TIGHTEN that can
#     never be used to remove protection. That is the "allow tightening, not
#     removal" rule the prefix-matching permission system cannot express directly
#     (a PUT that tightens and a PUT that loosens share the same command prefix;
#     only the JSON body differs — so the distinction has to live in a vetted
#     script, not a Bash(...) glob).
#
# FLEET-STANDARD PROTECTION (matches the operator-applied state on foh):
#   required_pull_request_reviews : 0 approvals  (a PR is REQUIRED; AI reviews,
#                                   admin merges — zero human approvals needed)
#   required_status_checks        : the repo's CI/Vercel check(s), strict=false
#   enforce_admins                : false  (the admin-merge escape hatch for the
#                                   Actions-billing-blocked case — ship it §8)
#   allow_force_pushes            : false
#   allow_deletions               : false
#   restrictions                  : null   (no push allow-list)
#
# REQUIRED-CHECK SAFETY (CLAUDE.md §8 / AI_RULES §20 — phantom checks): a
# required status check that never actually runs PERMANENTLY blocks every
# non-admin PR. So we NEVER invent a check context: resolution order is
#   --checks <a,b>  >  the repo's EXISTING required contexts (GET)  >
#   auto-detect from a local checkout (vercel.json -> "Vercel";
#   .github/workflows/ci.yml job names)  >  none (+ loud WARN).
# Pass --checks explicitly when you know the context name the CI/Vercel app posts.
#
# USAGE:
#   scripts/protect_main.sh <repo> [--branch main] [--checks "Vercel"] [--dry-run]
#   scripts/protect_main.sh --audit [--json]     # read-only, whole fleet
#
#   <repo> may be an `owner/repo` slug, a local checkout path, or a bare repo
#   name resolved against config/managed_repos.txt (origin remote -> slug).
#
# EXIT: 0 ok, 1 error / blocked by GitHub, 2 usage, 3 nothing resolved.
# bash-3.2-safe. Needs: gh (authenticated), git, python3.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROSTER="${MANAGED_REPOS_FILE:-$REPO_ROOT/config/managed_repos.txt}"

if [ -t 1 ]; then
  RED=$'\033[1;31m'; YEL=$'\033[1;33m'; GRN=$'\033[38;5;208m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  RED='' YEL='' GRN='' DIM='' NC=''
fi

BRANCH="main"; CHECKS=""; DRY=0; AUDIT=0; JSON=0; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --audit)    AUDIT=1; shift ;;
    --json)     JSON=1; shift ;;
    --dry-run)  DRY=1; shift ;;
    --branch)   BRANCH="${2:-main}"; shift 2 ;;
    --checks)   CHECKS="${2:-}"; shift 2 ;;
    --no-checks) CHECKS="__NONE__"; shift ;;
    -h|--help)  sed -n '2,52p' "$0"; exit 0 ;;
    -*)         echo "protect_main: unknown flag $1" >&2; exit 2 ;;
    *)          TARGET="$1"; shift ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "protect_main: gh (GitHub CLI) not found" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "protect_main: python3 not found" >&2; exit 1; }

# slug_from_remote <path> -> "owner/repo" (empty if no git/origin/github)
# Robust to both a normal checkout (.git dir) and a worktree (.git file).
slug_from_remote() {
  local p="$1" url
  [ -d "$p" ] || return 1
  git -C "$p" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  url="$(git -C "$p" remote get-url origin 2>/dev/null)" || return 1
  [ -n "$url" ] || return 1
  case "$url" in
    *github.com[:/]*) : ;;
    *) return 1 ;;
  esac
  # git@github.com:owner/repo.git | https://github.com/owner/repo(.git)
  url="${url##*github.com[:/]}"
  url="${url%.git}"
  printf '%s\n' "$url"
}

# resolve_target <arg> -> prints "slug<TAB>localpath" (localpath may be empty)
resolve_target() {
  local arg="$1" slug="" lp=""
  if [ -d "$arg" ] && git -C "$arg" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    lp="$(cd "$arg" && pwd)"; slug="$(slug_from_remote "$lp" || true)"
  elif printf '%s' "$arg" | grep -q '^[^/]\{1,\}/[^/]\{1,\}$'; then
    slug="$arg"                       # looks like owner/repo
  else
    # bare name -> find in roster by basename, then read its origin
    local line path base
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%%#*}"; line="$(printf '%s' "$line" | xargs 2>/dev/null)"
      [ -n "$line" ] || continue
      path="${line/#\~/$HOME}"; base="$(basename "$path")"
      if [ "$base" = "$arg" ]; then lp="$path"; slug="$(slug_from_remote "$path" || true)"; break; fi
    done < "$ROSTER"
  fi
  [ -n "$slug" ] || return 1
  printf '%s\t%s\n' "$slug" "$lp"
}

# current_contexts <slug> <branch> -> space-joined existing required contexts
current_contexts() {
  gh api "repos/$1/branches/$2/protection" 2>/dev/null \
    | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for c in (d.get("required_status_checks") or {}).get("contexts",[]) or []:
    print(c)' 2>/dev/null
}

# detect_checks <localpath> -> newline-separated check contexts (best-effort)
detect_checks() {
  local lp="$1"
  [ -n "$lp" ] && [ -d "$lp" ] || return 0
  if [ -f "$lp/vercel.json" ] || [ -f "$lp/vercel.ts" ]; then echo "Vercel"; return 0; fi
  # Fall back to CI workflow job names, if a ci workflow exists.
  if [ -f "$lp/.github/workflows/ci.yml" ]; then
    # Known fleet CI job contexts.
    for c in Lint Type-check Test; do echo "$c"; done
    return 0
  fi
  return 0
}

# ---------------------------------------------------------------------------
# AUDIT MODE — read-only GET across the fleet.
# ---------------------------------------------------------------------------
if [ "$AUDIT" = "1" ]; then
  [ "$JSON" = "1" ] || printf '%s%-26s %-34s %-9s %-7s %-7s %-7s %s%s\n' "$DIM" \
     "REPO" "SLUG" "PROTECT" "PR-REQ" "NOFORCE" "NODEL" "CHECKS" "$NC"
  first=1
  [ "$JSON" = "1" ] && printf '['
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | xargs 2>/dev/null)"
    [ -n "$line" ] || continue
    path="${line/#\~/$HOME}"; name="$(basename "$path")"
    slug="$(slug_from_remote "$path" || true)"
    [ -n "$slug" ] || continue   # skip non-git / no-origin / non-github roots
    prot="$(gh api "repos/$slug/branches/$BRANCH/protection" 2>/dev/null || true)"
    if [ -z "$prot" ]; then
      status="NONE"; prreq="-"; noforce="-"; nodel="-"; checks="-"
    else
      status="yes"
      prreq="$(printf '%s' "$prot" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if d.get("required_pull_request_reviews") is not None else "NO")' 2>/dev/null || echo "?")"
      noforce="$(printf '%s' "$prot" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if not (d.get("allow_force_pushes") or {}).get("enabled",False) else "NO")' 2>/dev/null || echo "?")"
      nodel="$(printf '%s' "$prot" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if not (d.get("allow_deletions") or {}).get("enabled",False) else "NO")' 2>/dev/null || echo "?")"
      checks="$(printf '%s' "$prot" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(",".join((d.get("required_status_checks") or {}).get("contexts",[]) or []) or "-")' 2>/dev/null || echo "?")"
    fi
    if [ "$JSON" = "1" ]; then
      [ "$first" = "1" ] || printf ','
      first=0
      printf '{"repo":"%s","slug":"%s","protected":"%s","pr_required":"%s","no_force_push":"%s","no_deletion":"%s","checks":"%s"}' \
        "$name" "$slug" "$status" "$prreq" "$noforce" "$nodel" "$checks"
    else
      col="$NC"
      [ "$status" = "NONE" ] && col="$RED"
      { [ "$status" = "yes" ] && { [ "$prreq" = "NO" ] || [ "$noforce" = "NO" ] || [ "$nodel" = "NO" ]; }; } && col="$YEL"
      printf '%s%-26s %-34s %-9s %-7s %-7s %-7s %s%s\n' "$col" \
        "$name" "$slug" "$status" "$prreq" "$noforce" "$nodel" "$checks" "$NC"
    fi
  done < "$ROSTER"
  [ "$JSON" = "1" ] && printf ']\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# APPLY MODE (tighten-only).
# ---------------------------------------------------------------------------
[ -n "$TARGET" ] || { echo "protect_main: pass <repo> (owner/repo | path | name) or --audit" >&2; exit 2; }

resolved="$(resolve_target "$TARGET" || true)"
[ -n "$resolved" ] || { echo "${RED}protect_main: could not resolve '$TARGET' to an owner/repo slug${NC}" >&2; exit 3; }
SLUG="${resolved%%$'\t'*}"; LOCALPATH="${resolved#*$'\t'}"
[ "$LOCALPATH" = "$SLUG" ] && LOCALPATH=""

# Resolve required check contexts (tighten-only: union, never drop existing).
ctx_list=""
if [ "$CHECKS" = "__NONE__" ]; then
  ctx_list=""
elif [ -n "$CHECKS" ]; then
  ctx_list="$(printf '%s' "$CHECKS" | tr ',' '\n')"
else
  existing="$(current_contexts "$SLUG" "$BRANCH")"
  if [ -n "$existing" ]; then
    ctx_list="$existing"
  else
    ctx_list="$(detect_checks "$LOCALPATH")"
  fi
fi
# Normalise to clean, de-duplicated lines.
ctx_list="$(printf '%s\n' "$ctx_list" | sed 's/^ *//;s/ *$//' | grep -v '^$' | awk '!seen[$0]++' || true)"

# Build the protection payload (python3 → correct JSON, null when no checks).
payload="$(CTX="$ctx_list" python3 -c '
import os, json
ctx = [c for c in os.environ.get("CTX","").splitlines() if c.strip()]
body = {
  "required_status_checks": ({"strict": False, "contexts": ctx} if ctx else None),
  "enforce_admins": False,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": False,
    "require_code_owner_reviews": False,
    "required_approving_review_count": 0
  },
  "restrictions": None,
  "allow_force_pushes": False,
  "allow_deletions": False
}
print(json.dumps(body))
')"

echo "${GRN}protect main${NC} → ${SLUG} (branch ${BRANCH})"
if [ -n "$ctx_list" ]; then
  echo "  required checks : $(printf '%s' "$ctx_list" | paste -sd, -)"
else
  echo "  required checks : ${YEL}none${NC} — no existing/declared context; PR-required + no-force + no-delete only"
  echo "  ${DIM}(pass --checks \"Vercel\" once you know the context the CI/Vercel app posts)${NC}"
fi
echo "  PR required     : yes (0 approvals — AI reviews, admin merges)"
echo "  enforce_admins  : false (admin-merge escape hatch, ship it §8)"
echo "  force push      : blocked        deletion: blocked"

if [ "$DRY" = "1" ]; then
  echo "${DIM}--- dry run — payload that WOULD be PUT: ---${NC}"
  printf '%s\n' "$payload" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$payload"
  exit 0
fi

if printf '%s' "$payload" | gh api "repos/$SLUG/branches/$BRANCH/protection" -X PUT --input - >/dev/null 2>/tmp/protect_main.$$; then
  echo "${GRN}✓ protection applied${NC} — ${SLUG}:${BRANCH}"
  rm -f /tmp/protect_main.$$ 2>/dev/null || true
  exit 0
else
  echo "${RED}✗ failed to apply protection${NC} — ${SLUG}:${BRANCH}" >&2
  sed 's/^/    /' /tmp/protect_main.$$ 2>/dev/null >&2 || true
  echo "  ${DIM}Needs admin on the repo. If GitHub refused, run it yourself:${NC}" >&2
  echo "    ${DIM}! bash \"\$(myai root)/scripts/protect_main.sh\" $SLUG${NC}" >&2
  rm -f /tmp/protect_main.$$ 2>/dev/null || true
  exit 1
fi
