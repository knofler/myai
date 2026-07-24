#!/usr/bin/env bash
# install_git_hooks.sh — point a repo's git hooks at its versioned .githooks/
# directory (core.hooksPath) so the conflicted-copy pre-commit guard (DEVOPS
# 2026-07-20 root-cause fix) is active without any manual per-machine step.
#
# core.hooksPath is LOCAL git config (.git/config, not synced by git itself),
# so every clone/machine needs this run once. Idempotent — safe to re-run.
# Called by:
#   - scripts/update_all.sh, once per managed repo (propagates fleet-wide)
#   - scripts/machine_selfheal.sh, every session (self-heals this machine's
#     checkout of whichever repo the session is in, same pattern as the
#     statusline/runner-cadence self-heal already there)
#
# Usage: ./scripts/install_git_hooks.sh [target-repo-path]   (default: pwd)
set -uo pipefail

TARGET="${1:-$(pwd)}"

ROOT=$(cd "$TARGET" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ROOT" ]; then
    echo "install_git_hooks: $TARGET is not a git repo — skipping" >&2
    exit 0
fi

if [ ! -d "$ROOT/.githooks" ]; then
    echo "install_git_hooks: no .githooks/ in $ROOT — skipping" >&2
    exit 0
fi

chmod +x "$ROOT"/.githooks/* 2>/dev/null || true

CURRENT=$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || echo "")
if [ "$CURRENT" != ".githooks" ]; then
    git -C "$ROOT" config core.hooksPath .githooks
    echo "install_git_hooks: core.hooksPath -> .githooks ($ROOT)"
fi

exit 0
