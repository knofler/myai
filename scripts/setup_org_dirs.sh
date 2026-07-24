#!/usr/bin/env bash
# setup_org_dirs.sh — Multi-Org-Auth Phase 1: create per-org config dirs + install aliases.
#
# Creates ~/.claude-museum and ~/.claude-tech (the personal default ~/.claude
# already exists) and appends shell aliases to ~/.zshrc inside a marked,
# idempotent block. It does NOT log you in — auth is a one-time browser step you
# run per alias afterwards (the script prints the exact commands).
#
# Safe to re-run: dirs are created only if missing; the alias block is replaced
# in place (never duplicated). Use --dry-run to preview.
#
# bash 3.2-safe. See documentation/MULTI_ORG_WORKFLOW.md + plan/MULTI_ORG_AUTH.md.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ZSHRC="$HOME/.zshrc"
BEGIN="# >>> claude multi-org aliases (managed by setup_org_dirs.sh) >>>"
END="# <<< claude multi-org aliases <<<"

MUSEUM_DIR="$HOME/.claude-museum"
TECH_DIR="$HOME/.claude-tech"
PERSONAL_DIR="$HOME/.claude-personal"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUSLINE_SRC="$SCRIPT_DIR/org-statusline.sh"
STATUSLINE_DEST="$HOME/.claude-org-statusline.sh"

say()  { printf '%s\n' "$*"; }
# Run a command, or print it under --dry-run. No eval — args are passed through
# verbatim so there is never a shell-injection surface on this fleet-wide script.
do_it() { if [ "$DRY_RUN" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi; }

say "== Multi-Org-Auth Phase 1 setup =="
[ "$DRY_RUN" = "1" ] && say "(dry-run — no changes will be made)"

# --- 1. Config dirs --------------------------------------------------------
say ""
say "1. Per-org config dirs:"
for d in "$MUSEUM_DIR" "$TECH_DIR" "$PERSONAL_DIR"; do
  if [ -d "$d" ]; then
    say "   exists: $d"
  else
    do_it mkdir -p "$d"
    say "   created: $d"
  fi
done

# --- 2. Aliases in ~/.zshrc (idempotent marked block) ----------------------
say ""
say "2. Shell aliases in $ZSHRC:"

BLOCK="$BEGIN
alias claude-museum='CLAUDE_CONFIG_DIR=~/.claude-museum claude'       # Powerhouse Museum (Enterprise)
alias claude-tech='CLAUDE_CONFIG_DIR=~/.claude-tech claude'           # Powerhouse Technology (Team)
alias claude-personal='CLAUDE_CONFIG_DIR=~/.claude-personal claude'   # personal account (pinned)
# 'claude' stays the bare default (~/.claude) — reflects whichever account is primary
$END"

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
  for cfg in "$HOME/.claude" "$MUSEUM_DIR" "$TECH_DIR" "$PERSONAL_DIR"; do
    settings="$cfg/settings.json"
    if [ "$DRY_RUN" = "1" ]; then
      say "   [dry-run] would register statusLine in $settings"
      continue
    fi
    [ -d "$cfg" ] || mkdir -p "$cfg"
    # Idempotent JSON merge — set only the statusLine key, preserve everything else.
    STATUSLINE_DEST="$STATUSLINE_DEST" SETTINGS="$settings" python3 - <<'PY'
import json, os
settings = os.environ["SETTINGS"]
dest = os.environ["STATUSLINE_DEST"]
try:
    with open(settings) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
data["statusLine"] = {"type": "command", "command": dest, "padding": 0}
with open(settings, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    say "   registered: $settings"
  done
fi

# --- 4. Next steps ---------------------------------------------------------
say ""
say "== Next steps (one-time, you run these) =="
say "   source ~/.zshrc        # load the new aliases into this shell"
say "   claude-museum          # /login -> pick Powerhouse Museum (Enterprise)"
say "   claude-tech            # /login -> pick Powerhouse Technology (Team)"
say "   claude-personal        # /login -> pick your personal account (pinned)"
say "   claude                 # bare default (whichever account is primary)"
say ""
say "Every session now shows the active org in its statusline (colour-coded)."
say "Map repos to orgs in config/repo_org_map.txt so the session hook can guard"
say "against mismatches."
