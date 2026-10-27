#!/usr/bin/env bash
# g2_stranger.sh — re-prove v1 gate G2 the way a stranger would (v1 G2,
# 2026-10-22): pack the npm tarball, install it in a CLEAN Linux container (no
# host mounts, no ~/.myai), `myai init` a throwaway repo, bring the stack up
# (docker mode), then drive the EXACT .mcp.json server an agent launches and
# check the DoD (plan/V1_LAUNCH_READINESS.md §1). Timed log + PASS/FAIL table;
# operator-data scan of what got installed via scripts/publish_guard.sh --dir.
#
# Usage:
#   scripts/g2_stranger.sh [--ref <git-ref> | --tgz <file>] [--mode docker|no-docker|both]
#                          [--user root|nonroot] [--out <dir>] [--name <prefix>] [--keep] [--dry-run]
#
#   --ref      pack this commit of the current repo (default HEAD) inside node:24
#   --tgz      test a tarball you already have instead of packing
#   --mode     docker    : the container gets its own Docker Engine (privileged,
#                          cgroup-nested like docker:dind) and runs `myai up`
#              no-docker : plain container, the CLI/brain/no-Docker MCP path
#              both      : both, one after the other (default)
#   --user     run init/up/MCP as root (default) or a normal user in group docker
#   --out      where the log + summary go (default: a new tmp dir, printed)
#   --keep     leave the containers (and their Docker volumes) for inspection
#   --dry-run  print the plan and exit; touches nothing
#
# Never touches the host's Docker socket from inside a container, never runs
# npm/npx on the host (CLAUDE.md rule 2), never mounts host paths. Exit 0 =
# every check passed. Needs: docker, git.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${G2_IMAGE:-node:24}"

REF="HEAD"; TGZ=""; MODE="both"; RUN_USER="root"; OUT=""; NAME="g2s"; KEEP=0; DRY=0
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "g2_stranger: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)  [ $# -ge 2 ] || die "--ref needs a git ref"; REF="$2"; shift 2 ;;
    --tgz)  [ $# -ge 2 ] || die "--tgz needs a file"; TGZ="$2"; shift 2 ;;
    --mode) [ $# -ge 2 ] || die "--mode needs docker|no-docker|both"; MODE="$2"; shift 2 ;;
    --user) [ $# -ge 2 ] || die "--user needs root|nonroot"; RUN_USER="$2"; shift 2 ;;
    --out)  [ $# -ge 2 ] || die "--out needs a dir"; OUT="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || die "--name needs a prefix"; NAME="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
case "$MODE" in docker|no-docker) MODES="$MODE" ;; both) MODES="no-docker docker" ;; *) die "--mode must be docker, no-docker or both (got '$MODE')" ;; esac
case "$RUN_USER" in root|nonroot) ;; *) die "--user must be root or nonroot (got '$RUN_USER')" ;; esac
case "$NAME" in ''|*[!a-z0-9-]*) die "--name must be lowercase [a-z0-9-] (got '$NAME')" ;; esac
if [ -n "$TGZ" ]; then
  [ -f "$TGZ" ] || die "--tgz file not found: $TGZ"
  TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"
fi

if [ "$DRY" = 1 ]; then
  echo "g2_stranger plan (dry run — nothing is started):"
  if [ -n "$TGZ" ]; then echo "  tarball: $TGZ (given)"
  else echo "  tarball: git archive $REF | docker run $IMAGE npm pack"; fi
  for m in $MODES; do
    echo "  mode $m: fresh $IMAGE container '$NAME-$m'$([ "$m" = docker ] && echo ' (privileged, own Docker Engine via get.docker.com)'), user $RUN_USER"
    echo "    steps: install · myai doctor · git init + myai init$([ "$m" = docker ] && echo ' · myai up · dashboard /, /brain · myai plug proof') · .mcp.json server: initialize + context_boot + handoff_write/read + brain_commit/search · the same on the no-gateway server (mcp_local_stdio.mjs)$([ "$m" = docker ] && echo ' · roundtrip: offline write → myai up → gateway read, gateway write → myai down → offline read') · myai brain log"
  done
  echo "  then: operator-data scan (publish_guard.sh --dir) of the installed module and the trial repo"
  echo "  docker mode volume: '$NAME-docker-varlib' (named, holds the inner Docker Engine's /var/lib/docker)"
  echo "  cleanup: $([ "$KEEP" = 1 ] && echo "keep containers + volumes (--keep); remove later with: docker rm -f -v <container> && docker volume rm <container>-varlib" || echo 'remove containers + their volumes, also on error or Ctrl-C (exit trap)')"
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker not found"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/g2_stranger.XXXXXX")"
mkdir -p "$OUT" || die "cannot create $OUT"
SUMMARY="$OUT/summary.md"; : > "$SUMMARY"
FAILS=0

