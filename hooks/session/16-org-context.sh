#!/usr/bin/env bash
# 16-org-context.sh — Surface the active Claude org at session start (Multi-Org-Auth Phase 4).
#
# Multiple Claude orgs run side by side on one machine via CLAUDE_CONFIG_DIR
# (one persistent authenticated session per config dir). This hook makes the
# ACTIVE org obvious at session start — like the machine/docker banners — and
# guards against working in a repo under the wrong org.
#
# OPERATOR-ONLY, CONFIG-GATED (v1 G1 ruling 2026-10-22): the org data — which
# config dir is which org, its banner label, the org UUID/name a profile must be
# signed into, and the launcher to suggest — lives in operator_org_policy.conf
# (`profile|…` and `org|…` records), which is NOT shipped. Without that file
# this hook prints nothing. Lookup: $MYAI_OPERATOR_POLICY (a file, or "none"),
# then ~/.myai/operator_org_policy.conf, then config/ next to this hook's repo.
#
# Resolution: the `profile|<basename of $CLAUDE_CONFIG_DIR>|<org key>|<label>`
# record, else the `profile|*|…` one.
#
# Mismatch guard: if config/repo_org_map.txt assigns this repo to an org and the
# active org differs, warn. The map is optional — with no entry the guard
# stays silent.
#
# Login check: a profile whose `org|<key>|<uuid>|<name>|…` record carries a
# UUID must actually be signed into that org — the folder name alone proves
# nothing. Mismatch prints ⚠ ORG LOGIN MISMATCH.
#
# forceLoginOrgUUID lockdown: on managed/shared machines Enterprise pins the org
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

# --- Operator policy file (absent → silent) --------------------------------
_op_policy_file() {
  local here cand
  case "${MYAI_OPERATOR_POLICY:-}" in
    none) return 1 ;;
    '') ;;
    *) [ -f "$MYAI_OPERATOR_POLICY" ] || return 1; printf '%s' "$MYAI_OPERATOR_POLICY"; return 0 ;;
  esac
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
  for cand in "${MYAI_HOME:-$HOME/.myai}/operator_org_policy.conf" "$here/config/operator_org_policy.conf"; do
    [ -f "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}
POLICY="$(_op_policy_file)" || exit 0
# _op_rec <type> <key> → the first "<type>|<key>|…" record, else "<type>|*|…".
_op_rec() {
  awk -F'|' -v t="$1" -v k="$2" '
    $1 == t && $2 == k && !hit { hit = $0 }
    $1 == t && $2 == "*" && !any { any = $0 }
    END { if (hit != "") print hit; else if (any != "") print any }' "$POLICY" 2>/dev/null
}

# --- Resolve active org from the config dir --------------------------------
CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CFG_BASE=$(basename "$CFG_DIR")

REC="$(_op_rec profile "$CFG_BASE")"
[ -n "$REC" ] || exit 0
IFS='|' read -r _ _ ORG_KEY ORG_LABEL <<EOF
$REC
EOF

echo "ORG: $ORG_LABEL — config $CFG_DIR"

# --- Verify the REAL login, not just the folder name ------------------------
# The label above is derived from the folder name only. On one Mac (2026-09-28)
# every profile was signed into the personal org while this banner named the
# work org — Remote Control links then belonged to the wrong org and the phone
# reported "session could not be found". Read oauthAccount and compare against
# the org record's UUID; a record with no UUID has no expectation.
EXPECT_UUID=""; EXPECT_NAME=""
IFS='|' read -r _ _ EXPECT_UUID EXPECT_NAME _ <<EOF
$(_op_rec org "$ORG_KEY")
EOF
# ~/.claude keeps its login at ~/.claude.json; the other dirs keep it inside.
AUTH_JSON="${ORG_AUTH_JSON:-$CFG_DIR/.claude.json}"
[ -f "$AUTH_JSON" ] || AUTH_JSON="$HOME/.claude.json"
if [ -n "$EXPECT_UUID" ]; then
  ACTUAL=""
  if [ -f "$AUTH_JSON" ] && command -v python3 >/dev/null 2>&1; then
    ACTUAL=$(python3 -c 'import json,sys
a=(json.load(open(sys.argv[1])).get("oauthAccount") or {})
print((a.get("organizationUuid") or "")+"|"+(a.get("organizationName") or ""))' "$AUTH_JSON" 2>/dev/null)
  fi
  ACTUAL_UUID=${ACTUAL%%|*}
  ACTUAL_NAME=${ACTUAL#*|}
  if [ -z "$ACTUAL_UUID" ]; then
    echo "ORG: login not verified — no oauthAccount readable in $AUTH_JSON (signed out, or python3 missing)"
  elif [ "$ACTUAL_UUID" = "$EXPECT_UUID" ]; then
    echo "ORG: login verified — signed into $ACTUAL_NAME ✓"
  else
    echo "⚠ ORG LOGIN MISMATCH: profile $CFG_BASE should be '$EXPECT_NAME' but is signed into '$ACTUAL_NAME' ($ACTUAL_UUID). Remote Control links from this session will not show under $EXPECT_NAME. Fix: /logout, then /login with your work account and pick $EXPECT_NAME."
  fi
fi

# --- forceLoginOrgUUID lockdown detection (managed settings) ---------------
# The real key is forceLoginOrgUUID, and Claude Code enforces it ONLY from
# managed settings (it is machine-wide, so it cannot pin one profile). The old
# spelling forceLoginOrgID is still matched so a legacy file keeps reporting.
PINNED=""
for MS in \
  "/Library/Application Support/ClaudeCode/managed-settings.json" \
  "/etc/claude-code/managed-settings.json"; do
  if [ -f "$MS" ] && grep -qE 'forceLoginOrg(UUID|ID)' "$MS" 2>/dev/null; then
    PINNED="$MS"
    break
  fi
done

if [ -n "$PINNED" ]; then
  echo "ORG: pinned (forceLoginOrgUUID via $PINNED) — switching disabled by design; mismatch guard skipped."
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
  HINT=""
  IFS='|' read -r _ _ _ _ HINT <<EOF
$(_op_rec org "$EXPECTED")
EOF
  [ -n "$HINT" ] || HINT="claude"
  echo "⚠ ORG MISMATCH: this repo ($REPO_BASE) is mapped to '$EXPECTED' but you're authed as '$ORG_KEY'. Run '$HINT' here to use the correct org."
else
  echo "ORG: repo '$REPO_BASE' matches mapped org '$EXPECTED' ✓"
fi

exit 0
