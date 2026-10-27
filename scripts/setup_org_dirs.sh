#!/usr/bin/env bash
# setup_org_dirs.sh — Multi-Org-Auth Phase 1: create per-org config dirs + install aliases.
#
# Usage: setup_org_dirs.sh [--dry-run] [--aliases-only] [<name>…]
#
# Creates ~/.claude-<name> for each profile name (the bare default ~/.claude is
# always managed) and appends a `claude-<name>` launcher per profile to ~/.zshrc
# inside a marked, idempotent block. Names: the arguments, else MYAI_PROFILES
# (the operator defaults file, scripts/lib/operator_defaults.sh), else the
# ~/.claude-* dirs already on this Mac; none → only ~/.claude (v1 G6 P4). It does NOT log you in — auth is a one-time browser step you
# run per alias afterwards (the script prints the exact commands).
#
# Safe to re-run: dirs are created only if missing; the alias block is replaced
# in place (never duplicated). Use --dry-run to preview.
#
# --aliases-only re-applies ONLY the ~/.zshrc alias block (section 2), backing up
# ~/.zshrc first and leaving the per-org dirs (1), statusline (3) and live-
# messaging hook (4) steps untouched. The boot auto-repair (boot_sync.sh /
# morning_boot.sh) calls it when it finds a STALE block — the managed marker
# present but the _claude_labelled wrapper missing, the state every Mac was left
# in when this installer died under bash 3.2 before writing (fixed a84bf984).
#
# bash 3.2-safe. See documentation/MULTI_ORG_WORKFLOW.md + plan/MULTI_ORG_AUTH.md.
set -euo pipefail

DRY_RUN=0
ALIASES_ONLY=0
NAME_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --aliases-only) ALIASES_ONLY=1 ;;
    -h|--help)      sed -n '2,27p' "$0"; exit 0 ;;
    -*) echo "setup_org_dirs: unknown argument: $arg" >&2; exit 2 ;;
    *) NAME_ARGS+=("$arg") ;;
  esac
done

ZSHRC="$HOME/.zshrc"
BEGIN="# >>> claude multi-org aliases (managed by setup_org_dirs.sh) >>>"
END="# <<< claude multi-org aliases <<<"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/operator_defaults.sh
. "$SCRIPT_DIR/lib/operator_defaults.sh"
# shellcheck source=scripts/lib/swarm_roles.sh
. "$SCRIPT_DIR/lib/swarm_roles.sh"
operator_defaults_load "$SCRIPT_DIR/.."
NAMES=()
if [ "${#NAME_ARGS[@]}" -gt 0 ]; then
  while IFS= read -r _n; do NAMES+=("$_n"); done < <(role_valid_names "${NAME_ARGS[@]}")
else
  while IFS= read -r _n; do NAMES+=("$_n"); done < <(role_profile_names)
fi
unset _n
PROFILE_DIRS=()
for _n in "${NAMES[@]+"${NAMES[@]}"}"; do PROFILE_DIRS+=("$HOME/.claude-$_n"); done
unset _n
STATUSLINE_SRC="$SCRIPT_DIR/org-statusline.sh"
STATUSLINE_DEST="$HOME/.claude-org-statusline.sh"

