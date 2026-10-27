#!/usr/bin/env bash
# morning_boot.sh — the `boot` routine. Fires 08:00 on EVERY Mac, every day
# (config/boot_machines.txt `*:0-6` — universal boot, operator directive
# 2026-09-28; a host line can still override one Mac's days), unattended, so that when the operator sits down the
# machine is already warm, reconciled, rebuilt, verified, and idle — waiting.
#
# OPERATOR DIRECTIVE (2026-09-16, plan/OPERATOR_DIRECTIVES_2026-09-16.md D1+D7+D9):
#   "run it every weekday morning on office Mac, at 8 o clock in the morning,
#    make sure before I sit on the Mac, you are waiting for my instructions,
#    ready, all warm up, reconcile and code check, fetch, fix done before that."
#   "Every morning make sure gateway rebuild and restart with new code. Mcp
#    connected and all."   "on completion ping."
#
# DESIGN RULES, each one paid for by a real incident:
#
#  1. NEVER ABORT ON THE FIRST FAILURE. This runs unattended and its whole
#     value is the operator reading ONE report at 08:0x. A `set -e` exit after
#     phase 2 would hide phases 3–8 and leave the morning blind. Every phase
#     records PASS/WARN/FAIL and the run continues.
#
#  2. UNIVERSAL, PER-MACHINE (directive 2026-09-28: "each separate machine,
#     separate agent, single git repo, single brain repo, dropbox ignore to
#     avoid conflict … boot is universal for all device always"). Every Mac
#     boots its OWN local Docker stack; git + the brain repo are the sync.
#     config/boot_machines.txt (`*:0-6`, host lines override) only picks days.
#     Because the repo is in Dropbox, NOTHING this writes may be a file another
#     Mac also writes: the report is per-host by name
#     (state/boot/BOOT_REPORT.<host>.md) — readable from every Mac, written by
#     exactly one. A host whose config says "not today" logs one line, exits 0.
#
#  3. THE GATEWAY IS REBUILT UNCONDITIONALLY, NOT "IF STALE". Staleness
#     detection is exactly what failed before (boot_sync.sh's check was dead
#     code for weeks; the gateway served 8-day-old code while every boot
#     printed a healthy line). A morning rebuild costs minutes of unattended
#     wall-clock and removes a whole class of bug. Then it is VERIFIED BY
#     CONTENT with verify_local_stack.sh — built is not the same as live.
#
#  4. PROVE, DON'T ASSUME. Every phase that changes something is followed by a
#     check that reads the result back (health endpoint, content markers, tool
#     count). A phase that cannot be verified reports WARN, never PASS.
#
#  5. THE FLEET, NOT JUST MASTER (2026-09-21). This routine said "MCP PASS"
#     through the master repo's bridge while the repo the operator actually
#     opened carried a broken .mcp.json and 401'd — half a session burnt
#     fixing myAI instead of working. Phase 6b converges EVERY fleet repo's
#     .mcp.json (rollout_mcp_bridge.sh) and then handshakes through EACH one
#     exactly as Claude Code will spawn it (verify_fleet_mcp.sh). A repo that
#     cannot connect is a FAIL, and the ping says which.
#
#  6. "WARM" IS NOT "WAITING" (2026-09-22). Every phase above passed and the
#     operator still sat down to nothing — no claude session existed, because
#     this routine never opened one. D1's end state is a session "waiting for
#     instructions". Phase 9 opens the master repo's swarm-master anchor
#     (remote_fleet.sh start AI — tmux-owned, labelled "<host> - AI", idle =
#     zero tokens, phone-drivable) and PROVES it is live through that script's
#     own status view. Phase 10 turns the D9 ping into a RECORDED phase: for a
#     week notify-telegram.sh exited 0 on an empty TELEGRAM_ALLOWED_CHATS and no
#     ping ever left the machine — invisible, because nothing recorded it.
#     Same day, phase 3 stopped merely LISTING Dropbox conflicts: it now runs
#     dropbox_conflicts.sh --clean-safe (identical · in-git · regenerated ·
#     append-only-merged are resolved; only what needs a human stays a WARN).
#
# Usage:
#   ./scripts/morning_boot.sh              # the real thing (hostname-gated)
#   ./scripts/morning_boot.sh --force      # run here regardless of hostname
#   ./scripts/morning_boot.sh --dry-run    # report the plan, change nothing
#   ./scripts/morning_boot.sh --no-build   # skip the gateway/dashboard rebuild
#   ./scripts/morning_boot.sh --quick      # skip the code check (slowest phase)
#   ./scripts/morning_boot.sh --status     # last run's verdict + report path
#   env BOOT_DOORWAY_REPOS="AI"            # fleet repo names to open a master session for (phase 9)
#   env BOOT_DOORWAY_TIMEOUT=180           # seconds before phase 9 gives up on remote_fleet start
#   env BOOT_SUITES_TIMEOUT=1200           # seconds before phase 7 kills the whole run_all (FAIL, run continues)
#
# Install the 08:00 Mon–Fri schedule:  ./scripts/setup_boot_schedule.sh
# bash 3.2-safe (macOS system bash). No associative arrays, no mapfile.
set -uo pipefail

# Docker CLI on PATH (2026-10-03 root cause of two RED boots): Docker Desktop
# may install `docker` only in ~/.docker/bin, which launchd's PATH lacks — the
# 08:00 run then reported "docker daemon unreachable" while the engine was up
# and answering. Add Docker's CLI dirs here so the boot finds it however it is
# launched (plist PATH is fixed in setup_boot_schedule.sh too).
for _d in "$HOME/.docker/bin" /Applications/Docker.app/Contents/Resources/bin /usr/local/bin /opt/homebrew/bin; do
    case ":$PATH:" in *":$_d:"*) ;; *) [ -d "$_d" ] && PATH="$PATH:$_d" ;; esac
done
export PATH; unset _d

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

FORCE=0 DRY=0 DO_BUILD=1 QUICK=0 ACTION=run
while [ $# -gt 0 ]; do
  case "$1" in
    --force)    FORCE=1 ;;
    --dry-run)  DRY=1 ;;
    --no-build) DO_BUILD=0 ;;
    --quick)    QUICK=1 ;;
    --status)   ACTION=status ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "morning_boot: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=scripts/lib/boot_machines.sh
