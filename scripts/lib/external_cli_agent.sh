#!/usr/bin/env bash
# external_cli_agent.sh — sourceable helper: L4 EXTERNAL-CLI agentic backends
# (Codex CLI, Antigravity CLI, Copilot CLI) as CLI_CMD-style runner
# engines, parallel to the existing `claude -p` dispatch. plan/
# MULTI_PROVIDER_ORCHESTRATION.md §5 L4, task-6f8dd2c1; agy/copilot vendors +
# per-vendor gates: task-7fd4320e (operator 2026-10-02: agy and the runner do
# the work; the master only directs). Gemini CLI removed as a vendor entirely
# (task-5a8c09ca, operator 2026-10-02: "kill Gemini as an option... AGY will
# do it for me") — `gemini-cli` may still be installed on a machine, but this
# lane no longer dispatches to it under any model id or env var.
#
# Unlike agentic_fallback.sh (DeepSeek/Kimi via an OpenAI-compatible tool-loop
# driven by scripts/lib/openai_agent.py, since those are plain chat-completion
# APIs with no agentic shell/file loop of their own), these CLIs are themselves
# full non-interactive coding agents — like `claude -p`, they read the task
# prompt, edit files, run shell commands, and are expected to git add/commit/
# push + emit the RESULT: line THEMSELVES, per the very same prompt text the
# Claude lane receives (built once in cli_task_runner.sh, handed to every lane
# on stdin). So this file does NOT drive a tool loop and does NOT touch git —
# it only resolves which binary a model id maps to, gates the lane behind an
# opt-in switch plus a per-vendor enable, and dispatches. The runner's existing
# worktree / watchdog / RESULT-line parsing are reused completely unchanged.
#
# Vendors and their default posture (per-vendor enables, all still behind the
# master EXTERNAL_CLI_AGENTIC=off switch; config/runner_lanes.txt flips these
# per host, an explicit env pin always outranks):
#   codex    on   — ChatGPT-sub billed, `codex exec`
#   agy      on   — Antigravity (paid Google sub, session-based): `agy -p
#                   <prompt> --print-timeout …`. REPLACES the Gemini CLI, whose
#                   personal sign-in Google now rejects (operator 2026-10-02).
#   copilot  off  — optional (GitHub Copilot CLI); NOTE: the homebrew `copilot`
#                   binary is AWS Copilot — point COPILOT_CLI_BIN at the GitHub
#                   Copilot CLI before enabling.
#
# Not executed directly — sourced by cli_task_runner.sh (and the test suite).

EXTERNAL_CLI_AGENTIC=${EXTERNAL_CLI_AGENTIC:-off}
CODEX_CLI_ENABLED=${CODEX_CLI_ENABLED:-on}
AGY_CLI_ENABLED=${AGY_CLI_ENABLED:-on}
COPILOT_CLI_ENABLED=${COPILOT_CLI_ENABLED:-off}

CODEX_CLI_BIN=${CODEX_CLI_BIN:-codex}
AGY_CLI_BIN=${AGY_CLI_BIN:-agy}
COPILOT_CLI_BIN=${COPILOT_CLI_BIN:-copilot}

# Non-interactive invocation flags — word-split on call (bash 3.2-safe, same
# convention as $CLI_MODELS/$CLI_MCP_ARGS elsewhere in this runner). Override
# for a deliberate one-off without touching this file.
CODEX_CLI_ARGS=${CODEX_CLI_ARGS:-"exec --sandbox workspace-write --skip-git-repo-check"}
# agy: --print-timeout bounds the turn (0 = wait forever — never that in an
# unattended runner; 45m matches the runner's own wall-clock watchdog), and
# --dangerously-skip-permissions is the headless auto-approve (the runner's
# worktree isolation + watchdog are the rails, same as `claude -p`'s auto mode).
AGY_CLI_ARGS=${AGY_CLI_ARGS:-"--dangerously-skip-permissions --print-timeout 45m"}
COPILOT_CLI_ARGS=${COPILOT_CLI_ARGS:-"--allow-all-tools"}
# Optional per-vendor model override (e.g. CODEX_CLI_MODEL=o3, AGY_CLI_MODEL=gemini-3-pro).
CODEX_CLI_MODEL=${CODEX_CLI_MODEL:-}
AGY_CLI_MODEL=${AGY_CLI_MODEL:-}
COPILOT_CLI_MODEL=${COPILOT_CLI_MODEL:-}

