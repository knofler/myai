#!/usr/bin/env bash
# mcp_optional.sh — opt-in MCP servers on top of the base .mcp.json template.
#
# WHY (task-b1287c56, agreed by both masters 2026-10-22). templates/mcp.json is
# what a stranger's `myai init` writes, so it carries only what every install
# needs: myai + context7. The rest of the old base set (shadcn-ui, playwright,
# dropbox, github, vercel) lives in templates/mcp-optional.json and is added
# ONLY when this host opts in:
#
#   ${MYAI_USER_DIR:-~/.myai}/mcp-optional.conf one server name per line, or `all`
#                                              (# comments and blank lines ignored)
#   MYAI_MCP_OPTIONAL_CONF=<file>              override the conf path (tests)
#
# Existing .mcp.json files are never stripped: json_merge keeps keys that only
# the target has, so a repo that already carries an optional server keeps it
# whether or not the host opts in.
#
#   mcp_optional_conf                 → the conf path
#   mcp_optional_overlay <src> <out>  → write {"mcpServers":{…selected…}} from
#                                       <src> (templates/mcp-optional.json) to
#                                       <out>; rc 0 when at least one server
#                                       was selected, rc 1 when none (no conf,
#                                       empty conf, or nothing matched). Names
#                                       not in <src> are warned on stderr.
#
# bash 3.2-safe; sourced, not executed; no network.

mcp_optional_conf() {
  # Never under $MYAI_HOME — it can point at the framework checkout (see
  # role_runner_conf in swarm_roles.sh).
  printf '%s' "${MYAI_MCP_OPTIONAL_CONF:-${MYAI_USER_DIR:-$HOME/.myai}/mcp-optional.conf}"
}

mcp_optional_overlay() {
  local src="$1" out="$2" conf
  conf="$(mcp_optional_conf)"
  [ -f "$conf" ] && [ -f "$src" ] || return 1
  /usr/bin/env python3 - "$src" "$conf" "$out" <<'PY'
import json, sys
src, conf, out = sys.argv[1:4]
available = (json.load(open(src)).get("mcpServers") or {})
wanted = []
for line in open(conf):
    name = line.split("#", 1)[0].strip()
    if name:
        wanted.append(name)
if "all" in wanted:
    wanted = list(available)
picked = {}
for name in wanted:
    if name in available:
        picked[name] = available[name]
    else:
        sys.stderr.write("mcp-optional: unknown server '%s' in %s (available: %s)\n"
                         % (name, conf, ", ".join(available)))
if not picked:
    sys.exit(1)
json.dump({"mcpServers": picked}, open(out, "w"), indent=2)
PY
}