. "$HERE/lib/boot_machines.sh"
HOST="${BOOT_HOST_OVERRIDE:-$(hostname -s 2>/dev/null || echo unknown)}"   # override: tests only

# Per-host app-stack limits (gateway mem / RAM-guard ceiling / restart policy).
# The DECISION lives in config/stack_limits.txt keyed by `hostname -s`, so no
# host-specific value leaks via .env/Dropbox (mirrors gh_runner_mem.txt). An
# explicit GATEWAY_MEM_LIMIT in the env still wins. STACK_LIMITS_FILE: tests only.
# shellcheck source=scripts/lib/stack_limits.sh
. "$HERE/lib/stack_limits.sh"
# shellcheck source=scripts/lib/swarm_roles.sh
. "$HERE/lib/swarm_roles.sh"
STACK_LIMITS_FILE="${STACK_LIMITS_FILE:-$ROOT/config/stack_limits.txt}"
export GATEWAY_MEM_LIMIT="${GATEWAY_MEM_LIMIT:-$(resolve_gateway_mem "$STACK_LIMITS_FILE" "$HOST")}"
# Per-host by NAME: every Mac boots, the tree is in Dropbox, so one shared
# report file would be a Dropbox conflict copy every morning.
REPORT_DIR="$ROOT/state/boot"
REPORT="$REPORT_DIR/BOOT_REPORT.$HOST.md"
LOG_DIR="$HOME/.ai-cli-runner/boot"
LOG="$LOG_DIR/boot-$(date +%Y%m%d-%H%M%S).log"

if [ "$ACTION" = status ]; then
  if [ -f "$REPORT" ]; then
    echo "Last boot report: $REPORT"
    sed -n '1,12p' "$REPORT"
  else
    echo "No boot report yet for $HOST ($REPORT absent)."
  fi
  for _other in "$REPORT_DIR"/BOOT_REPORT.*.md; do
    [ -f "$_other" ] && [ "$_other" != "$REPORT" ] || continue
    echo "Other Mac: $(basename "$_other") — $(head -1 "$_other" | sed 's/^# //')"
  done
  exit 0
fi

# ── weekday gate (rule 2) ────────────────────────────────────────────────────
# Universal: a missing config or a `*` line means this host boots. Only a
# config that names neither this host nor `*` leaves it out (silently).
ALLOW_FILE="${BOOT_MACHINES_FILE:-$ROOT/config/boot_machines.txt}"   # override: tests only
if [ "$FORCE" != 1 ]; then
  if ! DAYS="$(boot_machines_days "$ALLOW_FILE" "$HOST" 2>/dev/null)"; then
    exit 0
  fi
  if ! boot_machines_today "$ALLOW_FILE" "$HOST"; then
    echo "morning_boot: $HOST is off today (boots $(boot_machines_label "$DAYS") — config/boot_machines.txt); nothing to do."
    exit 0
  fi
fi

mkdir -p "$LOG_DIR" "$REPORT_DIR"

# ── phase bookkeeping (rule 1) ────────────────────────────────────────────────
PHASES="" ; FAILED=0 ; WARNED=0
STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"
START_TS=$(date +%s)

say() { printf '%s\n' "$*" | tee -a "$LOG"; }
record() {   # record <PASS|WARN|FAIL> <phase> <detail>
  local st="$1" name="$2" detail="$3"
  PHASES="${PHASES}${st}|${name}|${detail}"$'\n'
  case "$st" in
    FAIL) FAILED=$((FAILED+1)) ;;
    WARN) WARNED=$((WARNED+1)) ;;
  esac
  say "[$st] $name — $detail"
}

verdict_of() {
  if   [ "$FAILED" -gt 0 ]; then echo "RED — $FAILED failed, $WARNED warned"
  elif [ "$WARNED" -gt 0 ]; then echo "AMBER — $WARNED warned"
  else                           echo "GREEN — all phases passed"
  fi
}

say "── boot $STARTED_AT on $HOST ──"
if [ "$DRY" = 1 ]; then
  say "DRY-RUN: would run resync · collaborator-activity · selfheal · dropbox --clean-safe · gateway+dashboard rebuild · stack verify · MCP verify · fleet MCP converge+verify (every repo's .mcp.json) · code check · runner health · gh runners (per runner) · master doorway (remote_fleet start ${BOOT_DOORWAY_REPOS:-AI}) · swarm master (lease + watcher) · ping (recorded)"
  exit 0
fi

# ── 1. reconcile + fetch (code repo AND brain) ────────────────────────────────
# resync.sh owns the safety: it proves every local deviation is a byte-identical
# echo of origin before resetting anything, refuses losslessly on genuine local
# work, and never auto-merges diverged code.
if [ -f "$ROOT/scripts/resync.sh" ]; then
  OUT="$(bash "$ROOT/scripts/resync.sh" 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  SUM="$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-240)"
  if [ "$RC" = 0 ]; then record PASS "reconcile (code+brain)" "$SUM"
  else                   record FAIL "reconcile (code+brain)" "NEEDS OPERATOR — $SUM"; fi
else
  record WARN "reconcile (code+brain)" "resync.sh absent"
fi

# ── 1b. collaborator activity (new code from other people) ────────────────────
# Operator request 2026-10-02: boot must report what teammates pushed on
# any repo with a remote, not just fast-forward our own branch. resync.sh (phase
# 1) already fetched, so run report-only (--no-fetch). Informational — never a
# FAIL; it never mutates or prunes.
if [ -f "$ROOT/scripts/collaborator_activity.sh" ]; then
  OUT="$(bash "$ROOT/scripts/collaborator_activity.sh" --no-fetch 2>&1)"
  printf '%s\n' "$OUT" >> "$LOG"
  if [ -z "$OUT" ]; then
    record PASS "collaborator activity" "no remote (skipped)"
  elif printf '%s' "$OUT" | grep -q "No new activity"; then
    record PASS "collaborator activity" "no new activity since last session"
  else
    SUM="$(printf '%s\n' "$OUT" | grep -E '^(new / updated|commits not yet|pull-request|  housekeeping|   housekeeping)' | tr '\n' ' ' | cut -c1-220)"
    record PASS "collaborator activity" "${SUM:-see log — teammate activity since last session}"
  fi
else
  record WARN "collaborator activity" "collaborator_activity.sh absent"
fi

