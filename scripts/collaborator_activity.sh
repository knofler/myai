#!/bin/bash
set +e
# collaborator_activity.sh — the "Since last session" collaborator-activity boot step.
#
# WHY THIS EXISTS (operator request 2026-10-02, from foh): every boot
# (`agent mode`, `agent mode -min`, `boot`) must check for new code pushed by
# OTHER PEOPLE on any repo with a git remote — not just fast-forward our own
# branch. Until now boot ran `git fetch origin` + `git pull <branch>` and the
# codeclot/claude mobile-branch check, and NEVER reported what teammates did.
# In foh, collaborators (Rajeeva, Jakob, Joseph) push feature branches and open
# PRs; the operator had to ask by hand ("check new from rajeeva") and a reply on
# a "changes requested" PR thread sat unseen for days. This makes that report a
# standard, zero-ask boot step.
#
# Contract (warn-only, NEVER mutates history, NEVER prunes, ALWAYS exits 0):
#   - no git remote                    -> ZERO output (skip silently)
#   - remote but nothing new since the
#     anchor                           -> one "No new activity" line
#   - new branches / commits / PR
#     activity since the anchor        -> a short "Since last session" block,
#                                         grouped per author
#
# The since-anchor is, in order: $MYAI_COLLAB_SINCE (override) -> the newest
# timestamp in this repo's handoff header (master: state/AI_AGENT_HANDOFF.md;
# managed: AI/state/AI_AGENT_HANDOFF.md) -> a 7-day default window. (The brain
# `lastAnchor` date is an equivalent anchor the gateway resolves; the handoff
# timestamp is used here because it is offline and gateway-independent.)
#
# Usage:
#   scripts/collaborator_activity.sh            # fetch --all --prune, then report
#   scripts/collaborator_activity.sh --no-fetch # report from already-fetched refs
#                                               # (the session-start hook uses this:
#                                               #  09a-boot-sync already fetched)
#
# Env:
#   MYAI_COLLAB_SINCE   override anchor (anything git --since accepts)
#   MYAI_COLLAB_NO_GH=1 skip the gh (PR/issue/comment) section
#   MYAI_COLLAB_MAX     max rows per section (default 12)

DO_FETCH=1
for a in "$@"; do
  case "$a" in
    --no-fetch) DO_FETCH=0 ;;
    --fetch)    DO_FETCH=1 ;;
  esac
done

MAX="${MYAI_COLLAB_MAX:-12}"

# ── portable wall-clock cap: a hung network call must never wedge a boot, and
# macOS ships no timeout(1). Prefer timeout/gtimeout, else a temp-file poller
# (same pattern as scripts/lib/vercel_root.sh). Output goes to a temp file so a
# surrounding out="$(_ca_timeout ...)" returns within $secs even on overrun.
_ca_timeout() {
  local secs="$1"; shift
  if command -v timeout  >/dev/null 2>&1; then timeout  "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  local tf; tf="$(mktemp 2>/dev/null)" || { "$@"; return $?; }
  "$@" >"$tf" 2>/dev/null &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -ge "$secs" ] && { kill -TERM "$pid" 2>/dev/null; break; }
    sleep 1
  done
  wait "$pid" 2>/dev/null; local rc=$?
  cat "$tf" 2>/dev/null; rm -f "$tf"
  return $rc
}

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
[ -z "$ROOT" ] && exit 0
cd "$ROOT" 2>/dev/null || exit 0

# Skip silently when there is no remote at all — a purely local repo has no
# collaborators to report (task requirement).
REMOTES="$(git remote 2>/dev/null)"
[ -z "$REMOTES" ] && exit 0

# Prefer origin; fall back to the first remote.
REMOTE="origin"
echo "$REMOTES" | grep -qx origin || REMOTE="$(echo "$REMOTES" | head -1)"

# ── since-anchor ─────────────────────────────────────────────────────────────
ANCHOR=""
ANCHOR_SRC=""
if [ -n "${MYAI_COLLAB_SINCE:-}" ]; then
  ANCHOR="$MYAI_COLLAB_SINCE"; ANCHOR_SRC="override"
