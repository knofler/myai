# shellcheck shell=bash
# local_ci_runner.sh — "runner mode" for local-ci.sh: run the Node /
# tsc / vitest / coverage gates INSIDE the warm self-hosted GitHub Actions
# runner container (via `docker exec`) instead of spinning up an ad-hoc
# `docker run node:22` per gate.
#
# WHY: on a host that already has a myai-gh-runner container running, that
# container IS the environment real CI uses (ubuntu 24.04 + the pinned Node,
# glibc, git, python3, shellcheck). Reusing it gives ONE warm toolchain that
# matches ubuntu-latest exactly — no per-gate image pull, no alpine/musl
# surprises (the very reason check_runtime_coverage already pins node:22 over
# node:22-alpine), and no extra RAM from parallel throwaway containers.
#
# HARD CONSTRAINT (non-negotiable): the runner has NO docker socket and MUST
# NOT get one — any CI job it runs could otherwise control the host's Docker.
# So we never mount docker.sock into it; runner mode drives it from the HOST's
# docker CLI via `docker exec`, staging the checkout in with
# `git archive | tar -x`. The runner only ever runs node/npm/git — never docker.
#
# NEVER STARVE A REAL CI JOB: if the runner is busy running a GitHub Actions
# job, runner mode yields to ad-hoc docker so local-ci never competes with it
# for the runner's cores.
#
# FALLS BACK CLEANLY: on a host with no runner (or no docker, or an explicit
# LOCAL_CI_MODE=docker) every resolver returns `docker` and local-ci behaves
# exactly as it did before this lib existed.
#
# Pure helpers, sourced by scripts/local-ci.sh and unit-tested hermetically in
# scripts/tests/test_local_ci_runner_mode.sh (docker/gh stubbed). No side
# effects at source time beyond setting the defaults below.

# Container that hosts the warm toolchain. LOCAL_CI_RUNNER_CONTAINER pins one;
# otherwise local-ci.sh calls lcr_pick_container to choose a FREE runner of the
# repo under test (runner slots, 2026-10-22: myai-gh-runner-<repo>[-N]), with the
# pre-slot name myai-gh-runner as the fallback.
LCR_RUNNER_CONTAINER="${LOCAL_CI_RUNNER_CONTAINER:-myai-gh-runner}"
# User the runner's jobs run as (ci/runner/Dockerfile: `useradd -u 1001 runner`).
LCR_RUNNER_USER="${LOCAL_CI_RUNNER_USER:-runner}"
# Scratch root INSIDE the runner where checkouts are staged — under the runner
# user's home so it is writable without root and never collides with _work/.
LCR_RUNNER_WORKROOT="${LOCAL_CI_RUNNER_WORKROOT:-/home/runner/localci}"
# Resolved mode ("runner" | "docker") and a one-line human reason, both SET BY
# lcr_resolve_mode as globals (never echoed) so the sourcing script reads them
# in its OWN shell — a `$(lcr_resolve_mode)` would run in a subshell and lose
# the reason. Exported + initialised so `set -u` callers are safe before the
# first resolve call. Read by scripts/local-ci.sh (the sourcing script).
export LCR_MODE="docker"
export LCR_MODE_REASON=""

# lcr_pick_container <nwo> — the runner container local-ci should use for repo
# <owner/name>: LOCAL_CI_RUNNER_CONTAINER when set; else the first RUNNING
# myai-gh-runner-<repo>[-N] (then the pre-slot myai-gh-runner) that is not busy
# with a GitHub job; else the first running candidate (lcr_resolve_mode then
# reports it busy and falls back to docker); else the pre-slot default name.
lcr_pick_container() {
  local repo="${1##*/}" names cands c first=""
  if [ -n "${LOCAL_CI_RUNNER_CONTAINER:-}" ]; then printf '%s' "$LOCAL_CI_RUNNER_CONTAINER"; return 0; fi
  command -v docker >/dev/null 2>&1 || { printf 'myai-gh-runner'; return 0; }
  names="$(docker ps --format '{{.Names}}' 2>/dev/null)"
  cands="$(printf '%s\n' "$names" | grep -E "^myai-gh-runner-${repo}(-[0-9]+)?\$" | sort -V 2>/dev/null; printf '%s\n' "$names" | grep -x 'myai-gh-runner')"
  for c in $cands; do
    [ -n "$first" ] || first="$c"
    if ! lcr_runner_busy "$c" "$1"; then printf '%s' "$c"; return 0; fi
  done
  printf '%s' "${first:-myai-gh-runner}"
}