say()  { printf '%s\n' "$*"; }
# Run a command, or print it under --dry-run. No eval — args are passed through
# verbatim so there is never a shell-injection surface on this fleet-wide script.
do_it() { if [ "$DRY_RUN" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi; }

say "== Multi-Org-Auth Phase 1 setup =="
[ "$DRY_RUN" = "1" ] && say "(dry-run — no changes will be made)"

# --- 1. Config dirs --------------------------------------------------------
# Skipped under --aliases-only: the boot auto-repair only needs the ~/.zshrc
# alias block refreshed, not the per-org dirs re-created.
if [ "$ALIASES_ONLY" != 1 ]; then
  say ""
  say "1. Per-org config dirs:"
  [ "${#PROFILE_DIRS[@]}" -gt 0 ] || say "   none named — only the bare default ~/.claude"
  for d in "${PROFILE_DIRS[@]+"${PROFILE_DIRS[@]}"}"; do
    if [ -d "$d" ]; then
      say "   exists: $d"
    else
      do_it mkdir -p "$d"
      say "   created: $d"
    fi
  done
fi

# --- 2. Aliases in ~/.zshrc (idempotent marked block) ----------------------
say ""
say "2. Shell aliases in $ZSHRC:"

# Every interactive launch is named "<DEVICE> - <repo>" (`claude -n`), the same
# label remote_fleet.sh gives its doorways. WHY: the phone's Code list titles a
# nameless session from its first prompt and never shows the device, so hand-
# started sessions on two Macs were indistinguishable (and a session cannot be
# renamed once live). -n goes LAST: session_label_of_pid reads to end of line.
# No label for resume/continue/print, an explicit name, or a subcommand.
# EVERY launcher — each claude-<name> AND the bare `claude` — passes
# --dangerously-skip-permissions (operator directive 2026-10-02: every session
# starts in bypass) — not for a subcommand or --help/--version, and never twice.
# The bare wrapper used to be skipped (`[ -n "$dir" ]`), so every refresh left
# plain `claude` prompting (home Mac, 2026-10-19). The `bypass-v2` stamp below is
# what boot_sync.sh checks to tell a current block from an older one.
# Read via a TOP-LEVEL heredoc: bash 3.2 (macOS /bin/bash) expands $vars inside
# a quoted heredoc nested in "$(cat <<'X' …)", so `set -u` died on $repo and the
# block was never written on any Mac (sessions stayed auto-named 'ai-55').
IFS= read -r -d '' BODY <<'ZSH' || true
_claude_labelled() {
  local dir="$1"; shift
  local a label=1 bypass=1 repo
  for a in "$@"; do
    case "$a" in
      -h|--help|-v|--version) label=0; bypass=0 ;;
      --dangerously-skip-permissions|--permission-mode|--permission-mode=*) bypass=0 ;;
      -n|--name|--name=*|-r|--resume|--resume=*|-c|--continue|-p|--print) label=0 ;;
    esac
  done
  case "${1:-}" in
    mcp|config|update|doctor|install|setup-token|plugin|plugins|migrate-installer|auth|agents) label=0; bypass=0 ;;
  esac
  [ "$bypass" = 1 ] && set -- --dangerously-skip-permissions "$@"
  if [ "$label" = 1 ]; then
    repo="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
    set -- "$@" -n "${REMOTE_FLEET_DEVICE:-$(hostname -s)} - $repo"
  fi
  if [ -n "$dir" ]; then CLAUDE_CONFIG_DIR="$dir" command claude "$@"; else command claude "$@"; fi
}
ZSH
# The per-profile launchers are generated from NAMES (validated [a-z0-9_-]).
UNALIAS="claude"; FUNCS=""
for _n in "${NAMES[@]+"${NAMES[@]}"}"; do
  UNALIAS="$UNALIAS claude-$_n"
  FUNCS="${FUNCS}claude-$_n() { _claude_labelled ~/.claude-$_n \"\$@\"; }
"
done
unset _n
BLOCK="$BEGIN
# bypass-v2: every launcher incl. bare claude starts in bypass (boot_sync stamp)
for _a in $UNALIAS; do unalias \"\$_a\" 2>/dev/null || true; done; unset _a
${BODY%$'\n'}
${FUNCS}claude() { _claude_labelled \"\" \"\$@\"; }  # bare default (~/.claude)
$END"

# Under --aliases-only (the unattended boot auto-repair path) back up ~/.zshrc
# before rewriting the block, so a bad refresh is always recoverable. If the
# backup cannot be written, refuse to mutate ~/.zshrc rather than risk it.
if [ "$ALIASES_ONLY" = 1 ] && [ -f "$ZSHRC" ]; then
  BAK="$ZSHRC.claude-aliases.$(date +%Y%m%d%H%M%S).bak"
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] would back up $ZSHRC -> $BAK"
  elif cp "$ZSHRC" "$BAK"; then
    say "   backed up $ZSHRC -> $BAK"
  else
    echo "setup_org_dirs: backup of $ZSHRC failed ($BAK) — refusing to rewrite alias block" >&2
    exit 1
  fi
fi

if [ -f "$ZSHRC" ] && grep -qF "$BEGIN" "$ZSHRC" 2>/dev/null; then
  # Replace the existing block in place.
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] would refresh existing alias block"
  else
    tmp=$(mktemp)
    awk -v b="$BEGIN" -v e="$END" '
      $0==b {skip=1; next}
      $0==e {skip=0; next}
      skip!=1 {print}
    ' "$ZSHRC" > "$tmp"
    printf '%s\n' "$BLOCK" >> "$tmp"
    # Preserve the original file mode — mktemp defaults to 0600, and silently
    # tightening a user dotfile (or a shared rc) on every refresh is surprising.
    chmod --reference="$ZSHRC" "$tmp" 2>/dev/null \
      || { perms=$(stat -f '%Lp' "$ZSHRC" 2>/dev/null) && [ -n "$perms" ] && chmod "$perms" "$tmp"; }
    mv "$tmp" "$ZSHRC"
    say "   refreshed existing alias block"
  fi
