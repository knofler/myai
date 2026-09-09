#!/bin/bash
set +e
# Hook: Permission Mode Guard
#
# ALARMS when a session would fall back to manual (prompting) permission mode.
#
# WHY THIS EXISTS (2026-09-03): the operator gets a prompt on every tool call
# while the config says otherwise, and nothing announces that. This hook makes
# the state of the permission mode LOUD instead of silent.
#
# WHAT IT DOES NOT CLAIM (corrected 2026-09-03 after RAG recall of PR #146/#147):
# `permissions.defaultMode: "bypassPermissions"` in the COMMITTED
# .claude/settings.json is DELIBERATE FLEET POLICY — PR #147, operator direction
# verbatim: "make it policy level ... never any prompt allowed at all" — and it
# was propagated to 23 managed repos alongside skipDangerousModePermissionPrompt
# and skipAutoPermissionPrompt. An earlier draft of this hook alarmed on that
# exact placement, calling it ineffective. That was an unproven inference and it
# would have cried wolf on every repo in the fleet. It is gone.
#
# So this hook reports FACTS and never asserts a mechanism it cannot verify:
#   - nothing declares bypass anywhere            -> ALARM (unambiguous)
#   - managed ORG POLICY disables bypass          -> ALARM (not locally fixable)
#   - a runtime mode signal says non-bypass       -> ALARM (authoritative)
#   - bypass declared, no runtime signal to check -> one quiet NOTE, not an alarm
#     (a hook cannot observe the effective mode; only /permissions can)
#
# Warn-only. Never blocks. Exit 0 always.

REPO_ROOT="${MYAI_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "$REPO_ROOT" ]; then
    # Real precondition failure (no MYAI_ROOT override and git rev-parse
    # failed to resolve a root), not "nothing to alarm on" — same incident
    # class as hooks/session/17-schedule-status.sh. Warn instead of vanishing
    # silently: an operator relying on this hook to catch a manual-mode
    # regression would otherwise see the same quiet output as a healthy pass.
    echo "29-permission-mode-guard: cannot resolve repo (not a git repository) — permission mode check skipped" >&2
    exit 0
fi
command -v jq >/dev/null 2>&1 || exit 0

PROFILE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# Managed paths are overridable ONLY so the test suite can exercise the
# org-policy branch; production leaves them at the real OS locations.
MANAGED_1="${MYAI_MANAGED_SETTINGS_1:-/Library/Application Support/ClaudeCode/managed-settings.json}"
MANAGED_2="${MYAI_MANAGED_SETTINGS_2:-/etc/claude-code/managed-settings.json}"
USER_S="$PROFILE_DIR/settings.json"
PROJ_S="$REPO_ROOT/.claude/settings.json"
LOCAL_S="$REPO_ROOT/.claude/settings.local.json"

read_mode() {
  [ -f "$1" ] || return 0
  jq -r '.permissions.defaultMode // ""' "$1" 2>/dev/null
}
read_disable() {
  [ -f "$1" ] || return 0
  jq -r '.permissions.disableBypassPermissionsMode // ""' "$1" 2>/dev/null
}

BYPASS="bypassPermissions"
# "auto" is the sanctioned zero-prompt mode since Team/Enterprise orgs gained a
# server-side policy that disables bypass (observed 2026-09-03; fleet default
# moved to auto 2026-09-07 via scripts/rollout_permission_mode.sh). Either
# counts as NOT manual.
is_ok_mode() { [ "$1" = "$BYPASS" ] || [ "$1" = "auto" ]; }

# --- sources that CAN grant bypass: managed policy, or the user/profile file ---
GRANTING=""
for f in "$MANAGED_1" "$MANAGED_2" "$USER_S"; do
  is_ok_mode "$(read_mode "$f")" &&GRANTING="$f" && break
done

# --- every source that declares bypass, granting or not ---
DECLARED=""
for f in "$MANAGED_1" "$MANAGED_2" "$USER_S" "$PROJ_S" "$LOCAL_S"; do
  is_ok_mode "$(read_mode "$f")" &&DECLARED="$DECLARED $f"
done

# --- org policy explicitly disabling bypass beats everything ---
POLICY_BLOCK=""
for f in "$MANAGED_1" "$MANAGED_2"; do
  [ "$(read_disable "$f")" = "disable" ] && POLICY_BLOCK="$f" && break
done

# --- prefer a real runtime signal if one ever exists ---
RUNTIME_MODE="${CLAUDE_PERMISSION_MODE:-}"

alarm() {
  printf '\033[1;41;97m %s \033[0m\n' "PERMISSION MODE ALARM — SESSION IS IN MANUAL MODE"
  printf '\033[1;31m'
  echo "  $1"
  printf '\033[0m'
  shift
  for line in "$@"; do echo "     $line"; done
  echo "     Every tool call will prompt until this is fixed."
}

# A runtime signal, when present, is authoritative in BOTH directions:
# it alarms on a bad mode and it silences the config checks on a good one.
if [ -n "$RUNTIME_MODE" ]; then
  if ! is_ok_mode "$RUNTIME_MODE"; then
    alarm "runtime mode is '$RUNTIME_MODE', not bypassPermissions/auto." \
          "Source: CLAUDE_PERMISSION_MODE env var (authoritative)."
  fi
  exit 0
fi

if [ -n "$POLICY_BLOCK" ]; then
  alarm "ORG POLICY disables bypass mode — this is NOT fixable in this repo." \
        "Set by: $POLICY_BLOCK" \
        "disableBypassPermissionsMode=disable overrides every local setting." \
        "Escalate to whoever administers the managed Claude Code policy."
  exit 0
fi

if [ -n "$GRANTING" ]; then
  # correctly configured — stay silent, like every other healthy hook here
  exit 0
fi

if [ -n "$DECLARED" ]; then
  # Declared somewhere. A hook cannot see the EFFECTIVE mode, so do not pretend
  # to. One quiet line, only when it is not declared in a granting source, so a
  # fully-configured machine stays silent like every other healthy hook here.
  if [ -z "$GRANTING" ]; then
    printf '\033[2mpermission mode: bypass/auto declared in%s (fleet policy, PR #147; auto since 2026-09-07).\033[0m\n' "$DECLARED"
    printf '\033[2m  Cannot verify the EFFECTIVE mode from a hook. If tools still prompt, check /permissions;\033[0m\n'
    printf '\033[2m  the two known causes are a server-side org policy and a profile-level override.\033[0m\n'
  fi
  exit 0
fi

alarm "no bypassPermissions/auto declaration found in any settings source." \
      "Checked: managed policy, $USER_S," \
      "         $PROJ_S, $LOCAL_S" \
      "FIX: add \"permissions\": {\"defaultMode\": \"auto\"} to" \
      "     $USER_S"
exit 0
