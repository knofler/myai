#!/usr/bin/env bash
# 24-myai-mcp-health.sh — LOUD session-start check: never let the myai MCP
# server go dark silently again (task-35c9e181, P0).
#
# PAST INCIDENT this guards against: .mcp.json's myai entry was `"type": "http"`
# with header `x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}`. Claude Code
# substitutes that ${VAR} from ITS OWN launch environment, not this repo's
# .env — so on any shell that hadn't manually exported the token, the header
# went out blank, the gateway 401'd, myai never connected, and all 134 tools
# (every brain_*) silently vanished. Nothing surfaced this — the session just
# quietly fell back to file reads/grep, burning the ~79.6x cold-boot saving
# brain_delta exists for, for an entire session, unnoticed.
#
# Fixed by switching .mcp.json's myai entry to a command-type wrapper
# (scripts/lib/mcp_myai_stdio.sh) that resolves the token itself, off disk,
# independent of Claude Code's inherited env. THIS hook is the regression
# guard: it replicates that same handshake at session start and shouts if it
# would fail, so a revert or a broken token can never go unnoticed again.
#
# SECOND INCIDENT (2026-08-27): the wrapper existed and was executable, the
# gateway handshake was 200 — yet myai was dark in EVERY session for days.
# The break was one level up, in .mcp.json's args:
#   "args": ["${CLAUDE_PROJECT_DIR}/scripts/lib/mcp_myai_stdio.sh"]
# CLAUDE_PROJECT_DIR is a HOOK-only variable — not in the environment Claude
# Code spawns MCP servers with.
#
# THIRD INCIDENT (root-owned files in ~/.npm/_cacache breaking npx) this now
# also guards: this hook stayed green throughout, because it only stat()'d a
# hardcoded wrapper path (exists + executable) and separately curl'd the
# gateway with a token it resolved itself. Both of those checks are green
# even when the actual spawn Claude Code performs is broken — the file
# exists, the gateway is healthy in isolation, and neither check ever
# noticed `npx` couldn't run at all. Predicting whether the spawn would work
# is not the same as knowing it does. So: stop predicting. Resolve the
# command+args .mcp.json ACTUALLY declares, spawn that exact command in the
# same environment Claude Code uses (CLAUDE_PROJECT_DIR unset, cwd = repo
# root), write a real MCP `initialize` request to its stdin, and require a
# real JSON-RPC response back within a timeout. This is the only check that
# cannot stay green while the thing it guards never started.
set +e

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    # Real precondition failure (missing/broken .git), not "no .mcp.json here"
    # — see hooks/session/17-schedule-status.sh for the incident this pattern
    # caused. Warn instead of vanishing silently.
    echo "24-myai-mcp-health: cannot resolve repo (not a git repository) — MCP health check skipped" >&2
    exit 0
}
MCPFILE="$ROOT/.mcp.json"
[ -f "$MCPFILE" ] || exit 0   # no .mcp.json here — nothing to verify

HAS_MYAI=$(/usr/bin/python3 -c "
import json, sys
try:
    d = json.load(open('$MCPFILE'))
except Exception:
    sys.exit(1)
print('yes' if 'myai' in (d.get('mcpServers') or {}) else 'no')
" 2>/dev/null)
[ "$HAS_MYAI" = "yes" ] || exit 0   # myai isn't declared here — nothing to verify

# Actually spawn what .mcp.json declares — command + args, verbatim — in the
# same environment Claude Code uses (CLAUDE_PROJECT_DIR unset, cwd = repo
# root), speak one real MCP `initialize` handshake over its stdio, and report
# exactly what happened. Prints "OK" on a real JSON-RPC reply; otherwise
# prints "FAIL:<reason>" carrying the actual spawn/stderr evidence.
SPAWN_RESULT=$(cd "$ROOT" && env -u CLAUDE_PROJECT_DIR /usr/bin/python3 - "$MCPFILE" <<'PY'
import json, os, signal, subprocess, sys, time

mcpfile = sys.argv[1]
try:
    d = json.load(open(mcpfile))
except Exception as e:
    print("FAIL:could not parse .mcp.json (%s)" % e)
    sys.exit(1)

entry = (d.get("mcpServers") or {}).get("myai") or {}

if entry.get("type") or entry.get("url"):
    print("FAIL:myai in .mcp.json has reverted to the direct-http + ${VAR}-header "
          "pattern -- Claude Code substitutes that from ITS OWN env, not this "
          "repo's .env, so the token goes out blank and the gateway 401s. "
          "Restore the command-type mcp_myai_stdio.sh wrapper.")
    sys.exit(1)

command = entry.get("command")
args = list(entry.get("args") or [])
if not command:
    print("FAIL:myai in .mcp.json declares no spawnable command -- nothing for "
          "Claude Code to run.")
    sys.exit(1)

env = dict(os.environ)
env.pop("CLAUDE_PROJECT_DIR", None)
for k, v in (entry.get("env") or {}).items():
    env[k] = os.path.expandvars(v)

argv = [command] + args

try:
    proc = subprocess.Popen(
        argv, cwd=os.getcwd(), env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=False, bufsize=0, start_new_session=True,
    )
except Exception as e:
    print("FAIL:spawning myai's declared command (%r) failed -- %s" % (argv, e))
    sys.exit(1)

init_req = (json.dumps({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "mcp-health-check", "version": "1"},
    },
}) + "\n").encode("utf-8")

reason = None
try:
    proc.stdin.write(init_req)
    proc.stdin.flush()
except Exception as e:
    reason = ("FAIL:myai's process died before it could accept the MCP "
               "initialize request (%s) -- it never started." % e)