else
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] would append alias block to $ZSHRC"
  else
    printf '\n%s\n' "$BLOCK" >> "$ZSHRC"
    say "   appended alias block"
  fi
fi

# --- aliases-only short-circuit --------------------------------------------
# The boot auto-repair (boot_sync.sh / morning_boot.sh) calls this with
# --aliases-only once the ~/.zshrc block is detected stale: only the alias block
# above needs refreshing. The statusline (3) and live-messaging hook (4) steps
# touch every profile's settings.json and are deliberately NOT re-applied here.
if [ "$ALIASES_ONLY" = 1 ]; then
  say ""
  say "(--aliases-only) done — statusline + live-messaging hook steps skipped."
  exit 0
fi

# --- 3. Org statusline (always-visible active-org indicator) ---------------
# Installs the statusline script to a stable home path (independent of any
# config dir) and registers it as `statusLine` in EACH profile's settings.json,
# so every session in every repo shows which org is active, in colour.
say ""
say "3. Org statusline in each profile's settings.json:"
if [ ! -f "$STATUSLINE_SRC" ]; then
  say "   skipped — source not found: $STATUSLINE_SRC"
else
  do_it cp "$STATUSLINE_SRC" "$STATUSLINE_DEST"
  do_it chmod +x "$STATUSLINE_DEST"
  [ "$DRY_RUN" = "1" ] || say "   installed: $STATUSLINE_DEST"
  for cfg in "$HOME/.claude" "${PROFILE_DIRS[@]+"${PROFILE_DIRS[@]}"}"; do
    settings="$cfg/settings.json"
    if [ "$DRY_RUN" = "1" ]; then
      say "   [dry-run] would register statusLine in $settings"
      continue
    fi
    [ -d "$cfg" ] || mkdir -p "$cfg"
    # Idempotent JSON merge — set only the statusLine key, preserve everything else.
    if STATUSLINE_DEST="$STATUSLINE_DEST" SETTINGS="$settings" python3 - <<'PY'
import json, os, sys
settings = os.environ["SETTINGS"]
dest = os.environ["STATUSLINE_DEST"]
# {} only for a MISSING file; an existing file that won't parse or isn't an
# object is left byte-for-byte untouched (exit 2 → the caller WARNs).
if os.path.exists(settings):
    try:
        with open(settings) as f:
            data = json.load(f)
    except Exception as e:
        print("unparseable (%s)" % e.__class__.__name__); sys.exit(2)
    if not isinstance(data, dict):
        print("not a JSON object"); sys.exit(2)
else:
    data = {}
data["statusLine"] = {"type": "command", "command": dest, "padding": 0}
tmp = settings + ".tmp-%d" % os.getpid()
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, settings)
PY
    then
      say "   registered: $settings"
    else
      say "   WARN: left $settings untouched — it exists but is not a valid JSON object; fix it by hand, then re-run"
    fi
  done
fi

