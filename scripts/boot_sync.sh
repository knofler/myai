#!/usr/bin/env bash
# boot_sync.sh — make the two things that MUST be current at session start
# actually current: the BRAIN and the GATEWAY. Operator directive 2026-08-28:
# "always make sure both machines in sync, through Dropbox, brain and git …
# gateway must remain up to date always at any cost and synced."
#
# WHY THIS EXISTS — both pillars already had DETECTION and neither had ACTION:
#
#   • brain: scripts/lib/brain.sh brain_sync_pull is deliberately FF-ONLY. The
#     moment the two Macs both commit, main diverges, the fast-forward refuses,
#     and it prints "run 'myai brain merge'" — then nothing runs it. On
#     2026-08-28 work-desktop booted 181 commits behind / 122 ahead of origin. The
#     handoff anchor c123099 lived only on the origin side, so `brain_delta`
#     could not resolve it and EVERY `agent mode -min` boot silently degraded
#     to the stale blank-agent brief while printing a cheerful brain line.
#     A warning nobody acts on is indistinguishable from no warning.
#
#   • gateway: scripts/machine_selfheal.sh escalates a stale image
#     🟠 → 🔴 → ⛔ across consecutive sessions and only ever prints the build
#     command. The 2026-08 handoff carried "gateway image is STALE" as an open
#     blocker for SEVEN sessions; merged runtime/ code simply was not live.
#     A dead tasks_claim from exactly this drift starved the runner once before.
#
# So this script does the merge and does the rebuild.
#
# SAFETY — the brain is the memory of record, so the auto-merge is deliberately
# narrow. It reconciles ONLY when every conflicted path is a distiller OUTPUT
# (brief.md / working.md / rollup.md), which is regenerated from the atoms and
# is therefore not a source of truth. If a single real atom conflicts, the merge
# is aborted untouched and the operator is told. Session atoms are per-file and
# append-only, so in practice they never collide — the compiled artifacts are
# the only thing that ever does.
#
# Compiled-artifact conflicts resolve to origin/main, per the operator's
# "home Mac takes precedence" call — and it is the safe default regardless,
# since the distiller immediately recompiles all of them from the merged atoms.
#
# Usage:
#   ./scripts/boot_sync.sh              # act (default)
#   ./scripts/boot_sync.sh --dry-run    # report only, write nothing
#   ./scripts/boot_sync.sh --no-brain   # gateway only
#   ./scripts/boot_sync.sh --no-gateway # brain only
#
# Contract: QUIET when both pillars are already current (prints nothing, exit
# 0) so it can sit in the boot path without adding noise. Speaks only when it
# changed something or when it needs the operator. Never exits non-zero for a
# condition the operator cannot act on (a missing brain, no Docker) — those are
# silent skips.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

APPLY=1
DO_BRAIN=1
DO_GATEWAY=1
for a in "$@"; do
  case "$a" in
    --dry-run)    APPLY=0 ;;
    --no-brain)   DO_BRAIN=0 ;;
    --no-gateway) DO_GATEWAY=0 ;;
    -h|--help)    sed -n '2,50p' "$0"; exit 0 ;;
  esac
done

# Host-only. A container guest shares neither the Dropbox fleet nor the Docker
# socket that owns the gateway stack.
#
# MYAI_BOOT_SYNC_ALLOW_CONTAINER is a TEST-ONLY override, set solely by
# scripts/tests/test_boot_sync.sh. The self-hosted CI runner is itself a
# container, so without it this guard fired first and the script exited 0
# silently — the suite's assertions all read empty output and 11 of them failed
# on CI while passing 20/20 on every Mac. The override is safe there because the
# suite points MYAI_BRAIN_DIR at a throwaway fixture repo and always passes
# --no-gateway, so neither the real brain nor Docker is ever touched. Do NOT set
# it anywhere else: in a normal container this guard is what stops boot_sync
# reconciling a brain it cannot see properly.
if [ -f /.dockerenv ] || [ -n "${MYAI_IN_CONTAINER:-}" ]; then
  if [ -z "${MYAI_BOOT_SYNC_ALLOW_CONTAINER:-}" ]; then
    exit 0
  fi
fi

CHANGED=0
NEEDS=()
note_needs() { NEEDS+=("$1"); }

