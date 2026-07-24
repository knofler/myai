#!/bin/bash
# lint_myai_init.sh — guardrail lint for a repo that ran `myai init` (greenfield).
#
# Asserts the S-INIT-6 guardrails for a kernel-only repo (ADR-016 §0.2):
#   1. a kernel CLAUDE.md is present and is a genuine myAI kernel
#   2. .myai-local is present
#   3. .myai-local is gitignored AND not tracked (the pointer never reaches history)
#   4. the kernel CLAUDE.md + .myai-local carry NO secret material
#
# This is the "docs/guardrail lint" the plan (S-INIT-6) requires and the check
# health_check.sh delegates to for kernel-only repos. It resolves from the
# installed module's scripts/ dir, so it never needs to be copied into the
# target repo.
#
# Usage: ./scripts/lint_myai_init.sh [repo_path]   (default: current directory)
# Exit:  0 = GREEN (compliant), 1 = one or more violations.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${1:-$PWD}"
REPO="${REPO/#\~/$HOME}"

# Shared secret regexes (single source of truth — see scripts/lib/secret_patterns.sh).
. "$SCRIPT_DIR/lib/secret_patterns.sh" 2>/dev/null || true
: "${SECRET_PAT_COMBINED:=AKIA[A-Z0-9]{16}|sk-[a-zA-Z0-9]{48}|ghp_[a-zA-Z0-9]{36}|AIza[a-zA-Z0-9_-]{35}|-----BEGIN [A-Z ]+KEY-----}"

FAILS=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; FAILS=$((FAILS + 1)); }

CLAUDE="$REPO/CLAUDE.md"
LOCAL="$REPO/.myai-local"
GI="$REPO/.gitignore"

echo "myai-init lint → $REPO"

# 1. Kernel CLAUDE.md present + genuine (stable "# myAI kernel" marker heading).
if [ -f "$CLAUDE" ] && head -n 3 "$CLAUDE" 2>/dev/null | grep -qE '^#[[:space:]]+myAI kernel'; then
  ok "kernel CLAUDE.md present"
else
  bad "kernel CLAUDE.md missing or not a myAI kernel (run 'myai init')"
fi

# 2. .myai-local present.
if [ -f "$LOCAL" ]; then
  ok ".myai-local present"
else
  bad ".myai-local missing (run 'myai init')"
fi

# 3. .myai-local gitignored AND not tracked — the pointer must never be committed.
if [ -f "$GI" ] && grep -qxF '.myai-local' "$GI" 2>/dev/null; then
  ok ".myai-local is gitignored"
else
  bad ".myai-local NOT gitignored — add a '.myai-local' line to .gitignore"
fi
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 \
   && git -C "$REPO" ls-files --error-unmatch .myai-local >/dev/null 2>&1; then
  bad ".myai-local is tracked by git — must never be committed (git rm --cached .myai-local)"
fi

# 4. Kernel + .myai-local secret-free.
scan_one() {
  if command -v secret_scan_file >/dev/null 2>&1; then
    secret_scan_file "$1"
  else
    grep -iE "$SECRET_PAT_COMBINED" "$1" 2>/dev/null
  fi
}
for f in "$CLAUDE" "$LOCAL"; do
  [ -f "$f" ] || continue
  if [ -n "$(scan_one "$f")" ]; then
    bad "secret material detected in $(basename "$f") — kernel/pointer must be secret-free"
  else
    ok "$(basename "$f") secret-free"
  fi
done

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "myai-init lint: GREEN"
  exit 0
else
  echo "myai-init lint: $FAILS violation(s)"
  exit 1
fi
