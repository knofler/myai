#!/usr/bin/env bash
# 18-machine-selfheal.sh — session-start hook: idempotently self-heal this Mac's
# machine-local config (statusline deploy + runner cadence) so multi-machine
# setup needs no manual steps. Delegates to scripts/machine_selfheal.sh. Silent
# no-op when already correct; never fails the session.
set +e
DIR=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd) || {
    # Real precondition failure — the hook can't resolve its own repo root
    # (hooks/session/../.. from $0), not "self-heal not applicable here".
    echo "18-machine-selfheal: cannot resolve repo root from \$0 ($0) — self-heal skipped" >&2
    exit 0
}
[ -f "$DIR/scripts/machine_selfheal.sh" ] && bash "$DIR/scripts/machine_selfheal.sh" 2>/dev/null
exit 0
