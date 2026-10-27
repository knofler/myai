#!/usr/bin/env bash
# rollout_mcp_bridge.sh — converge every fleet repo's .mcp.json on the module
# template: `myai` = stdio bridge with a global-module fallback, legacy http
# `ai-framework` entry retired. Idempotent; safe to run every morning.
#
# WHY (2026-09-21): the 08:00 boot reported "MCP PASS" from the master repo
# while 30+ managed repos still carried the OLD http-type gateway entries —
# `ai-framework` with a `${GATEWAY_LOCAL_TOKEN}` header that Claude Code
# substitutes from ITS env (blank in a normal shell) and, in exo, a `myai`
# entry with the dev-default token the gateway stopped accepting on 2026-09-02.
# Every one 401'd, Claude Code fell into an OAuth Dynamic Client Registration
# dance, and the operator's first session of the day had no memory tools.
# The fix (the stdio bridge) had existed in master for weeks; nothing carried it
# to the repos the operator actually opens. This script is that carrier, and
# morning_boot.sh phase 6b runs it before verifying.
#
# HOW: `myai mcp repo <path>` (scripts/myai_mcp.sh) deep-merges templates/mcp.json
# into the repo's .mcp.json — framework servers canonical, repo-local servers
# preserved, a null template value retires a key (scripts/lib/json_merge.py).
# No AI/ folder is copied into any repo (operator rule: propagate via the npm
# module, never by file-copy); the template's `myai` command resolves the bridge
# from the repo's AI/ if present, else the globally installed ai-management.
#
# Docker MCP (phase 6) — OPT-IN, default OFF: with --docker-gateway (or
# MYAI_DOCKER_MCP_FLEET=1) a repo with a docker-compose file is converged on
# templates/mcp.json + templates/mcp-docker-gateway.json (the `docker` entry that
# starts the framework's Docker MCP gateway launcher; npx context7 retired — it
# runs inside every lane profile). Off, every repo gets the base template only,
# exactly as before phase 6 — so the unattended 08:00 boot (which commits) never
# rolls the gateway out before the operator says so.
#
# Repos: config/managed_repos.txt + config/mcp_repos_extra.txt + every repo the
#        CODE tree holds with a .mcp.json/.myai-local (lib/fleet_mcp_repos.sh
#        discovery, minus config/mcp_repos_ignore.txt) — a new repo needs no listing.
#   "NEVER write outside AI/" repos are skipped (.mcp.json is outside AI/).
#   "NEVER push" / fetch-only repos are never pushed.
#
# Usage:
#   scripts/rollout_mcp_bridge.sh              converge + commit .mcp.json in each repo
#   scripts/rollout_mcp_bridge.sh --dry-run    report only
#   scripts/rollout_mcp_bridge.sh --push       also push repos that sit on `test`
#   scripts/rollout_mcp_bridge.sh --no-git     write the file, leave git alone
#   scripts/rollout_mcp_bridge.sh --only <path>
#   scripts/rollout_mcp_bridge.sh --docker-gateway   also converge compose repos on the Docker MCP gateway entry (opt-in)
# Exit 0 when every in-scope repo ends converged; 1 if any write failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=scripts/lib/fleet_mcp_repos.sh
. "$ROOT/scripts/lib/fleet_mcp_repos.sh"
CODE_ROOT="$(fleet_code_root "$ROOT")"   # display only: repo paths print relative to it

DRY=0 PUSH=0 GIT=1 ONLY="" QUIET=0 DOCKER_GW="${MYAI_DOCKER_MCP_FLEET:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --push)    PUSH=1 ;;
    --no-git)  GIT=0 ;;
    --quiet)   QUIET=1 ;;
    --docker-gateway) DOCKER_GW=1 ;;
    --only)    shift; ONLY="$(cd "${1:?--only needs a path}" 2>/dev/null && pwd -P)" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "rollout_mcp_bridge: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

TEMPLATE="$ROOT/templates/mcp.json"
WRITER="$ROOT/scripts/myai_mcp.sh"
[ -f "$TEMPLATE" ] || { echo "rollout_mcp_bridge: $TEMPLATE missing" >&2; exit 1; }
[ -f "$WRITER" ]   || { echo "rollout_mcp_bridge: $WRITER missing" >&2; exit 1; }

