#!/usr/bin/env bash
# setup_antigravity_mcp.sh — give Antigravity (agy) the myai gateway tools
# (task-7fd4320e, operator 2026-10-02: agy and the runner do the work;
# the master only directs).
#
# Antigravity reads MCP servers from ~/.gemini/config/mcp_config.json (global —
# see ~/.gemini/antigravity/builtin/skills/agy-customizations/docs/mcp_servers.md;
# schema: {"mcpServers": {"<id>": {"command": …, "args": […], "env": {…}}}}).
# This script merges ONE stdio entry, "myai", pointing at the SAME
# scripts/lib/mcp_myai_stdio.sh bridge every Claude session uses — so an agy
# session gets tasks/brain/mailbox/swarm (tasks_*, brain_*, mail_*, swarm_*,
# dispatch_delegate) with the gateway token resolved off disk by the bridge,
# never from agy's environment. All other entries in the file are preserved
# (deep-merge, same no-clobber doctrine as update_all.sh's settings merge).
#
# The committed command path is the MASTER checkout's bridge: a ci-workspaces
# worktree path would be deleted when its task ends (the launchd plist lesson,
# boot_sync.sh §3), so running from a workspace clone refuses unless the test
# override is set.
#
# Usage:
#   ./scripts/setup_antigravity_mcp.sh            # merge + write
#   ./scripts/setup_antigravity_mcp.sh --dry-run  # print what would change
#
# Env (tests): AGY_MCP_CONFIG=<path> overrides the config file;
#              AGY_MCP_BRIDGE=<path> overrides the bridge path;
#              AGY_MCP_ALLOW_WORKTREE=1 skips the worktree refusal.
# Idempotent + quiet when already current (exit 0, no output) — safe in the
# boot path. Exit 1 only on a real write failure.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

APPLY=1
for a in "$@"; do
  case "$a" in
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

if [ -z "${AGY_MCP_ALLOW_WORKTREE:-}" ]; then
  case "$REPO_ROOT" in
    "$HOME"/ci-workspaces/*)
      echo "setup_antigravity_mcp: refusing from a workspace clone ($REPO_ROOT) — the bridge path must outlive this worktree. Run from the master checkout." >&2
      exit 0
      ;;
  esac
fi

BRIDGE="${AGY_MCP_BRIDGE:-$REPO_ROOT/scripts/lib/mcp_myai_stdio.sh}"
if [ ! -f "$BRIDGE" ]; then
  echo "setup_antigravity_mcp: bridge not found at $BRIDGE — nothing configured" >&2
  exit 0
fi

CFG="${AGY_MCP_CONFIG:-$HOME/.gemini/config/mcp_config.json}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "setup_antigravity_mcp: python3 not available — skipping" >&2
  exit 0
fi

# A function, not a heredoc inside "$(…)": bash 3.2 (macOS /bin/bash) scans a
# command substitution for matching quotes, so one apostrophe in the Python
# body broke the parse on any Mac without Homebrew bash (2026-10-18).
merge_agy_config() {
  python3 - "$@" <<'PY'
import json, os, sys

cfg_path, bridge, apply_flag = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
data = {}
if os.path.isfile(cfg_path):
    try:
        with open(cfg_path) as f:
            raw = f.read()
        # agy itself creates mcp_config.json EMPTY (0 bytes, seen 2026-10-02) —
        # that is "no servers yet", not a corrupt file.
        data = json.loads(raw) if raw.strip() else {}
        data = data or {}
    except Exception as e:
        # Never clobber a file we cannot parse — that could nuke the
        # operator's other MCP servers.
        print(f"UNPARSEABLE:{e}")
        sys.exit(0)

servers = data.setdefault("mcpServers", {})
want = {"command": "bash", "args": [bridge]}
cur = servers.get("myai")
if cur == want:
    print("CURRENT")
    sys.exit(0)

servers["myai"] = want
if apply_flag:
    os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
    tmp = cfg_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, cfg_path)
    print("WROTE" if cur is None else "UPDATED")
else:
    print("WOULD-WRITE" if cur is None else "WOULD-UPDATE")
PY
}
OUT="$(merge_agy_config "$CFG" "$BRIDGE" "$APPLY")"

case "$OUT" in
  CURRENT) exit 0 ;;
  WROTE)        echo "antigravity MCP: myai stdio bridge added → $CFG" ;;
  UPDATED)      echo "antigravity MCP: myai entry repointed at $BRIDGE → $CFG" ;;
  WOULD-WRITE)  echo "antigravity MCP: DRY-RUN would add myai stdio bridge to $CFG" ;;
  WOULD-UPDATE) echo "antigravity MCP: DRY-RUN would repoint myai entry at $BRIDGE in $CFG" ;;
  # Non-zero so the boot records WARN, never a PASS over a config agy can't read
  # (2026-10-03: the boot printed PASS next to "not valid JSON").
  UNPARSEABLE:*) echo "antigravity MCP: $CFG exists but is not valid JSON: ${OUT#UNPARSEABLE:} — fix it by hand, nothing written" >&2; exit 3 ;;
  *) echo "antigravity MCP: unexpected merge outcome '$OUT' — nothing written" >&2; exit 1 ;;
esac
exit 0
