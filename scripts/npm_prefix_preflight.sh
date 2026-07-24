#!/usr/bin/env bash
# npm_prefix_preflight.sh — detect a root-owned/unwritable npm global prefix
# BEFORE `npm install -g ai-management` hits a raw EACCES stack trace,
# and either auto-configure a user-writable prefix (~/.local) or print the
# exact corrective command.
#
# Background: the 2026-07-16 EXO dogfood session hit `npm config get prefix`
# resolving to a root-owned /usr/local — the install had to be redirected to
# ~/.local by hand. This is step 0, run before `npm install -g`.
#
# Usage:
#   ./scripts/npm_prefix_preflight.sh          check only — exit 0 if writable,
#                                               exit 1 (+ corrective command) if not
#   ./scripts/npm_prefix_preflight.sh --fix     auto-configure npm prefix to
#                                               ~/.local when the current prefix
#                                               is not writable
#   ./scripts/npm_prefix_preflight.sh --quiet   suppress human-readable output
#                                               (exit code still reflects status)
set -uo pipefail

FIX=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    --quiet|-q) QUIET=1 ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

if ! command -v npm >/dev/null 2>&1; then
  say "npm_prefix_preflight: npm not found on PATH — install Node.js/npm first."
  exit 1
fi

PREFIX="$(npm config get prefix 2>/dev/null)"
if [ -z "$PREFIX" ] || [ "$PREFIX" = "undefined" ]; then
  say "npm_prefix_preflight: could not determine npm prefix (npm config get prefix)."
  exit 1
fi

# npm creates $PREFIX (and lib/node_modules under it) on demand, so the write
# probe walks up to the nearest EXISTING ancestor — that is the directory npm
# actually needs permission to write into.
probe="$PREFIX"
while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do
  probe="$(dirname "$probe")"
done

if [ -w "$probe" ]; then
  say "npm_prefix_preflight: OK — npm prefix '$PREFIX' is writable."
  exit 0
fi

OWNER="$(stat -f '%Su' "$probe" 2>/dev/null || stat -c '%U' "$probe" 2>/dev/null || echo unknown)"
say "npm_prefix_preflight: npm prefix '$PREFIX' is NOT writable by $(whoami) (owned by ${OWNER})."
say "  'npm install -g' would fail here with EACCES."

USER_PREFIX="$HOME/.local"

if [ "$FIX" = 1 ]; then
  if npm config set prefix "$USER_PREFIX" >/dev/null 2>&1; then
    mkdir -p "$USER_PREFIX/bin"
    say "npm_prefix_preflight: configured npm prefix -> $USER_PREFIX"
    case ":$PATH:" in
      *":$USER_PREFIX/bin:"*)
        say "  $USER_PREFIX/bin is already on PATH." ;;
      *)
        say "  Add it to PATH (one-time): echo 'export PATH=\"$USER_PREFIX/bin:\$PATH\"' >> ~/.zshrc  (or ~/.bashrc)" ;;
    esac
    exit 0
  fi
  say "npm_prefix_preflight: failed to set npm prefix automatically. Run manually:"
  say "  npm config set prefix \"$USER_PREFIX\""
  exit 1
fi

say ""
say "Fix: run this before 'npm install -g ai-management':"
say "  npm config set prefix \"$USER_PREFIX\" && export PATH=\"$USER_PREFIX/bin:\$PATH\""
say "  (add the export line to your shell rc file to persist it)"
exit 1
