#!/usr/bin/env bash
# docker_gate.sh — ONE source of truth for "is Docker ready for myAI?" and, when
# it isn't, for telling a first-time user exactly what to do about it.
#
# Why this exists: a colleague ran `npm i -g ai-management` on a machine with no
# Docker. `myai setup` finished happily (it never looked), `myai up` died deep
# inside `docker compose`, and they never got a gateway — and never learned why.
# Only `myai doctor` noticed, as one terse line nobody ran. Everything myAI does
# locally (gateway, Mongo RAG, brain sync, runner, local CI) runs in Docker, so
# a missing engine has to be the LOUDEST thing on first run, not the quietest.
#
# Used by: scripts/myai_setup.sh (first-run gate + wait-and-resume),
# scripts/myai_up.sh (refuse before compose), bin/myai.cjs (doctor banner +
# --json remedy + the pending-resume reminder). Sourceable OR executable:
#
#   docker_gate.sh state            → missing|not-running|no-permission|no-compose|ok
#   docker_gate.sh os               → macos|linux|wsl|windows|other
#   docker_gate.sh explain [state]  → the full what/why/how block (state probed if omitted)
#   docker_gate.sh remedy [state]   → ONE line: the exact command / step for this OS
#   docker_gate.sh check            → exit 0 when ok; else explain to stderr, exit 3
#   docker_gate.sh wait [secs]      → poll until ok (exit 0) or timeout (exit 1)
#   docker_gate.sh pending-check    → the next-command reminder after a deferred setup
#
# Never installs anything itself — installing a system daemon is the user's call.
# Bash 3.2-safe (stock macOS). Tests: scripts/tests/test_docker_gate.sh
#
# Env:
#   MYAI_DOCKER_GATE_OS=<os>      override OS detection (tests)
#   MYAI_DOCKER_WAIT_TIMEOUT=900  wait budget in seconds
#   MYAI_DOCKER_WAIT_STEP=5       poll interval in seconds
#   MYAI_SKIP_DOCKER_GATE=1       callers skip the gate entirely (CI / hermetic tests)
#   MYAI_HOME                     marker lives at $MYAI_HOME/docker-pending

# ── probes ────────────────────────────────────────────────────────────────────

docker_gate_os() {
  if [ -n "${MYAI_DOCKER_GATE_OS:-}" ]; then printf '%s\n' "$MYAI_DOCKER_GATE_OS"; return 0; fi
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo macos ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo other ;;
  esac
}

# docker_gate_state — classify the engine. `docker info` is the only honest
# probe: the CLI can be installed with no daemon (Docker Desktop not started,
# systemd unit stopped) and that is the commonest "it's installed, why not?".
docker_gate_state() {
  command -v docker >/dev/null 2>&1 || { echo missing; return 0; }
  local err
  if ! err="$(docker info --format '{{.ServerVersion}}' 2>&1 >/dev/null)"; then
    case "$err" in
      *"permission denied"*|*"Permission denied"*) echo no-permission ;;
      *) echo not-running ;;
    esac
    return 0
  fi
  docker compose version >/dev/null 2>&1 || { echo no-compose; return 0; }
  echo ok
}

docker_gate_marker() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}/docker-pending"; }

# ── words ─────────────────────────────────────────────────────────────────────

# docker_gate_remedy [state] [os] — the single next action, as one line.
docker_gate_remedy() {
  local state="${1:-$(docker_gate_state)}" os="${2:-$(docker_gate_os)}"
  case "$state:$os" in
    ok:*) echo "Docker is ready." ;;
    missing:macos)  echo "Install Docker Desktop: brew install --cask docker   (or download https://www.docker.com/products/docker-desktop/), then open Docker once" ;;
    missing:linux)  echo "Install Docker Engine: curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker \$USER   (then log out and back in)" ;;
    missing:wsl)    echo "Install Docker Desktop for Windows (https://docs.docker.com/desktop/setup/install/windows-install/) and turn on WSL integration for this distro" ;;
    missing:windows) echo "Install Docker Desktop for Windows: https://docs.docker.com/desktop/setup/install/windows-install/" ;;
    missing:*)      echo "Install Docker: https://docs.docker.com/get-docker/" ;;
    not-running:macos) echo "Start Docker: open -a Docker   (wait for the whale icon to stop animating)" ;;
    not-running:linux) echo "Start Docker: sudo systemctl enable --now docker" ;;
    not-running:wsl|not-running:windows) echo "Start Docker Desktop on Windows (and check Settings → Resources → WSL integration)" ;;
    not-running:*)  echo "Start the Docker engine" ;;
    no-permission:*) echo "Let your user talk to Docker: sudo usermod -aG docker \$USER && newgrp docker" ;;
    no-compose:linux) echo "Install the Compose plugin: sudo apt-get install docker-compose-plugin   (dnf: sudo dnf install docker-compose-plugin)" ;;
    no-compose:*)   echo "Update Docker Desktop — it ships 'docker compose' v2" ;;
    *)              echo "See https://docs.docker.com/get-docker/" ;;
  esac
}