else
  for hf in "$ROOT/state/AI_AGENT_HANDOFF.md" "$ROOT/AI/state/AI_AGENT_HANDOFF.md"; do
    [ -f "$hf" ] || continue
    # Newest handoff timestamp — e.g. 2026-10-02T15:10+10 or 2026-09-29T09:40Z.
    # The header lists sessions newest-first, so the first match is the anchor.
    cand="$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}([0-9:]*)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?' "$hf" 2>/dev/null | head -1)"
    if [ -n "$cand" ]; then ANCHOR="$cand"; ANCHOR_SRC="handoff ($(basename "$(dirname "$hf")")/)"; break; fi
    # Fall back to a bare date (e.g. 2026-10-02) if no full timestamp present.
    cand="$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' "$hf" 2>/dev/null | head -1)"
    if [ -n "$cand" ]; then ANCHOR="$cand"; ANCHOR_SRC="handoff date"; break; fi
  done
fi
if [ -z "$ANCHOR" ]; then
  ANCHOR="7 days ago"; ANCHOR_SRC="default 7d (no handoff anchor)"
fi

# ── fetch (unless --no-fetch; bounded so a dead remote can't hang the boot) ──
if [ "$DO_FETCH" -eq 1 ]; then
  _ca_timeout 25 git fetch --all --prune --quiet >/dev/null 2>&1
fi

# Main ref to diff against: origin/main, else origin/master, else remote HEAD.
MAIN_REF=""
for c in "$REMOTE/main" "$REMOTE/master"; do
  if git rev-parse --verify --quiet "$c" >/dev/null 2>&1; then MAIN_REF="$c"; break; fi
done
if [ -z "$MAIN_REF" ]; then
  MAIN_REF="$(git rev-parse --abbrev-ref "$REMOTE/HEAD" 2>/dev/null)"
fi

# Who are we? Used only to label "(you)" and to flag collaborator (= not us)
# replies. Best-effort; empty is fine.
SELF_NAME="$(git config user.name 2>/dev/null)"
SELF_LOGIN=""
if [ "${MYAI_COLLAB_NO_GH:-0}" != "1" ] && command -v gh >/dev/null 2>&1; then
  SELF_LOGIN="$(_ca_timeout 8 gh api user --jq .login 2>/dev/null)"
fi

OUT=""        # accumulated report body
HAD_ANY=0

# ── 1. New / updated remote branches since the anchor ───────────────────────
BR_LINES=""
while IFS='|' read -r ref author subject; do
  [ -z "$ref" ] && continue
  short="${ref#"$REMOTE"/}"
  # Skip the shared trunks and the remote HEAD pointer — they are not
  # "collaborator branches". The HEAD symbolic ref (refs/remotes/origin/HEAD)
  # shortens to the bare remote name ("origin"), so drop that too.
  [ "$short" = "$REMOTE" ] && continue
  case "$short" in main|master|HEAD|test) continue ;; esac
  # Tip committed after the anchor? Let git's own date parser decide (handles
  # ISO8601 with tz, bare dates, and "7 days ago" uniformly).
  if [ -n "$(git log -1 --since="$ANCHOR" --format='%h' "$ref" 2>/dev/null)" ]; then
    BR_LINES="${BR_LINES}  · ${short}  —  ${author}  ·  ${subject}
"
  fi
done <<EOF
$(git for-each-ref --sort=-committerdate "refs/remotes/$REMOTE" \
    --format='%(refname:short)|%(authorname)|%(subject)' 2>/dev/null | head -50)
EOF
BR_LINES="$(printf '%s' "$BR_LINES" | sed '/^$/d' | head -"$MAX")"
if [ -n "$BR_LINES" ]; then
  OUT="${OUT}
new / updated remote branches:
${BR_LINES}
"
  HAD_ANY=1
fi

# ── 2. Commits not on main since the anchor, grouped by author ──────────────
if [ -n "$MAIN_REF" ]; then
  COMMITS="$(git log --remotes="$REMOTE" --not "$MAIN_REF" --since="$ANCHOR" \
               --format='%an|%h %s' 2>/dev/null | head -200)"