# ── 2. deterministic self-heal ────────────────────────────────────────────────
if [ -f "$ROOT/scripts/machine_selfheal.sh" ]; then
  OUT="$(bash "$ROOT/scripts/machine_selfheal.sh" 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  if [ "$RC" = 0 ]; then record PASS "self-heal" "clean"
  else record WARN "self-heal" "rc=$RC — $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"; fi
else
  record WARN "self-heal" "machine_selfheal.sh absent"
fi

# ── 2b. claude session-label block (~/.zshrc) ─────────────────────────────────
# The '<device> - <repo>' claude -n wrapper (_claude_labelled) lives in a managed
# block in ~/.zshrc, installed by setup_org_dirs.sh. 2026-10-02: the installer
# died under macOS /bin/bash 3.2 before writing, so the block never upgraded past
# the OLD plain-alias form on any Mac (marker present, _claude_labelled missing)
# and hand-started sessions stayed auto-named 'ai-55'. Fixed in a84bf984; this
# phase carries the fix to every Mac — detect the stale block and re-apply the
# alias step ONLY (--aliases-only backs up ~/.zshrc, leaves statusline/settings
# untouched). PASS when the labelled wrapper is present (already-ok or repaired).
if [ -f "$ROOT/scripts/setup_org_dirs.sh" ]; then
  ZRC="$HOME/.zshrc"
  ZMARKER="# >>> claude multi-org aliases (managed by setup_org_dirs.sh) >>>"
  # Current = _claude_labelled AND the bypass-v2 stamp (2026-10-19: a labelled
  # but bypass-less block passed as "present" while bare `claude` prompted).
  ZCUR=0
  grep -qF "_claude_labelled" "$ZRC" 2>/dev/null && grep -qF "# bypass-v2:" "$ZRC" 2>/dev/null && ZCUR=1
  if [ -f "$ZRC" ] && grep -qF "$ZMARKER" "$ZRC" 2>/dev/null && [ "$ZCUR" = 0 ]; then
    OUT="$(bash "$ROOT/scripts/setup_org_dirs.sh" --aliases-only 2>&1)"; RC=$?
    printf '%s\n' "$OUT" >> "$LOG"
    BAK="$(printf '%s\n' "$OUT" | grep -oE '[^ ]*\.bak' | tail -1)"
    if [ "$RC" = 0 ] && grep -qF "_claude_labelled" "$ZRC" 2>/dev/null && grep -qF "# bypass-v2:" "$ZRC" 2>/dev/null; then
      record PASS "claude session-label block" "stale ~/.zshrc block refreshed (--aliases-only)${BAK:+; backup $BAK}"
    else
      record WARN "claude session-label block" "stale ~/.zshrc block — --aliases-only did not repair it (rc=$RC); run ./scripts/setup_org_dirs.sh"
    fi
  elif [ -f "$ZRC" ] && [ "$ZCUR" = 1 ]; then
    record PASS "claude session-label block" "present (_claude_labelled + bypass-v2 wrapper installed)"
  else
    record PASS "claude session-label block" "no managed block yet (setup_org_dirs.sh not run on this Mac)"
  fi
fi

# ── 3. Dropbox conflict sweep ─────────────────────────────────────────────────
# Dropbox is one of the four platform seams the operator holds to <0.1%; a
# conflicted copy inside .git or state/ is the classic Monday-morning failure.
if [ -f "$ROOT/scripts/dropbox_conflicts.sh" ]; then
  # --clean-safe resolves what it can PROVE lossless (byte-identical · content
  # already in git history · regenerated snapshot per
  # config/dropbox_conflict_policy.txt · append-only log, merged first) and
  # exits 3 only for copies a human must judge. Until 2026-09-22 this phase
  # only LISTED, and the same 13 lossless copies WARNed for three boots.
  OUT="$(bash "$ROOT/scripts/dropbox_conflicts.sh" --clean-safe 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  DONE_LINE="$(printf '%s\n' "$OUT" | grep -E '^removed [0-9]+ lossless' | head -1)"
  if   [ "$RC" = 0 ]; then record PASS "dropbox conflicts" "${DONE_LINE:-none found}"
  elif [ "$RC" = 3 ]; then record WARN "dropbox conflicts" "NEEDS A HUMAN — ${DONE_LINE:+$DONE_LINE }$(printf '%s\n' "$OUT" | grep -E '^KEPT|^  · ' | tr '\n' ' ' | cut -c1-220)"
  else record WARN "dropbox conflicts" "rc=$RC — $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"; fi
else
  record WARN "dropbox conflicts" "dropbox_conflicts.sh absent"
fi

# ── 3b. node_modules never syncs (AI_RULES §12 hard rule, 2026-10-02) ─────────
# Full Dropbox-root sweep, then PROVE it: every node_modules under Dropbox must
# carry com.dropbox.ignored=1 (the 15-min launchd sweeper keeps it so between
# boots; this phase is the daily read-back).
if [ -f "$ROOT/scripts/dropbox_ignore_artifacts.sh" ] && [ "$(uname -s)" = Darwin ]; then
  OUT="$(bash "$ROOT/scripts/dropbox_ignore_artifacts.sh" --all 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  DB_ROOT="$HOME/Dropbox"
  NM_TOTAL=0; NM_BAD=0
  if [ -d "$DB_ROOT" ]; then
    while IFS= read -r d; do
      NM_TOTAL=$((NM_TOTAL+1))
      [ "$(xattr -p com.dropbox.ignored "$d" 2>/dev/null)" = "1" ] || NM_BAD=$((NM_BAD+1))
    done < <(find "$DB_ROOT" -type d \( -name .git -prune -o -name node_modules -print -prune \) 2>/dev/null)
  fi
  SWEEP="$(printf '%s\n' "$OUT" | grep -E '^dropbox-ignore:' | tail -1)"
  if [ "$RC" = 0 ] && [ "$NM_BAD" = 0 ]; then
    record PASS "node_modules Dropbox-ignored" "$NM_TOTAL/$NM_TOTAL ignored · ${SWEEP:-sweep clean}"
  else
    record WARN "node_modules Dropbox-ignored" "$NM_BAD of $NM_TOTAL still syncing (rc=$RC) — run ./scripts/dropbox_ignore_artifacts.sh --all"
  fi
  if ! launchctl list com.myai.dropbox-ignore >/dev/null 2>&1; then
    record WARN "dropbox-ignore sweeper" "launchd agent not loaded — run ./scripts/setup_dropbox_ignore_schedule.sh"
  fi