docker_gate_headline() {
  case "$1" in
    missing)       echo "Docker is not installed" ;;
    not-running)   echo "Docker is installed but not running" ;;
    no-permission) echo "Docker is running but your user can't use it" ;;
    no-compose)    echo "Docker Compose v2 is missing" ;;
    *)             echo "Docker is ready" ;;
  esac
}

# docker_gate_explain [state] — what Docker is, why myAI needs it, and the exact
# step for THIS machine. Plain text (no colour) so it reads the same in a TTY,
# a log, a CI transcript and `myai doctor`.
docker_gate_explain() {
  local state="${1:-$(docker_gate_state)}" os; os="$(docker_gate_os)"
  [ "$state" = ok ] && { echo "Docker is ready."; return 0; }
  cat <<EOF

  ┌──────────────────────────────────────────────────────────────────┐
  │  DOCKER REQUIRED — $(printf '%-46s' "$(docker_gate_headline "$state")")│
  └──────────────────────────────────────────────────────────────────┘

  What it is: Docker runs small, self-contained "containers" on your machine.
  Why myAI needs it: your whole local stack runs in Docker — the gateway
  (MCP + API), Mongo with RAG search, brain sync, the background runner and
  local CI. Without it you get the CLI but none of the stack.

  Do this ($os):
    $(docker_gate_remedy "$state" "$os")
EOF
  if [ "$os" = macos ] && [ "$state" = missing ]; then
    cat <<'EOF'
    Apple silicon and Intel both work — the download page picks the right one.
EOF
  fi
  cat <<'EOF'

  Then check with:  myai doctor
EOF
}

# ── actions ───────────────────────────────────────────────────────────────────

# docker_gate_try_start — best-effort, no sudo: on macOS launch Docker Desktop
# if it is installed but stopped. Returns 0 when a start was attempted.
docker_gate_try_start() {
  [ "$(docker_gate_os)" = macos ] || return 1
  command -v open >/dev/null 2>&1 || return 1
  open -a Docker >/dev/null 2>&1
}

# docker_gate_wait [timeout_secs] — block until the gate reads ok. Dots on
# stderr so a user can see it is alive; never prompts.
docker_gate_wait() {
  local timeout="${1:-${MYAI_DOCKER_WAIT_TIMEOUT:-900}}" step="${MYAI_DOCKER_WAIT_STEP:-5}"
  case "$timeout" in ''|*[!0-9]*) timeout=900 ;; esac
  case "$step" in ''|*[!0-9]*|0) step=5 ;; esac
  local waited=0
  while :; do
    [ "$(docker_gate_state)" = ok ] && { [ "$waited" -gt 0 ] && echo >&2; return 0; }
    [ "$waited" -ge "$timeout" ] && { echo >&2; return 1; }
    printf '.' >&2
    sleep "$step"
    waited=$((waited + step))
  done
}

docker_gate_mark_pending() {
  local m; m="$(docker_gate_marker)"
  mkdir -p "$(dirname "$m")" 2>/dev/null && date -u +%Y-%m-%dT%H:%M:%SZ > "$m" 2>/dev/null || true
}
docker_gate_clear_pending() { rm -f "$(docker_gate_marker)" 2>/dev/null || true; }

# docker_gate_pending_check — called by bin/myai.cjs on the next command after
# a setup that finished without Docker. Still missing → one-line reminder;
# now up → clear the marker and point at `myai up`. Silent with no marker.
docker_gate_pending_check() {
  [ -f "$(docker_gate_marker)" ] || return 0
  local state; state="$(docker_gate_state)"
  if [ "$state" = ok ]; then
    docker_gate_clear_pending
    echo "myai: Docker is up now — run 'myai up' to start your myAI stack." >&2
  else
    echo "myai: setup is waiting on Docker ($(docker_gate_headline "$state")). $(docker_gate_remedy "$state")" >&2
  fi
}

# ── CLI ───────────────────────────────────────────────────────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  cmd="${1:-state}"; [ $# -gt 0 ] && shift
  case "$cmd" in
    state)  docker_gate_state ;;
    os)     docker_gate_os ;;
    explain) docker_gate_explain "${1:-}" ;;
    remedy) docker_gate_remedy "${1:-}" ;;
    check)
      s="$(docker_gate_state)"
      [ "$s" = ok ] && exit 0
      docker_gate_explain "$s" >&2; exit 3 ;;
    wait)   docker_gate_wait "${1:-}" ;;
    pending-check) docker_gate_pending_check ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) echo "docker_gate: unknown command: $cmd" >&2; exit 2 ;;
  esac
fi
