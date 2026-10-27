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
#     2026-08-28 an office Mac booted 181 commits behind / 122 ahead of origin. The
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
#
# A brain push that is ahead-only is retried once after a short backoff
# (MYAI_BOOT_SYNC_PUSH_RETRY_DELAY, default 5s) before this script declares
# "needs operator" — a transient network/auth blip should not cost an
# operator interrupt. If it still fails, a marker is left at
# <state-dir>/.brain-push-needs-operator so that if hooks/session/
# 22a-brain-converge.sh recovers the same push later in this boot, it can say
# "RESOLVED: brain pushed" instead of the two hooks silently disagreeing.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

# Per-host gateway mem cap (config/stack_limits.txt, keyed by `hostname -s`;
# compose default 1g). Exported so the `docker compose build/up gateway` below
# sizes the gateway per host without leaking a host value into .env/Dropbox
# (mirrors gh_runner_mem.txt). An explicit GATEWAY_MEM_LIMIT in the env wins.
# shellcheck source=scripts/lib/stack_limits.sh
. "$HERE/lib/stack_limits.sh"
export GATEWAY_MEM_LIMIT="${GATEWAY_MEM_LIMIT:-$(resolve_gateway_mem)}"

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
      #
      # RETRY-ONCE, then a MARKER FILE if it still fails: 2026-09-08 a first
      # push attempt hit a transient network/auth blip, this script declared
      # "needs operator", and later in the SAME boot 22-brain-converge (via
      # brain_sync_push) tried the identical push and it went through fine —
      # two hooks reporting contradictory verdicts about the same condition in
      # one boot. A single retry after a short backoff absorbs the transient
      # case here; the marker lets a later hook that DOES recover it say so
      # explicitly instead of leaving the operator with two disagreeing lines.
      # MYAI_BOOT_SYNC_TEST_FAIL_PUSH_ONCE is test-only (test_boot_sync.sh):
      # forces exactly the first push attempt in this run to fail so the retry
      # path is exercised without needing a real transient failure.
      if [ "$APPLY" = 1 ]; then
        # MYAI_BOOT_SYNC_STATE_DIR is a TEST-ONLY override (test_boot_sync.sh)
        # so the suite never writes this marker into the real repo's state/.
        STATE_DIR="${MYAI_BOOT_SYNC_STATE_DIR:-$REPO_ROOT/state}"
        NEEDS_MARKER="$STATE_DIR/.brain-push-needs-operator"
        FORCE_FAIL_ONCE="${MYAI_BOOT_SYNC_TEST_FAIL_PUSH_ONCE:-0}"
        _bs_try_push() {
          if [ "$FORCE_FAIL_ONCE" = 1 ]; then
            FORCE_FAIL_ONCE=0
            return 1
          fi
          git -C "$BRAIN_DIR" push -q origin main 2>/dev/null
        }

        ahead2="$(git -C "$BRAIN_DIR" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
        if [ "${ahead2:-0}" -gt 0 ]; then
          if _bs_try_push; then
            echo "brain: pushed $ahead2 commit(s) to origin/main"
            CHANGED=1
            rm -f "$NEEDS_MARKER" 2>/dev/null
          else
            sleep "${MYAI_BOOT_SYNC_PUSH_RETRY_DELAY:-5}"
            if _bs_try_push; then
              echo "brain: pushed $ahead2 commit(s) to origin/main (after retry)"
              CHANGED=1
              rm -f "$NEEDS_MARKER" 2>/dev/null
            else
              note_needs "brain: $ahead2 commit(s) unpushed and push failed (retried once) — check network/auth for $BRAIN_DIR"
              mkdir -p "$STATE_DIR" 2>/dev/null
              echo "$ahead2" > "$NEEDS_MARKER" 2>/dev/null
            fi
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

    # STALENESS VERDICT — content first, timestamps never as the last word.
    #
    # This check was DEAD CODE from the day it was written, and it failed OPEN.
    # `docker compose images gateway` reports an .ID whose sha256 is not an
    # inspectable object on this machine (`error: no such object`; Repository
    # and Tag empty, Size 0), so IMG_TS came back EMPTY, the `[ -n "$IMG_TS" ]`
    # guard was false, and the whole block was skipped: no rebuild, and no
    # warning either. Measured 2026-09-16: gateway image Created 2026-09-07
    # against a last runtime/ commit of 2026-09-15 (3c0e0b9f) — 8 days stale,
    # reported by NOTHING. That is precisely the hole verify_local_stack.sh
    # (2a17469d) was written to close, and why the stale-gateway warning rode
    # the handoff unresolved for 7 sessions while merged runtime/ code was not
    # live. CLAUDE.md promises this script "ACTS instead of warning".
    #
    # So: ask the content verifier, which greps compiled markers out of the
    # RUNNING container and cannot be fooled. Its own header is blunt about why
    # the old approach could never work — "FILE MTIME LIES ... mtime proves
    # nothing either direction — never compare it. Compare content." It exits
    # 0 FRESH · 1 STALE/DOWN · 4 Docker unreachable.
    #
    # The timestamp heuristic stays only as a fallback for a checkout without
    # the verifier, and now resolves the image through the CONTAINER (the one
    # handle that does inspect) — and if it still cannot determine a build
    # time, it FAILS CLOSED with an operator note instead of reading as fresh.
    GW_STALE=0
    VLS="$REPO_ROOT/scripts/verify_local_stack.sh"
    if [ -x "$VLS" ] || [ -f "$VLS" ]; then
      bash "$VLS" --service gateway --quiet >/dev/null 2>&1
      case $? in
        0) GW_STALE=0 ;;
        1) GW_STALE=1 ;;
        *) GW_STALE=0 ;;   # 4 = daemon unreachable; the outer docker guard already passed, so stay quiet
      esac
    else
      IMG_TS=$(docker inspect --format '{{.Created}}' \
                 "$(docker inspect --format '{{.Image}}' myai-gateway 2>/dev/null)" 2>/dev/null \
               | /usr/bin/python3 -c '
import sys, datetime
s = sys.stdin.read().strip()[:19]
try: print(int(datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp()))
except Exception: pass' 2>/dev/null)
      SRC_TS=$(cd "$REPO_ROOT" && git log -1 --format=%ct -- runtime/ 2>/dev/null)
      if [ -z "$IMG_TS" ] || [ -z "$SRC_TS" ]; then
        note_needs "gateway: cannot determine image freshness (no verify_local_stack.sh, image build time unreadable) — verify by hand before trusting runtime/ is live"
      elif [ "$IMG_TS" -lt "$SRC_TS" ] 2>/dev/null; then
        GW_STALE=1
      fi
    fi

    if [ "$GW_STALE" = 1 ]; then
      if [ "$APPLY" != 1 ]; then
        echo "gateway: DRY-RUN image is STALE (running container does not match HEAD by content) — would rebuild"
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

# ── 3. BOOT SCHEDULE (launchd) ────────────────────────────────────────────────
# Each Mac installs its OWN `boot` agent from config/boot_machines.txt
# (`*:0-6` — universal boot on every Mac, operator directive 2026-09-28; a
# host line overrides one Mac's days). The config is in Dropbox; the plist is per-machine. Whenever the
# two disagree (first session on the home Mac after the directive, a changed
# day, a changed profile) re-install from config here, so editing that one file
# on EITHER Mac is the whole change. Silent when already current. Skipped in
# the test harness (MYAI_BOOT_SYNC_ALLOW_CONTAINER) — never touch launchctl
# from a unit test.
#
# NEVER re-install from a runner worktree / workspace clone. setup_boot_schedule
# bakes ProgramArguments + WorkingDirectory into the plist; from a worktree those
# are ~/ci-workspaces/.worktrees/… paths that are deleted when the task ends, and
# launchd's next 08:00 fire dies exit 78 EX_CONFIG (recurred 2026-09-22/23 and
# 2026-09-30 → no boot 2026-10-01). Only the durable master checkout installs the
# schedule; a worktree session leaves the live plist untouched. (setup_boot_
# schedule also refuses on its own, but skipping here avoids the needless call.)
_bs_is_worktree=0
case "$REPO_ROOT" in "$HOME"/ci-workspaces/*) _bs_is_worktree=1 ;; esac
[ -f "$REPO_ROOT/.git" ] && _bs_is_worktree=1   # a linked git worktree keeps .git as a FILE
if [ "$(uname -s)" = Darwin ] && [ -z "${MYAI_BOOT_SYNC_ALLOW_CONTAINER:-}" ] \
   && [ "$_bs_is_worktree" = 0 ] \
   && [ -f "$REPO_ROOT/scripts/setup_boot_schedule.sh" ] && [ -f "$REPO_ROOT/scripts/lib/boot_machines.sh" ]; then
  # shellcheck source=/dev/null
  . "$REPO_ROOT/scripts/lib/boot_machines.sh"
  _bs_host="$(hostname -s 2>/dev/null)"
  if boot_machines_days "$REPO_ROOT/config/boot_machines.txt" "$_bs_host" >/dev/null 2>&1; then
    _bs_plist="$HOME/Library/LaunchAgents/com.myai.morning-boot.plist"
    if ! { [ -f "$_bs_plist" ] \
           && bash "$REPO_ROOT/scripts/setup_boot_schedule.sh" --print 2>/dev/null | cmp -s - "$_bs_plist" \
           && launchctl list com.myai.morning-boot >/dev/null 2>&1; }; then
      if [ "$APPLY" = 1 ]; then
        _bs_out="$(bash "$REPO_ROOT/scripts/setup_boot_schedule.sh" 2>&1 | head -1)"
        case "$_bs_out" in
          Installed*|Already*) echo "boot schedule: ${_bs_out#Installed }" ;;
          *) note_needs "boot schedule: install failed — run ./scripts/setup_boot_schedule.sh  ($_bs_out)" ;;
        esac
      else
        echo "boot schedule: [dry-run] would (re)install com.myai.morning-boot from config/boot_machines.txt"
      fi
    fi
  fi
fi

# ── 3b. DROPBOX-IGNORE SWEEPER (launchd) ──────────────────────────────────────
# HARD RULE (AI_RULES §12, 2026-10-02): node_modules never syncs to Dropbox, on
# any repo, on any Mac. Each Mac installs its OWN 15-minute sweeper
# (setup_dropbox_ignore_schedule.sh) — missing or stale plist → reinstall here,
# so a new Mac is covered from its first session. Same worktree + test-harness
# guards as the boot schedule above.
if [ "$(uname -s)" = Darwin ] && [ -z "${MYAI_BOOT_SYNC_ALLOW_CONTAINER:-}" ] \
   && [ "$_bs_is_worktree" = 0 ] && [ -f "$REPO_ROOT/scripts/setup_dropbox_ignore_schedule.sh" ]; then
  _di_plist="$HOME/Library/LaunchAgents/com.myai.dropbox-ignore.plist"
  if ! { [ -f "$_di_plist" ] \
         && bash "$REPO_ROOT/scripts/setup_dropbox_ignore_schedule.sh" --print 2>/dev/null | cmp -s - "$_di_plist" \
         && launchctl list com.myai.dropbox-ignore >/dev/null 2>&1; }; then
    if [ "$APPLY" = 1 ]; then
      _di_out="$(bash "$REPO_ROOT/scripts/setup_dropbox_ignore_schedule.sh" 2>&1 | head -1)"
      case "$_di_out" in
        Installed*|Already*) echo "dropbox-ignore sweeper: ${_di_out#Installed }" ;;
        *) note_needs "dropbox-ignore sweeper: install failed — run ./scripts/setup_dropbox_ignore_schedule.sh  ($_di_out)" ;;
      esac
    else
      echo "dropbox-ignore sweeper: [dry-run] would (re)install com.myai.dropbox-ignore"
    fi
  fi
fi

# ── 3c. GIT-HOOK RAILS fleet-wide (task-7fd4320e) ─────────────────────────────
# The push-to-main block + secret scan moved from Claude-only PreToolUse hooks
# into .githooks/ so EVERY tool (agy, codex, copilot, bare git) hits them — but
# core.hooksPath is LOCAL git config, so each repo on each Mac needs it set.
# update_all.sh propagates the .githooks/ FILES; this step re-asserts the
# ACTIVATION (hooksPath + exec bits) for master + every managed repo that has
# them, every boot. install_git_hooks.sh is idempotent and quiet when current;
# repos without .githooks/ are skipped (propagation is update_all's job, and
# fetch-only/noai repos never get local writes from here — hooksPath lives in
# .git/config, not the working tree).
if [ -z "${MYAI_BOOT_SYNC_ALLOW_CONTAINER:-}" ] && [ -f "$REPO_ROOT/scripts/install_git_hooks.sh" ]; then
  _gh_targets="$REPO_ROOT"
  if [ -f "$REPO_ROOT/config/managed_repos.txt" ]; then
    while IFS= read -r _gh_line || [ -n "$_gh_line" ]; do
      case "$_gh_line" in ''|'#'*) continue ;; esac
      _gh_path="${_gh_line%%#*}"
      _gh_path="$(printf '%s' "$_gh_path" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
      [ -n "$_gh_path" ] || continue
      # shellcheck disable=SC2088  # literal "~/" prefix match is intended (config file syntax)
      case "$_gh_path" in "~/"*) _gh_path="$HOME/${_gh_path#\~/}" ;; esac
      [ -d "$_gh_path/.githooks" ] || continue
      _gh_targets="$_gh_targets
$_gh_path"
    done < "$REPO_ROOT/config/managed_repos.txt"
  fi
  while IFS= read -r _gh_t; do
    [ -n "$_gh_t" ] || continue
    if [ "$APPLY" = 1 ]; then
      _gh_out="$(bash "$REPO_ROOT/scripts/install_git_hooks.sh" "$_gh_t" 2>/dev/null)"
      if [ -n "$_gh_out" ]; then echo "git-hook rails: $_gh_out"; CHANGED=1; fi
    else
      _gh_cur="$(git -C "$_gh_t" config --get core.hooksPath 2>/dev/null || true)"
      [ "$_gh_cur" = ".githooks" ] || echo "git-hook rails: DRY-RUN would set core.hooksPath in $_gh_t"
    fi
  done <<EOF
$_gh_targets
EOF
fi

# ── 3d. CLAUDE SESSION-LABEL BLOCK (~/.zshrc) ─────────────────────────────────
# setup_org_dirs.sh installs a '<device> - <repo>' claude -n wrapper
# (_claude_labelled) into a managed block in ~/.zshrc so hand-started sessions
# are NAMED, not auto-numbered 'ai-55'. 2026-10-02: under macOS /bin/bash 3.2 the
# installer died before writing (3.2 expanded $repo in a quoted heredoc nested in
# "$(…)", set -u aborted), so the block never upgraded past the OLD plain-alias
# form on ANY Mac — the managed marker is present but _claude_labelled is missing.
# Fixed in a84bf984; this step carries the fix to every Mac without a manual
# re-run: detect the stale block and re-apply the ALIAS step only (--aliases-only
# backs up ~/.zshrc and leaves the statusline/settings steps untouched).
# Idempotent + silent once the labelled wrapper is present.
# 2026-10-19: ALSO stale when the block lacks the `bypass-v2` stamp — an older
# block (or a hand-edited one) can carry _claude_labelled yet leave the bare
# `claude` without --dangerously-skip-permissions, and the old check passed it.
#
# Test-only: skipped under MYAI_BOOT_SYNC_ALLOW_CONTAINER (so the brain-focused
# suite never reads/writes the real ~/.zshrc) UNLESS MYAI_BOOT_SYNC_TEST_ZSHRC is
# set — the dedicated suite sets both together with a sandbox HOME.
if { [ -z "${MYAI_BOOT_SYNC_ALLOW_CONTAINER:-}" ] || [ -n "${MYAI_BOOT_SYNC_TEST_ZSHRC:-}" ]; } \
   && [ -f "$REPO_ROOT/scripts/setup_org_dirs.sh" ]; then
  _zrc="$HOME/.zshrc"
  _zmarker="# >>> claude multi-org aliases (managed by setup_org_dirs.sh) >>>"
  _zstale=0
  if [ -f "$_zrc" ] && grep -qF "$_zmarker" "$_zrc" 2>/dev/null; then
    grep -qF "_claude_labelled" "$_zrc" 2>/dev/null || _zstale=1
    grep -qF "# bypass-v2:" "$_zrc" 2>/dev/null || _zstale=1
  fi
  if [ "$_zstale" = 1 ]; then
    if [ "$APPLY" = 1 ]; then
      _zout="$(bash "$REPO_ROOT/scripts/setup_org_dirs.sh" --aliases-only 2>&1)"
      if grep -qF "_claude_labelled" "$_zrc" 2>/dev/null && grep -qF "# bypass-v2:" "$_zrc" 2>/dev/null; then
        echo "claude session-label: stale ~/.zshrc block refreshed (--aliases-only; backup kept)"
        CHANGED=1
      else
        note_needs "claude session-label: ~/.zshrc block still stale after --aliases-only — run ./scripts/setup_org_dirs.sh by hand ($(printf '%s' "$_zout" | tr '\n' ' ' | cut -c1-120))"
      fi
    else
      echo "claude session-label: DRY-RUN ~/.zshrc block is stale (marker present, _claude_labelled or bypass-v2 stamp missing) — would re-run setup_org_dirs.sh --aliases-only"
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
