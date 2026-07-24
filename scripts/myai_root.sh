#!/usr/bin/env bash
# myai_root.sh — bash resolver for the framework-as-module root (plan S-INIT-5).
#
# Mirror of the `root` handler in bin/myai.cjs, for bash callers (hooks, settings
# fragments, other scripts) that need the installed ai-management module
# path without shelling into node. Prints the absolute module root on stdout when
# it resolves; fails loud (stderr + exit 1) when the resolved dir is not a valid
# install, so a kernel-only repo never silently runs WITHOUT its safety hooks.
#
# Resolution: this script lives at <module>/scripts/myai_root.sh, so the module
# root is one dir up from $0 by construction — no npm lookup needed.
#
# Usage:  myai_root.sh            → prints module root, exit 0 (or exit 1 + error)
#         myai_root.sh --quiet    → same, but suppress the human error text
set -uo pipefail

QUIET=0
for arg in "$@"; do
  case "$arg" in --quiet|-q) QUIET=1 ;; esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Framework markers — must match MODULE_MARKERS in bin/myai.cjs.
MISSING=""
for m in "hooks/pre-tool" "skills" "templates/CLAUDE_KERNEL.md"; do
  [ -e "$MODULE_ROOT/$m" ] || MISSING="${MISSING:+$MISSING, }$m"
done

if [ -n "$MISSING" ]; then
  if [ "$QUIET" != 1 ]; then
    echo "myai_root: '$MODULE_ROOT' is not a valid ai-management install" >&2
    echo "  missing framework markers: $MISSING" >&2
    echo "  reinstall with:  npm i -g ai-management" >&2
  fi
  exit 1
fi

printf '%s\n' "$MODULE_ROOT"
