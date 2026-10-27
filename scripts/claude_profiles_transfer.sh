#!/usr/bin/env bash
# claude_profiles_transfer.sh — carry the Claude Code profiles (every named
# ~/.claude-<name> plus the bare default) from one Mac to another, and keep
# Remote Control on.
#
# WHY THIS EXISTS: the workspace rides Dropbox, so the repo and its .env arrive
# on a new Mac by themselves — but the per-org CLAUDE_CONFIG_DIRs live in $HOME
# (~/.claude-<name>) and nothing moved them.
# setup_org_dirs.sh creates them EMPTY: no settings, no auto-memory, no plugins,
# no Remote Control. A machine swap then quietly loses every learned preference
# and the phone doorway stops working until someone remembers the setting.
#
# WHAT MOVES (whitelist — anything not named here stays behind):
#   settings.json settings.local.json CLAUDE.md keybindings.json
#   agents/ commands/ skills/ hooks/ output-styles/ plugins/
#   projects/*/memory/                       (auto-memory only, not transcripts)
#   .claude.json -> mcpServers               (user-scope MCP servers only)
# WHAT NEVER MOVES: logins (Keychain / .credentials.json), history, sessions,
# transcripts, caches, telemetry. Each profile is /login'd once on the new Mac.
#
# The bundle is written OUTSIDE git, next to the repo in the Dropbox workspace
# (../.machine-transfer/), so it syncs to the new Mac without ever being
# committed. It holds no credentials, but it does hold your settings and
# memory — treat it as personal.
#
# Usage:
#   ./scripts/claude_profiles_transfer.sh export [--out DIR] [--dry-run]
#   ./scripts/claude_profiles_transfer.sh import [BUNDLE] [--force] [--dry-run]
#   ./scripts/claude_profiles_transfer.sh remote-control [--dry-run]
#   ./scripts/claude_profiles_transfer.sh status
#
# import with no BUNDLE takes the newest bundle in the transfer dir. A bundle
# already imported into a profile is skipped (marker .imported-bundle) unless
# --force; whatever an import replaces is first moved to <profile>/.pre-import-<ts>/.
# Paths under the old $HOME are rewritten to the new $HOME, including the
# auto-memory project slugs, so a different username still lands correctly.
# import always finishes by enforcing Remote Control (remoteControlAtStartup).
#
# bash 3.2-safe. Needs python3 (Xcode CLT). Tests: scripts/tests/test_claude_profiles_transfer.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "$HERE/.." && pwd)"
MANIFEST="$REPO_DIR/config/machine_manifest.txt"
TRANSFER_DIR="${MYAI_TRANSFER_DIR:-$(dirname "$REPO_DIR")/.machine-transfer}"
PY="${PYTHON:-python3}"

ITEMS="settings.json settings.local.json CLAUDE.md keybindings.json agents commands skills hooks output-styles plugins"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*"; }
die()  { printf 'claude_profiles_transfer: %s\n' "$*" >&2; exit 1; }