# --- 4. Live cross-session messaging hooks (task-d759dd15) -----------------
# Two profiles on different accounts running side by side on ONE Mac can't
# SendMessage across accounts, but the mailbox is account-independent. These
# hooks make a message land LIVE in whichever profile is open:
#   • mail-live.sh — a throttled mail_inbox poll on UserPromptSubmit + PostToolUse
#     that injects new mail into context (so a long-open session sees mail that
#     arrived after boot, not just at boot).
#   • 36-live-session-registry.sh — writes this session's tmux pane into the
#     live-session registry at SessionStart so `tell <label>` / session_ping.sh
#     can wake it.
#   • 37-arm-mail-watch.sh — SessionStart banner that ARMS the idle mail watcher
#     (scripts/mail_watch.sh) — the third delivery layer that wakes an IDLE
#     session (the mail-live hook only covers a BUSY one). Suppressed in per-task
#     runner workspaces (they read mail at claim).
#   • swarm-worker-role.sh (via the ~/.claude-swarm-worker-role.sh wrapper) —
#     SessionStart + UserPromptSubmit: while a swarm runs, every non-master
#     session is told who the master is and where to report. Registered per
#     PROFILE so it fires in EVERY repo (2026-10-26: AZURE/WEBSITE/foh sessions
#     never knew the master; the hook lived only in the swarm repo's settings).
#     The wrapper execs the framework's own copy (it needs scripts/lib) and is
#     silent in a repo that registers the hook itself, so nothing fires twice.
# They are ALSO registered in each repo's own .claude/settings.json (propagated
# by update_all.sh); installing them per-PROFILE here guarantees they fire in
# every account lane even in a repo not yet updated. The double registration is
# throttle-/upsert-safe: mail-live shares one ~60s cache keyed by the address
# set (the second fire is a silent no-op), and the registry write is an
# idempotent upsert by pid.
say ""
say "4. Live-messaging hooks in each profile's settings.json:"
MAILLIVE_SRC="$SCRIPT_DIR/../hooks/mail-live.sh"
MAILLIVE_DEST="$HOME/.claude-mail-live.sh"
REGISTRY_SRC="$SCRIPT_DIR/../hooks/session/36-live-session-registry.sh"
REGISTRY_DEST="$HOME/.claude-live-session-registry.sh"
ARMWATCH_SRC="$SCRIPT_DIR/../hooks/session/37-arm-mail-watch.sh"
ARMWATCH_DEST="$HOME/.claude-arm-mail-watch.sh"
ROLE_DEST="$HOME/.claude-swarm-worker-role.sh"
# The framework checkout the wrapper points at: the MAIN checkout when this
# runs from a linked worktree (a lane/runner worktree is deleted later).
FW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
_common="$(git -C "$FW_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$_common" ] && [ -f "$(dirname "$_common")/hooks/swarm-worker-role.sh" ]; then FW_ROOT="$(dirname "$_common")"; fi
unset _common
ROLE_SRC="$FW_ROOT/hooks/swarm-worker-role.sh"
if [ ! -f "$MAILLIVE_SRC" ] || [ ! -f "$REGISTRY_SRC" ] || [ ! -f "$ARMWATCH_SRC" ]; then
  say "   skipped — hook source(s) not found next to this script"
else
  do_it cp "$MAILLIVE_SRC" "$MAILLIVE_DEST"
  do_it chmod +x "$MAILLIVE_DEST"
  do_it cp "$REGISTRY_SRC" "$REGISTRY_DEST"
  do_it chmod +x "$REGISTRY_DEST"
  do_it cp "$ARMWATCH_SRC" "$ARMWATCH_DEST"
  do_it chmod +x "$ARMWATCH_DEST"
  if [ -f "$ROLE_SRC" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      say "  [dry-run] would write $ROLE_DEST (-> $ROLE_SRC)"
    else
      {
        printf '%s\n' '#!/usr/bin/env bash' \
          '# Managed by setup_org_dirs.sh — runs the framework swarm worker-role hook in' \
          '# EVERY repo (names the swarm master at session start). Silent when this' \
          '# repo registers the hook itself, or when the framework has moved.'
        printf 'H=%q\n' "$ROLE_SRC"
        # shellcheck disable=SC2016  # the wrapper's own text: $H/$top expand when IT runs
        printf '%s\n' '[ -f "$H" ] || exit 0' \
          'top="$(git rev-parse --show-toplevel 2>/dev/null)"' \
          '[ -n "$top" ] && [ -f "$top/hooks/swarm-worker-role.sh" ] && exit 0' \
          'exec bash "$H" "$@"'
      } > "$ROLE_DEST"
      chmod +x "$ROLE_DEST"
    fi
  fi
  [ "$DRY_RUN" = "1" ] || say "   installed: $MAILLIVE_DEST, $REGISTRY_DEST, $ARMWATCH_DEST${ROLE_SRC:+, $ROLE_DEST}"
  for cfg in "$HOME/.claude" "${PROFILE_DIRS[@]+"${PROFILE_DIRS[@]}"}"; do
    settings="$cfg/settings.json"
    if [ "$DRY_RUN" = "1" ]; then
      say "   [dry-run] would register mail-live + registry + arm-mail-watch + swarm-worker-role hooks in $settings"
      continue
    fi
    [ -d "$cfg" ] || mkdir -p "$cfg"
    _role=""; [ -f "$ROLE_DEST" ] && _role="$ROLE_DEST"
    if MAILLIVE_DEST="$MAILLIVE_DEST" REGISTRY_DEST="$REGISTRY_DEST" ARMWATCH_DEST="$ARMWATCH_DEST" ROLE_DEST="$_role" SETTINGS="$settings" python3 - <<'PY'
import json, os, sys
settings = os.environ["SETTINGS"]
mail = os.environ["MAILLIVE_DEST"]
reg = os.environ["REGISTRY_DEST"]
arm = os.environ["ARMWATCH_DEST"]
# {} only for a MISSING file; an existing file that won't parse or isn't an
# object is left byte-for-byte untouched (exit 2 → the caller WARNs).
if os.path.exists(settings):
    try:
        with open(settings) as f:
            data = json.load(f)
    except Exception as e:
        print("unparseable (%s)" % e.__class__.__name__); sys.exit(2)
    if not isinstance(data, dict):
        print("not a JSON object"); sys.exit(2)
else:
    data = {}
hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = data["hooks"] = {}

def ensure(event, command, timeout):
    """Idempotently add {command} to the matcher:"" group of {event}."""
    groups = hooks.setdefault(event, [])
    if not isinstance(groups, list):
        groups = hooks[event] = []
    grp = None
    for g in groups:
        if isinstance(g, dict) and g.get("matcher", "") == "":
            grp = g
            break
    if grp is None:
        grp = {"matcher": "", "hooks": []}
        groups.append(grp)
    hlist = grp.setdefault("hooks", [])
    if any(isinstance(h, dict) and h.get("command") == command for h in hlist):
        return
    hlist.append({"type": "command", "command": command, "timeout": timeout})

ensure("UserPromptSubmit", mail, 6000)
ensure("PostToolUse", mail, 6000)
ensure("SessionStart", reg, 5000)
ensure("SessionStart", arm, 5000)
role = os.environ.get("ROLE_DEST", "")
if role:
    ensure("SessionStart", role + " SessionStart", 5000)
    ensure("UserPromptSubmit", role + " UserPromptSubmit", 5000)

tmp = settings + ".tmp-%d" % os.getpid()
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, settings)
PY
    then
      say "   registered: $settings"
    else
      say "   WARN: left $settings untouched — it exists but is not a valid JSON object; fix it by hand, then re-run"
    fi
  done
