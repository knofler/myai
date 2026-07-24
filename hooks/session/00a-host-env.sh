#!/bin/bash
set +e
# Hook: Write host identity for Docker + Telegram host control
# Event: SessionStart
# 1. Writes HOST_HOSTNAME to /tmp for docker-compose (not Dropbox-synced)
# 2. Writes hostname to state/.telegram-active-host (Dropbox-synced)
#    This tells ALL gateways which machine should own Telegram polling.
#    The other machine's gateway reads this file every 10s and deactivates.

# Skip inside a container (e.g. the gateway's own hook registry): the Dropbox
# bind is read-only here so the write fails with EROFS, and `hostname -s` is the
# container ID — claiming the container as the Telegram host would be wrong, not
# just noisy. This hook is meant to run on the HOST at session start.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  echo "00a-host-env: skipped (inside container — host-only hook)"
  exit 0
fi

HOSTNAME_SHORT=$(hostname -s)

# Docker Compose env (local only, not synced)
echo "HOST_HOSTNAME=$HOSTNAME_SHORT" > /tmp/.myai-host-env

# Telegram host control (synced via Dropbox to all machines)
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE_DIR="$ROOT/state"
[ -d "$STATE_DIR" ] || STATE_DIR="$ROOT/AI/state"
if [ -d "$STATE_DIR" ]; then
  echo "$HOSTNAME_SHORT" > "$STATE_DIR/.telegram-active-host"
fi