# lcr_container_running [name] — 0 iff the named container is up right now.
lcr_container_running() {
  local name="${1:-$LCR_RUNNER_CONTAINER}"
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

# lcr_has_toolchain [name] — 0 iff node, npm, git AND python3 are all on PATH
# inside the container (i.e. it can actually run the gates). A runner whose
# image predates the Node install would otherwise be picked and then fail every
# gate; this makes the auto-detect honest.
lcr_has_toolchain() {
  local name="${1:-$LCR_RUNNER_CONTAINER}"
  command -v docker >/dev/null 2>&1 || return 1
  docker exec "$name" sh -lc \
    'command -v node >/dev/null && command -v npm >/dev/null && command -v git >/dev/null && command -v python3 >/dev/null' \
    >/dev/null 2>&1
}

# lcr_runner_name [name] — the agentName this container registered with GitHub,
# read from its persisted .runner config. Empty when not registered / unreadable.
lcr_runner_name() {
  local name="${1:-$LCR_RUNNER_CONTAINER}"
  command -v docker >/dev/null 2>&1 || return 0
  docker exec "$name" sh -lc \
    'sed -n "s/.*\"agentName\": *\"\([^\"]*\)\".*/\1/p" /home/runner/actions-runner/.runner 2>/dev/null' \
    2>/dev/null | tr -d '\r' | head -1
}

# lcr_runner_busy [name] [nwo] — 0 when the runner is CURRENTLY running a GitHub
# Actions job (so local-ci must NOT pile on), 1 when free/unknown.
#
# Primary signal: GitHub's own busy flag for this runner (authoritative — it
# flips the instant a job is assigned). Needs gh + a resolvable owner/repo and
# the runner's registered name. Fallback when gh/nwo is unavailable: look for a
# Runner.Worker process inside the container (the runner host spawns exactly one
# per in-flight job) by reading /proc — no ps/pgrep needed, so it works with the
# runner's minimal userland.
lcr_runner_busy() {
  local name="${1:-$LCR_RUNNER_CONTAINER}" nwo="${2:-}"
  if [ -n "$nwo" ] && command -v gh >/dev/null 2>&1; then
    local rname busy
    rname="$(lcr_runner_name "$name")"
    if [ -n "$rname" ]; then
      busy="$(gh api --paginate "repos/${nwo}/actions/runners" \
                --jq ".runners[] | select(.name==\"${rname}\") | .busy" 2>/dev/null \
              | head -1)"
      case "$busy" in
        true)  return 0 ;;
        false) return 1 ;;
      esac
      # empty/unknown → fall through to the local /proc signal
    fi
  fi
  command -v docker >/dev/null 2>&1 || return 1
  docker exec "$name" sh -lc '
      for c in /proc/[0-9]*/cmdline; do
        tr "\0" " " < "$c" 2>/dev/null | grep -q "Runner.Worker" && exit 0
      done
      exit 1' >/dev/null 2>&1
}