fi

# ── 4. gateway + dashboard: rebuild and restart on the new code (rule 3) ──────
# stack_up_verified.sh owns build → up → retry → PROOF (dashboard Running and
# :3210 answering). 2026-10-27: a bare `compose up` gave up on the dashboard
# while the gateway was still unhealthy and left it in Created — nothing
# retried and nothing proved the UI was up. Its LAST stdout line is the
# verdict; compose output (stderr) goes to the log.
if [ "$DO_BUILD" = 1 ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    SUV_OUT="$(bash "$ROOT/scripts/stack_up_verified.sh" --build --root "$ROOT" 2>>"$LOG")"; SUV_RC=$?
    printf '%s\n' "$SUV_OUT" >>"$LOG"
    SUV_LAST="$(printf '%s\n' "$SUV_OUT" | sed '/^[[:space:]]*$/d' | tail -1)"
    if [ "$SUV_RC" = 0 ]; then
      record PASS "gateway+dashboard rebuild" "${SUV_LAST:-images built, dashboard running and answering}"
    else
      record FAIL "gateway+dashboard rebuild" "${SUV_LAST:-stack_up_verified.sh exited $SUV_RC} — see $LOG"
    fi
  else
    record FAIL "gateway+dashboard rebuild" "docker daemon unreachable"
  fi
else
  record WARN "gateway+dashboard rebuild" "skipped (--no-build)"
fi

# ── 4b. restart policy: only myai-* auto-restarts at login (operator rule) ─────
# Operator 2026-10-02: "not all containers need start at login, only myai." On a
# `myai-only` host, re-assert restart=no on every RUNNING container that is not
# `myai-*`. Other repos' compose files (e.g. restart: unless-stopped) re-set
# their own policy on their next `up`, so this is a DAILY correction, not a
# one-off. `default` hosts keep every container's compose restart policy.
RESTART_MODE="$(resolve_restart_mode "$STACK_LIMITS_FILE" "$HOST")"
if [ "$RESTART_MODE" = myai-only ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    TOUCHED="$(stack_reassert_myai_only_restart 2>>"$LOG")"; RRC=$?
    N=0; [ -n "$TOUCHED" ] && N=$(printf '%s\n' "$TOUCHED" | grep -c .)
    LIST="$(printf '%s' "$TOUCHED" | tr '\n' ' ' | sed 's/ *$//')"
    if [ "$RRC" = 0 ]; then
      record PASS "restart policy (myai-only)" "restart=no on $N non-myai container(s)${LIST:+: $LIST}"
    else
      record WARN "restart policy (myai-only)" "some 'docker update --restart=no' calls failed (did $N) — see $LOG"
    fi
  else
    record WARN "restart policy (myai-only)" "docker unreachable — cannot re-assert restart=no"
  fi
else
  record PASS "restart policy" "mode=$RESTART_MODE — containers keep their compose restart policy"
fi

# ── 5. prove the running containers ARE the new code (rule 4) ─────────────────
if [ -f "$ROOT/scripts/verify_local_stack.sh" ]; then
  OUT="$(bash "$ROOT/scripts/verify_local_stack.sh" 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  SUM="$(printf '%s' "$OUT" | grep -E '^(FRESH|STALE|DOWN)' | tr '\n' ' ')"
  if [ "$RC" = 0 ]; then record PASS "stack matches HEAD (by content)" "$SUM"
  else record FAIL "stack matches HEAD (by content)" "$SUM"; fi
else
  record WARN "stack matches HEAD (by content)" "verify_local_stack.sh absent"
fi

# ── 6. gateway health + MCP connected ─────────────────────────────────────────
HEALTH=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 5 http://localhost:3100/health >/dev/null 2>&1; then HEALTH=1; break; fi
  sleep 3
done
if [ "$HEALTH" = 1 ]; then record PASS "gateway /health" "responding on :3100"
else record FAIL "gateway /health" "no response after ~30s"; fi

# ── 6a. fleet DB: every fleet gateway must share ONE database ───────────────
# The fleet coordinator lease and (phase 2) the usage ledger live in the
# gateway's DB; a Mac whose gateway points elsewhere (runtime/.env carries a
# local-mongo URI) would elect its own coordinator and double-spend accounts.
# Only checked on a Mac with a fleet role (config/fleet_roles.txt fleet_db).
# shellcheck source=scripts/lib/fleet_role.sh
[ -f "$HERE/lib/fleet_role.sh" ] && . "$HERE/lib/fleet_role.sh"
if command -v fleet_has_role >/dev/null 2>&1 && fleet_has_role && [ -n "$(fleet_db_expected)" ]; then
  _fdb_want="$(fleet_db_expected)"
  _fdb_got="$(fleet_db_of_uri "$(docker exec myai-gateway printenv MONGODB_URI 2>/dev/null)")"
  if [ "$_fdb_got" = "$_fdb_want" ]; then
    record PASS "fleet DB shared (role $(fleet_my_role))" "gateway → $_fdb_got"
  elif [ -z "$_fdb_got" ]; then
    record WARN "fleet DB shared (role $(fleet_my_role))" "could not read the gateway's MONGODB_URI (container down?)"
  else
    record FAIL "fleet DB shared (role $(fleet_my_role))" "gateway → $_fdb_got but the fleet uses $_fdb_want — leases + usage ledger would split; set MONGODB_URI in .env, then docker compose up -d gateway"
  fi
fi

# Tool surface: a gateway that answers /health but exposes no tools is the
# failure that starved the runner once (a dead tasks_claim after image drift).
if [ "$HEALTH" = 1 ]; then
  # shellcheck source=scripts/lib/gateway.sh
  [ -f "$ROOT/scripts/lib/gateway.sh" ] && . "$ROOT/scripts/lib/gateway.sh"
  TOOLS="$(curl -s -m 15 -X POST http://localhost:3100/mcp \
            -H 'Content-Type: application/json' \
            -H 'Accept: application/json, text/event-stream' \
            -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
            -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null \
          | /usr/bin/python3 -c 'import sys,json
try:
    d=json.loads(sys.stdin.read())
    print(len(d["result"]["tools"]))
except Exception: print("")' 2>/dev/null)"
fi
if [ -n "$TOOLS" ] && [ "$TOOLS" -gt 0 ] 2>/dev/null; then
  record PASS "MCP tool surface" "$TOOLS tools exposed"
else
  record FAIL "MCP tool surface" "tools/list returned nothing — MCP not usable"
fi

# The stdio bridge is what Claude Code itself launches; a working gateway with a
# broken bridge still gives the operator a dead `myai` server at 09:00.
if [ -f "$ROOT/scripts/lib/mcp_myai_stdio.sh" ]; then
  BOUT="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"boot","version":"1"}}}' \
          | bash "$ROOT/scripts/lib/mcp_myai_stdio.sh" 2>&1 | head -40)"
  case "$BOUT" in
    *"Proxy established successfully"*) record PASS "myai MCP stdio bridge" "handshake ok" ;;
    *) record WARN "myai MCP stdio bridge" "no proxy line — $(printf '%s' "$BOUT" | tr '\n' ' ' | cut -c1-160)" ;;
  esac