# Docker MCP phase 6 (opt-in, see the header): compose repos also get
# templates/mcp-docker-gateway.json (same compose detection as
# lib/mcp_config.sh). Converged as ONE source so a repo is written once and the
# dry-run verdict covers both. Built by a plain per-server overlay, NOT
# json_merge: json_merge applies a null as "retire now", which would drop the
# `context7: null` marker from the combined source before it reached the repo.
DOCKER_OVERLAY="$ROOT/templates/mcp-docker-gateway.json"
DOCKER_TEMPLATE=""
if [ "$DOCKER_GW" = 1 ]; then
  [ -f "$DOCKER_OVERLAY" ] || { echo "rollout_mcp_bridge: $DOCKER_OVERLAY missing" >&2; exit 1; }
  DOCKER_TEMPLATE="$(mktemp -t mcp-docker-template.XXXXXX)"
  trap 'rm -f "$DOCKER_TEMPLATE"' EXIT
  /usr/bin/python3 - "$TEMPLATE" "$DOCKER_OVERLAY" "$DOCKER_TEMPLATE" <<'PY_OVERLAY' \
    || { echo "rollout_mcp_bridge: could not combine $DOCKER_OVERLAY with the base template" >&2; exit 1; }
import json, sys
base, over = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
base.setdefault("mcpServers", {}).update(over.get("mcpServers") or {})
json.dump(base, open(sys.argv[3], "w"), indent=2)
PY_OVERLAY
fi

# template_for <repo> → the source to converge this repo on.
template_for() {
  if [ -n "$DOCKER_TEMPLATE" ] && { [ -f "$1/docker-compose.yml" ] || [ -f "$1/docker-compose.yaml" ]; }; then
    printf '%s' "$DOCKER_TEMPLATE"
  else
    printf '%s' "$TEMPLATE"
  fi
}

MSG="chore(mcp): myai stdio bridge with global-module fallback; retire legacy ai-framework http entry

Converged on the ai-management module template by rollout_mcp_bridge.sh
(compose repos: plus the Docker MCP gateway docker entry).
The old http-type entries sent a blank/dev-default x-gateway-local-token and
401'd every session start (Claude Code then failed OAuth client registration).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"

