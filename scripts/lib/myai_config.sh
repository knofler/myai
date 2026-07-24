#!/usr/bin/env bash
# myai_config.sh — the per-user `~/.myai/config` (JSON) + first-run brain
# bootstrap (plan MYAI_INIT_ONE_COMMAND_PLAN.md S-INIT-3, ADR-016 §0.1/§0.4).
#
# TWO responsibilities, both keyed off ONE brain-per-user (never per-repo):
#
#   1. Config store — a JSON file at `$MYAI_HOME/config` (default ~/.myai/config)
#      holding the brain location + its private git remote, so a SECOND machine
#      that only has the config can auto-clone the same brain and be "back where
#      you left off". Read/write via python3 (hermetic; no jq dependency).
#
#   2. myai_brain_bootstrap — the first-run wiring `myai init` calls:
#        • brain already present locally → adopt + record it in config (no-op-ish)
#        • config names a remote but no local brain → AUTO-CLONE it before boot
#        • first-ever run, no brain, no config → create it (reuse `brain init`),
#          OFFER a private remote (TTY only; CI/non-TTY skips silently), persist
#          the remote + brain dir in config.
#
# Guardrail (ADR-016 §0.4, non-negotiable): the brain remote is PRIVATE by
# construction and is NEVER the code repo's own remote — a brain nested on a
# shared code remote would publish private memory. The offer refuses any URL
# that matches one of the code repo's remotes.
#
# Resolution of the config home matches the brain's (scripts/lib/brain.sh):
#   $MYAI_HOME/config   (MYAI_HOME defaults to ~/.myai)
#
# Sourceable (set -e/-u safe, bash 3.2 for stock macOS). Node mirror TBD
# (runtime/src/core/*). Tests: scripts/tests/test_myai_config_brain.sh (hermetic
# — git + python3 only, MYAI_HOME/HOME redirected into a tmpdir).

_MYAI_CONFIG_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# The brain lib is the single source of truth for brain_dir/brain_init/etc.
if ! command -v brain_dir >/dev/null 2>&1; then
  # shellcheck source=brain.sh
  . "$_MYAI_CONFIG_HERE/brain.sh"
fi

# ── config location + JSON read/write ─────────────────────────────────────────

myai_config_home() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}"; }
myai_config_path() { printf '%s\n' "$(myai_config_home)/config"; }

# myai_config_get <dotted.key> — print a scalar value (empty if missing / the
# key resolves to an object/array / the file is absent or invalid). rc always 0.
myai_config_get() {
  local key="$1" file; file="$(myai_config_path)"
  [ -f "$file" ] || return 0
  python3 - "$file" "$key" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
cur = d
for part in sys.argv[2].split('.'):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        sys.exit(0)
if isinstance(cur, (dict, list)) or cur is None:
    sys.exit(0)
print(cur)
PY
}

# myai_config_set <dotted.key> <value> — merge one scalar into the config JSON,
# creating parents as needed. Always stamps version:1. Atomic write. rc 0/1.
myai_config_set() {
  local key="$1" value="$2" file; file="$(myai_config_path)"
  mkdir -p "$(dirname "$file")" || return 1
  python3 - "$file" "$key" "$value" <<'PY'
import json, os, sys
f, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(f))
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
d.setdefault("version", 1)
cur = d
parts = key.split(".")
for p in parts[:-1]:
    if not isinstance(cur.get(p), dict):
        cur[p] = {}
    cur = cur[p]
cur[parts[-1]] = value
tmp = f + ".tmp"
with open(tmp, "w") as fh:
    json.dump(d, fh, indent=2)
    fh.write("\n")
os.replace(tmp, f)
PY
}

# ── helpers ────────────────────────────────────────────────────────────────

# _myai_interactive — 0 (true) when we may prompt: stdin is a TTY, not CI, and
# no explicit non-interactive override. Mirrors the myai_init wizard's gating.
_myai_interactive() {
  [ "${MYAI_NONINTERACTIVE:-0}" = 1 ] && return 1
  [ -n "${CI:-}" ] && return 1
  [ -t 0 ] || return 1
  return 0
}

# _myai_norm_remote <url> — normalize a git remote for comparison: strip a
# trailing .git and any trailing slash. Enough to catch the obvious
# code-repo-as-brain-remote mistake (the guardrail is belt-and-suspenders, not
# a URL parser).
_myai_norm_remote() {
  printf '%s' "${1:-}" | sed -e 's#/*$##' -e 's#\.git$##'
}

# _myai_is_code_remote <code_repo_dir> <candidate_url> — 0 (true) when candidate
# matches ANY remote configured on the code repo. Used to refuse wiring the code
# repo's own remote as the brain remote (ADR-016 §0.4).
_myai_is_code_remote() {
  local cdir="$1" cand; cand="$(_myai_norm_remote "$2")"
  [ -n "$cand" ] || return 1
  git -C "$cdir" rev-parse --git-dir >/dev/null 2>&1 || return 1
  local r url
  for r in $(git -C "$cdir" remote 2>/dev/null); do
    url="$(_myai_norm_remote "$(git -C "$cdir" remote get-url "$r" 2>/dev/null)")"
    [ -n "$url" ] && [ "$url" = "$cand" ] && return 0
  done
  return 1
}