# Profile dirs from the manifest's [claude_profile] section (alias|dir|label),
# ~ expanded against the CURRENT $HOME. Falls back to ~/.claude plus the named
# profiles (swarm_roles.sh role_profile_names: MYAI_PROFILES from the operator
# defaults file, else the ~/.claude-* dirs on disk — v1 G6 P4).
profile_dirs() {
  local out=""
  if [ -f "$MANIFEST" ]; then
    out="$(awk '
      /^\[/ { sec = substr($0, 2, index($0,"]")-2); next }
      sec == "claude_profile" && $0 !~ /^[ \t]*(#|$)/ { split($0, f, "|"); print f[2] }
    ' "$MANIFEST")"
  fi
  if [ -z "$out" ]; then
    printf '%s\n' "$HOME/.claude"
    # shellcheck disable=SC1091  # resolved at run time from $HERE
    ( . "$HERE/lib/operator_defaults.sh" && . "$HERE/lib/swarm_roles.sh" \
        && operator_defaults_load "$REPO_DIR" && role_profile_names ) 2>/dev/null \
      | while IFS= read -r n; do printf '%s\n' "$HOME/.claude-$n"; done
    return 0
  fi
  printf '%s\n' "$out" | sed "s#^~#$HOME#"
}

# The bare default profile keeps its .claude.json in $HOME; a CLAUDE_CONFIG_DIR
# profile keeps it inside the dir.
claude_json_for() {
  if [ "$1" = "$HOME/.claude" ]; then printf '%s\n' "$HOME/.claude.json"; else printf '%s\n' "$1/.claude.json"; fi
}

# ── export ───────────────────────────────────────────────────────────────────
do_export() {
  local out="$TRANSFER_DIR" dry=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) out="${2:-}"; shift ;;
      --dry-run) dry=1 ;;
      *) die "export: unknown option $1" ;;
    esac
    shift
  done
  local stamp host bundle dir name it found cj mem
  stamp="$(date +%Y%m%d-%H%M%S)"; host="$(hostname -s)"
  bundle="$out/claude-profiles-$host-$stamp.tar.gz"
  stage="$(mktemp -d -t claude-profiles.XXXXXX)"; TMPDIRS="$stage"
  trap 'rm -rf $TMPDIRS' EXIT
  mkdir -p "$stage/profiles"
  say "export: $host -> $bundle"
  found=0
  while read -r dir; do
    [ -d "$dir" ] || { warn "$dir absent — skipped"; continue; }
    name="$(basename "$dir")"; found=$((found+1))
    mkdir -p "$stage/profiles/$name"
    for it in $ITEMS; do
      [ -e "$dir/$it" ] || continue
      (cd "$dir" && tar -cf - "$it") | (cd "$stage/profiles/$name" && tar -xf -)
    done
    # Auto-memory only — transcripts are hundreds of MB and machine-local.
    if [ -d "$dir/projects" ]; then
      (cd "$dir" && find projects -mindepth 2 -maxdepth 2 -type d -name memory) | while read -r mem; do
        (cd "$dir" && tar -cf - "$mem") | (cd "$stage/profiles/$name" && tar -xf -)
      done
    fi
    cj="$(claude_json_for "$dir")"
    if [ -f "$cj" ]; then
      "$PY" - "$cj" "$stage/profiles/$name/.claude-portable.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
json.dump({"mcpServers": d.get("mcpServers", {}) or {}}, open(sys.argv[2], "w"), indent=2)
PY
    fi
    # Belt and braces: the whitelist never names these, but a plugin or skill
    # dir could carry one in. Credentials never leave the machine.
    find "$stage/profiles/$name" \( -name '.credentials.json' -o -name 'credentials.json' -o -name '*.pem' \) -exec rm -f {} + 2>/dev/null
    ok "$name ($(find "$stage/profiles/$name" -path '*/memory' -type d | wc -l | tr -d ' ') memory dir(s), remoteControlAtStartup=$(json_get "$dir/settings.json" remoteControlAtStartup))"
  done <<EOF
$(profile_dirs)
EOF
  [ "$found" -gt 0 ] || die "no profile dirs found under $HOME"
  printf 'OLD_HOME=%s\nHOST=%s\nCREATED=%s\n' "$HOME" "$host" "$stamp" > "$stage/BUNDLE_INFO"
  if [ "$dry" = "1" ]; then
    say "  [dry-run] would write $bundle ($(du -sh "$stage" | awk '{print $1}') uncompressed)"
    return 0
  fi
  mkdir -p "$out" || die "cannot create $out"
  (cd "$stage" && tar -czf "$bundle" BUNDLE_INFO profiles) || die "tar failed"
  chmod 600 "$bundle"
  say "  wrote $bundle ($(du -h "$bundle" | awk '{print $1}'))"
  say "  On the new Mac, once Dropbox has synced: ./scripts/bootstrap_mac.sh   (the 'profiles' stage imports it)"
}

json_get() {  # json_get <file> <key>  -> value or "unset"
  [ -f "$1" ] || { printf 'unset'; return 0; }
  "$PY" - "$1" "$2" <<'PY' 2>/dev/null || printf 'unset'
import json, sys
try:
    v = json.load(open(sys.argv[1])).get(sys.argv[2], "unset")
except Exception:
    v = "unset"
print(str(v).lower() if isinstance(v, bool) else v, end="")
PY
}