# external_cli_model_match <model> — rc 0 when the model id belongs to this
# lane (bare vendor name or a "vendor-*" alias — same convention as
# agentic_model_match in agentic_fallback.sh). "antigravity" aliases "agy".
external_cli_model_match() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        codex|codex-*|agy|agy-*|antigravity|antigravity-*|copilot|copilot-*) return 0 ;;
        *) return 1 ;;
    esac
}

# external_cli_provider_name <model> — canonical vendor label (dashboard/
# execution-provider stamp), distinct from any exact aliased model id.
external_cli_provider_name() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        codex|codex-*)                       printf 'codex' ;;
        agy|agy-*|antigravity|antigravity-*) printf 'agy' ;;
        copilot|copilot-*)                   printf 'copilot' ;;
        *) return 1 ;;
    esac
}

# external_cli_bin <model> — resolved binary for the model's vendor (override
# with CODEX_CLI_BIN / AGY_CLI_BIN / COPILOT_CLI_BIN).
external_cli_bin() {
    case "$(external_cli_provider_name "$1" 2>/dev/null)" in
        codex)   printf '%s' "$CODEX_CLI_BIN" ;;
        agy)     printf '%s' "$AGY_CLI_BIN" ;;
        copilot) printf '%s' "$COPILOT_CLI_BIN" ;;
        *) return 1 ;;
    esac
}

# external_cli_vendor_enabled <provider> — rc 0 when that vendor's per-vendor
# enable is "on". Prints the reason it is not (for the runner log) on rc 1.
external_cli_vendor_enabled() {
    local v
    case "${1:-}" in
        codex)   v="$CODEX_CLI_ENABLED";   [ "$v" = on ] && return 0; echo "vendor 'codex' disabled (CODEX_CLI_ENABLED=$v)" ;;
        agy)     v="$AGY_CLI_ENABLED";     [ "$v" = on ] && return 0; echo "vendor 'agy' disabled (AGY_CLI_ENABLED=$v)" ;;
        copilot) v="$COPILOT_CLI_ENABLED"; [ "$v" = on ] && return 0; echo "vendor 'copilot' disabled (COPILOT_CLI_ENABLED=$v — optional, off by default)" ;;
        *) echo "unknown external-CLI vendor '${1:-}'" ;;
    esac
    return 1
}

# external_cli_ready <model> — rc 0 when the lane may engage for this model:
# opt-in switch ON, the vendor's per-vendor enable ON, and the vendor's binary
# resolvable on PATH. Prints the human reason it is NOT ready on rc 1 (for the
# runner log), same convention as agentic_fallback_ready.
external_cli_ready() {
    local model="${1:-}" provider bin reason
    if [ "$EXTERNAL_CLI_AGENTIC" != "on" ]; then
        echo "lane disabled (EXTERNAL_CLI_AGENTIC=off)"; return 1
    fi
    provider="$(external_cli_provider_name "$model")" || { echo "unknown external-CLI vendor for model '$model'"; return 1; }
    if ! reason="$(external_cli_vendor_enabled "$provider")"; then
        echo "$reason"; return 1
    fi
    bin="$(external_cli_bin "$model")"
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "'$bin' not found on PATH"; return 1
    fi
    return 0
}

