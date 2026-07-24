#!/usr/bin/env bash
# 16-org-context.sh — Surface the active Claude org at session start (Multi-Org-Auth Phase 4).
#
# Multiple Claude orgs run side by side on one machine via CLAUDE_CONFIG_DIR
# (one persistent authenticated session per config dir). This hook makes the
# ACTIVE org obvious at session start — like the machine/docker banners — and
# guards against working in a repo under the wrong org.
#
# Resolution (by the basename of $CLAUDE_CONFIG_DIR, default ~/.claude):
#   ~/.claude          -> personal  (knofler, personal default)
#   ~/.claude-museum   -> museum    (Powerhouse Museum, Enterprise)
#   ~/.claude-tech     -> tech      (Team org)
#
# Mismatch guard: if config/repo_org_map.txt assigns this repo to an org and the
# active org differs, warn (e.g. "in a museum repo but authed as personal").
# The map is optional — with no entry a repo defaults to personal and the guard
# stays silent.
#
# forceLoginOrgID lockdown: on managed/shared machines Enterprise pins the org
# via managed settings (switching disabled by design). When that pin is
# detected the hook reports it and SKIPS the mismatch guard — it never fights
# the lockdown. See plan/MULTI_ORG_AUTH.md + documentation/MULTI_ORG_WORKFLOW.md.
#
# Always non-fatal. bash 3.2-safe (no associative arrays). set +e throughout.
set +e

# Host-only — inside the gateway container CLAUDE_CONFIG_DIR is meaningless.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

# --- Resolve active org from the config dir --------------------------------
CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CFG_BASE=$(basename "$CFG_DIR")

case "$CFG_BASE" in
  .claude-museum) ORG_KEY="museum";   ORG_LABEL="Powerhouse Museum (Enterprise)" ;;
  .claude-tech)   ORG_KEY="tech";     ORG_LABEL="Team org" ;;
  .claude)        ORG_KEY="personal"; ORG_LABEL="personal default (knofler)" ;;
  *)              ORG_KEY="personal"; ORG_LABEL="personal default (knofler) [custom dir]" ;;
esac

echo "ORG: $ORG_LABEL — config $CFG_DIR"

# --- forceLoginOrgID lockdown detection (managed settings) -----------------
# macOS managed-settings path; also honour a managed settings.json carrying the pin.
PINNED=""
for MS in \
  "/Library/Application Support/ClaudeCode/managed-settings.json" \
  "/etc/claude-code/managed-settings.json" \
  "$CFG_DIR/managed-settings.json"; do
  if [ -f "$MS" ] && grep -q 'forceLoginOrgID' "$MS" 2>/dev/null; then
    PINNED="$MS"
    break
  fi
done

if [ -n "$PINNED" ]; then
  echo "ORG: pinned (forceLoginOrgID via $PINNED) — switching disabled by design; mismatch guard skipped."
  exit 0
fi

# --- Mismatch guard against the per-repo org map ---------------------------
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
MAP=""
for CANDIDATE in "$ROOT/config/repo_org_map.txt" "$ROOT/AI/config/repo_org_map.txt"; do
  [ -f "$CANDIDATE" ] && { MAP="$CANDIDATE"; break; }
done

[ -z "$MAP" ] && exit 0   # no map -> repo defaults to personal, nothing to check

REPO_BASE=$(basename "$ROOT")
EXPECTED=""
# Match by full path first, then by repo basename. Skip comments/blank lines.
# Format: <repo-path-or-name><whitespace><org-key>
while IFS= read -r line; do
  # Strip leading whitespace so indented comments/blank lines are skipped too.
  trimmed=${line#"${line%%[![:space:]]*}"}
  case "$trimmed" in ''|\#*) continue ;; esac
  key=$(printf '%s\n' "$line" | awk '{print $1}')
  val=$(printf '%s\n' "$line" | awk '{print $2}')
  [ -z "$val" ] && continue
  if [ "$key" = "$ROOT" ] || [ "$key" = "$REPO_BASE" ]; then
    EXPECTED="$val"
    break
  fi
done < "$MAP"

[ -z "$EXPECTED" ] && exit 0   # repo not mapped -> defaults to personal, silent

if [ "$EXPECTED" != "$ORG_KEY" ]; then
  case "$EXPECTED" in
    museum) HINT="claude-museum" ;;
    tech)   HINT="claude-tech" ;;
    *)      HINT="claude" ;;
  esac
  echo "⚠ ORG MISMATCH: this repo ($REPO_BASE) is mapped to '$EXPECTED' but you're authed as '$ORG_KEY'. Run '$HINT' here to use the correct org."
else
  echo "ORG: repo '$REPO_BASE' matches mapped org '$EXPECTED' ✓"
fi

exit 0
