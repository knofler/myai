#!/bin/bash
set +e
# Hook: No Local npm Guard
# Event: PreToolUse (Bash)
# Blocks bare npm/npx/node commands — must use docker compose exec
# macOS-compatible (no grep -P)

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Allow docker compose exec commands (the correct way)
if echo "$COMMAND" | grep -qE 'docker\s+compose\s+exec'; then
  exit 0
fi

# Allow docker exec commands
if echo "$COMMAND" | grep -qE 'docker\s+exec'; then
  exit 0
fi

# Allow npm/node version checks
if echo "$COMMAND" | grep -qE '(npm|node|npx)\s+(-v|--version|version)'; then
  exit 0
fi

# GLOBAL npm operations — the sanctioned framework-CLI path is `npm i -g ai-management`
# (AI_RULES §19). The host-npm block targets PROJECT-LOCAL deps (Docker mandate); global
# CLI tools are a host concern. But §19 says registry-only, NO EXCEPTION — so this guard
# also ENFORCES that: a global INSTALL of a forbidden form (tarball .tgz, the unpublished
# scoped @knofler/ai-management) is blocked. Cleanup (uninstall/remove) of ANY global
# package stays allowed — that is how a machine is migrated OFF a bad install.
if echo "$COMMAND" | grep -qE '^[[:space:]]*npm[[:space:]]' && echo "$COMMAND" | grep -qE '(^|[[:space:]])(-g|--global)([[:space:]]|$)'; then
  if echo "$COMMAND" | grep -qE '\b(install|i|add)\b' \
     && echo "$COMMAND" | grep -qE '\.tgz([[:space:]"'"'"']|$)|@knofler/ai-management'; then
    echo "BLOCKED (AI_RULES §19): the framework CLI installs ONLY as the bare registry"
    echo "package — no tarball (.tgz), no scoped @knofler/ai-management, no npm link."
    echo "  Use exactly:  npm i -g ai-management"
    exit 2
  fi
  exit 0
fi

# `npm link` is a forbidden framework-CLI install path (AI_RULES §19).
if echo "$COMMAND" | grep -qE '^[[:space:]]*npm[[:space:]]+link\b'; then
  echo "BLOCKED (AI_RULES §19): npm link is not an allowed framework-CLI install path."
  echo "  Use exactly:  npm i -g ai-management"
  exit 2
fi

# Allow if explicitly in a CI context
if [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ]; then
  exit 0
fi

# Block bare npm install/ci/run/start/build/test/lint (POSIX-compatible regex)
if echo "$COMMAND" | grep -qE '^[[:space:]]*(npm\s+(install|ci|run|start|build|test|lint))'; then
  echo "BLOCKED: Direct npm commands are not allowed on the host."
  echo "Use Docker instead:"
  echo "  docker compose exec app npm install"
  echo "  docker compose exec app npm run build"
  exit 2
fi

# Block bare npx (unless it's inside a docker command — already allowed above)
if echo "$COMMAND" | grep -qE '^[[:space:]]*npx\s+'; then
  echo "BLOCKED: Direct npx commands are not allowed on the host."
  echo "Use Docker instead:"
  echo "  docker compose exec app npx tsc --noEmit"
  exit 2
fi

exit 0