# autostash_reconcile <repo> — for every stash entry `git rebase --autostash`
# left behind ("did not re-apply cleanly"), compare each stashed file with the
# working tree. Identical everywhere → the "uncommitted work" was a Dropbox echo
# of what origin had already committed (RUNBOOK mode 8) → drop it. Any real
# difference → keep it and say so. Processes newest-last so drops never shift
# an index we have yet to visit.
autostash_reconcile() {
  local repo="$1" ref f same kept=0 dropped=0 nfiles restored
  local -a done_files
  for ref in $(git -C "$repo" stash list --format='%gd %s' 2>/dev/null | awk '/autostash/{print $1}' | awk '{a[NR]=$0} END{for(i=NR;i>0;i--) print a[i]}'); do
    same=1
    # -z: unquoted, NUL-separated names — a plain (non -z) `--name-only` C-quotes
    # any non-ASCII/space filename (core.quotePath), so a bare `for f in $(...)`
    # word-splits the quote marks into the path and every git call on it 404s.
    while IFS= read -r -d '' f; do
      [ -n "$f" ] || continue
      if git -C "$repo" cat-file -e "$ref:$f" 2>/dev/null; then
        if ! git -C "$repo" show "$ref:$f" 2>/dev/null | cmp -s - "$repo/$f" 2>/dev/null; then same=0; break; fi
      else
        # $f doesn't exist in the stash's tree at all: the stash recorded a
        # DELETION (working tree had it removed, unstaged, when we stashed).
        # "same as origin" here means the file is ALSO gone from the working
        # tree now — if it exists, that's a real difference, not an echo.
        [ -e "$repo/$f" ] && { same=0; break; }
      fi
    done < <(git -C "$repo" stash show --name-only -z "$ref" 2>/dev/null)
    if [ "$same" = 1 ]; then
      git -C "$repo" stash drop -q "$ref" >/dev/null 2>&1 && dropped=$((dropped+1))
    else
      # Put the operator's files back EXACTLY as we found them (the stash commit
      # holds the pre-rebase worktree content), then drop the stash. The tree
      # ends up as dirty as it was, just relative to the new HEAD — never parked
      # somewhere the operator has to know to look.
      nfiles="$(git -C "$repo" stash show --name-only -z "$ref" 2>/dev/null | tr '\0' '\n' | sed '/^$/d' | wc -l | tr -d ' ')"
      # ONLY the stashed paths. `checkout "$ref" -- .` wrote the stash commit's
      # ENTIRE pre-rebase tree over worktree+index — every file origin had just
      # moved (and the operator never touched) came back stale AND staged, so the
      # next `git add -A` commit would have pushed a revert of upstream work
      # (review 2026-09-22). Restore each stashed file's content, then unstage
      # it, so the tree is dirty exactly as before — relative to the new HEAD.
      # `:(literal)` stops a filename holding pathspec-magic characters (`*`,
      # `[`, `?`, `:`) from being read as a pattern instead of a literal path.
      restored=1
      done_files=()
      while IFS= read -r -d '' f; do
        [ -n "$f" ] || continue
        if git -C "$repo" cat-file -e "$ref:$f" 2>/dev/null; then
          if ! git -C "$repo" checkout -q "$ref" -- ":(literal)$f" >/dev/null 2>&1; then restored=0; break; fi
          git -C "$repo" reset -q -- ":(literal)$f" >/dev/null 2>&1 || true
        else
          # Deleted in the stash → reproduce the deletion (nothing to check out).
          rm -f -- "$repo/$f" 2>/dev/null || { restored=0; break; }
        fi
        done_files+=("$f")
      done < <(git -C "$repo" stash show --name-only -z "$ref" 2>/dev/null)
      if [ "$restored" = 1 ] && git -C "$repo" stash drop -q "$ref" >/dev/null 2>&1; then
        kept=$((kept+1)); log "         restored your $nfiles uncommitted file(s) to the working tree exactly as they were (they differ from origin; tree is dirty as before)"
      else
        # A per-file failure (escaped/rename edge case, permission error) leaves
        # files already restored dirty relative to the NEW HEAD while the stash
        # is kept — the printed `git stash pop` then refuses ("local changes
        # would be overwritten") because those files are already dirty. Undo
        # what we've applied so far so the tree is exactly HEAD, stash untouched.
        if [ "${#done_files[@]}" -gt 0 ]; then
          for f in "${done_files[@]}"; do
            git -C "$repo" checkout -q HEAD -- ":(literal)$f" >/dev/null 2>&1 || true
          done
        fi
        log "         NOTE: could not restore $ref automatically — your changes are in \`git stash list\`, run \`git stash pop\` there"
      fi
    fi
  done
  [ "$dropped" -gt 0 ] && log "         autostash: $dropped stash entr$([ "$dropped" = 1 ] && echo y || echo ies) were byte-identical echoes of origin — dropped"
  return 0
}

n_total=0 n_changed=0 n_current=0 n_skipped=0 n_failed=0 n_committed=0 n_pushed=0 n_pushfail=0
log() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