# ── the first-run bootstrap ──────────────────────────────────────────────────

# myai_brain_bootstrap [code_repo_dir]
# The per-user brain wiring `myai init` (greenfield) calls before the repo boots.
# Idempotent. Prints human-readable status to stdout; never fatal to init (a
# failed clone falls back to a local brain via brain_init). rc 0.
#
# Sources of a brain remote, in order:
#   1. an existing local brain's origin        → recorded in config, adopt
#   2. config's brain.remote (later machine)    → AUTO-CLONE before boot
#   3. $MYAI_BRAIN_REMOTE env (automation/tests) → wire on fresh init
#   4. interactive offer (TTY, not CI)           → prompt for a private URL
# In all "wire a remote" paths the code repo's own remote is refused.
myai_brain_bootstrap() {
  local cdir="${1:-$PWD}"
  local bdir; bdir="$(brain_dir)"

  # 1. Brain already here → adopt + record. If it carries an origin, persist it
  #    so a later machine can auto-clone; never overwrite an existing config
  #    remote with an empty one.
  if brain_is_repo "$bdir"; then
    myai_config_set "brain.dir" "$bdir" >/dev/null 2>&1 || true
    local origin; origin="$(brain_remote_url "$bdir" 2>/dev/null || true)"
    if [ -n "$origin" ]; then
      myai_config_set "brain.remote" "$origin" >/dev/null 2>&1 || true
    fi
    echo "myai: brain present at $bdir — recorded in $(myai_config_path)"
    return 0
  fi

  # 2. No local brain, but config names a remote → auto-clone (new-machine
  #    onboarding: `myai init` on a machine that only has the synced config).
  local cfg_remote; cfg_remote="$(myai_config_get "brain.remote" 2>/dev/null || true)"
  if [ -n "$cfg_remote" ]; then
    echo "myai: no local brain — auto-cloning from config remote before boot…"
    brain_init "$bdir" --remote "$cfg_remote" >/dev/null 2>&1 || true
    if brain_is_repo "$bdir"; then
      myai_config_set "brain.dir" "$bdir" >/dev/null 2>&1 || true
      # brain_init falls back to a fresh init if the clone yields no brain; only
      # keep the recorded remote if the brain actually carries it now.
      local now; now="$(brain_remote_url "$bdir" 2>/dev/null || true)"
      [ -n "$now" ] && myai_config_set "brain.remote" "$now" >/dev/null 2>&1 || true
      echo "myai: brain ready at $bdir (auto-cloned / fresh) — recorded in $(myai_config_path)"
    else
      echo "myai: WARN — could not clone or create brain at $bdir; run 'myai brain init' manually" >&2
    fi
    return 0
  fi

  # 3/4. First-ever run: no brain, no config remote. Decide on a remote to wire.
  local remote=""
  if [ -n "${MYAI_BRAIN_REMOTE:-}" ]; then
    remote="$MYAI_BRAIN_REMOTE"
  elif _myai_interactive; then
    echo ""
    echo "  myAI keeps its memory (the brain) in a PRIVATE git repo — one per you,"
    echo "  shared across all your projects. Wire a private remote now and every"
    echo "  future machine auto-clones it (leave blank to keep it local only)."
    printf '  private brain remote URL [skip]: '
    read -r remote || remote=""
  fi

  # Guardrail (ADR-016 §0.4): never wire the code repo's own remote as the brain
  # remote — that would publish private memory to everyone with code access.
  if [ -n "$remote" ] && _myai_is_code_remote "$cdir" "$remote"; then
    echo "myai: WARN — that URL is this repo's code remote; the brain must be a SEPARATE private repo. Creating a local-only brain instead." >&2
    remote=""
  fi

  if [ -n "$remote" ]; then
    brain_init "$bdir" --remote "$remote" >/dev/null 2>&1 || true
  else
    brain_init "$bdir" >/dev/null 2>&1 || true
  fi

  if brain_is_repo "$bdir"; then
    myai_config_set "brain.dir" "$bdir" >/dev/null 2>&1 || true
    local wired; wired="$(brain_remote_url "$bdir" 2>/dev/null || true)"
    if [ -n "$wired" ]; then
      myai_config_set "brain.remote" "$wired" >/dev/null 2>&1 || true
      echo "myai: created brain at $bdir + wired private remote — recorded in $(myai_config_path)"
    else
      echo "myai: created local brain at $bdir (no remote) — recorded in $(myai_config_path)"
    fi
  else
    echo "myai: WARN — could not create the brain at $bdir; run 'myai brain init' manually" >&2
  fi
  return 0
}