# ── cleanup (the inner Docker Engine's /var/lib/docker is GBs) ───────────────
# docker mode gives each container a NAMED volume <container>-varlib instead of
# an anonymous `-v /var/lib/docker`: an anonymous volume outlives any
# `docker rm` without -v and silently filled the host disk (19 GB, 2026-10-26).
# Unless --keep, the exit trap removes every container and volume this run
# created, also after die / Ctrl-C.
CREATED=""
cleanup_all() {
  [ "$KEEP" = 1 ] && return 0
  local c
  for c in $CREATED; do
    docker rm -f -v "$c" >/dev/null 2>&1
    docker volume rm "$c-varlib" >/dev/null 2>&1
  done
  docker rm -f "$NAME-pack" >/dev/null 2>&1
  return 0
}
trap 'cleanup_all' EXIT
trap 'exit 130' INT TERM
row() { # row <PASS|FAIL|INFO> <mode> <check> <detail>
  printf '| %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4" >> "$SUMMARY"
  printf '  %-4s %-9s %-34s %s\n' "$1" "$2" "$3" "$4"
  if [ "$1" = FAIL ]; then FAILS=$((FAILS + 1)); fi
}

# ── the tarball ──────────────────────────────────────────────────────────────
if [ -z "$TGZ" ]; then
  echo "▶ packing $(git -C "$ROOT" rev-parse --short "$REF" 2>/dev/null || echo "$REF") inside $IMAGE"
  docker rm -f "$NAME-pack" >/dev/null 2>&1
  t0=$(date +%s)
  git -C "$ROOT" archive "$REF" | docker run -i --name "$NAME-pack" "$IMAGE" \
    sh -c 'mkdir /p && cd /p && tar -x && npm pack --silent >/dev/null 2>&1 && ls *.tgz' > "$OUT/pack.txt" 2>&1 \
    || { cat "$OUT/pack.txt" >&2; die "npm pack failed"; }
  docker cp "$NAME-pack:/p/$(tail -1 "$OUT/pack.txt")" "$OUT/" >/dev/null || die "could not copy the tarball out"
  docker rm "$NAME-pack" >/dev/null
  TGZ="$OUT/$(tail -1 "$OUT/pack.txt")"
  echo "  $(basename "$TGZ") in $(( $(date +%s) - t0 ))s"