# ── 1. BRAIN ──────────────────────────────────────────────────────────────────
if [ "$DO_BRAIN" = 1 ]; then
  BRAIN_DIR="${MYAI_BRAIN_DIR:-$HOME/.myai/brain}"
  if [ -d "$BRAIN_DIR/.git" ] && git -C "$BRAIN_DIR" remote get-url origin >/dev/null 2>&1; then
    git -C "$BRAIN_DIR" fetch -q origin 2>/dev/null

    if [ -n "$(git -C "$BRAIN_DIR" status --porcelain 2>/dev/null)" ]; then
      note_needs "brain: working tree dirty — sync skipped. Commit or stash in $BRAIN_DIR, then re-run."
    elif ! git -C "$BRAIN_DIR" rev-parse --verify -q origin/main >/dev/null 2>&1; then
      : # no remote main yet — nothing to reconcile
    else
      counts="$(git -C "$BRAIN_DIR" rev-list --left-right --count origin/main...HEAD 2>/dev/null)"
      behind="$(printf '%s' "$counts" | awk '{print $1}')"
      ahead="$(printf '%s' "$counts" | awk '{print $2}')"
      behind="${behind:-0}"; ahead="${ahead:-0}"

      if [ "$behind" -gt 0 ] && [ "$ahead" -eq 0 ]; then
        # Clean catch-up.
        if [ "$APPLY" = 1 ]; then
          if git -C "$BRAIN_DIR" merge --ff-only -q origin/main 2>/dev/null; then
            echo "brain: fast-forwarded $behind commit(s) from origin/main"
            CHANGED=1
          else
            note_needs "brain: $behind behind but fast-forward failed — inspect $BRAIN_DIR"
          fi
        else
          echo "brain: DRY-RUN would fast-forward $behind commit(s)"
        fi

      elif [ "$behind" -gt 0 ] && [ "$ahead" -gt 0 ]; then
        # DIVERGED — the case ff-only has always refused and left to rot.
        if [ "$APPLY" != 1 ]; then
          echo "brain: DRY-RUN diverged ($behind behind / $ahead ahead) — would attempt artifact-only auto-merge"
        else
          PRE="$(git -C "$BRAIN_DIR" rev-parse HEAD)"
          git -C "$BRAIN_DIR" tag -f "backup/pre-boot-sync-$(hostname -s)" "$PRE" >/dev/null 2>&1
          git -C "$BRAIN_DIR" merge --no-commit --no-ff origin/main >/dev/null 2>&1

          UNMERGED="$(git -C "$BRAIN_DIR" diff --name-only --diff-filter=U 2>/dev/null)"
          # Anything conflicting that is NOT a distiller output?
          REAL="$(printf '%s\n' "$UNMERGED" | grep -vE '(^|/)(brief|working|rollup)\.md$' | grep -v '^$' || true)"

          if [ -n "$REAL" ]; then
            git -C "$BRAIN_DIR" merge --abort >/dev/null 2>&1
            note_needs "brain: diverged ($behind/$ahead) and REAL atoms conflict — NOT auto-merged, nothing written. Resolve by hand in $BRAIN_DIR:"
            while IFS= read -r rf; do [ -n "$rf" ] && note_needs "         conflict: $rf"; done <<< "$REAL"
          else
            for f in $UNMERGED; do
              git -C "$BRAIN_DIR" checkout --theirs -- "$f" >/dev/null 2>&1
              git -C "$BRAIN_DIR" add -- "$f" >/dev/null 2>&1
            done
            if git -C "$BRAIN_DIR" commit -q -m "brain(merge): boot-sync reconcile on $(hostname -s) ($behind behind / $ahead ahead)

Diverged brain mains reconciled automatically at boot. Every conflict was a
distiller OUTPUT (brief/working/rollup.md), resolved to origin/main and
recompiled from the merged atoms immediately after. No session atom conflicted.