fi

# ── 6b. fleet MCP: every repo the operator opens must connect, not just master ──
# (rule 5) Converge first — the boot FIXES before it judges ("fix done before
# that") — then prove each repo's own .mcp.json handshakes. Commits the
# converged .mcp.json in each repo; never pushes from an unattended run.
if [ -f "$ROOT/scripts/rollout_mcp_bridge.sh" ]; then
  ROUT="$(bash "$ROOT/scripts/rollout_mcp_bridge.sh" --quiet 2>&1)"; RRC=$?
  printf '%s\n' "$ROUT" >> "$LOG"
  RSUM="$(printf '%s' "$ROUT" | tail -1 | sed 's/^rollout_mcp_bridge: //')"
  if [ "$RRC" = 0 ]; then record PASS "fleet MCP configs converged" "$RSUM"
  else record WARN "fleet MCP configs converged" "$RSUM"; fi
fi
# Antigravity (agy) is a first-class worker (task-7fd4320e) — converge its
# global mcp_config.json onto the same myai stdio bridge so agy sessions get
# tasks/brain/mailbox/swarm tools. Idempotent + quiet when current.
if [ -f "$ROOT/scripts/setup_antigravity_mcp.sh" ]; then
  AOUT="$(bash "$ROOT/scripts/setup_antigravity_mcp.sh" 2>&1)"; ARC=$?
  [ -n "$AOUT" ] && printf '%s\n' "$AOUT" >> "$LOG"
  ASUM="$(printf '%s' "$AOUT" | tr '\n' ' ' | cut -c1-140)"
  if [ "$ARC" = 0 ]; then record PASS "antigravity MCP (agy → myai bridge)" "${ASUM:-already current}"
  else record WARN "antigravity MCP (agy → myai bridge)" "$ASUM"; fi
fi

# ── 6c. Docker MCP gateway profiles (Docker MCP rollout A, phase 0) ─────────
# Converge this Mac's `docker mcp` profiles onto config/docker_mcp_profiles.txt
# so the .mcp.json `docker` entry finds its lane's profile — no hand-made
# `docker mcp profile create` per Mac. Each profile is read back after the
# change; Docker Desktop down / MCP Toolkit off is a WARN (those tools are
# simply absent this morning), a profile that won't converge is a FAIL.
if [ -f "$ROOT/scripts/docker_mcp_profiles.sh" ]; then
  DMOUT="$(bash "$ROOT/scripts/docker_mcp_profiles.sh" ensure 2>&1)"; DMRC=$?
  printf '%s\n' "$DMOUT" >> "$LOG"
  DMSUM="$(printf '%s' "$DMOUT" | tr '\n' ';' | sed 's/;$//; s/;/ · /g' | cut -c1-200)"
  case "$DMRC" in
    0) record PASS "docker MCP profiles" "$DMSUM" ;;
    2) record WARN "docker MCP profiles" "$DMSUM — docker MCP tools unavailable until Docker Desktop runs" ;;
    *) record FAIL "docker MCP profiles" "$DMSUM — fix: bash scripts/docker_mcp_profiles.sh ensure" ;;
  esac
fi
if [ -f "$ROOT/scripts/verify_fleet_mcp.sh" ]; then
  if [ "$HEALTH" = 1 ]; then
    VOUT="$(bash "$ROOT/scripts/verify_fleet_mcp.sh" 2>&1)"; VRC=$?
    printf '%s\n' "$VOUT" >> "$LOG"
    VSUM="$(printf '%s' "$VOUT" | tail -1 | sed 's/^fleet MCP ([a-z]*): //')"
    VFAILS="$(printf '%s\n' "$VOUT" | grep '^FAIL' | awk '{print $2}' | tr '\n' ' ' | cut -c1-140)"
    if [ "$VRC" = 0 ]; then record PASS "fleet MCP handshakes (each repo's .mcp.json)" "$VSUM"
    else record FAIL "fleet MCP handshakes (each repo's .mcp.json)" "$VSUM — broken: $VFAILS"; fi
  else
    record FAIL "fleet MCP handshakes (each repo's .mcp.json)" "skipped — gateway /health is down"
  fi
fi

# ── 7. code check ─────────────────────────────────────────────────────────────
if [ "$QUICK" = 1 ]; then
  record WARN "code check" "skipped (--quick)"
elif [ -f "$ROOT/scripts/local-ci.sh" ]; then
  # --no-branch-policy: the boot checks out `main`, and "Enforce branch policy"
  # judges a PR head NAME (test/hotfix/*), not code — it FAILed every boot.
  OUT="$(bash "$ROOT/scripts/local-ci.sh" --dry-run --no-branch-policy 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  SUM="$(printf '%s' "$OUT" | tail -6 | tr '\n' ' ' | cut -c1-240)"
  if [ "$RC" = 0 ]; then record PASS "code check (local-ci --dry-run)" "$SUM"
  else record FAIL "code check (local-ci --dry-run)" "$SUM"; fi
else
  record WARN "code check" "local-ci.sh absent"
fi