fi
{ echo "# g2_stranger run — $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo; echo "tarball: \`$(basename "$TGZ")\` · user: $RUN_USER · image: $IMAGE"; echo
  echo "| result | mode | check | detail |"; echo "|---|---|---|---|"; } >> "$SUMMARY"

# ── the in-container stranger (stdout: "CHECK <name> <PASS|FAIL> <secs> <detail>") ─
read -r -d '' INNER <<'INNER_EOF'
set -u
MODE="$1"; RUN_USER="$2"
LOG=/tmp/g2.log; : > "$LOG"
now() { date +%s.%N; }
check() { # check <name> <cmd…> — run, time, log, report
  local name="$1" t0 t1 rc out; shift
  t0=$(now); out="$(timeout "${STEP_TIMEOUT:-900}" bash -c "$*" 2>&1)"; rc=$?; t1=$(now)
  { printf '\n### %s (rc=%s, %.1fs)\n$ %s\n' "$name" "$rc" "$(echo "$t1 - $t0" | awk '{print $1-$3}')" "$*"; printf '%s\n' "$out" | head -80; } >> "$LOG"
  printf 'CHECK %s %s %.1f %s\n' "$name" "$([ $rc = 0 ] && echo PASS || echo FAIL)" "$(awk -v a="$t0" -v b="$t1" 'BEGIN{print b-a}')" "$(printf '%s' "$out" | tail -1 | tr '\t|' '  ' | cut -c1-110)"
}
as_user() { if [ "$RUN_USER" = nonroot ]; then su - stranger -c "$*"; else bash -lc "$*"; fi; }
if [ "$MODE" = docker ]; then
  mkdir -p /sys/fs/cgroup/init && xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null
  check docker-engine 'curl -fsSL https://get.docker.com | sh >/tmp/getdocker.log 2>&1 && (dockerd >/tmp/dockerd.log 2>&1 &) && for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done && docker version --format "Docker Engine {{.Server.Version}}"'
fi
check install 'npm i -g /tmp/stranger.tgz 2>&1 | tail -2 && myai --version'
if [ "$RUN_USER" = nonroot ]; then
  useradd -m -s /bin/bash stranger
  [ "$MODE" = docker ] && usermod -aG docker stranger
  H=/home/stranger
else H=/root; fi
check doctor "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'myai doctor 2>&1 | tail -3'; true"
check init "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'mkdir -p ~/trial && cd ~/trial && git init -q && myai init 2>&1 | tail -2 && test -f .mcp.json && test -f .myai-local'"
if [ "$MODE" = docker ]; then
  check up "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && myai up 2>&1 | grep -E \"stack healthy\" '"
  sleep 15
  check dashboard 'for u in / /brain; do c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3210$u); echo "$u $c"; [ "$c" = 200 ] || exit 1; done'
  check plug-proof "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && myai plug proof 2>&1 | grep -E \"initialize — connected\"'"
fi
# The EXACT .mcp.json server an agent launches, from inside the trial repo —
# or, with --local, the no-gateway server (scripts/lib/mcp_local_stdio.mjs).
#   agent          initialize · handoff_write · context_boot · brain_commit · brain_search
#   write <file>   handoff_write the file's text
#   expect <file>  handoff_read latest == the text · context_boot shows it · brain_search finds it
cat > /tmp/mcp_session.py <<'PY'
import json, os, subprocess, sys, time
args = sys.argv[1:]
local = args[:1] == ["--local"]
if local: args = args[1:]
action = args[0] if args else "agent"
text = open(args[1]).read().strip() if len(args) > 1 else ""
if local:
    argv = ["node", os.path.join(os.environ["MYAI_MODULE"], "scripts/lib/mcp_local_stdio.mjs")]
else:
    cmd = json.load(open(".mcp.json"))["mcpServers"]["myai"]
    argv = [cmd["command"], *cmd["args"]]
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env={**os.environ, "CLAUDE_PROJECT_DIR": os.getcwd()})
def call(i, method, params=None):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n"); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: raise SystemExit(f"no response to {method}")
        try: m = json.loads(line)
        except Exception: continue
        if m.get("id") == i: return m
def tool(i, name, args):
    r = call(i, "tools/call", {"name": name, "arguments": args}).get("result") or {}
    text = "".join(c.get("text", "") for c in r.get("content") or [])
    if r.get("isError"): raise SystemExit(f"{name}: {text[:200]}")
    return text
init = call(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "g2-stranger", "version": "0"}})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
server = ((init.get("result") or {}).get("serverInfo") or {}).get("name", "?")
repo = json.load(open(".myai-local"))["namespace"]
ok = False
if action == "agent":
    tool(2, "handoff_write", {"repo": repo, "content": f"g2 stranger handoff {int(time.time())}"})
    time.sleep(1)
    boot = json.loads(tool(3, "context_boot", {}))
    tool(4, "brain_commit", {"kind": "session", "repo": repo, "slug": "g2-stranger", "content": "g2 stranger session committed through MCP from a clean install"})
    found = json.loads(tool(5, "brain_search", {"query": "g2 stranger session committed", "repo": repo}))
    state = (boot.get("brief") or {}).get("state", "")
    handoff = (boot.get("brief") or {}).get("handoff", "") or ""
    ok = repo in state and "g2 stranger handoff" in handoff and found.get("count", 0) >= 1
    print(f"server={server} state='{state}' handoff_read_back={'g2 stranger handoff' in handoff} brain_search={found.get('count', 0)}")
elif action == "write":
    w = json.loads(tool(2, "handoff_write", {"repo": repo, "content": text}))
    ok = bool(w.get("saved"))
    print(f"server={server} wrote '{text}' atom={(w.get('atom') or {}).get('path', '-')}")
elif action == "expect":
    latest = (json.loads(tool(2, "handoff_read", {"repo": repo})).get("latest") or {}).get("content", "")
    handoff = (json.loads(tool(3, "context_boot", {"repo": repo})).get("brief") or {}).get("handoff", "") or ""
    found = json.loads(tool(4, "brain_search", {"query": text, "repo": repo})).get("count", 0)
    ok = latest == text and text in handoff and found >= 1
    print(f"server={server} '{text}': handoff_read={latest == text} context_boot={text in handoff} brain_search={found}")
want = os.environ.get("EXPECT_SERVER")
if want and server != want:
    ok = False
    print(f"expected server {want}, got {server}")
p.terminate()
sys.exit(0 if ok else 1)
PY
MOD="$(as_user 'myai root' 2>/dev/null | tail -1)"
echo "roundtrip offline $(date +%s)" > /tmp/rt-offline; echo "roundtrip gateway $(date +%s)" > /tmp/rt-gateway; chmod 644 /tmp/rt-*
# The .mcp.json bridge picks the server: the gateway when it answers, else the local one (B2 b).
GW=myai-framework; [ "$MODE" = docker ] || GW=myai-local
check mcp-agent "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && EXPECT_SERVER=$GW timeout 120 python3 /tmp/mcp_session.py agent'"
check mcp-local "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && MYAI_MODULE=$MOD timeout 120 python3 /tmp/mcp_session.py --local agent'"
if [ "$MODE" = docker ]; then
  # Non-divergence, both ways (B2): what one server writes, the other reads —
  # each side reached the way an agent reaches it, through the .mcp.json bridge.
  check roundtrip-offline-write "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && myai down >/dev/null 2>&1; EXPECT_SERVER=myai-local timeout 120 python3 /tmp/mcp_session.py write /tmp/rt-offline'"
  check roundtrip-gateway-read "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && myai up 2>&1 | grep -q \"stack healthy\" && sleep 10 && EXPECT_SERVER=myai-framework timeout 120 python3 /tmp/mcp_session.py expect /tmp/rt-offline'"
  check roundtrip-gateway-write "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && EXPECT_SERVER=myai-framework timeout 120 python3 /tmp/mcp_session.py write /tmp/rt-gateway'"
  check roundtrip-local-read "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'cd ~/trial && myai down >/dev/null 2>&1; EXPECT_SERVER=myai-local timeout 120 python3 /tmp/mcp_session.py expect /tmp/rt-gateway'"
fi
check brain-log "$(declare -f as_user); RUN_USER=$RUN_USER as_user 'myai brain log 2>&1 | grep -m1 g2-stranger'"
if [ "$MODE" = docker ] && [ "$RUN_USER" = nonroot ]; then
  check brain-ownership "n=\$(find $H/.myai/brain ! -user stranger | wc -l); echo \"files not owned by the user: \$n\"; [ \"\$n\" = 0 ]"
fi
echo "HOME_DIR $H"
INNER_EOF

for m in $MODES; do
  C="$NAME-$m"
  echo "▶ $m — fresh $IMAGE container $C (user $RUN_USER)"
  docker rm -f -v "$C" >/dev/null 2>&1
  CREATED="$CREATED $C"
  if [ "$m" = docker ]; then
    docker volume rm "$C-varlib" >/dev/null 2>&1
    docker volume create --label myai.g2_stranger=1 "$C-varlib" >/dev/null || die "could not create volume $C-varlib"
    docker run -d --privileged --cgroupns=private --name "$C" -v "$C-varlib:/var/lib/docker" "$IMAGE" sleep infinity >/dev/null || die "could not start $C"
  else
    docker run -d --name "$C" "$IMAGE" sleep infinity >/dev/null || die "could not start $C"
  fi
  docker cp "$TGZ" "$C:/tmp/stranger.tgz" >/dev/null || die "could not copy the tarball into $C"
  t0=$(date +%s)
  printf '%s\n' "$INNER" | docker exec -i "$C" bash -s "$m" "$RUN_USER" > "$OUT/$m.checks" 2>&1
  docker cp "$C:/tmp/g2.log" "$OUT/$m.log" >/dev/null 2>&1
  while read -r tag name st secs detail; do
    [ "$tag" = CHECK ] || continue
    row "$st" "$m" "$name (${secs}s)" "$(printf '%s' "$detail" | sed "s/$(printf '\033')\[[0-9;]*m//g")"
  done < "$OUT/$m.checks"
  row INFO "$m" "total" "$(( $(date +%s) - t0 ))s"
  # Operator-data scan of what the stranger got: the installed module + their repo.
  home="$(sed -n 's/^HOME_DIR //p' "$OUT/$m.checks" | tail -1)"; home="${home:-/root}"
  mod="$(docker exec "$C" bash -lc 'myai root' 2>/dev/null | tail -1)"
  rm -rf "$OUT/$m-module" "$OUT/$m-trial"
  if [ -n "$mod" ] && docker cp "$C:$mod" "$OUT/$m-module" >/dev/null 2>&1 && docker cp "$C:$home/trial" "$OUT/$m-trial" >/dev/null 2>&1; then
    # Not ours to judge: the stranger's own git store and the third-party deps npm installed.
    rm -rf "$OUT/$m-trial/.git" "$OUT/$m-module/node_modules"
    for d in module trial; do
      res="$(cd "$ROOT" && bash scripts/publish_guard.sh --dir "$OUT/$m-$d" 2>&1)"
      # The guard's FORBIDDEN PATH rules are for the package; the stranger's repo
      # legitimately holds files like the CLAUDE.md `myai init` writes — judge its content only.
      if [ "$d" = trial ]; then res="$(printf '%s\n' "$res" | grep -v 'FORBIDDEN PATH')"; fi
      n="$(printf '%s\n' "$res" | grep -c '✗' || true)"
      if [ "$n" = 0 ]; then row PASS "$m" "no operator data ($d)" "publish_guard: 0 findings"
      else row FAIL "$m" "no operator data ($d)" "publish_guard: $n findings — see $OUT/$m-$d.leaks"; printf '%s\n' "$res" > "$OUT/$m-$d.leaks"; fi
    done
  else
    row FAIL "$m" "operator-data scan" "could not copy the module/repo out of $C"
  fi
  if [ "$KEEP" = 1 ]; then
    echo "  kept: $C — remove with: docker rm -f -v $C$([ "$m" = docker ] && echo " && docker volume rm $C-varlib")"
  else
    docker rm -f -v "$C" >/dev/null 2>&1
    docker volume rm "$C-varlib" >/dev/null 2>&1
    left="$(docker volume ls -q --filter "name=^$C-varlib\$" 2>/dev/null)"
    if [ -z "$left" ]; then row PASS "$m" "no leaked volume" "container + volume removed"
    else row FAIL "$m" "no leaked volume" "volume $left still present"; fi
  fi
done

echo
echo "g2_stranger: $([ "$FAILS" = 0 ] && echo ALL CHECKS PASSED || echo "$FAILS check(s) FAILED") — summary: $SUMMARY (logs alongside)"
[ "$FAILS" = 0 ]
