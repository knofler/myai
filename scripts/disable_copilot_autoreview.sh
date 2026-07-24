#!/usr/bin/env bash
# ============================================================
# disable_copilot_autoreview.sh — enforce AI_RULES §17.2: Copilot reviews only
# CODE PRs, never docs/AI-only PRs.
# ============================================================
# The gated `copilot-review.yml` workflow already requests Copilot ONLY on code
# PRs (it carries the §16 changes gate). But if the repo/org ALSO has "Copilot
# automatically reviews pull requests" turned on (a repository ruleset or the repo
# Code-review setting), Copilot reviews EVERY PR — bypassing the gate and burning
# credit on docs/AI-only PRs. This script audits for that and disables it where the
# API allows; otherwise it prints the exact manual toggle.
#
# Best-effort: GitHub's "automatic Copilot review" lives in repository rulesets /
# a UI code-review setting; the ruleset path is scriptable via `gh api`, the plain
# setting is UI-only. This never fails a pipeline — it reports and guides.
#
# Usage:
#   scripts/disable_copilot_autoreview.sh                 # audit current repo (origin)
#   scripts/disable_copilot_autoreview.sh owner/repo      # audit a specific repo
#   scripts/disable_copilot_autoreview.sh owner/repo --apply   # try to disable rulesets
# ============================================================
set -uo pipefail

APPLY=false
REPO=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=true ;;
    -*) echo "unknown option: $a" >&2; exit 1 ;;
    *) REPO="$a" ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found — cannot audit Copilot auto-review via API." >&2
  echo "Manual: Repo → Settings → Code review → uncheck 'Automatically review PRs' (Copilot)." >&2
  exit 0
fi

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '')"
fi
[ -n "$REPO" ] || { echo "Cannot determine repo (pass owner/repo)." >&2; exit 0; }

echo "── Copilot auto-review audit: $REPO ──"

# 1. Confirm the gated workflow is the sanctioned trigger.
if gh api "repos/$REPO/contents/.github/workflows/copilot-review.yml" >/dev/null 2>&1; then
  echo "  ✓ copilot-review.yml present (gated, code-PR-only) — the sanctioned trigger."
else
  echo "  · no copilot-review.yml — Copilot review only via automatic setting (if any)."
fi

# 2. Scan repository rulesets for an automatic-Copilot-review requirement.
rules_json="$(gh api "repos/$REPO/rulesets" 2>/dev/null || echo '')"
found=0
if [ -n "$rules_json" ] && echo "$rules_json" | grep -qi 'copilot'; then
  found=1
  echo "  ⚠ a repository ruleset references Copilot review:"
  echo "$rules_json" | python3 -c '
import sys,json
try: data=json.load(sys.stdin)
except Exception: sys.exit(0)
for r in (data if isinstance(data,list) else []):
    s=json.dumps(r).lower()
    if "copilot" in s:
        print("      - ruleset #%s: %s" % (r.get("id"), r.get("name")))
' 2>/dev/null
  if [ "$APPLY" = true ]; then
    echo "      (auto-disable of ruleset requirements is intentionally NOT automated —"
    echo "       edit the ruleset in the UI to avoid clobbering other required rules.)"
  fi
fi

if [ "$found" = 0 ]; then
  echo "  ✓ no ruleset requires automatic Copilot review (good)."
fi

echo ""
echo "  MANUAL (the UI code-review setting is not exposed via API):"
echo "    Repo → Settings → Code review → uncheck 'Automatically review pull requests'"
echo "    (or Org → Settings → Copilot → Code review). Leave the gated workflow ON."
echo "  Result: docs/AI-only PRs get NO Copilot review; code PRs get one (§17.2)."
exit 0