else
  COMMITS="$(git log --remotes="$REMOTE" --since="$ANCHOR" \
               --format='%an|%h %s' 2>/dev/null | head -200)"
fi
if [ -n "$COMMITS" ]; then
  CM_BLOCK=""
  AUTHORS="$(printf '%s\n' "$COMMITS" | cut -d'|' -f1 | sort -u)"
  while IFS= read -r au; do
    [ -z "$au" ] && continue
    label="$au"; [ -n "$SELF_NAME" ] && [ "$au" = "$SELF_NAME" ] && label="$au (you)"
    CM_BLOCK="${CM_BLOCK}  ${label}:
"
    rows="$(printf '%s\n' "$COMMITS" | awk -F'|' -v a="$au" '$1==a{print $2}' | head -"$MAX")"
    while IFS= read -r r; do
      [ -z "$r" ] && continue
      CM_BLOCK="${CM_BLOCK}      ${r}
"
    done <<< "$rows"
  done <<< "$AUTHORS"
  if [ -n "$CM_BLOCK" ]; then
    OUT="${OUT}
commits not yet on ${MAIN_REF:-$REMOTE} since ${ANCHOR}:
${CM_BLOCK}"
    HAD_ANY=1
  fi
fi

# ── 3. PR / issue / comment activity (only when gh is authenticated) ─────────
ANCHOR_UTC=""
if [ "${MYAI_COLLAB_NO_GH:-0}" != "1" ] && command -v gh >/dev/null 2>&1 \
   && _ca_timeout 8 gh auth status >/dev/null 2>&1; then
  # Normalize the anchor to the ISO8601 Z form GitHub's `since=` filter needs.
  ANCHOR_UTC="$(python3 - "$ANCHOR" <<'PY' 2>/dev/null
import sys, datetime
s = sys.argv[1].strip()
# Tolerate "+10" (no minutes) and a trailing Z.
if s.endswith("Z"):
    s = s[:-1] + "+00:00"
import re
m = re.search(r'([+-])(\d{2})$', s)
if m:
    s = s + ":00"
try:
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    print(dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
except Exception:
    pass
PY
)"

  GH_BLOCK=""

  # 3a. Open PRs (author · updated).
  PRS="$(_ca_timeout 12 gh pr list --state open --limit 30 \
           --json number,title,author,updatedAt,isDraft \
           --jq '.[] | "#\(.number)|\(.author.login)|\(.updatedAt)|\(if .isDraft then "draft " else "" end)\(.title)"' 2>/dev/null)"
  if [ -n "$PRS" ]; then
    GH_BLOCK="${GH_BLOCK}  open PRs:
"
    while IFS='|' read -r num login upd title; do
      [ -z "$num" ] && continue
      GH_BLOCK="${GH_BLOCK}      ${num}  ${login}  ·  ${upd%T*}  ·  ${title}
"
    done <<< "$(printf '%s\n' "$PRS" | head -"$MAX")"
  fi

  # 3b. Merged PRs since the anchor.
  if [ -n "$ANCHOR_UTC" ]; then
    # NOTE: `gh ... --jq` takes ONE filter string and does NOT accept jq's
    # --arg, so the anchor is embedded directly (it is a controlled ISO8601Z
    # string with no shell/jq metacharacters).
    MERGED="$(_ca_timeout 12 gh pr list --state merged --limit 40 \
                --json number,title,author,mergedAt \
                --jq ".[] | select(.mergedAt > \"$ANCHOR_UTC\") | \"#\(.number)|\(.author.login)|\(.mergedAt)|\(.title)\"" 2>/dev/null)"
    if [ -n "$MERGED" ]; then
      GH_BLOCK="${GH_BLOCK}  PRs merged since anchor:
"
      while IFS='|' read -r num login mg title; do
        [ -z "$num" ] && continue
        GH_BLOCK="${GH_BLOCK}      ${num}  ${login}  ·  ${mg%T*}  ·  ${title}