fi

# --- 5. Bypass without the confirmation prompt -------------------------------
# Every launcher passes --dangerously-skip-permissions (step 2); without
# skipDangerousModePermissionPrompt each profile still stops on a confirmation
# screen at launch, which an unattended doorway can't answer (one profile was
# missing it, 2026-10-19). Idempotent merge — only that key is touched.
say "5. Bypass-prompt suppression in each profile's settings.json:"
for cfg in "$HOME/.claude" "${PROFILE_DIRS[@]+"${PROFILE_DIRS[@]}"}"; do
  settings="$cfg/settings.json"
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] would set skipDangerousModePermissionPrompt=true in $settings"
    continue
  fi
  [ -d "$cfg" ] || mkdir -p "$cfg"
  # Start from {} ONLY when the file does not exist. A file that exists but
  # won't parse (comments, trailing comma, a partial write) or isn't an object
  # is left byte-for-byte untouched with a WARN — rewriting it would wipe the
  # profile's statusLine/permissions/hooks. Written atomically (tmp + replace).
  if SETTINGS="$settings" python3 - <<'PY'
import json, os, sys
settings = os.environ["SETTINGS"]
if os.path.exists(settings):
    try:
        with open(settings) as f:
            data = json.load(f)
    except Exception as e:
        print("unparseable (%s)" % e.__class__.__name__); sys.exit(2)
    if not isinstance(data, dict):
        print("not a JSON object"); sys.exit(2)
else:
    data = {}
if data.get("skipDangerousModePermissionPrompt") is not True:
    data["skipDangerousModePermissionPrompt"] = True
    tmp = settings + ".tmp-%d" % os.getpid()
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, settings)
PY
  then
    say "   ensured: $settings"
  else
    say "   WARN: left $settings untouched — it exists but is not a valid JSON object; fix it by hand, then re-run"
  fi
done

# --- 6. Next steps ---------------------------------------------------------
say ""
say "== Next steps (one-time, you run these) =="
say "   source ~/.zshrc        # load the new aliases into this shell"
for _n in "${NAMES[@]+"${NAMES[@]}"}"; do
  say "   claude-$_n   # /login -> pick the account for this profile"
done
say "   claude                 # bare default (whichever account is primary)"
say ""
say "Every session now shows the active org in its statusline (colour-coded)."
say "Map repos to orgs in config/repo_org_map.txt so the session hook can guard"
say "against mismatches."