while IFS='|' read -r repo flags; do
  [ -n "$repo" ] || continue
  [ -n "$ONLY" ] && [ "$repo" != "$ONLY" ] && continue
  n_total=$((n_total+1))
  short="$repo"; [ -n "$CODE_ROOT" ] && short="${repo#"$CODE_ROOT"/}"

  case ",$flags," in *,noai,*)
    n_skipped=$((n_skipped+1)); log "skip     $short  (AI/-only repo — .mcp.json is outside AI/)"; continue ;;
  esac

  if [ "$DRY" = 1 ]; then
    out="$(MYAI_MCP_SOURCE="$(template_for "$repo")" bash "$WRITER" repo "$repo" --dry-run 2>&1)"
    case "$out" in
      *"already current"*) n_current=$((n_current+1)); log "current  $short" ;;
      *"would "*)          n_changed=$((n_changed+1)); log "WOULD    $short  ${out##*would }" ;;
      *)                   n_failed=$((n_failed+1));   log "FAIL     $short  $out" ;;
    esac
    continue
  fi

  out="$(MYAI_MCP_SOURCE="$(template_for "$repo")" bash "$WRITER" repo "$repo" 2>&1)"; rc=$?
  case "$rc:$out" in
    0:*"already current"*) n_current=$((n_current+1)); log "current  $short" ;;
    0:*"refreshed"*|0:*"wrote"*) n_changed=$((n_changed+1)); log "changed  $short" ;;
    *) n_failed=$((n_failed+1)); log "FAIL     $short  $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"; continue ;;
  esac

  [ "$GIT" = 1 ] || continue
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log "         (not a git repo — file written, nothing to commit)"; continue; }
  # Respect a repo that deliberately ignores .mcp.json.
  if git -C "$repo" check-ignore -q .mcp.json 2>/dev/null; then log "         (.mcp.json is gitignored here — written, not committed)"; continue; fi
  br="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  # Commit whenever the file differs from HEAD — including a file an earlier
  # --no-git run (or an unattended boot that was denied git) left converged
  # but uncommitted. "current" is about content, not about git state.
  if [ -n "$(git -C "$repo" status --porcelain -- .mcp.json 2>/dev/null)" ]; then
    if [ "$br" != test ]; then
      # 2026-09-22 review: the unattended boot committed onto WHATEVER branch a
      # repo happened to have checked out, including `main`. Gating to the
      # repo's "burn branch" (test-if-origin-has-one, else main) still left a
      # gap — the push step below only ever pushes literal `test` (never
      # `main`), so a repo with no origin/test branch got a *local* commit on
      # main that could never be pushed: local main permanently ahead of
      # origin with no push path, exactly the divergence this gate exists to
      # prevent. Only `test` is ever committed to; every other branch —
      # `main` included — gets the file written and left uncommitted so the
      # next run on `test` picks it up.
      log "         converged, not committed (branch $br)"
      continue
    fi
    if cerr="$(git -C "$repo" add -- .mcp.json 2>&1 && git -C "$repo" commit -q -m "$MSG" -- .mcp.json 2>&1)"; then
      n_committed=$((n_committed+1)); log "         committed on $br"
    else
      log "         commit FAILED: $(printf '%s' "$cerr" | grep -v '^$' | tail -1 | cut -c1-140)"; continue
    fi
  fi

  [ "$PUSH" = 1 ] || continue
  case ",$flags," in *,nopush,*) log "         (NEVER push repo — not pushed)"; continue ;; esac
  git -C "$repo" remote get-url origin >/dev/null 2>&1 || { log "         (no origin remote — commit left local)"; continue; }
  [ "$br" = test ] || { log "         (branch $br — only \`test\` is pushed; commit left local)"; continue; }
  # 2026-09-21: the first --push run rejected 15 repos as non-fast-forward —
  # the local origin/test refs were stale, the remotes had moved. Fetch first,
  # rebase our (config-only) commits onto the remote, then push. A dirty tree
  # or a rebase conflict is reported, never forced.
  # GitHub's SSH front door resets connections after a burst (seen 2026-09-21:
  # three back-to-back fleet runs → every fetch "Connection reset by peer" for
  # a minute). One short pause per repo keeps ~40 connections under the limit.
  [ "${ROLLOUT_NET_PAUSE:-1}" = 0 ] || sleep "${ROLLOUT_NET_PAUSE:-1}"
  ferr="$(git -C "$repo" fetch -q origin test 2>&1)" || { n_pushfail=$((n_pushfail+1)); log "         push FAILED: fetch origin test — $(printf '%s' "$ferr" | grep -v '^$' | head -1 | cut -c1-120)"; continue; }
  autostash_reconcile "$repo"
  ahead="$(git -C "$repo" rev-list --count origin/test..HEAD 2>/dev/null || echo 0)"
  behind="$(git -C "$repo" rev-list --count HEAD..origin/test 2>/dev/null || echo 0)"
  [ "$ahead" -gt 0 ] || continue                      # origin already has everything
  if [ "$behind" -gt 0 ]; then
    # These are live working trees (Dropbox-synced, often with uncommitted
    # work). --autostash is what `git pull --rebase --autostash` does: park the
    # dirty files, rebase, put them back. If putting them back conflicts, git
    # keeps them in the stash and says so — we surface that, never lose them.
    # RUNBOOK mode 8: an UNTRACKED local file that origin/test adds blocks the
    # checkout ("would be overwritten"). Dropbox usually delivered it already —
    # byte-identical → remove it, git re-creates it from origin. Differing →
    # refuse by name; it may be the only copy of an edit.
    blocked=""
    for f in $(git -C "$repo" diff --name-only --diff-filter=A HEAD origin/test 2>/dev/null); do
      [ -e "$repo/$f" ] || continue
      git -C "$repo" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && continue   # tracked → autostash handles it
      if git -C "$repo" show "origin/test:$f" 2>/dev/null | cmp -s - "$repo/$f"; then rm -f "$repo/$f"
      else blocked="$blocked $f"; fi
    done
    if [ -n "$blocked" ]; then
      n_pushfail=$((n_pushfail+1)); log "         push SKIPPED: untracked local file(s) differ from what origin/test adds:$blocked — resolve by hand"; continue
    fi
    if ! rerr="$(git -C "$repo" rebase -q --autostash origin/test 2>&1)"; then
      # The only file we commit is .mcp.json. If THAT is the conflict (origin
      # also changed it — another machine's rollout, a runner sync), resolve it
      # the way the template is meant to be applied: take origin's version and
      # re-converge the template into it, so origin's additions survive and the
      # framework servers are canonical. Anything else conflicting → abort.
      conflicted="$(git -C "$repo" diff --name-only --diff-filter=U 2>/dev/null)"
      if [ -z "$conflicted" ]; then
        # The rebase never got to a content conflict (untracked files in the
        # way, a lock, a hook…) — say what git said.
        git -C "$repo" rebase --abort >/dev/null 2>&1
        n_pushfail=$((n_pushfail+1)); log "         push SKIPPED: rebase could not run — $(printf '%s' "$rerr" | grep -v '^$' | grep -v -i 'autostash' | tail -1 | cut -c1-160)"; continue
      fi
      if [ "$conflicted" = ".mcp.json" ]; then
        # Prefer origin's version as the base (their additions survive) — unless
        # origin's file is not even valid JSON (seen 2026-09-21, one fleet repo:
        # a broken .mcp.json committed elsewhere), in which case ours — the
        # converged, valid one — is the only sane base.
        side=--ours
        git -C "$repo" show origin/test:.mcp.json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1 || side=--theirs
        if rres="$( { git -C "$repo" checkout "$side" -- .mcp.json \
                 && MYAI_MCP_SOURCE="$(template_for "$repo")" bash "$WRITER" repo "$repo" \
                 && git -C "$repo" add -- .mcp.json \
                 && GIT_EDITOR=true git -C "$repo" rebase --continue; } 2>&1 )" \
           && [ ! -d "$repo/.git/rebase-merge" ] && [ ! -d "$repo/.git/rebase-apply" ]; then
          log "         resolved: origin also changed .mcp.json — re-converged the template onto $([ "$side" = --ours ] && echo "origin's version" || echo "OUR version (origin's file is invalid JSON)")"
        else
          git -C "$repo" rebase --abort >/dev/null 2>&1
          n_pushfail=$((n_pushfail+1)); log "         push SKIPPED: .mcp.json conflict resolution failed (aborted) — $(printf '%s' "$rres" | grep -v '^$' | tail -1 | cut -c1-160)"; continue
        fi
      else
        git -C "$repo" rebase --abort >/dev/null 2>&1
        n_pushfail=$((n_pushfail+1)); log "         push SKIPPED: rebase onto origin/test conflicted on [$(printf '%s' "$conflicted" | tr '\n' ' ' | sed 's/ *$//')] (aborted) — resolve by hand"; continue
      fi
    fi
    autostash_reconcile "$repo"
    log "         rebased $ahead commit(s) onto origin/test (was $behind behind$([ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ] && printf ', dirty tree autostashed'))"
  fi
  if perr="$(git -C "$repo" push -q origin test 2>&1)"; then n_pushed=$((n_pushed+1)); log "         pushed origin/test"
  else
    n_pushfail=$((n_pushfail+1))
    log "         push FAILED (left committed locally): $(printf '%s' "$perr" | grep -v '^$' | tail -1 | cut -c1-140)"
  fi
done < <(fleet_mcp_repos "$ROOT")

verb="changed"; [ "$DRY" = 1 ] && verb="would change"
echo "rollout_mcp_bridge: $n_total repos — $n_current current · $n_changed $verb · $n_skipped skipped · $n_failed failed$( [ "$GIT" = 1 ] && [ "$DRY" = 0 ] && printf ' · %s committed · %s pushed' "$n_committed" "$n_pushed")$( [ "$n_pushfail" -gt 0 ] && printf ' · %s push FAILED' "$n_pushfail")"
[ "$n_failed" -eq 0 ]