# Shell unit suites — cheap, and they are what catches the boot scripts' own
# regressions (this routine included). Bounded as a WHOLE (run_all's own
# per-suite watchdog only reaches direct children): on 2026-10-14 this phase
# held the boot ~4.3 days. Output goes to a file, never a $(…) pipe — a
# straggler grandchild holding the pipe open would block the capture forever —
# and run_all gets its own process group so an overrun kills everything it
# spawned. Overrun = FAIL naming the suite that was running; the run continues.
SUITES_TIMEOUT="${BOOT_SUITES_TIMEOUT:-1200}"
case "$SUITES_TIMEOUT" in ''|*[!0-9]*) SUITES_TIMEOUT=1200 ;; esac
if [ "$QUICK" != 1 ] && [ -f "$ROOT/scripts/tests/run_all.sh" ]; then
  SOUT_FILE="$(mktemp -t bootsuites.XXXXXX)"
  set -m   # job control → the background job leads its own process group
  bash "$ROOT/scripts/tests/run_all.sh" </dev/null >"$SOUT_FILE" 2>&1 &
  SPID=$!
  set +m
  W=0; STIMEOUT=0
  while kill -0 "$SPID" 2>/dev/null && [ "$W" -lt "$SUITES_TIMEOUT" ]; do sleep 1; W=$((W+1)); done
  if kill -0 "$SPID" 2>/dev/null; then
    STIMEOUT=1
    kill -TERM -- "-$SPID" 2>/dev/null; sleep 2; kill -KILL -- "-$SPID" 2>/dev/null
  fi
  wait "$SPID" 2>/dev/null; RC=$?
  kill -TERM -- "-$SPID" 2>/dev/null   # reap stragglers a finished run left behind
  OUT="$(cat "$SOUT_FILE" 2>/dev/null)"; rm -f "$SOUT_FILE"
  printf '%s\n' "$OUT" >> "$LOG"
  if [ "$STIMEOUT" = 1 ]; then
    SRUNNING="$(printf '%s\n' "$OUT" | grep -E '^▶ ' | tail -1 | sed 's/^▶ //')"
    record FAIL "shell suites (run_all)" "timed out after ${SUITES_TIMEOUT}s (BOOT_SUITES_TIMEOUT) while running ${SRUNNING:-an unknown suite} — killed; rerun: bash scripts/tests/run_all.sh"
  else
    SUM="$(printf '%s' "$OUT" | tail -3 | tr '\n' ' ' | cut -c1-200)"
    if [ "$RC" = 0 ]; then record PASS "shell suites (run_all)" "$SUM"
    else record FAIL "shell suites (run_all)" "$SUM"; fi
  fi
fi

# ── 8. runner health ──────────────────────────────────────────────────────────
if [ -f "$ROOT/scripts/runner_health.sh" ]; then
  OUT="$(bash "$ROOT/scripts/runner_health.sh" 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$LOG"
  SUM="$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
  if [ "$RC" = 0 ]; then record PASS "runner health" "$SUM"
  else record WARN "runner health" "$SUM"; fi
fi

# ── 8b. self-hosted CI runners — one row PER runner (2026-10-22: N runners per
# repo, every one a slot of project myai). `runner_selfhosted.sh check` prints
# "OK   <container> (<repo>, <name>): up, online, idle|busy" or "WARN …" per
# runner from ~/.myai/runners/slots.<host>; a host with none (or only pre-slot
# runners) gets one WARN row naming the fix. Never restarts anything.
if [ -f "$ROOT/scripts/runner_selfhosted.sh" ]; then
  GOUT="$(bash "$ROOT/scripts/runner_selfhosted.sh" check </dev/null 2>&1)"
  printf '%s\n' "$GOUT" >> "$LOG"
  while IFS= read -r gline; do
    case "$gline" in
      "OK   "*)  gname="${gline#OK   }";  record PASS "gh runner ${gname%% *}" "${gname#* }" ;;
      "WARN "*)  gname="${gline#WARN }"; record WARN "gh runner ${gname%% *}" "${gname#* }" ;;
    esac
  done <<GEOF
$GOUT
GEOF
fi

# ── 8b. standing-agent recurring-task cadence (last/next run) ─────────────────
# Generic — reports EVERY recurring_tasks_create template (standing-pr-reviewer's
# pr_review_fleet_sweep, standing-blog-scout's blog_scout_weekly_sweep, etc), not
# a hardcoded name, so a newly registered standing agent shows up here for free.
# Read-only MCP call; never touches the gateway stack (DEPLOY GUARD).
if [ "$HEALTH" = 1 ]; then
  RT_OUT="$(curl -s -m 10 -X POST http://localhost:3100/mcp \
            -H 'Content-Type: application/json' \
            -H 'Accept: application/json, text/event-stream' \
            -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
            -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recurring_tasks_list","arguments":{}}}' 2>/dev/null \
          | /usr/bin/python3 -c 'import sys, json
try:
    d = json.loads(json.load(sys.stdin)["result"]["content"][0]["text"])
except Exception:
    print("ERR:unreachable")
    sys.exit(0)
rows = d.get("recurring") or d.get("recurringTasks") or d.get("tasks") or []
if not rows:
    print("NONE:0 registered (operator opt-in via scripts/register_*_recurring.sh)")
    sys.exit(0)
for t in rows:
    name = t.get("name", "?")
    last = t.get("lastFiredAt") or "never"
    stat = t.get("lastFireStatus", "?")
    nxt = t.get("nextFireAt", "?")
    print("%s: last=%s (%s) next=%s" % (name, last, stat, nxt))' 2>/dev/null)"
  case "$RT_OUT" in
    ERR:*|"")
      record WARN "standing-agent cadence (recurring tasks)" "recurring_tasks_list unreachable"
      ;;
    NONE:*)
      record PASS "standing-agent cadence (recurring tasks)" "${RT_OUT#NONE:}"
      ;;
    *)
      record PASS "standing-agent cadence (recurring tasks)" "$(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-240)"
      ;;
  esac
else
  record WARN "standing-agent cadence (recurring tasks)" "skipped — gateway /health is down"
fi

