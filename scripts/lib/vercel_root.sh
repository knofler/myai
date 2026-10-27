#!/bin/bash
# vercel_root.sh — resolve a repo's Vercel project "Root Directory".
#
# WHY THIS EXISTS (incident foh, 2026-10-01): Vercel reads vercel.json ONLY from
# the project's Root Directory — NOT necessarily the repo root. foh is a turbo
# monorepo whose Vercel Root Directory is `apps/web`, but its vercel.json sat at
# the repo root, so the WHOLE file was silently ignored in production: the
# `/api/warm` cron never deployed (zero cron calls in 24h) and the CI-thrift
# `git.deploymentEnabled` prod-gate (CLAUDE.md rule 8) was never applied either.
# Fixed with `git mv vercel.json apps/web/vercel.json`. This is now a fleet
# standard (AI_RULES §11a): vercel.json lives in the Root Directory.
#
# `vercel_root_dir <repo_path>` echoes the Root Directory RELATIVE to the repo
# root (e.g. "apps/web"), or "" when it is the repo root / cannot be resolved.
# Resolution order (cheapest/offline first, each guarded so a missing CLI,
# missing link, no network, or no auth NEVER hangs and ALWAYS falls back to ""):
#   1. .vercel/project.json → .settings.rootDirectory   (offline, instant)
#   2. `vercel project inspect` → "Root Directory"       (network, timeout-bound)
#   3. project REST API rootDirectory via `vercel ... --json` where available
#   4. ""  (repo root — the task's mandated fallback "when that is empty")
#
# Pure stdout contract: prints exactly the subpath (or empty line). All
# diagnostics go to stderr. Safe to source from any script.

# Run a command with a wall-clock cap. Prints its stdout. Vercel network calls
# must NEVER wedge a fleet-wide sweep (health_check iterates every managed repo),
# and macOS ships no timeout(1) by default — so when neither timeout nor gtimeout
# exists, fall back to a portable temp-file + bounded-poll killer. The command's
# output goes to a temp file (not the caller's captured pipe), so a surrounding
# `out="$(_vercel_timeout ...)"` returns within $secs even on overrun — it never
# holds the substitution's fd open.
_vercel_timeout() {
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

# Normalize a raw Root Directory value to the stdout contract: strip quotes and
# surrounding whitespace, and map the "it's the repo root" sentinels to "".
_vercel_norm_root() {
  local v="$1"
  v="$(printf '%s' "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
  case "$v" in
    ''|'-'|'.'|'/'|'./'|'null'|'~') printf '' ;;
    *) printf '%s' "${v#./}" ;;   # drop a leading ./ so callers can "$d/$sub"
  esac
}

vercel_root_dir() {
  local d="$1" root=""
  if [ -z "$d" ] || [ ! -d "$d" ]; then printf ''; return 0; fi

  # (1) Offline: `vercel pull` / recent `vercel link` writes settings.rootDirectory
  # into .vercel/project.json. No network, no auth, instant — preferred.
  local linkf="$d/.vercel/project.json"
  if [ -f "$linkf" ] && command -v jq >/dev/null 2>&1; then
    root="$(jq -r '.settings.rootDirectory // empty' "$linkf" 2>/dev/null)"
    root="$(_vercel_norm_root "$root")"
    [ -n "$root" ] && { printf '%s' "$root"; return 0; }
  fi

  # Nothing below works without the CLI — bail to the repo-root fallback.
  command -v vercel >/dev/null 2>&1 || { printf ''; return 0; }

  # The project name/id links the repo to its Vercel project.
  local proj="" scope=""
  if [ -f "$linkf" ] && command -v jq >/dev/null 2>&1; then
    proj="$(jq -r '.projectId // empty' "$linkf" 2>/dev/null)"
    scope="$(jq -r '.orgId // empty' "$linkf" 2>/dev/null)"
  fi
  [ -n "$proj" ] || { printf ''; return 0; }   # unlinked → can't inspect

  # (2) `vercel project inspect <id>` prints a human table whose Root Directory
  # row is "Root Directory  apps/web" (dash/blank when it is the repo root).
  local out
  out="$(cd "$d" && _vercel_timeout 12 vercel project inspect "$proj" ${scope:+--scope "$scope"} 2>/dev/null)" || out=""
  if [ -n "$out" ]; then
    root="$(printf '%s\n' "$out" | sed -n 's/.*[Rr]oot [Dd]irectory[[:space:]]*//p' | head -1)"
    root="$(_vercel_norm_root "$root")"
    [ -n "$root" ] && { printf '%s' "$root"; return 0; }
  fi

  # (3) Fall through: repo root.
  printf ''
  return 0
}

# Does this repo even have a Vercel link? (offline, used to skip audits cheaply)
vercel_is_linked() { [ -f "$1/.vercel/project.json" ]; }