# ── remote-control ───────────────────────────────────────────────────────────
do_remote_control() {
  local dry=0 dir
  [ "${1:-}" = "--dry-run" ] && dry=1
  while read -r dir; do
    [ -d "$dir" ] || continue
    if [ "$(json_get "$dir/settings.json" remoteControlAtStartup)" = "true" ]; then
      ok "remote control on: $dir"; continue
    fi
    if [ "$dry" = "1" ]; then say "  [dry-run] set remoteControlAtStartup=true in $dir/settings.json"; continue; fi
    "$PY" - "$dir/settings.json" <<'PY' || { warn "could not update $dir/settings.json"; continue; }
import json, os, sys
p = sys.argv[1]
d = {}
if os.path.exists(p):
    try:
        d = json.load(open(p))
    except Exception:
        sys.exit("unparseable JSON - left untouched")  # never clobber a hand-edited file
    if not isinstance(d, dict):
        sys.exit("not a JSON object - left untouched")
d["remoteControlAtStartup"] = True
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2); f.write("\n")
os.replace(tmp, p)
PY
    ok "remote control enabled: $dir"
  done <<EOF
$(profile_dirs)
EOF
}

# ── import ───────────────────────────────────────────────────────────────────
do_import() {
  local bundle="" force=0 dry=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1 ;;
      --dry-run) dry=1 ;;
      -*) die "import: unknown option $1" ;;
      *) bundle="$1" ;;
    esac
    shift
  done
  if [ -z "$bundle" ]; then
    # shellcheck disable=SC2012  # our own fixed-pattern names; ls -t is the portable newest-first
    bundle="$(ls -t "$TRANSFER_DIR"/claude-profiles-*.tar.gz 2>/dev/null | head -1)"
    [ -n "$bundle" ] || die "no bundle in $TRANSFER_DIR — run 'export' on the old Mac and let Dropbox sync"
  fi
  [ -f "$bundle" ] || die "bundle not found: $bundle"
  local old_home sum ts src name dest it
  work="$(mktemp -d -t claude-profiles-in.XXXXXX)"; TMPDIRS="$work"
  trap 'rm -rf $TMPDIRS' EXIT
  tar -xzf "$bundle" -C "$work" || die "cannot unpack $bundle"
  old_home="$(sed -n 's/^OLD_HOME=//p' "$work/BUNDLE_INFO" 2>/dev/null)"
  [ -n "$old_home" ] || die "bundle has no BUNDLE_INFO — not made by this script"
  sum="$(shasum -a 256 "$bundle" | awk '{print $1}')"
  ts="$(date +%Y%m%d-%H%M%S)"
  say "import: $(basename "$bundle") (from $(sed -n 's/^HOST=//p' "$work/BUNDLE_INFO"), old HOME $old_home)"
  for src in "$work"/profiles/.[!.]* "$work"/profiles/*; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"; dest="$HOME/$name"
    if [ "$force" != "1" ] && [ "$(cat "$dest/.imported-bundle" 2>/dev/null)" = "$sum" ]; then
      ok "$name — this bundle already imported (use --force to re-apply)"; continue
    fi
    if [ "$dry" = "1" ]; then
      say "  [dry-run] $name -> $dest: $(for it in $ITEMS projects; do [ -e "$src/$it" ] && printf '%s ' "$it"; done)"
      continue
    fi
    mkdir -p "$dest"
    for it in $ITEMS; do
      [ -e "$src/$it" ] || continue
      if [ -e "$dest/$it" ]; then mkdir -p "$dest/.pre-import-$ts"; mv "$dest/$it" "$dest/.pre-import-$ts/"; fi
      mv "$src/$it" "$dest/$it"
    done
    import_memory "$src" "$dest" "$old_home"
    rewrite_home "$dest" "$old_home"
    [ -f "$src/.claude-portable.json" ] && merge_mcp "$src/.claude-portable.json" "$(claude_json_for "$dest")"
    printf '%s\n' "$sum" > "$dest/.imported-bundle"
    ok "$name imported -> $dest"
  done
  [ "$dry" = "1" ] && { do_remote_control --dry-run; return 0; }
  [ -f "$HOME/.claude-org-statusline.sh" ] || [ ! -f "$REPO_DIR/scripts/org-statusline.sh" ] || {
    cp "$REPO_DIR/scripts/org-statusline.sh" "$HOME/.claude-org-statusline.sh" && chmod +x "$HOME/.claude-org-statusline.sh"; }
  do_remote_control
}

# Memory dirs are keyed by a slug of the project path. Re-key anything under the
# old HOME onto the new one; merge into an existing dir without clobbering.
import_memory() {
  local src="$1" dest="$2" old_home="$3" old_slug new_slug mem proj newproj
  [ -d "$src/projects" ] || return 0
  old_slug="$(printf '%s' "$old_home" | sed 's/[^A-Za-z0-9]/-/g')"
  new_slug="$(printf '%s' "$HOME" | sed 's/[^A-Za-z0-9]/-/g')"
  for mem in "$src"/projects/*/memory; do
    [ -d "$mem" ] || continue
    proj="$(basename "$(dirname "$mem")")"
    case "$proj" in "$old_slug"*) newproj="$new_slug${proj#"$old_slug"}" ;; *) newproj="$proj" ;; esac
    mkdir -p "$dest/projects/$newproj/memory"
    # -n: a memory already written on this Mac wins over the imported copy.
    cp -Rn "$mem/." "$dest/projects/$newproj/memory/" 2>/dev/null || true
  done
}