# ── 9. master doorway: a session WAITING for instructions (D1, rule 6) ─────────
# remote_fleet.sh owns the mechanics (tmux-owned session, "<host> - <repo>"
# label, remote-control handshake, duplicate guard). It is idempotent: an
# already-live labelled doorway is skipped, a mid-work session is never touched
# (WARN, with the reason), and a hand-started master session gets the labelled
# doorway started alongside. Bounded by a timeout so a hung `claude` start can
# never stall the unattended run. Verified through `remote_fleet.sh status`,
# not through the start command's own exit code.
DOORWAY_REPOS="${BOOT_DOORWAY_REPOS:-AI}"
DOORWAY_TIMEOUT="${BOOT_DOORWAY_TIMEOUT:-180}"
# The doorway is the swarm MASTER's session (v1 G6: lane from master.<host>,
# never a hard-coded name) — the same default remote_fleet.sh start uses.
DLANE="$(role_master_lane 2>/dev/null)"; [ -n "$DLANE" ] || DLANE=default
if [ -f "$ROOT/scripts/remote_fleet.sh" ]; then
  DOUT_FILE="$(mktemp -t bootdoorway.XXXXXX)"
  # shellcheck disable=SC2086  # DOORWAY_REPOS is a space-separated list of repo names
  ( bash "$ROOT/scripts/remote_fleet.sh" start $DOORWAY_REPOS </dev/null >"$DOUT_FILE" 2>&1 ) &
  DPID=$!; W=0; DTIMEOUT=0
  while kill -0 "$DPID" 2>/dev/null && [ "$W" -lt "$DOORWAY_TIMEOUT" ]; do sleep 2; W=$((W+2)); done
  if kill -0 "$DPID" 2>/dev/null; then kill "$DPID" 2>/dev/null; DTIMEOUT=1; fi
  wait "$DPID" 2>/dev/null
  DOUT="$(cat "$DOUT_FILE" 2>/dev/null)"; rm -f "$DOUT_FILE"
  printf '%s\n' "$DOUT" >> "$LOG"
  DSTAT="$(bash "$ROOT/scripts/remote_fleet.sh" status </dev/null 2>/dev/null)"
  # DMISSING = no master session at all. DUNLAB = master session(s) live but none
  # labelled '<host> - <repo>' — a hand-started session the boot skipped as
  # MID-WORK. That is NOT a doorway: on 2026-09-28 it passed as "live and
  # waiting" while the phone could not find any session.
  DMISSING=""; DUNLAB=""
  for r in $DOORWAY_REPOS; do
    # Captured, never piped into grep -q: under pipefail an early-exit grep -q
    # can SIGPIPE its writer and fail the pipe on a MATCH.
    DLINE="$(printf '%s\n' "$DSTAT" | grep -E "^${r}[[:space:]]+LIVE")"
    DMUS="$(printf '%s\n' "$DLINE" | grep -oE "\[$DLANE [^]]*\]")"
    # RC-OFF: labelled but Remote Control dropped — not on the phone (2026-09-29,
    # the labelled AI doorway passed here while the phone could not see it).
    DGOOD="$(printf '%s\n' "$DMUS" | grep -vE 'UNLABELLED|MISLABELLED|RC-OFF')"
    if [ -z "$DMUS" ]; then DMISSING="$DMISSING $r"
    elif [ -z "$DGOOD" ]; then DUNLAB="$DUNLAB $r"
    fi
  done
  DSUM="$(printf '%s\n' "$DOUT" | grep -E '^  (▶|↷|⟳|\?|✗|✋|⊘|⚠|!!)' | tr '\n' ' ' | cut -c1-220)"
  DNAME="claude-$DLANE doorway ($DOORWAY_REPOS)"
  DOORWAY_ST=PASS
  if [ -z "$DMISSING" ] && [ -n "$DUNLAB" ]; then
    DOORWAY_ST=WARN; record WARN "$DNAME" "no labelled, Remote-Control-on doorway for:$DUNLAB — only a hand-started (or RC-dropped) $DLANE session is live (may not be on the phone; run /remote-control in it, or wrap up there then: bash scripts/remote_fleet.sh start$DUNLAB) — ${DSUM:-see log}"
  elif [ -z "$DMISSING" ]; then
    case "$DOUT" in
      *"handshake UNCONFIRMED"*|*"handshake FAILED"*|*"iTerm attach failed"*)
        DOORWAY_ST=WARN; record WARN "$DNAME" "$DLANE session live, but: ${DSUM:-see log}" ;;
      *) record PASS "$DNAME" "$DLANE session live and waiting — ${DSUM:-already live}" ;;
    esac
  elif [ "$DTIMEOUT" = 1 ]; then
    DOORWAY_ST=FAIL; record FAIL "$DNAME" "remote_fleet start timed out after ${DOORWAY_TIMEOUT}s; no $DLANE session for:$DMISSING — fix: bash scripts/remote_fleet.sh start $DOORWAY_REPOS"
  else
    case "$DOUT" in
      *MID-WORK*) DOORWAY_ST=WARN; record WARN "$DNAME" "not started — repo mid-work (finish with wrap up):$DMISSING — $DSUM" ;;
      *) DOORWAY_ST=FAIL; record FAIL "$DNAME" "no $DLANE session for:$DMISSING — ${DSUM:-$(printf '%s' "$DOUT" | tail -2 | tr '\n' ' ' | cut -c1-160)} — fix: bash scripts/remote_fleet.sh start $DOORWAY_REPOS" ;;
    esac
  fi
else
  DOORWAY_ST=WARN; record WARN "claude-$DLANE doorway" "remote_fleet.sh absent"
fi

# ── 9b. Antigravity doorway: agy waiting in a visible iTerm tab ─────────────
# The agy counterpart of phase 9 (operator 2026-10-03: "I don't want to start agy
# every morning"; every session lives in a visible iTerm tab, no hidden tmux).
# agy_session.sh start is idempotent (a running agy is kept and brought forward),
# opens a new iTerm tab otherwise, launches with --remote-control like the
# operator's agy wrapper, and never starts/stops/re-registers agy's own
# remote-control daemon. Verified by finding the live agy process for this repo
# in the process table (session_lanes.sh), never by exit code.
# Skipped when agy is not installed; BOOT_AGY=0 opts out.
# Cold boot: iTerm is launching and the new tab's zsh is still sourcing its rc
# when agy is typed, so agy can appear well after agy_session's interactive 20s
# default. The unattended run waits longer (BOOT_AGY_WAIT, 60s) and re-checks
# the process table (BOOT_AGY_RECHECK × BOOT_AGY_RECHECK_SLEEP) before a FAIL.
AGY_BOOT_BIN="$(command -v agy 2>/dev/null || echo "$HOME/.local/bin/agy")"
if [ "${BOOT_AGY:-1}" = "0" ]; then
  record WARN "antigravity doorway" "skipped (BOOT_AGY=0)"
elif [ ! -x "$AGY_BOOT_BIN" ]; then
  say "antigravity doorway: agy not installed — skipped"