response = None
stdout_buf = b""
stderr_buf = b""
TIMEOUT_S = float(os.environ.get("MCP_HEALTH_SPAWN_TIMEOUT_S", "12"))

if reason is None:
    import select

    hard_deadline = time.time() + TIMEOUT_S + 5  # backstop even if select misbehaves
    def _alarm(signum, frame):
        raise TimeoutError("hard alarm backstop fired")
    old_handler = signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(int(TIMEOUT_S) + 5)

    try:
        deadline = time.time() + TIMEOUT_S
        out_fd, err_fd = proc.stdout.fileno(), proc.stderr.fileno()
        while time.time() < deadline and time.time() < hard_deadline:
            exited = proc.poll() is not None
            rlist, _, _ = select.select([out_fd, err_fd], [], [], 0.5)
            if err_fd in rlist:
                chunk = os.read(err_fd, 4096)
                if chunk:
                    stderr_buf += chunk
            if out_fd in rlist:
                chunk = os.read(out_fd, 4096)
                if chunk:
                    stdout_buf += chunk
                    while b"\n" in stdout_buf:
                        line, stdout_buf = stdout_buf.split(b"\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            candidate = json.loads(line.decode("utf-8", "replace"))
                        except Exception:
                            continue
                        if isinstance(candidate, dict) and ("result" in candidate or "error" in candidate):
                            response = candidate
                            break
            if response is not None:
                break
            if exited and not rlist:
                # process is gone and there was nothing left to read this tick
                break
    except TimeoutError:
        pass
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)

def _descendants(root_pid):
    # Belt-and-suspenders teardown: start_new_session's setsid() is not
    # guaranteed to land the spawned tree in its own process group under
    # every sandbox this hook runs in, so killpg alone can silently miss the
    # actual npx/node grandchildren and leak them past session end. Walk the
    # live process table for anything descended from proc.pid and kill it
    # directly, in addition to the group kill below.
    try:
        out = subprocess.check_output(["ps", "-Ao", "pid=,ppid="], text=True)
    except Exception:
        return []
    children = {}
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) != 2:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)
    found, frontier = [], [root_pid]
    while frontier:
        nxt = []
        for p in frontier:
            for c in children.get(p, []):
                found.append(c)
                nxt.append(c)
        frontier = nxt
    return found

victims = {proc.pid}
for _ in range(3):  # a couple passes in case the tree is still forking
    victims |= set(_descendants(proc.pid))
    for pid in list(victims):
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    time.sleep(0.05)
try:
    os.killpg(proc.pid, signal.SIGKILL)
except Exception:
    pass
try:
    proc.wait(timeout=2)
except Exception:
    pass

if reason:
    print(reason)
    sys.exit(1)

if response is None:
    tail = stderr_buf.decode("utf-8", "replace").strip()
    low = tail.lower()
    if "cacache" in low or "root-owned" in low or "eacces" in low:
        kind = ("npm cache is broken -- root-owned files in ~/.npm/_cacache "
                "block npx. Fix: sudo chown -R \"$(id -u):$(id -g)\" ~/.npm, "
                "or confirm the wrapper's dedicated NPM_CONFIG_CACHE is in effect.")
    elif "no such file or directory" in low or "enoent" in low:
        kind = "the declared command/wrapper does not exist at the resolved path."
    elif "401" in tail or "403" in tail or "unauthor" in low or "forbidden" in low:
        kind = ("the gateway rejected the handshake (unauthorized) -- "
                "GATEWAY_LOCAL_TOKEN did not resolve to a value the gateway accepts.")
    elif tail:
        kind = "myai's process produced no MCP response and exited/stalled."
    else:
        kind = ("myai's process produced no MCP response within %gs (no stderr "
                 "output) -- spawn likely hung." % TIMEOUT_S)
    evidence = (" stderr: %s" % tail[-500:]) if tail else ""
    print("FAIL:myai stdio spawn never completed an MCP handshake -- %s%s" % (kind, evidence))
    sys.exit(1)

if "error" in response:
    err = response["error"]
    msg = err.get("message", "") if isinstance(err, dict) else str(err)
    code = err.get("code") if isinstance(err, dict) else None
    if code in (401, 403) or "unauthor" in msg.lower() or "forbidden" in msg.lower():
        print("FAIL:myai MCP handshake was rejected (unauthorized) -- "
              "GATEWAY_LOCAL_TOKEN did not resolve to a value the gateway "
              "accepts. %s" % msg)
    else:
        print("FAIL:myai MCP initialize returned an error: %s" % msg)
    sys.exit(1)

print("OK")
sys.exit(0)
PY
)
SPAWN_RC=$?

FAIL_REASON=""
if [ "$SPAWN_RC" -ne 0 ]; then
  FAIL_REASON="${SPAWN_RESULT#FAIL:}"
  [ -n "$FAIL_REASON" ] || FAIL_REASON="myai MCP health check failed for an unknown reason (spawn exit $SPAWN_RC)."
fi

[ -z "$FAIL_REASON" ] && exit 0

if [ -n "$NO_COLOR" ]; then RED=''; RESET=''; BOLD=''
else RED=$'\033[1;31m'; RESET=$'\033[0m'; BOLD=$'\033[1m'; fi

{
  echo "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}"
  echo "${RED}${BOLD}  MYAI MCP HEALTH CHECK FAILED — tools (incl. all brain_*) may be dark${RESET}"
  echo "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}"
  echo "  $FAIL_REASON"
  echo "  This session may silently fall back to file reads/grep instead of"
  echo "  brain_delta/brain_search — the exact regression task-35c9e181 fixed."
  echo "  Fix: documentation/RUNBOOK.md §7."
  echo "${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}"
} >&2

exit 0
