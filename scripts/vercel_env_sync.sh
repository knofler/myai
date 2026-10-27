#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  vercel_env_sync.sh — set an env var to the SAME value across EVERY Vercel
#  target a project has: production, preview, development AND every CUSTOM
#  environment (e.g. foh's "test").
#
#  WHY THIS EXISTS (incident foh, mail-21cde25c, 2026-10-02): foh deploys its
#  `test` branch to a *custom* Vercel environment literally named "test" (not
#  Preview). An agent rotated CONTENT_API_KEY but only updated Production +
#  Preview — the custom "test" env kept the STALE key, so every gateway route
#  on the test deployment returned 401. "Update Preview" is not "update every
#  target". This helper enumerates ALL targets and writes the var to each, so a
#  custom environment can never be silently skipped again.
#
#  AGENT-DRIVEN + VALUE NEVER READ: the agent runs THIS script with only the
#  var NAME. The script reads the value out of the repo's env file itself and
#  PIPES it to `vercel env add` over stdin — the value is never printed to
#  stdout/stderr, never echoed, never pasted into the agent's context. The
#  operator does not have to run any `vercel env` command by hand (foh: "you
#  should be able to do it, why i need to do that?").
#
#  USAGE
#    scripts/vercel_env_sync.sh [options] VAR [VAR ...]
#
#  OPTIONS
#    --env-file PATH      env file to read values from (default: <dir>/.env)
#    --project-dir DIR    the vercel-linked dir (has .vercel/project.json)
#                         (default: $VERCEL_ENV_SYNC_PROJECT_DIR or CWD)
#    --targets LIST       use EXACTLY these targets (comma/space list); skips
#                         discovery — escape hatch for odd setups
#    --extra-targets LIST add these targets on top of the discovered set
#    --dry-run            print the plan (var names + targets, NEVER values);
#                         make no changes
#    -h | --help          this help
#
#  EXAMPLES
#    # sync one rotated secret to every target, value straight from .env
#    scripts/vercel_env_sync.sh CONTENT_API_KEY
#    # several vars, custom env file, dry run first
#    scripts/vercel_env_sync.sh --env-file AI/.env --dry-run CONTENT_API_KEY JWT_SECRET
#
#  FLEET-PORTABLE: pure bash + python3 + the `vercel` CLI. No gateway, no
#  Docker, no repo-specific paths. Drop it in any repo's scripts/ and it works.
#
#  Hermetic unit tests: scripts/tests/test_vercel_env_sync.sh (stubbed vercel).
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

# ── Pure helpers (also sourced by the test via VERCEL_ENV_SYNC_LIB_ONLY=1) ───

# The parser lives in a variable, not a heredoc fed to `python3 -`: the function
# needs STDIN for the piped `vercel env ls` output, so the program text must
# arrive via `-c` instead of competing for the same stdin. Single-quoted heredoc
# => the python `$`/regex bodies are never touched by the shell.
_ENV_LS_PARSE_PY="$(cat <<'PY'
import sys, re
TIME_AGO = re.compile(r'(\bago\b|just now|^\d{4}-\d{2}-\d{2})', re.I)
seen = []
for raw in sys.stdin:
    s = raw.strip()
    if not s:
        continue
    if s.startswith('>'):                       # "> Environment Variables found…"
        continue
    if s.lower().startswith('vercel cli'):
        continue
    cols = re.split(r'\s{2,}', s)
    if len(cols) < 2:
        continue
    low = [c.strip().lower() for c in cols]
    if 'environments' in low and 'name' in low:  # header row
        continue
    envcol = cols[-2] if TIME_AGO.search(cols[-1].strip()) else cols[-1]
    for tok in envcol.split(','):
        t = re.sub(r'\s*\(.*\)$', '', tok.strip()).strip().lower()  # drop "(branch)"
        if t and t not in seen:
            seen.append(t)
for t in seen:
    print(t)
PY
)"

# _env_ls_parse — read `vercel env ls` output on stdin, print every environment
# name it mentions (one per line, lowercased, deduped). Standard names
# (Production/Preview/Development) normalize to their lowercase target form;
# custom environments (e.g. "test") pass through as-is. Best-effort: columns are
# split on runs of 2+ spaces, the "created" (time-ago) column is detected and
# dropped, and the remaining environments column is comma-split. Callers always
# union this with the standard three, so a parse miss can only ADD work, never
# drop a standard target.
_env_ls_parse() { python3 -c "$_ENV_LS_PARSE_PY"; }

# env_file_value FILE KEY — print the value of KEY= from an env file on stdout
# (nothing else). Last assignment wins; `export ` prefix and one layer of
# surrounding single/double quotes are stripped; the value is NOT echoed to
# stderr or logged anywhere. Returns 1 if the file or key is missing.
env_file_value() {
  local file="$1" key="$2" line val
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -1)"
  [ -n "$line" ] || return 1
  val="${line#*"${key}="}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

# normalize_targets — read a comma/space/newline list on stdin, print one
# lowercased token per line, deduped, order preserved.
normalize_targets() {
  awk '{ gsub(/,/, " "); for (i = 1; i <= NF; i++) { t = tolower($i); if (!seen[t]++) print t } }'
}