rewrite_home() {  # rewrite_home <dest> <old_home> — JSON/MD/SH under the imported items only
  [ "$2" = "$HOME" ] && return 0
  # shellcheck disable=SC2086  # intentional word-split: $ITEMS is a space-separated whitelist
  "$PY" - "$1" "$2" "$HOME" $ITEMS <<'PY'
import os, sys
dest, old, new, items = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
exts = (".json", ".md", ".sh", ".txt")
def fix(p):
    try:
        if os.path.islink(p) or os.path.getsize(p) > 2_000_000:
            return
        s = open(p, encoding="utf-8").read()
    except Exception:
        return
    if old in s:
        open(p, "w", encoding="utf-8").write(s.replace(old, new))
for it in items:
    p = os.path.join(dest, it)
    if os.path.isfile(p):
        fix(p)
    elif os.path.isdir(p) and it in ("plugins", "hooks", "agents", "commands", "output-styles"):
        for root, dirs, files in os.walk(p):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
            for f in files:
                if f.endswith(exts):
                    fix(os.path.join(root, f))
PY
}

merge_mcp() {  # merge_mcp <portable.json> <dest .claude.json> — existing entries win
  "$PY" - "$1" "$2" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
new = (json.load(open(src)) or {}).get("mcpServers", {}) or {}
if not new:
    sys.exit(0)
try:
    d = json.load(open(dst))
except Exception:
    d = {}
cur = d.setdefault("mcpServers", {})
for k, v in new.items():
    cur.setdefault(k, v)
tmp = dst + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, dst)
PY
}

# ── status ───────────────────────────────────────────────────────────────────
do_status() {
  local dir mem
  say "profiles on $(hostname -s):"
  while read -r dir; do
    if [ ! -d "$dir" ]; then printf '  %-22s absent\n' "$(basename "$dir")"; continue; fi
    mem="$(find "$dir/projects" -mindepth 2 -maxdepth 2 -type d -name memory 2>/dev/null | wc -l | tr -d ' ')"
    printf '  %-22s remoteControl=%-5s memory-dirs=%-3s imported=%s\n' "$(basename "$dir")" \
      "$(json_get "$dir/settings.json" remoteControlAtStartup)" "$mem" \
      "$([ -f "$dir/.imported-bundle" ] && echo yes || echo no)"
  done <<EOF
$(profile_dirs)
EOF
  say "bundles in $TRANSFER_DIR:"
  # shellcheck disable=SC2012  # display-only listing of our own fixed-pattern names
  ls -t "$TRANSFER_DIR"/claude-profiles-*.tar.gz 2>/dev/null | sed 's/^/  /' || true
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  export) do_export "$@" ;;
  import) do_import "$@" ;;
  remote-control) do_remote_control "$@" ;;
  status) do_status ;;
  -h|--help|help|"") sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $cmd (export|import|remote-control|status)" ;;
esac
