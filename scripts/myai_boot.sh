#!/usr/bin/env bash
# myai_boot.sh — token-free session boot (`myai boot`). The deterministic spine
# of `agent mode -min`, done with ZERO LLM tokens: git sync + brain delta +
# schedule banner + remote-control status. Run this BEFORE opening Claude to
# see exactly where things stand; Claude is then only needed for reasoning.
#
# Brain step (2) is zero-gateway by construction (BRAIN_OFFLINE.md Layer 3):
# it reads the compiled brief.md/working.md straight off brain `main` on disk
# via plain git + file reads — no HTTP call, no runtime, no Docker. `--offline`
# additionally skips steps 1/3/4 (git fetch + the two gateway-backed banners),
# so the whole boot is guaranteed to complete with the stack fully down —
# the operator-travelling / no-runner-machine case.
#
#   myai boot [--no-fetch] [--no-pull] [--offline] [--working] [--quiet]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
NO_FETCH=0 NO_PULL=0 OFFLINE=0 SHOW_WORKING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) NO_FETCH=1; shift ;;
    --no-pull)  NO_PULL=1;  shift ;;
    --offline)  OFFLINE=1; NO_FETCH=1; NO_PULL=1; shift ;;
    --working)  SHOW_WORKING=1; shift ;;
    --quiet)    shift ;;   # accepted for symmetry; boot output is already terse
    -h|--help)  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) shift ;;
  esac
done
cd "$ROOT" || exit 1
bar() { printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '%.0s─' $(seq 1 $((40 - ${#1}))) 2>/dev/null)"; }

# ── 1. Git sync ───────────────────────────────────────────────
bar "git"
BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
if [ "$NO_FETCH" = 1 ]; then
  [ "$OFFLINE" = 1 ] && echo "  (--offline — skipping network fetch)"
else
  git fetch --quiet origin 2>/dev/null || echo "  (fetch failed — offline?)"
fi
LOCAL="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
if git rev-parse --verify --quiet "origin/$BR" >/dev/null 2>&1; then
  BEHIND="$(git rev-list --count "HEAD..origin/$BR" 2>/dev/null || echo 0)"
  AHEAD="$(git rev-list --count "origin/$BR..HEAD" 2>/dev/null || echo 0)"
  printf '  branch %s @ %s  (ahead %s, behind %s)\n' "$BR" "$LOCAL" "$AHEAD" "$BEHIND"
  if [ "$NO_PULL" != 1 ] && [ "${BEHIND:-0}" -gt 0 ] 2>/dev/null; then
    if [ -z "$(git status --porcelain --untracked-files=no)" ]; then
      git merge --ff-only "origin/$BR" --quiet 2>/dev/null \
        && echo "  fast-forwarded → $(git rev-parse --short HEAD)" \
        || echo "  behind but ff-only failed — pull manually"
    else
      echo "  behind $BEHIND but working tree dirty — not auto-pulling"
    fi
  fi
else
  printf '  branch %s @ %s (no upstream)\n' "$BR" "$LOCAL"
fi

# ── 2. Brain delta (pure git in the brain repo — no gateway, no tokens) ──
bar "brain"
if [ -f "$HERE/lib/brain.sh" ]; then
  # shellcheck source=lib/brain.sh
  . "$HERE/lib/brain.sh"
  if brain_is_repo 2>/dev/null; then
    BD="$(brain_dir)"
    HEAD_SHA="$(brain_git rev-parse --short HEAD 2>/dev/null || echo '?')"
    ANCHOR_FILE="$(brain_home)/.boot-anchor"
    LAST="$(cat "$ANCHOR_FILE" 2>/dev/null || true)"
    printf '  brain %s @ %s\n' "$BD" "$HEAD_SHA"
    if [ -n "$LAST" ] && brain_git cat-file -e "${LAST}^{commit}" 2>/dev/null; then
      N="$(brain_git rev-list --count "${LAST}..HEAD" 2>/dev/null || echo 0)"
      if [ "${N:-0}" -gt 0 ] 2>/dev/null; then
        printf '  +%s commits since last boot (%s):\n' "$N" "$LAST"
        brain_git log --oneline "${LAST}..HEAD" 2>/dev/null | head -8 | sed 's/^/    /'
      else
        echo "  up to date since last boot"
      fi
    else
      echo "  (first boot on this machine — anchoring now)"
    fi
    brain_git rev-parse HEAD > "$ANCHOR_FILE" 2>/dev/null || true

    # Zero-gateway read (BRAIN_OFFLINE.md Layer 3): the compiled brief/working
    # artifacts live as plain files on brain `main` (compile-at-write, B3) —
    # cat them straight off disk, no server involved at all.
    REPO_NS="$(_brain_slugify "$(basename "$ROOT")")"
    NSDIR="$BD/repos/$REPO_NS"
    if [ -f "$NSDIR/brief.md" ]; then
      printf '  boot brief (%s, offline read — no gateway):\n' "$REPO_NS"
      sed 's/^/    /' "$NSDIR/brief.md"
    else
      printf '  (no compiled brief yet for %s — run "myai brain merge" / distill)\n' "$REPO_NS"
    fi
    if [ "$SHOW_WORKING" = 1 ]; then
      if [ -f "$NSDIR/working.md" ]; then
        printf '  working context:\n'
        sed 's/^/    /' "$NSDIR/working.md"
      else
        echo "  (no compiled working.md yet for $REPO_NS)"
      fi
    fi
  else
    echo "  (no brain repo wired — see: myai brain init)"
  fi
else
  echo "  (brain lib missing)"
fi

if [ "$OFFLINE" = 1 ]; then
  printf '\n\033[1mmyai boot complete\033[0m (--offline) — zero gateway dependency, see documentation/BRAIN_OFFLINE.md.\n'
  exit 0
fi

# ── 3. Schedule banner ────────────────────────────────────────
bar "schedule"
if [ -f "hooks/session/17-schedule-status.sh" ]; then
  bash hooks/session/17-schedule-status.sh 2>/dev/null || echo "  (schedule banner unavailable)"
else
  echo "  (no schedule hook)"
fi

# ── 4. Remote control (current repo) ──────────────────────────
bar "remote"
if [ -f "$HERE/remote_fleet.sh" ]; then
  bash "$HERE/remote_fleet.sh" status 2>/dev/null | head -20 || echo "  (remote_fleet unavailable)"
else
  echo "  (no remote_fleet.sh)"
fi

printf '\n\033[1mmyai boot complete\033[0m — token-free. Open Claude only for reasoning.\n'