# lcr_resolve_mode [name] [nwo] — set globals LCR_MODE + LCR_MODE_REASON to the
# effective execution mode (NOT echoed — see the LCR_MODE note above):
#   runner  → run the Node gates via `docker exec` in the warm runner
#   docker  → today's behaviour: an ad-hoc `docker run <image>` per gate
#
# LOCAL_CI_MODE overrides auto-detection:
#   docker  → never touch the runner (force ad-hoc)
#   runner  → prefer the runner, but STILL yield to a busy / absent /
#             toolchain-less one (never starve a real CI job, never pick a
#             runner that cannot run the gates) and fall back to docker
# unset/auto → runner iff a runner is running, has the toolchain, and is free.
lcr_resolve_mode() {
  local name="${1:-$LCR_RUNNER_CONTAINER}" nwo="${2:-}"
  if [ "${LOCAL_CI_MODE:-auto}" = docker ]; then
    LCR_MODE=docker
    LCR_MODE_REASON="LOCAL_CI_MODE=docker (forced ad-hoc containers)"
    return 0
  fi
  if ! lcr_container_running "$name"; then
    LCR_MODE=docker
    LCR_MODE_REASON="no '$name' runner container running → ad-hoc containers"
    return 0
  fi
  if ! lcr_has_toolchain "$name"; then
    LCR_MODE=docker
    LCR_MODE_REASON="runner '$name' lacks node/npm/git/python3 → ad-hoc containers"
    return 0
  fi
  if lcr_runner_busy "$name" "$nwo"; then
    LCR_MODE=docker
    LCR_MODE_REASON="runner '$name' busy with a GitHub job → ad-hoc (never starve CI)"
    return 0
  fi
  LCR_MODE=runner
  LCR_MODE_REASON="warm runner '$name' (docker exec — one env matching real CI)"
  return 0
}

# lcr_staged_dir <repo_root> <sha> — the path INSIDE the runner where <sha>'s
# tree is staged. Deterministic per (repo basename, short sha).
lcr_staged_dir() {
  local repo_root="$1" sha="$2" base
  base="$(basename "$repo_root")"
  # printf '%s' (no trailing newline) BEFORE `tr -c`: basename's newline is not
  # in the keep-set, so tr would translate it to a spurious trailing '-'.
  base="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_.-' '-')"
  printf '%s/%s-%s' "$LCR_RUNNER_WORKROOT" "$base" "${sha:0:12}"
}

# lcr_stage <repo_root> <sha> [name] — stage <sha>'s COMMITTED tree into the
# runner (git archive | tar -x), owned by the runner user. Echoes the staged
# dir on success, non-zero on failure.
#
# We stage the committed SHA (not the live working tree) deliberately: that is
# exactly the commit the status will attach to and exactly what actions/checkout
# would materialise in real CI — reproducible, and it cannot smuggle in
# uncommitted local edits. (Ad-hoc docker mode mounts the live tree; runner mode
# cannot add a bind-mount to an already-running container, so it copies instead.)
lcr_stage() {
  local repo_root="$1" sha="$2" name="${3:-$LCR_RUNNER_CONTAINER}" dir
  command -v docker >/dev/null 2>&1 || return 1
  command -v git >/dev/null 2>&1 || return 1
  dir="$(lcr_staged_dir "$repo_root" "$sha")"
  if git -C "$repo_root" archive --format=tar "$sha" 2>/dev/null \
      | docker exec -i -u "$LCR_RUNNER_USER" "$name" sh -c \
          "rm -rf '$dir' && mkdir -p '$dir' && tar -x -C '$dir'" >/dev/null 2>&1; then
    printf '%s' "$dir"
    return 0
  fi
  return 1
}

# lcr_exec <workdir> <cmd> [name] — run <cmd> (a shell string) in the runner as
# the runner user, cwd'd to <workdir>. Returns the command's own exit status, so
# callers gate PASS/FAIL on it exactly as they do the ad-hoc `docker run`.
lcr_exec() {
  local workdir="$1" cmd="$2" name="${3:-$LCR_RUNNER_CONTAINER}"
  docker exec -u "$LCR_RUNNER_USER" -w "$workdir" "$name" bash -lc "$cmd"
}
