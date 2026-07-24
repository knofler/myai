#!/bin/bash
set +e
# Hook: Block shared-gateway compose deploys from runner ci-workspaces (LL 2026-07-04)
#
# Incident 2026-07-04: a headless task ran `docker compose up` for the shared
# myai gateway FROM its ~/ci-workspaces clone. The clone has no real .env
# (gitignored — the real one lives only in the master checkout), so the gateway
# silently rebound to the empty local mongo instead of Atlas and served an EMPTY
# fleet queue for 10.5h (every runner fire claimed nothing; status flips were
# written to the wrong DB and lost).
#
# Rule: the shared `myai` compose project is deployed ONLY from the master
# checkout — a workspace clone may never own it. Mutating compose commands
# (up/build/restart/create/start/down/stop/rm) targeting the myai stack are
# blocked when the effective directory is under the ci-workspaces root. Other
# repos' own stacks (Docker-only npm builds in their workspaces) stay allowed,
# as do read-only compose commands (ps/logs/config) and exec into the shared
# containers. Compose interpolation hardening (`MONGODB_URI` is now `:?`
# required in docker-compose.yml) is the second line of defence; this hook
# stops the attempt before compose even runs.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)
[ -z "$CWD" ] && CWD="$PWD"

# Only docker compose invocations
echo "$CMD" | grep -qE 'docker([[:space:]]+|-)compose' || exit 0

# Extract the compose SUBCOMMAND (first non-flag token after the LAST
# `docker compose`, with value-taking flags stripped) so e.g.
# `docker compose exec app npm run build` never false-matches on "build".
SUB=$(echo "$CMD" \
  | sed -E 's/.*docker([[:space:]]+|-)compose//' \
  | sed -E 's/(-f|--file|-p|--project-name|--project-directory|--env-file|--profile)([= ][^[:space:]]+)//g' \
  | awk '{print $1}')
case "$SUB" in
  up|build|restart|create|start|down|stop|rm) ;;   # mutating — keep checking
  *) exit 0 ;;                                     # read-only / exec / run — allowed
esac

WS_ROOT="${CI_WORKSPACES:-$HOME/ci-workspaces}"

# Effective directory compose runs from: the last `cd <dir>` in the command
# wins, otherwise the session cwd.
DIR="$CWD"
LAST_CD=$(echo "$CMD" | grep -oE 'cd[[:space:]]+[^;&|]+' | tail -1 | sed -E 's/^cd[[:space:]]+//; s/[[:space:]]+$//' | tr -d '"'"'")
[ -n "$LAST_CD" ] && DIR="$LAST_CD"
case "$DIR" in "~"*) DIR="$HOME${DIR#\~}" ;; esac

# Outside a runner workspace → allowed (master-checkout deploys are the norm).
case "$DIR" in
  "$WS_ROOT"/*) ;;
  *) exit 0 ;;
esac

# Inside a workspace: block only when it targets the SHARED myai stack —
# explicit `-p myai`, or the workspace's own compose project is named `myai`
# (an ai_management clone). App repos' own stacks stay allowed.
TARGETS_MYAI=false
echo "$CMD" | grep -qE '(-p|--project-name)[= ]+myai([[:space:]]|$)' && TARGETS_MYAI=true
for cf in "$DIR/docker-compose.yml" "$DIR/docker-compose.yaml" "$DIR/compose.yml" "$DIR/compose.yaml"; do
  [ -f "$cf" ] && grep -qE '^name:[[:space:]]*myai[[:space:]]*$' "$cf" 2>/dev/null && TARGETS_MYAI=true
done
[ "$TARGETS_MYAI" = false ] && exit 0

echo "BLOCKED: '$SUB' on the shared myai gateway stack from a runner ci-workspace ($DIR)."
echo "A workspace clone has no real .env — composing the gateway from here rebinds it to the"
echo "empty local mongo and split-brains the fleet queue (LL 2026-07-04: 10.5h starvation)."
echo "Gateway deploys are interactive/selfheal ops run from the MASTER checkout only:"
echo "  cd <master AI repo> && docker compose build gateway && docker compose up -d gateway dashboard"
echo "If your change needs a gateway rebuild to take effect, note it in your RESULT line instead."
exit 2
