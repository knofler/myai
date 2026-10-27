#!/usr/bin/env bash
# mcp_docker_gateway.sh — the `docker` entry in .mcp.json: start the Docker MCP
# gateway on THIS session's lane profile (config/docker_mcp_profiles.txt).
# stdio MCP server: stdout belongs to the protocol, so every note goes to stderr.
#
# A profile missing on this Mac (no boot since it was added) is created once,
# here, before the gateway starts.
#
# Phase 4 (scope): every call passes lib/mcp_interceptor.sh (phase 3, #524) —
# audit to traces_record, and the gateway's management tools (mcp-add,
# mcp-remove, mcp-config-set, code-mode) refused for the master + runner (role_master_lane). Per-run
# `--tools` cannot do this: measured on CLI v0.43.3, it does not hide the
# gateway's built-in tools, and Docker's `dynamic-tools` switch is global to
# every client. The resolved lane is exported so the interceptor judges the
# same lane that picked the profile.
#
# Env: MYAI_DOCKER_MCP_MEMORY (default 512Mb), MYAI_DOCKER_MCP_PROFILE (force a
# profile id), MYAI_DOCKER_MCP_INTERCEPTOR=0 (start without the interceptor).
set -u
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
DOCKER_MCP_PROFILES_LIB_ONLY=1 . "$HERE/../docker_mcp_profiles.sh"

lane="$(_dmp_lane)"
profile="${MYAI_DOCKER_MCP_PROFILE:-$(dmp_resolve "$lane")}" || profile=""
if [ -z "$profile" ]; then
  echo "mcp_docker_gateway: no profile for lane '$lane' in $DOCKER_MCP_PROFILES" >&2
  exit 1
fi
if ! "$DOCKER_BIN" mcp profile show "$profile" >/dev/null 2>&1; then
  echo "mcp_docker_gateway: profile $profile missing on this Mac — creating" >&2
  dmp_ensure --only "$profile" >&2 || true
fi
set -- --profile "$profile" --memory "${MYAI_DOCKER_MCP_MEMORY:-512Mb}"
if [ "${MYAI_DOCKER_MCP_INTERCEPTOR:-1}" != 0 ] && [ -x "$HERE/mcp_interceptor.sh" ]; then
  # The gateway runs the exec target through a shell: an unescaped space
  # ("Dropbox (Personal)") made EVERY tool call fail with "executing
  # interceptor: exit status 2" (measured 2026-10-21). %q escapes it.
  set -- "$@" --interceptor "before:exec:$(printf '%q' "$HERE/mcp_interceptor.sh")"
fi
export MYAI_SESSION_PROFILE="$lane"
exec "$DOCKER_BIN" mcp gateway run "$@"
