#!/usr/bin/env bash
# scripts/lib/local_state.sh — per-machine-scoped paths for hook-written
# ephemeral session state (task-d4c32377, 2026-08-31 DEVOPS root-cause fix).
#
# ROOT CAUSE: every managed repo (and the master) lives inside a Dropbox-synced
# folder that multiple Macs point at as the literal same path, not separate
# clones — Dropbox mirrors the working tree itself, git pull is not involved.
# A handful of hook-written scratch files (state/.session-metrics,
# state/.autosave-metrics, state/.token-metrics, state/.token-rolling-cache)
# are rewritten wholesale (`cat > file`) on EVERY SessionStart and, worse,
# EVERY PostToolUse/PreToolUse call — i.e. dozens of times per session. Their
# content is 100% machine/session-local (wall-clock counters, a dedup key
# keyed off THIS machine's `~/.claude/projects/**/*.jsonl` transcript path) —
# no hook ever needs to read another machine's copy. Writing them to a SHARED
# path guarantees a write-write race the instant two Macs have sessions open
# within the same Dropbox propagation window: Dropbox can't distinguish a
# genuine concurrent edit from two machines innocently re-writing their own
# counters, so it defensively spins up a "<file> (<machine>'s conflicted copy
# <date>)" duplicate — the exact pileup this fix targets. The July 2026-07-20
# fix (scripts/lib/sync_guard.sh) solved the analogous problem for
# update_all.sh's push-down copies (skip write when byte-identical); it does
# not apply here because these counters are NOT byte-identical across
# machines by design.
#
# FIX: suffix the path with the sanitized short hostname so each machine reads
# and writes its own file. No shared path → no race, independent of timing.
# This also fixes a latent correctness bug, not just a cosmetic one: before
# this fix, Mac B could silently read Mac A's dedup/rolling-window state
# (whichever one last synced) and treat it as its own.
#
# Consumers: hooks/session/12-usage-guard-init.sh, hooks/pre-tool/10-usage-guard.sh,
# hooks/stop/03-session-dashboard.sh, hooks/post-tool/06-handoff-staleness.sh,
# hooks/pre-tool/15-token-budget-guard.sh, hooks/session/15-token-budget-status.sh.
# Sourced, not executed. bash 3.2 safe (no arrays, no bashisms beyond [ ]/[[ ]]).
#
# Layout note: lives at <root>/scripts/lib/ (master) or <root>/AI/scripts/lib/
# (managed) — same convention as sync_guard.sh / gateway.sh.

# local_state_suffix — sanitized short hostname, safe to embed in a filename.
# Falls back to "unknown-host" if hostname is unavailable (never empty, so a
# caller can never accidentally produce the unsuffixed shared path by mistake).
local_state_suffix() {
    local h
    h="$(hostname -s 2>/dev/null)"
    [ -n "$h" ] || h="$(hostname 2>/dev/null)"
    [ -n "$h" ] || h="unknown-host"
    # Keep it filename-safe: alnum, dot, dash, underscore only.
    printf '%s' "$h" | tr -c 'A-Za-z0-9_.-' '_'
}

# local_state_path BASE_PATH — BASE_PATH with the per-machine suffix appended,
# e.g. local_state_path "state/.session-metrics" -> ".session-metrics.home-mac"
# Idempotent no-op on an empty argument (callers that pass through an
# unresolved path shouldn't get a bare ".suffix" file).
local_state_path() {
    local base="$1"
    [ -n "$base" ] || return 0
    printf '%s.%s' "$base" "$(local_state_suffix)"
}
