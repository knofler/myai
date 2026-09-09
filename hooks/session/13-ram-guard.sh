#!/bin/bash
set +e
# Hook: 2 GB RAM Ceiling Guard
# Event: SessionStart (runs on every `agent mode` kickoff)
#
# Sums Docker container RAM across this project's stack. Warns if total
# exceeds 2 GB. Non-blocking — issues a recommendation, never aborts.
#
# Exempt a heavy-model repo by creating `.ram-exempt` at repo root.

LIMIT_MB=2048

# Docker daemon must be up — borrow the check from 03-docker-health
if ! docker info &>/dev/null; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
COMPOSE_FILE="$ROOT/docker-compose.yml"

# No compose file means nothing to measure
if [ ! -f "$COMPOSE_FILE" ]; then
  exit 0
fi

# Exemption marker — projects that legitimately exceed 2 GB (e.g. local LLM)
if [ -f "$ROOT/.ram-exempt" ]; then
  echo "RAM Guard: exempt (.ram-exempt present)"
  exit 0
fi

# Find this project's containers from compose.
#
# `ps` reports running services from EVERY profile, not just the default set, so
# the ci-profile runner would land in this sum once it is up. That is CI infra,
# not the app stack, and it must not eat the app's 2 GB ceiling (a runner mid-job
# can reach its 4 GB mem_limit on its own). Subtract the profiled services by
# name — `--services` without a `--profile` flag lists only the default set, so
# the difference is exactly the profiled ones.
ALL_RUNNING=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}}' 2>/dev/null)
DEFAULT_SERVICES=$(docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null) || DEFAULT_SERVICES=""
ALL_SERVICES=$(docker compose -f "$COMPOSE_FILE" --profile '*' config --services 2>/dev/null) || ALL_SERVICES=""

PROJECT_CONTAINERS=""
while IFS= read -r CNAME; do
  [ -z "$CNAME" ] && continue
  # Map container -> its compose service, then drop ONLY genuinely profiled ones.
  #
  # Identify the profiled set POSITIVELY: a service present in the all-profiles
  # listing but absent from the default listing. Testing "not in DEFAULT_SERVICES"
  # alone cannot tell a profiled service from one that was renamed or deleted out
  # of the compose file, and silently dropped the latter's RAM from the sum.
  #
  # Every uncertain case COUNTS the container: either listing empty (config failed,
  # or all services are profiled), an unresolvable service label, or a service in
  # neither listing. Over-reporting RAM is recoverable; silently disabling the
  # ceiling guard is not. -F because service names are literals, not patterns.
  SVC=$(docker inspect "$CNAME" -f '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null)
  if [ -n "$DEFAULT_SERVICES" ] && [ -n "$ALL_SERVICES" ] && [ -n "$SVC" ] \
     && printf '%s\n' "$ALL_SERVICES"     | grep -Fqx "$SVC" \
     && ! printf '%s\n' "$DEFAULT_SERVICES" | grep -Fqx "$SVC"; then
    continue
  fi
  PROJECT_CONTAINERS="${PROJECT_CONTAINERS}${CNAME}"$'\n'
done <<< "$ALL_RUNNING"

# normalize_mb <docker-stats-MemUsage-first-field> — e.g. "256.4MiB" -> "256"
normalize_mb() {
  awk -v s="$1" 'BEGIN{
    n=s+0;
    if (s ~ /GiB/ || s ~ /GB/) n=n*1024;
    else if (s ~ /KiB/ || s ~ /kB/ || s ~ /KB/) n=n/1024;
    printf "%.0f", n;
  }'
}

if [ -z "${PROJECT_CONTAINERS//[$'\n\t ']/}" ]; then
  PROJECT_CONTAINERS=""
fi

# Sum MemUsage across this project's compose containers
TOTAL_MB=0
DETAIL=""
while IFS= read -r CNAME; do
  [ -z "$CNAME" ] && continue
  # docker stats output like: "256.4MiB / 7.652GiB"
  STAT=$(docker stats --no-stream --format '{{.MemUsage}}' "$CNAME" 2>/dev/null | awk '{print $1}')
  [ -z "$STAT" ] && continue
  CONTAINER_MB=$(normalize_mb "$STAT")
  [ -z "$CONTAINER_MB" ] && continue
  TOTAL_MB=$((TOTAL_MB + CONTAINER_MB))
  DETAIL="${DETAIL}  - ${CNAME}: ${CONTAINER_MB} MB"$'\n'
done <<< "$PROJECT_CONTAINERS"

# Ad-hoc containers bind-mounting this repo (task-6cd9d9c4) — e.g. the
# throwaway `docker run --rm ... node:22` containers scripts/local-ci.sh
# shells out to. These carry no compose service label at all, so the
# accounting above never sees them: a coverage-gate container was observed at
# 626 MiB / 450% CPU while this hook reported "403 MB / 2048 MB (under
# ceiling)" — the ceiling was silently bypassed. Detected positively (no
# compose-service label AND a bind mount Source under this repo root), never
# by name, so it can't be dodged by an unnamed/auto-named container. A
# compose-managed container (default OR profiled, e.g. the ci-profile
# gh-runner) always carries the service label and is skipped here — profiled
# services stay deliberately excluded from the app-stack ceiling either way.
while IFS= read -r CID; do
  [ -z "$CID" ] && continue
  SVC=$(docker inspect "$CID" -f '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null)
  [ -n "$SVC" ] && continue
  MOUNTS=$(docker inspect "$CID" -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null)
  printf '%s\n' "$MOUNTS" | grep -Fq "$ROOT" || continue
  CNAME=$(docker inspect "$CID" -f '{{.Name}}' 2>/dev/null | sed 's#^/##')
  [ -z "$CNAME" ] && CNAME="$CID"
  STAT=$(docker stats --no-stream --format '{{.MemUsage}}' "$CID" 2>/dev/null | awk '{print $1}')
  [ -z "$STAT" ] && continue
  CONTAINER_MB=$(normalize_mb "$STAT")
  [ -z "$CONTAINER_MB" ] && continue
  TOTAL_MB=$((TOTAL_MB + CONTAINER_MB))
  DETAIL="${DETAIL}  - ${CNAME} (ad-hoc, bind-mounts repo): ${CONTAINER_MB} MB"$'\n'
done <<< "$(docker ps -q 2>/dev/null)"

if [ "$TOTAL_MB" -eq 0 ]; then
  exit 0
fi

if [ "$TOTAL_MB" -gt "$LIMIT_MB" ]; then
  echo "⚠️  RAM Guard: ${TOTAL_MB} MB used — OVER 2 GB ceiling"
  echo "$DETAIL" | head -10
  echo "  Fix: add mem_limit (e.g. 1g / 512m) to services in docker-compose.yml"
  echo "  Or:  touch .ram-exempt   # if heavy-model repo (Ollama, etc.)"
else
  echo "RAM Guard: ${TOTAL_MB} MB / ${LIMIT_MB} MB (under ceiling)"
fi

exit 0
