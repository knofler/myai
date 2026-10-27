#!/usr/bin/env bash
# myai_uninstall.sh — `myai uninstall`: remove what myAI installed on this machine.
#
#   myai uninstall [--yes] [--volumes] [--purge-brain] [--repo <path>]...
#
#   Default is a DRY RUN: it lists exactly what it found and would remove, and
#   changes nothing. --yes removes it. A second run finds nothing (idempotent).
#
#   Removed (only what myAI itself created — nothing else is edited):
#     • scheduled jobs: ~/Library/LaunchAgents/com.myai.*.plist (unloaded first);
#       crontab lines tagged "# myai-…" (and the line under a "# myai-… (managed
#       by …)" marker)
#     • shell rc blocks between OUR markers only, in ~/.zshrc and ~/.bashrc:
#       "# >>> <name> (managed by …) >>>" … "# <<< <name> <<<" for the names in
#       $MYAI_UNINSTALL_RC_BLOCKS (default: the blocks myAI's scripts write) —
#       an unmarked line is never touched
#     • the statusline script ~/.claude-org-statusline.sh, and the "statusLine"
#       key in any ~/.claude*/settings.json that points at it
#     • our "myai" entry in other agents' MCP configs (Cursor, Windsurf: the
#       mcpServers.myai key; Codex: the [mcp_servers.myai] table) — every other
#       byte of those files is kept
#     • myAI's Docker containers, network and built images (the data volume
#       only with --volumes)
#     • the state dir ($MYAI_HOME, default ~/.myai) — EXCEPT the brain
#     --repo <path>   also that repo's .myai-local, its .gitignore line, and our
#                     .mcp.json entry (never commits; CLAUDE.md is left as is)
#
#   The BRAIN (your memory) is KEPT, with brain.path and backups/, unless
#   --purge-brain: it is first saved to ~/myai-brain-final-<ts>.bundle
#   (verified; outside the state dir), then removed.
#
#   The npm package cannot remove itself: the last line says what to run.
#
# Exit: 0 done (or dry run); 1 something could not be removed; 2 bad usage.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JSON_RM="$HERE/lib/json_remove_key.py"
# shellcheck source=lib/brain.sh disable=SC1091
. "$HERE/lib/brain.sh" 2>/dev/null || {
  brain_home() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}"; }
  brain_dir() { printf '%s\n' "${MYAI_BRAIN_DIR:-$(brain_home)/brain}"; }
}

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; }

YES=0 VOLUMES=0 PURGE_BRAIN=0
REPOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --volumes) VOLUMES=1 ;;
    --purge-brain) PURGE_BRAIN=1 ;;
    --repo) [ -n "${2:-}" ] || { echo "myai uninstall: --repo needs a path" >&2; exit 2; }
            REPOS+=("$2"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai uninstall: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

STATE="$(brain_home)"
BRAIN="$(brain_dir)"
PROJECT="${MYAI_PROJECT_NAME:-myai}"
# Compose prefixes the project to the names declared in the stack file
# (templates/docker-compose.portable.yml: network myai-net, volume myai-mongo-data).
NET="${PROJECT}_myai-net"
VOL="${PROJECT}_myai-mongo-data"
# The shell-rc blocks myAI's own scripts write, by marker name (comma list).
# Only a block with BOTH "# >>> <name> (managed …) >>>" and "# <<< <name> <<<"
# is removed. MYAI_UNINSTALL_RC_BLOCKS overrides the list.
RC_BLOCKS="${MYAI_UNINSTALL_RC_BLOCKS:-claude multi-org aliases,agy-rc}"
FOUND=0 REMOVED=0 FAILED=0

# item <description> <command...> — dry run: list it; --yes: run it.
item() {
  local desc="$1"; shift
  FOUND=$((FOUND + 1))
  if [ "$YES" != 1 ]; then echo "  would remove  $desc"; return 0; fi
  if "$@" >/dev/null 2>&1; then
    REMOVED=$((REMOVED + 1)); echo "  removed       $desc"
  else
    FAILED=$((FAILED + 1)); echo "  FAILED        $desc"
  fi
}

# rm_under <root> <path> — recursive delete, only strictly inside <root>.
rm_under() {
  local root="$1" p="$2"
  case "$root" in ''|/|"$HOME"|"$HOME/") return 1 ;; esac
  case "$p" in "$root"/?*) rm -rf -- "$p" ;; *) return 1 ;; esac
}