"
      done <<< "$(printf '%s\n' "$MERGED" | head -"$MAX")"
    fi
  fi

  # 3c. Comments since the anchor (issue + PR-review), by someone OTHER than us.
  # A reply here on a PR we authored/reviewed is the "collaborator replied after
  # our review" case the operator kept having to catch by hand — flag it (↩).
  if [ -n "$ANCHOR_UTC" ]; then
    for kind in "issues/comments" "pulls/comments"; do
      CMTS="$(_ca_timeout 12 gh api \
                "repos/{owner}/{repo}/${kind}?since=${ANCHOR_UTC}&per_page=50" \
                --jq '.[] | "\(.user.login)|\(.created_at)|\(.html_url)"' 2>/dev/null)"
      [ -z "$CMTS" ] && continue
      LBL="issue comments"; [ "$kind" = "pulls/comments" ] && LBL="PR review replies"
      rows=""
      while IFS='|' read -r login created url; do
        [ -z "$login" ] && continue
        [ -n "$SELF_LOGIN" ] && [ "$login" = "$SELF_LOGIN" ] && continue
        # Derive the PR/issue number from the comment URL for a compact line.
        num="$(printf '%s' "$url" | sed -E 's#.*/(pull|issues)/([0-9]+).*#\2#')"
        rows="${rows}      ↩ #${num}  ${login}  ·  ${created%T*}
"
      done <<< "$CMTS"
      rows="$(printf '%s' "$rows" | sed '/^$/d' | head -"$MAX")"
      if [ -n "$rows" ]; then
        GH_BLOCK="${GH_BLOCK}  ${LBL} since anchor (not you):
${rows}
"
      fi
    done
  fi

  # 3d. New / updated issues since the anchor.
  if [ -n "$ANCHOR_UTC" ]; then
    ISSUES="$(_ca_timeout 12 gh issue list --state open --limit 30 \
                --json number,title,author,updatedAt \
                --jq ".[] | select(.updatedAt > \"$ANCHOR_UTC\") | \"#\(.number)|\(.author.login)|\(.updatedAt)|\(.title)\"" 2>/dev/null)"
    if [ -n "$ISSUES" ]; then
      GH_BLOCK="${GH_BLOCK}  issues new/updated since anchor:
"
      while IFS='|' read -r num login upd title; do
        [ -z "$num" ] && continue
        GH_BLOCK="${GH_BLOCK}      ${num}  ${login}  ·  ${upd%T*}  ·  ${title}
"
      done <<< "$(printf '%s\n' "$ISSUES" | head -"$MAX")"
    fi
  fi

  if [ -n "$GH_BLOCK" ]; then
    OUT="${OUT}
pull-request / issue activity:
${GH_BLOCK}"
    HAD_ANY=1
  fi
fi

# ── 5. Housekeeping: remote branches already merged into main (prunable) ─────
# Offered, NEVER pruned automatically.
PRUNABLE=""
if [ -n "$MAIN_REF" ]; then
  PRUNABLE="$(git branch -r --merged "$MAIN_REF" 2>/dev/null \
               | sed 's/^[* ]*//' \
               | grep -vE "(^|/)(HEAD|main|master|test)$" \
               | grep -E "^$REMOTE/" )"
fi
PCOUNT=0
[ -n "$PRUNABLE" ] && PCOUNT="$(printf '%s\n' "$PRUNABLE" | sed '/^$/d' | wc -l | tr -d ' ')"

# ── Output ───────────────────────────────────────────────────────────────────
echo "── Since last session (collaborator activity) ──────────────"
echo "   anchor: ${ANCHOR}  [${ANCHOR_SRC}]   remote: ${REMOTE}"
if [ "$HAD_ANY" -eq 1 ]; then
  printf '%s\n' "$OUT" | sed '/^$/N;/^\n$/D'
else
  echo "   No new activity."
fi
if [ "$PCOUNT" -gt 0 ]; then
  echo "   housekeeping: ${PCOUNT} remote branch(es) already merged into ${MAIN_REF} — prunable (not pruned):"
  printf '%s\n' "$PRUNABLE" | sed '/^$/d' | head -"$MAX" | sed 's/^/      /'
  echo "      → prune with: git push $REMOTE --delete <branch>   (or: git fetch --prune)"
fi
echo "────────────────────────────────────────────────────────────"
exit 0