# Everything below is the executable body — skipped when sourced for unit tests.
# shellcheck disable=SC2317  # body is reachable when run normally (guard off)
if [ -n "${VERCEL_ENV_SYNC_LIB_ONLY:-}" ]; then return 0 2>/dev/null || exit 0; fi

# ── Logging (var names + targets only — NEVER a value) ───────────────────────
log()  { printf '[vercel-env-sync] %s\n' "$*"; }
warn() { printf '[vercel-env-sync] WARN: %s\n' "$*" >&2; }
die()  { printf '[vercel-env-sync] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────────────
ENV_FILE=""
PROJECT_DIR="${VERCEL_ENV_SYNC_PROJECT_DIR:-$PWD}"
EXPLICIT_TARGETS=""
EXTRA_TARGETS=""
DRY_RUN=0
VARS=""

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)      ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --project-dir)   PROJECT_DIR="${2:?--project-dir needs a dir}"; shift 2 ;;
    --targets)       EXPLICIT_TARGETS="${2:?--targets needs a list}"; shift 2 ;;
    --extra-targets) EXTRA_TARGETS="${2:?--extra-targets needs a list}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    --) shift; while [ "$#" -gt 0 ]; do VARS="$VARS $1"; shift; done ;;
    -*) die "unknown option: $1" ;;
    *)  VARS="$VARS $1"; shift ;;
  esac
done

# strip leading space
VARS="${VARS# }"
[ -n "$VARS" ] || die "no variable name(s) given — usage: vercel_env_sync.sh [options] VAR [VAR ...]"

[ -d "$PROJECT_DIR" ] || die "project dir not found: $PROJECT_DIR"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
[ -n "$ENV_FILE" ] || ENV_FILE="$PROJECT_DIR/.env"

command -v vercel  >/dev/null 2>&1 || die "vercel CLI not installed/linked — cannot sync"
command -v python3 >/dev/null 2>&1 || die "python3 required for target discovery"
if [ ! -f "$PROJECT_DIR/.vercel/project.json" ] && [ -z "${VERCEL_PROJECT_ID:-}" ]; then
  die "no .vercel/project.json in $PROJECT_DIR (and no VERCEL_PROJECT_ID) — run 'vercel link' there first"
fi

# ── Resolve the full target set ──────────────────────────────────────────────
# Explicit --targets wins outright (escape hatch). Otherwise: the standard three
# ALWAYS, unioned with every custom environment discovered from `vercel env ls`,
# plus any --extra-targets. Discovery can only ever ADD a target.
resolve_targets() {
  if [ -n "$EXPLICIT_TARGETS" ]; then
    printf '%s' "$EXPLICIT_TARGETS" | normalize_targets
    return 0
  fi
  local discovered=""
  discovered="$( (cd "$PROJECT_DIR" && vercel env ls 2>/dev/null) | _env_ls_parse 2>/dev/null || true)"
  {
    printf 'production\npreview\ndevelopment\n'
    [ -n "$discovered" ]    && printf '%s\n' "$discovered"
    [ -n "$EXTRA_TARGETS" ] && printf '%s\n' "$EXTRA_TARGETS"
  } | normalize_targets
}

TARGETS="$(resolve_targets)"
[ -n "$TARGETS" ] || die "could not resolve any Vercel targets"

TARGET_LINE="$(printf '%s' "$TARGETS" | tr '\n' ' ')"
log "project dir : $PROJECT_DIR"
log "env file    : $ENV_FILE"
log "targets     : ${TARGET_LINE% }"
[ "$DRY_RUN" = "1" ] && log "DRY RUN — no changes will be made"

# ── Set one var into one target (value arrives on stdin; never printed) ───────
set_one() {
  local var="$1" target="$2"
  # rm reads from /dev/null so it can NEVER consume the value piped in for add
  # (add must receive it on stdin). rm failing (var absent) is fine — add re-creates.
  ( cd "$PROJECT_DIR" && vercel env rm "$var" "$target" -y </dev/null ) >/dev/null 2>&1 || true
  ( cd "$PROJECT_DIR" && vercel env add "$var" "$target" ) >/dev/null 2>&1
}

# ── Sync loop ────────────────────────────────────────────────────────────────
rc=0
for var in $VARS; do
  if ! value="$(env_file_value "$ENV_FILE" "$var")"; then
    warn "$var not found in $ENV_FILE — skipping (nothing to sync)"
    rc=1
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "would set $var in: ${TARGET_LINE% }"
    continue
  fi
  ok_targets="" bad_targets=""
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    if printf '%s' "$value" | set_one "$var" "$target"; then
      ok_targets="$ok_targets $target"
    else
      bad_targets="$bad_targets $target"
    fi
  done <<EOF
$TARGETS
EOF
  if [ -n "$bad_targets" ]; then
    warn "$var — failed on:${bad_targets} (ok:${ok_targets:- none})"
    rc=1
  else
    log "$var — synced to all targets:${ok_targets}"
  fi
  unset value
done

if [ "$rc" -ne 0 ]; then
  warn "finished with issues (see WARN lines above)"
elif [ "$DRY_RUN" = "1" ]; then
  log "dry run complete — nothing changed"
else
  log "done — all requested vars synced to every target"
fi
exit "$rc"
