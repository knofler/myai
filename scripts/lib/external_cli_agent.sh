#!/usr/bin/env bash
# external_cli_agent.sh — sourceable helper: L4 EXTERNAL-CLI agentic backends
# (Codex CLI, Gemini CLI) as CLI_CMD-style runner engines, parallel to the
# existing `claude -p` dispatch. plan/MULTI_PROVIDER_ORCHESTRATION.md §5 L4
# ("CLI_CMD abstraction noted in runner (Future: codex, gemini)"), task-6f8dd2c1.
#
# Unlike agentic_fallback.sh (DeepSeek/Kimi via an OpenAI-compatible tool-loop
# driven by scripts/lib/openai_agent.py, since those are plain chat-completion
# APIs with no agentic shell/file loop of their own), Codex CLI (`codex exec`)
# and Gemini CLI (`gemini -p`) are themselves full non-interactive coding
# agents — like `claude -p`, they read the task prompt, edit files, run shell
# commands, and are expected to git add/commit/push + emit the RESULT: line
# THEMSELVES, per the very same prompt text the Claude lane receives (built
# once in cli_task_runner.sh, handed to every lane on stdin). So this file does
# NOT drive a tool loop and does NOT touch git — it only resolves which binary
# a model id maps to, gates the whole lane behind an opt-in switch (mirrors
# AGENTIC_FALLBACK's default-off posture — these CLIs bill their own
# subscription/API separately from the Claude pool), and dispatches. The
# runner's existing worktree (already checked out onto the right branch before
# any model in the chain runs) / watchdog (resource_watchdog wraps the
# backgrounded PID exactly like every other lane) / RESULT-line parsing
# (LOG_FILE is grepped for '^RESULT: ' regardless of which lane wrote it) are
# reused completely unchanged.
#
# Not executed directly — sourced by cli_task_runner.sh (and the test suite).

EXTERNAL_CLI_AGENTIC=${EXTERNAL_CLI_AGENTIC:-off}
CODEX_CLI_BIN=${CODEX_CLI_BIN:-codex}
GEMINI_CLI_BIN=${GEMINI_CLI_BIN:-gemini}
# Non-interactive invocation flags — word-split on call (bash 3.2-safe, same
# convention as $CLI_MODELS/$CLI_MCP_ARGS elsewhere in this runner). Override
# for a deliberate one-off without touching this file.
CODEX_CLI_ARGS=${CODEX_CLI_ARGS:-"exec --sandbox workspace-write --skip-git-repo-check"}
GEMINI_CLI_ARGS=${GEMINI_CLI_ARGS:-"--yolo"}
# Optional per-vendor model override (e.g. CODEX_CLI_MODEL=o3, GEMINI_CLI_MODEL=gemini-2.5-pro).
CODEX_CLI_MODEL=${CODEX_CLI_MODEL:-}
GEMINI_CLI_MODEL=${GEMINI_CLI_MODEL:-}

# external_cli_model_match <model> — rc 0 when the model id belongs to this
# lane (bare "codex"/"gemini" or a "codex-*"/"gemini-*" alias — same
# "vendor-*" convention as agentic_model_match in agentic_fallback.sh).
external_cli_model_match() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        codex|codex-*|gemini|gemini-*) return 0 ;;
        *) return 1 ;;
    esac
}

# external_cli_provider_name <model> — canonical vendor label (dashboard/
# execution-provider stamp), distinct from any exact aliased model id.
external_cli_provider_name() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        codex|codex-*)   printf 'codex' ;;
        gemini|gemini-*) printf 'gemini' ;;
        *) return 1 ;;
    esac
}

# external_cli_bin <model> — resolved binary for the model's vendor (override
# with CODEX_CLI_BIN / GEMINI_CLI_BIN, same override convention as CLI_CMD).
external_cli_bin() {
    case "$(external_cli_provider_name "$1" 2>/dev/null)" in
        codex)  printf '%s' "$CODEX_CLI_BIN" ;;
        gemini) printf '%s' "$GEMINI_CLI_BIN" ;;
        *) return 1 ;;
    esac
}

# external_cli_ready <model> — rc 0 when the lane may engage for this model:
# opt-in switch ON and the vendor's binary resolvable on PATH. Prints the
# human reason it is NOT ready on rc 1 (for the runner log), same convention
# as agentic_fallback_ready.
external_cli_ready() {
    local model="${1:-}" bin
    if [ "$EXTERNAL_CLI_AGENTIC" != "on" ]; then
        echo "lane disabled (EXTERNAL_CLI_AGENTIC=off)"; return 1
    fi
    bin="$(external_cli_bin "$model")" || { echo "unknown external-CLI vendor for model '$model'"; return 1; }
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "'$bin' not found on PATH"; return 1
    fi
    return 0
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
    local workdir="$1" model="$2" task_id="${3:-}" not_ready provider bin prompt rc
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
        gemini)
            # `gemini -p` takes the prompt as a flag VALUE (stdin is only
            # appended alongside it, not read as the whole prompt) — buffer
            # stdin into a variable first.
            prompt="$(cat)"
            ( cd "$workdir" && "$bin" $GEMINI_CLI_ARGS ${GEMINI_CLI_MODEL:+-m "$GEMINI_CLI_MODEL"} -p "$prompt" )
            rc=$?
            ;;
        *)
            echo "[external-cli] no invocation recipe for vendor '$provider'"
            return 1
            ;;
    esac
    return "$rc"
}