# external_cli_agy_model <model-id> <bin> — resolves agy's --model value.
# Precedence (same "explicit env pin always outranks" convention as every
# other per-host override in this file):
#   1. AGY_CLI_MODEL, if set — used as-is, no validation (operator's call).
#   2. the "agy-<x>" / "antigravity-<x>" suffix of <model-id> (a task's
#      recommendedModel), IF <x> is actually listed by `<bin> models` —
#      task-9c81300e: before this, the suffix was silently dropped and only
#      AGY_CLI_MODEL could ever pick a non-default Gemini model.
#   3. empty — no --model flag, agy uses its own default. Always the result
#      for plain "agy"/"antigravity" (no suffix), unchanged from before.
# An unrecognized/unlisted suffix is reported on stderr (visible in the
# runner log, never mixed into the resolved value on stdout) and dropped
# rather than risk handing the CLI a flag value it would reject outright.
external_cli_agy_model() {
    local model="${1:-}" bin="${2:-}" lower suffix models_out
    if [ -n "$AGY_CLI_MODEL" ]; then
        printf '%s' "$AGY_CLI_MODEL"
        return 0
    fi
    lower="$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
        agy-*|antigravity-*) suffix="${model#*-}" ;;
        *) return 0 ;;
    esac
    [ -n "$suffix" ] || return 0
    if models_out="$("$bin" models </dev/null 2>/dev/null)" && printf '%s\n' "$models_out" | grep -Fq -- "$suffix"; then
        printf '%s' "$suffix"
    else
        echo "[external-cli] agy model suffix '$suffix' not listed by '$bin models' — dispatching without --model" >&2
    fi
}

# external_cli_run WORKDIR MODEL [TASK-ID] — public entry point (task prompt
# on stdin, identical text the Claude lane receives — including its own
# branch/push/commit/RESULT-line rules). rc is exactly the CLI's own exit
# code: the runner's existing close-off (grep LOG_FILE for the account-limit
# signature, the RESULT: line, etc.) treats every lane's log the same way, so
# this function stays a thin dispatcher and never inspects the CLI's output
# itself. WORKDIR is already on the correct branch (isolated per-task worktree
# or shared 'test') by the time any model in the chain runs — this function
# must NOT touch git (a stray checkout here would fight the worktree isolation
# rails set up earlier in cli_task_runner.sh).
external_cli_run() {
    local workdir="$1" model="$2" task_id="${3:-}" not_ready provider bin prompt rc agy_model
    if ! not_ready="$(external_cli_ready "$model")"; then
        echo "[external-cli] $not_ready — skipping"
        return 1
    fi
    provider="$(external_cli_provider_name "$model")"
    bin="$(external_cli_bin "$model")"
    echo "[external-cli] dispatching task${task_id:+ $task_id} to $provider ($bin) in $workdir"
    case "$provider" in
        codex)
            # `codex exec` reads its instructions from stdin when no PROMPT
            # positional is given — pass the prompt straight through.
            ( cd "$workdir" && "$bin" $CODEX_CLI_ARGS ${CODEX_CLI_MODEL:+-m "$CODEX_CLI_MODEL"} )
            rc=$?
            ;;
        agy)
            # `agy -p` (--print) takes the prompt as the flag's VALUE (same
            # shape as --prompt, its documented alias) — buffer stdin first.
            # --model is agy's long-only model flag: AGY_CLI_MODEL always
            # wins; otherwise a "agy-<x>"/"antigravity-<x>" recommendedModel
            # suffix is honored IF `agy models` lists <x> (task-9c81300e —
            # external_cli_agy_model). Plain `agy`/`antigravity` (no suffix)
            # stays unchanged — no --model flag.
            prompt="$(cat)"
            agy_model="$(external_cli_agy_model "$model" "$bin")"
            ( cd "$workdir" && "$bin" $AGY_CLI_ARGS ${agy_model:+--model "$agy_model"} -p "$prompt" )
            rc=$?
            ;;
        copilot)
            # GitHub Copilot CLI: prompt as -p's value, --allow-all-tools for
            # headless auto-approve.
            prompt="$(cat)"
            ( cd "$workdir" && "$bin" $COPILOT_CLI_ARGS ${COPILOT_CLI_MODEL:+--model "$COPILOT_CLI_MODEL"} -p "$prompt" )
            rc=$?
            ;;
        *)
            echo "[external-cli] no invocation recipe for vendor '$provider'"
            return 1
            ;;
    esac
    return "$rc"
}