# rc_has_block <file> <name>: exactly one begin and one end marker, in order.
rc_has_block() {
  local f="$1" name="$2" b e
  [ -f "$f" ] || return 1
  b="$(grep -nF "# >>> $name (managed" "$f" | cut -d: -f1)"
  e="$(grep -nxF "# <<< $name <<<" "$f" | cut -d: -f1)"
  [ "$(printf '%s\n' "$b" | grep -c .)" = 1 ] && [ "$(printf '%s\n' "$e" | grep -c .)" = 1 ] && [ "$b" -lt "$e" ]
}
rc_remove_block() {
  local f="$1" name="$2" tmp
  tmp="$(mktemp "$f.myai-uninstall.XXXXXX")" || return 1
  awk -v b="# >>> $name (managed" -v e="# <<< $name <<<" '
    !skip && index($0, b) == 1 { skip = 1; next }
    skip && $0 == e { skip = 0; next }
    !skip { print }' "$f" > "$tmp" && cat "$tmp" > "$f"
  local rc=$?; rm -f "$tmp"; return $rc
}

toml_has_table() { [ -f "$1" ] && grep -qxF "[$2]" "$1"; }
toml_remove_table() {  # drop "[table]" and its lines up to the next table header
  local f="$1" t="$2" tmp
  tmp="$(mktemp "$f.myai-uninstall.XXXXXX")" || return 1
  awk -v h="[$t]" '
    $0 == h { skip = 1; next }
    skip && /^[[:space:]]*\[/ { skip = 0 }
    !skip { print }' "$f" > "$tmp" && cat "$tmp" > "$f"
  local rc=$?; rm -f "$tmp"; return $rc
}

crontab_strip() {  # read the whole table first, then install the filtered copy
  local kept
  kept="$(crontab -l 2>/dev/null | awk '
    skip { skip = 0; next }
    /^# myai-.*\(managed by/ { skip = 1; next }
    /# myai-/ { next }
    { print }')" || return 1
  printf '%s\n' "$kept" | crontab -
}

gitignore_drop_line() {  # remove exact ".myai-local" lines, keep the rest
  local f="$1" tmp
  tmp="$(mktemp "$f.myai-uninstall.XXXXXX")" || return 1
  grep -vxF '.myai-local' "$f" > "$tmp"; cat "$tmp" > "$f"; rm -f "$tmp"
}

json_has() { [ -f "$1" ] && python3 -I "$JSON_RM" "$1" "$2" --check >/dev/null 2>&1; }
json_drop() { python3 -I "$JSON_RM" "$1" "$2"; }

echo "myai uninstall — $([ "$YES" = 1 ] && echo "removing" || echo "DRY RUN (nothing is changed; pass --yes to remove)")"

# ── scheduled jobs ────────────────────────────────────────────────────────────
echo "Scheduled jobs:"
LA="$HOME/Library/LaunchAgents"
if [ -d "$LA" ]; then
  for f in "$LA"/com.myai.*.plist; do
    [ -f "$f" ] || continue
    # shellcheck disable=SC2016  # $1 expands in the child sh
    item "launchd job $(basename "$f" .plist)" \
      sh -c 'launchctl bootout "gui/$(id -u)" "$1" 2>/dev/null; rm -f "$1"' _ "$f"
  done
fi
if command -v crontab >/dev/null 2>&1; then
  n="$(crontab -l 2>/dev/null | grep -c '# myai-' || true)"
  [ "${n:-0}" -gt 0 ] && item "crontab: $n myai line(s)" crontab_strip
fi

# ── shell rc blocks (our markers only) ───────────────────────────────────────
echo "Shell startup files:"
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  IFS=',' read -r -a _blocks <<<"$RC_BLOCKS"
  for name in "${_blocks[@]}"; do
    if rc_has_block "$rc" "$name"; then
      item "$rc: '$name' block" rc_remove_block "$rc" "$name"
    elif [ -f "$rc" ] && grep -qF "# >>> $name (managed" "$rc"; then
      echo "  LEFT ALONE    $rc: '$name' block has unbalanced markers — edit it by hand"
    fi
  done
done

# ── statusline ────────────────────────────────────────────────────────────────
echo "Statusline:"
[ -f "$HOME/.claude-org-statusline.sh" ] && item "$HOME/.claude-org-statusline.sh" rm -f "$HOME/.claude-org-statusline.sh"
for s in "$HOME"/.claude/settings.json "$HOME"/.claude-*/settings.json; do
  [ -f "$s" ] || continue
  # shellcheck disable=SC2016  # python source, not shell
  if json_has "$s" statusLine && python3 -I -c 'import json,sys;c=json.load(open(sys.argv[1])).get("statusLine",{});sys.exit(0 if "claude-org-statusline" in json.dumps(c) else 1)' "$s"; then
    item "$s: statusLine (myAI's)" json_drop "$s" statusLine
  fi
done

# ── other agents' MCP configs ────────────────────────────────────────────────
echo "Agent MCP configs:"
for f in "$HOME/.cursor/mcp.json" "$HOME/.codeium/windsurf/mcp_config.json"; do
  json_has "$f" mcpServers.myai && item "$f: mcpServers.myai" json_drop "$f" mcpServers.myai
done
toml_has_table "$HOME/.codex/config.toml" mcp_servers.myai \
  && item "$HOME/.codex/config.toml: [mcp_servers.myai]" toml_remove_table "$HOME/.codex/config.toml" mcp_servers.myai

# ── Docker ────────────────────────────────────────────────────────────────────
echo "Docker:"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  names="$(docker ps -a --format '{{.Names}}' 2>/dev/null)"
  for c in "$PROJECT-gateway" "$PROJECT-dashboard" "$PROJECT-mongo"; do
    grep -qxF "$c" <<<"$names" && item "container $c" docker rm -f "$c"
  done
  docker network ls --format '{{.Name}}' 2>/dev/null | grep -qxF "$NET" \
    && item "network $NET" docker network rm "$NET"
  imgs="$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)"
  for img in $(grep -E "^$PROJECT-(gateway|dashboard):" <<<"$imgs" || true); do
    item "image $img" docker image rm "$img"
  done
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qxF "$VOL"; then
    if [ "$VOLUMES" = 1 ]; then item "volume $VOL (database data)" docker volume rm "$VOL"
    else echo "  kept          volume $VOL (database data — pass --volumes to remove)"; fi
  fi
else
  echo "  (docker not available — skipped)"
fi

# ── per-repo ──────────────────────────────────────────────────────────────────
for r in ${REPOS[@]+"${REPOS[@]}"}; do
  echo "Repo $r:"
  [ -d "$r" ] || { echo "  (not a directory — skipped)"; continue; }
  [ -f "$r/.myai-local" ] && item "$r/.myai-local" rm -f "$r/.myai-local"
  [ -f "$r/.gitignore" ] && grep -qxF '.myai-local' "$r/.gitignore" && item "$r/.gitignore: .myai-local line" gitignore_drop_line "$r/.gitignore"
  json_has "$r/.mcp.json" mcpServers.myai && item "$r/.mcp.json: mcpServers.myai" json_drop "$r/.mcp.json" mcpServers.myai
  [ -f "$r/CLAUDE.md" ] && echo "  left as is    $r/CLAUDE.md (yours to keep or delete; nothing is committed)"
done

# ── state dir (the brain stays unless --purge-brain) ─────────────────────────
echo "State ($STATE):"
if [ -d "$STATE" ]; then
  for p in "$STATE"/* "$STATE"/.[!.]*; do
    [ -e "$p" ] || continue
    case "$(basename "$p")" in brain|brain.path|backups) continue ;; esac
    item "$p" rm_under "$STATE" "$p"
  done
fi
if [ "$PURGE_BRAIN" = 1 ]; then
  if [ -d "$BRAIN/.git" ]; then
    FINAL="$HOME/myai-brain-final-$(date -u +%Y%m%dT%H%M%SZ).bundle"
    if [ "$YES" = 1 ]; then
      if git -C "$BRAIN" bundle create "$FINAL" --all >/dev/null 2>&1 && git -C "$BRAIN" bundle verify "$FINAL" >/dev/null 2>&1; then
        echo "  saved         brain → $FINAL (restore with: git clone \"$FINAL\" <dir>)"
        case "$BRAIN" in "$STATE"/*) item "brain $BRAIN" rm_under "$STATE" "$BRAIN" ;;
          *) item "brain $BRAIN" rm_under "$(dirname "$BRAIN")" "$BRAIN" ;; esac
      else
        rm -f "$FINAL"; FAILED=$((FAILED + 1))
        echo "  FAILED        could not save a verified brain bundle — the brain was NOT removed"
      fi
    else
      echo "  would save    brain → ~/myai-brain-final-<timestamp>.bundle, then"; item "brain $BRAIN" true
    fi
  fi
  for p in "$STATE/brain.path" "$STATE/backups"; do [ -e "$p" ] && item "$p" rm_under "$STATE" "$p"; done
  [ -d "$STATE" ] && [ -z "$(ls -A "$STATE" 2>/dev/null)" ] && [ "$YES" = 1 ] && rmdir "$STATE" 2>/dev/null
elif [ -e "$BRAIN" ]; then
  echo "  kept          brain $BRAIN (your memory — pass --purge-brain to remove it, after a saved bundle)"
fi

echo
if [ "$FOUND" = 0 ]; then
  echo "Nothing from myAI found on this machine."
elif [ "$YES" = 1 ]; then
  echo "Removed $REMOVED item(s)$([ "$FAILED" -gt 0 ] && echo ", $FAILED FAILED (see above)")."
else
  echo "$FOUND item(s) would be removed. Re-run with --yes to remove them."
fi
echo "Last step (the package cannot remove itself): npm rm -g ai-management"
[ "$FAILED" = 0 ]