Revert: backup/pre-boot-sync-$(hostname -s)" 2>/dev/null; then
              echo "brain: reconciled diverged main ($behind behind / $ahead ahead; artifact-only conflicts)"
              myai brain distill >/dev/null 2>&1 || true
              CHANGED=1
            else
              git -C "$BRAIN_DIR" merge --abort >/dev/null 2>&1
              note_needs "brain: merge commit failed — aborted, nothing written"
            fi
          fi
        fi
      fi

      # Push whatever we now hold that origin does not.
      if [ "$APPLY" = 1 ]; then
        ahead2="$(git -C "$BRAIN_DIR" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
        if [ "${ahead2:-0}" -gt 0 ]; then
          if git -C "$BRAIN_DIR" push -q origin main 2>/dev/null; then
            echo "brain: pushed $ahead2 commit(s) to origin/main"
            CHANGED=1
          else
            note_needs "brain: $ahead2 commit(s) unpushed and push failed — check network/auth for $BRAIN_DIR"
          fi
        fi
      fi
    fi
  fi
fi

# ── 2. GATEWAY ────────────────────────────────────────────────────────────────
# Rebuild ONLY from the master checkout. A ci-workspaces clone has no real .env
# and would silently rebind the shared stack (the split-brain incident this
# guard already exists for elsewhere in the fleet).
if [ "$DO_GATEWAY" = 1 ]; then
  IS_WORKSPACE_CLONE=0
  case "$REPO_ROOT" in "$HOME"/ci-workspaces/*) IS_WORKSPACE_CLONE=1 ;; esac
  HAS_REAL_ENV=0
  [ -f "$REPO_ROOT/.env" ] && grep -qE '^MONGODB_URI=' "$REPO_ROOT/.env" 2>/dev/null && HAS_REAL_ENV=1

  if command -v docker >/dev/null 2>&1 \
     && docker info >/dev/null 2>&1 \
     && [ "$IS_WORKSPACE_CLONE" = 0 ] \
     && [ "$HAS_REAL_ENV" = 1 ] \
     && [ -f "$REPO_ROOT/docker-compose.yml" ]; then

    GW_IMG="$(docker compose -f "$REPO_ROOT/docker-compose.yml" images gateway --format json 2>/dev/null \
              | /usr/bin/python3 -c 'import sys,json
try:
    d=json.loads(sys.stdin.read() or "[]")
    d=d if isinstance(d,list) else [d]
    print(d[0].get("ID") or d[0].get("Repository",""))
except Exception: pass' 2>/dev/null)"
    [ -z "$GW_IMG" ] && GW_IMG="myai-gateway"

    IMG_TS=$(docker inspect --format '{{.Created}}' "$GW_IMG" 2>/dev/null | /usr/bin/python3 -c '
import sys, datetime
s = sys.stdin.read().strip()[:19]
try: print(int(datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp()))
except Exception: pass' 2>/dev/null)
    SRC_TS=$(cd "$REPO_ROOT" && git log -1 --format=%ct -- runtime/ 2>/dev/null)

    if [ -n "$IMG_TS" ] && [ -n "$SRC_TS" ] && [ "$IMG_TS" -lt "$SRC_TS" ] 2>/dev/null; then
      if [ "$APPLY" != 1 ]; then
        echo "gateway: DRY-RUN image is STALE (built $IMG_TS, runtime/ changed $SRC_TS) — would rebuild"
      else
        echo "gateway: image STALE — rebuilding (merged runtime/ code is not live until this completes)…"
        if ( cd "$REPO_ROOT" && docker compose build gateway && docker compose up -d gateway ) >/dev/null 2>&1; then
          # Prove it, don't assume it.
          ok=0
          for _ in 1 2 3 4 5 6 7 8 9 10; do
            if curl -fsS -m 5 http://localhost:3100/health >/dev/null 2>&1; then ok=1; break; fi
            sleep 2
          done
          if [ "$ok" = 1 ]; then
            echo "gateway: rebuilt and healthy"
            rm -f "$REPO_ROOT/state/.gateway-staleness-streak" 2>/dev/null
            CHANGED=1
          else
            note_needs "gateway: rebuilt but /health did not come up — check 'docker compose logs gateway'"
          fi
        else
          note_needs "gateway: rebuild FAILED — run manually: (cd \"$REPO_ROOT\" && docker compose build gateway && docker compose up -d gateway)"
        fi
      fi
    fi
  fi
fi

# ── report ────────────────────────────────────────────────────────────────────
if [ "${#NEEDS[@]}" -gt 0 ]; then
  echo "BOOT SYNC — needs operator:"
  for n in ${NEEDS[@]+"${NEEDS[@]}"}; do echo "  ! $n"; done
  exit 1
fi
exit 0
