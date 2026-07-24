#!/usr/bin/env bash
# 18-machine-selfheal.sh — session-start hook: idempotently self-heal this Mac's
# machine-local config (statusline deploy + runner cadence) so multi-machine
# setup needs no manual steps. Delegates to scripts/machine_selfheal.sh. Silent
# no-op when already correct; never fails the session.
set +e
DIR=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd) || exit 0
[ -f "$DIR/scripts/machine_selfheal.sh" ] && bash "$DIR/scripts/machine_selfheal.sh" 2>/dev/null
exit 0