elif [ -f "$ROOT/scripts/agy_session.sh" ]; then
  AOUT="$(AGY_BIN="$AGY_BOOT_BIN" AGY_START_WAIT="${BOOT_AGY_WAIT:-60}" bash "$ROOT/scripts/agy_session.sh" start "$ROOT" --new-tab </dev/null 2>&1)"
  printf '%s\n' "$AOUT" >> "$LOG"
  AREPO="$(bash -c '. "$1/scripts/lib/session_lanes.sh"; _lanes_repo_of "$1"' _ "$ROOT")"
  ALIVE=""; ATRY=0
  while :; do
    ALIVE="$(bash "$ROOT/scripts/check_session.sh" agy --repo "$AREPO" </dev/null 2>/dev/null | head -1)"
    case "$ALIVE" in "CHECK agy"*) break ;; esac
    ATRY=$((ATRY + 1))
    [ "$ATRY" -gt "${BOOT_AGY_RECHECK:-3}" ] && break
    sleep "${BOOT_AGY_RECHECK_SLEEP:-5}"
  done
  case "$ALIVE" in
    "CHECK agy"*)
      AWHERE="$(printf '%s' "$ALIVE" | sed 's/^CHECK agy · //')"
      case "$AOUT" in
        *"daemon is NOT running"*) record WARN "antigravity doorway" "agy live ($AWHERE) but its remote-control daemon is down — phone can't see it: agy remote-control start --name $(hostname -s)" ;;
        *) record PASS "antigravity doorway" "agy live in iTerm ($AWHERE), tell agy + phone reachable" ;;
      esac ;;
    *)
      record FAIL "antigravity doorway" "agy session did not come up — $(printf '%s' "$AOUT" | tail -2 | tr '\n' ' ' | cut -c1-160) — fix: bash scripts/agy_session.sh start --new-tab" ;;
  esac
fi

# ── 9c. swarm master: this device's configured master holds the lease AND
# listens (operator rule 2026-10-22: every device always has exactly one master;
# on 2026-10-22 office-mac's master held nothing and was deaf to the home Mac's
# mail). `swarm_master.sh check`: 0 PASS · 1 WARN (lease by another lane / no
# mail watcher / gateway down) · 2 FAIL (lease not held) · 3 FAIL (no master
# configured). The doorway session above has only just started — its
# SessionStart hook takes the lease and the agent then arms its watcher — so a
# non-PASS answer is re-checked (BOOT_MASTER_RECHECK × BOOT_MASTER_RECHECK_SLEEP).
if [ -f "$ROOT/scripts/swarm_master.sh" ]; then
  MTRY=0
  while :; do
    MOUT="$(KL_TIMEOUT=4 bash "$ROOT/scripts/swarm_master.sh" check </dev/null 2>&1)"; MRC=$?
    MOUT="$(printf '%s\n' "$MOUT" | head -1)"
    if [ "$MRC" = 0 ] || [ "$MRC" = 3 ]; then break; fi
    MTRY=$((MTRY + 1))
    [ "$MTRY" -gt "${BOOT_MASTER_RECHECK:-3}" ] && break
    sleep "${BOOT_MASTER_RECHECK_SLEEP:-10}"
  done
  MDETAIL="$(printf '%s' "$MOUT" | sed -E 's/^(OK|WARN|RED) — //')"
  case "$MRC" in
    0) record PASS "swarm master" "$MDETAIL" ;;
    1) record WARN "swarm master" "$MDETAIL" ;;
    *) record FAIL "swarm master" "$MDETAIL" ;;
  esac
else
  record WARN "swarm master" "swarm_master.sh absent"
fi

# ── 10. ping on completion (D9) — RECORDED, never fire-and-forget (rule 6) ────
ELAPSED=$(( $(date +%s) - START_TS ))
# The ping text carries the verdict of phases 1–9 (the ping rows themselves come
# after) and says "waiting" ONLY when the doorway phase actually delivered a session.
case "$DOORWAY_ST" in
  PASS) READY="warm and waiting" ;;
  *)    READY="warm — doorway $DOORWAY_ST, no session waiting (see report)" ;;
esac
PING="boot $(verdict_of) on $HOST in ${ELAPSED}s — $READY. Report: state/boot/BOOT_REPORT.$HOST.md"
if [ -f "$ROOT/scripts/notify-telegram.sh" ]; then
  PERR="$(NOTIFY_STRICT=1 bash "$ROOT/scripts/notify-telegram.sh" 'done' "$PING" </dev/null 2>&1)"; PRC=$?
  case "$PRC" in
    0) record PASS "ping (telegram)" "sent" ;;
    2) record WARN "ping (telegram)" "NOT CONFIGURED — $(printf '%s' "$PERR" | tr '\n' ' ' | cut -c1-220)" ;;
    *) record WARN "ping (telegram)" "send failed rc=$PRC — $(printf '%s' "$PERR" | tr '\n' ' ' | cut -c1-200)" ;;
  esac
else
  record WARN "ping (telegram)" "notify-telegram.sh absent"
fi
if command -v osascript >/dev/null 2>&1; then
  if osascript -e "display notification \"$(verdict_of) — warm and waiting\" with title \"myAI boot\"" >/dev/null 2>&1; then
    record PASS "ping (macOS notification)" "posted"
  else
    record WARN "ping (macOS notification)" "osascript failed (no GUI session?)"
  fi
fi

# ── report ────────────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
VERDICT="$(verdict_of)"

{
  echo "# BOOT REPORT — $VERDICT"
  echo
  echo "- **Host:** $HOST"
  echo "- **Started:** $STARTED_AT   (**took** ${ELAPSED}s)"
  echo "- **HEAD:** \`$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)\` on \`$(git -C "$ROOT" branch --show-current 2>/dev/null)\`"
  echo "- **Log:** \`$LOG\`"
  echo
  echo "| Status | Phase | Detail |"
  echo "|--------|-------|--------|"
  printf '%s' "$PHASES" | while IFS='|' read -r st name detail; do
    [ -n "$st" ] || continue
    printf '| %s | %s | %s |\n' "$st" "$name" "$(printf '%s' "$detail" | sed 's/|/\\|/g')"
  done
  echo
  echo "_Generated by \`scripts/morning_boot.sh\` (the \`boot\` routine). The morning"
  echo "session should read THIS FILE rather than re-running the checks._"
} > "$REPORT"

say "── boot $VERDICT in ${ELAPSED}s — report: $REPORT"

[ "$FAILED" -eq 0 ]
