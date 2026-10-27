#!/usr/bin/env bash
# verify_fleet_mcp.sh — prove that the `myai` MCP server CONNECTS from every
# fleet repo's own .mcp.json, the way Claude Code will spawn it at 09:00.
#
# WHY (2026-09-21): morning_boot.sh's MCP phase handshook through the MASTER
# repo's bridge and said PASS, while the repo the operator actually opened had
# a broken .mcp.json and 401'd. "The gateway works" and "the operator's next
# session can reach it" are two different facts. This script checks the second
# one, per repo, from the repo's own config — nothing is inferred from master.
#
# Per repo (config/managed_repos.txt + config/mcp_repos_extra.txt), TWO rows —
# `claude` (.mcp.json, key "mcpServers") and `vscode` (.vscode/mcp.json, key
# "servers" — VS Code's own MCP schema, read by Copilot/Codex-in-VS-Code agent
# mode; same myai stdio bridge, args substituted for ${workspaceFolder}):
#   FAIL  no `myai` server declared
#   FAIL  `myai` is a stdio command and the handshake does not reach
#         "Proxy established" (spawned with cwd=repo, no CLAUDE_PROJECT_DIR,
#         exactly Claude Code's spawn environment)
#   FAIL  `myai` is an http-type entry and the gateway answers 401 with the
#         header Claude Code would send (env-substituted from THIS shell)
#   WARN  legacy http `ai-framework` entry still present (retired 2026-09-21)
#   WARN  `myai` is http-type but happens to work (token exported in this shell —
#         will not be in the operator's)
#   WARN  (instead of FAIL) for a "NEVER write outside AI/" repo — the framework
#         cannot converge its .mcp.json / .vscode/mcp.json, so the line names
#         the manual fix (`myai mcp repo` / `myai mcp vscode`)
#   OK    stdio bridge handshake succeeded (tool count when obtainable)
# A third row, `docker`, only for a repo whose .mcp.json declares `docker`:
#   OK    legacy `npx docker-mcp` entry while the gateway rollout is opt-in (default)
#   WARN  …the same, once MYAI_DOCKER_MCP_FLEET=1 (run rollout_mcp_bridge.sh --docker-gateway)
#   WARN  docker mcp unavailable (Docker Desktop down) — never FAIL
#   WARN  framework launcher not found (the entry falls back to npx docker-mcp)
#   FAIL  launcher found, Docker up, but the gateway never answers tools/list
#   OK    gateway handshake (once per distinct launcher, stdin kept open)
#
# Usage:
#   scripts/verify_fleet_mcp.sh              full handshakes (~2-5 s per repo, 4 in parallel)
#   scripts/verify_fleet_mcp.sh --static     no spawns: resolve the bridge path the
#                                            template's chain would, flag http entries
#   scripts/verify_fleet_mcp.sh --only <path>
#   scripts/verify_fleet_mcp.sh --quiet      summary line only
# Exit 0 = no FAIL; 1 = at least one FAIL. WARNs never fail the run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=scripts/lib/fleet_mcp_repos.sh
. "$ROOT/scripts/lib/fleet_mcp_repos.sh"

STATIC=0 ONLY="" QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --static) STATIC=1 ;;
    --quiet)  QUIET=1 ;;
    --only)   shift; ONLY="$(cd "${1:?--only needs a path}" 2>/dev/null && pwd -P)" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "verify_fleet_mcp: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPOS="$(fleet_mcp_repos "$ROOT")"          # <path>|<flags>
[ -n "$ONLY" ] && REPOS="$(printf '%s\n' "$REPOS" | grep -F "$ONLY|" || printf '%s|\n' "$ONLY")"

REPOS="$REPOS" CODE_ROOT="$(fleet_code_root "$ROOT")" STATIC="$STATIC" QUIET="$QUIET" GW_URL="${MYAI_GATEWAY_MCP_URL:-http://localhost:${MCP_PORT:-3100}/mcp}" \
/usr/bin/python3 - <<'PY'
import json, os, re, select, subprocess, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

STATIC = os.environ.get("STATIC") == "1"
QUIET = os.environ.get("QUIET") == "1"
HOME = os.path.expanduser("~")
CODE = os.environ.get("CODE_ROOT", "").rstrip("/")  # display only: repo paths print relative to it
GLOBAL_CANDIDATES = [
    os.path.join(HOME, ".local/lib/node_modules/ai-management/scripts/lib/mcp_myai_stdio.sh"),
    "/opt/homebrew/lib/node_modules/ai-management/scripts/lib/mcp_myai_stdio.sh",
    "/usr/local/lib/node_modules/ai-management/scripts/lib/mcp_myai_stdio.sh",
]
INIT = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "verify_fleet_mcp", "version": "1"}}})
INITED = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
LIST = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})

def subst(s):
    # Claude Code's ${VAR} / ${VAR:-default} substitution from ITS environment.
    def rep(m):
        var, default = m.group(1), m.group(3)
        val = os.environ.get(var)
        if val is None or (val == "" and m.group(2)):
            return default if default is not None else ""
        return val
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}", rep, s)

def http_probe(cfg):
    headers = {k: subst(str(v)) for k, v in (cfg.get("headers") or {}).items()}
    headers.setdefault("Content-Type", "application/json")
    headers.setdefault("Accept", "application/json, text/event-stream")
    req = urllib.request.Request(subst(cfg.get("url", "")), data=LIST.encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001
        return 0, str(e)

def spawn_probe(repo, cfg, timeout=60):
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
    argv = [cfg.get("command", "")] + list(cfg.get("args") or [])
    t0 = time.time()
    try:
        r = subprocess.run(argv, cwd=repo, env=env, input=INIT + "\n" + INITED + "\n" + LIST + "\n",
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return False, f"timeout after {timeout}s: " + ((e.stderr or "") if isinstance(e.stderr, str) else "")[-160:], time.time() - t0
    except FileNotFoundError as e:
        return False, f"command not found: {e}", time.time() - t0
    out, err = r.stdout or "", r.stderr or ""
    tools = None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                d = json.loads(line)
                if d.get("id") == 2 and "result" in d:
                    tools = len(d["result"].get("tools") or [])
            except ValueError:
                pass
    if "Proxy established successfully" in err or tools is not None:
        return True, (f"{tools} tools" if tools is not None else "handshake ok"), time.time() - t0
    tail = (err.strip().splitlines() or out.strip().splitlines() or ["no output"])[-1]
    return False, tail[-160:], time.time() - t0

def static_resolve(repo, cfg):
    blob = " ".join([cfg.get("command", "")] + list(cfg.get("args") or []))
    if "mcp_myai_stdio" not in blob:
        return True, "stdio (custom command, not checked statically)"
    cands = [os.path.join(repo, "AI/scripts/lib/mcp_myai_stdio.sh"), os.path.join(repo, "scripts/lib/mcp_myai_stdio.sh")]
    chain = "for p in" in blob
    if chain:
        cands += GLOBAL_CANDIDATES
    for p in cands:
        if os.path.isfile(p):
            return True, "bridge → " + (p.replace(HOME, "~"))
    return False, "bridge script not found" + ("" if chain else " (single-path entry, no global fallback — run rollout_mcp_bridge.sh)")

# ── Docker MCP gateway (`docker` entry, phase 6) ─────────────────────────────
# A third row, ONLY for a repo whose .mcp.json declares `docker`. The entry
# (templates/mcp-docker-gateway.json) runs the FRAMEWORK's launcher, so every repo
# resolves to the same script: the handshake is done once per distinct
# launcher, not once per repo (one gateway start per boot, not thirty).
# Docker Desktop down / no `docker mcp` is a WARN, never a FAIL — it must not
# turn the boot RED.
DOCKER_LAUNCHER = "scripts/lib/mcp_docker_gateway.sh"
DOCKER_BIN = os.environ.get("DOCKER_BIN", "docker")
_docker_lock = threading.Lock()
_docker_state = {}

def _myai_root():
    if "root" not in _docker_state:
        try:
            r = subprocess.run(["myai", "root"], capture_output=True, text=True, timeout=10)
            _docker_state["root"] = r.stdout.strip() if r.returncode == 0 else ""
        except Exception:  # noqa: BLE001
            _docker_state["root"] = ""
    return _docker_state["root"]

def docker_resolve(repo):
    # Same order as the template's chain.
    cands = [os.path.join(d, DOCKER_LAUNCHER) for d in
             (os.environ.get("MYAI_FRAMEWORK_DIR"), os.environ.get("MYAI_HOME"), _myai_root()) if d]
    cands.append(os.path.join(repo, "AI", DOCKER_LAUNCHER))
    cands += [c.replace("scripts/lib/mcp_myai_stdio.sh", DOCKER_LAUNCHER) for c in GLOBAL_CANDIDATES]
    return next((p for p in cands if os.path.isfile(p)), None)

def stream_probe(repo, cfg, timeout=90):
    # The Docker MCP gateway exits on stdin EOF BEFORE it answers tools/list
    # (measured: "server is closing: EOF", no id=2 reply), so the one-shot
    # spawn_probe cannot be used here: keep stdin open until the reply arrives.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
    argv = [cfg.get("command", "")] + list(cfg.get("args") or [])
    t0 = time.time()
    try:
        p = subprocess.Popen(argv, cwd=repo, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
    except FileNotFoundError as e:
        return False, f"command not found: {e}", time.time() - t0
    tools, err_tail, buf, eof = None, "", b"", False
    try:
        p.stdin.write(INIT + "\n" + INITED + "\n" + LIST + "\n"); p.stdin.flush()
        # Raw fd reads, not readline(): a buffered readline can pull BOTH reply
        # lines into Python's buffer at once, and select() on the now-empty pipe
        # then waits out the whole timeout (seen: 1 run in 3 timed out at 90s).
        fd = p.stdout.fileno()
        while time.time() - t0 < timeout and tools is None and not eof:
            r, _, _ = select.select([fd], [], [], 1)
            if not r:
                if p.poll() is not None:
                    break
                continue
            chunk = os.read(fd, 65536)
            if not chunk:
                eof = True
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for line in lines:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("id") == 2 and "result" in d:
                    tools = len(d["result"].get("tools") or [])
    finally:
        p.kill()
        try:
            err_tail = (p.communicate(timeout=5)[1] or "").strip().splitlines()[-1:] or [""]
            err_tail = err_tail[0]
        except Exception:  # noqa: BLE001
            pass
    if tools is not None:
        return True, f"{tools} tools", time.time() - t0
    if time.time() - t0 >= timeout:
        return False, f"timeout after {timeout}s: {err_tail[-160:]}", time.time() - t0
    return False, (err_tail or "no tools/list reply")[-160:], time.time() - t0

def docker_available():
    with _docker_lock:
        if "avail" not in _docker_state:
            try:
                r = subprocess.run([DOCKER_BIN, "mcp", "version"], capture_output=True, text=True, timeout=15)
                _docker_state["avail"] = r.returncode == 0
            except Exception:  # noqa: BLE001
                _docker_state["avail"] = False
        return _docker_state["avail"]

def check_repo_docker(repo, short):
    try:
        cfg = (json.load(open(os.path.join(repo, ".mcp.json"))).get("mcpServers") or {}).get("docker")
    except Exception:  # noqa: BLE001 — check_repo already reported the broken file
        return None
    if not cfg:
        return None
    blob = " ".join([cfg.get("command", "")] + list(cfg.get("args") or []))
    if "docker-mcp" in blob and "mcp_docker_gateway" not in blob:
        # The gateway fleet rollout is opt-in (rollout_mcp_bridge.sh --docker-gateway
        # / MYAI_DOCKER_MCP_FLEET=1). Until the operator turns it on, the legacy
        # entry IS the expected state — not worth a WARN on every boot.
        if os.environ.get("MYAI_DOCKER_MCP_FLEET") != "1":
            return "OK", "legacy npx docker-mcp (Docker MCP gateway fleet rollout is opt-in: MYAI_DOCKER_MCP_FLEET=1)"
        return "WARN", "legacy `npx docker-mcp` entry — run: scripts/rollout_mcp_bridge.sh --docker-gateway"
    if "mcp_docker_gateway" not in blob:
        return "OK", "custom docker entry (not checked)"
    launcher = docker_resolve(repo)
    if not launcher:
        # The entry's chain ends in the legacy `npx -y docker-mcp` server, so the
        # session still gets docker tools — today's behaviour, not a breakage.
        # WARN with the two real fixes; never spawn the npx fallback here.
        return "WARN", ("framework Docker MCP launcher not found — the entry falls back to legacy npx docker-mcp, without context7 "
                        "(fix: export MYAI_FRAMEWORK_DIR=<ai_management checkout>, or a release that ships "
                        "scripts/lib/mcp_docker_gateway.sh + config/docker_mcp_profiles.txt)")
    if STATIC:
        return "OK", "launcher → " + launcher.replace(HOME, "~")
    if not docker_available():
        return "WARN", "docker mcp unavailable (Docker Desktop not running?) — gateway not checked"
    with _docker_lock:
        if launcher not in _docker_state:
            ok, detail, secs = stream_probe(repo, cfg, timeout=90)
            _docker_state[launcher] = (ok, f"{detail} ({secs:.1f}s)")
        ok, detail = _docker_state[launcher]
    return ("OK" if ok else "FAIL"), detail

def check(entry):
    repo, _, flags = entry.partition("|")
    noai = "noai" in flags.split(",")
    short = repo[len(CODE) + 1:] if CODE and repo.startswith(CODE + "/") else repo
    st, short, detail = check_repo(repo, short)
    if st == "FAIL" and noai:
        # The framework is forbidden to write outside AI/ here, so it can never
        # converge this .mcp.json itself. Say so instead of turning every boot
        # RED over a repo nobody automated can fix.
        st, detail = "WARN", detail + " — AI/-only repo, framework cannot write .mcp.json here; fix by hand: myai mcp repo " + repo
    vst, _, vdetail = check_repo_vscode(repo, short)
    if vst == "FAIL" and noai:
        vst, vdetail = "WARN", vdetail + " — AI/-only repo, framework cannot write .vscode/mcp.json here; fix by hand: myai mcp vscode " + repo
    rows = [("claude", st, short, detail), ("vscode", vst, short, vdetail)]
    d = check_repo_docker(repo, short)
    if d:
        dst, ddetail = d
        if dst == "FAIL" and noai:
            dst, ddetail = "WARN", ddetail + " — AI/-only repo, framework cannot write .mcp.json here"
        rows.append(("docker", dst, short, ddetail))
    return rows

def check_repo(repo, short):
    mcp = os.path.join(repo, ".mcp.json")
    if not os.path.isfile(mcp):
        return "FAIL", short, "no .mcp.json"
    try:
        servers = json.load(open(mcp)).get("mcpServers") or {}
    except ValueError as e:
        return "FAIL", short, f".mcp.json invalid: {e}"
    notes = []
    if "ai-framework" in servers:
        notes.append("legacy ai-framework http entry present")
    myai = servers.get("myai")
    if not myai:
        return "FAIL", short, "; ".join(["no myai server declared"] + notes)
    if "url" in myai:
        if STATIC:
            return "FAIL", short, "; ".join(["myai is an http-type entry (blank/stale token in Claude Code's env)"] + notes)
        code, _ = http_probe(myai)
        if code == 200:
            return "WARN", short, "; ".join(["myai http entry works ONLY because the token is exported in this shell"] + notes)
        return "FAIL", short, "; ".join([f"myai http entry → gateway HTTP {code or 'unreachable'}"] + notes)
    if STATIC:
        ok, detail = static_resolve(repo, myai)
    else:
        ok, detail, secs = spawn_probe(repo, myai)
        detail = f"{detail} ({secs:.1f}s)"
    if not ok:
        return "FAIL", short, "; ".join([detail] + notes)
    return ("WARN" if notes else "OK"), short, "; ".join([detail] + notes)

def check_repo_vscode(repo, short):
    # VS Code's OWN MCP schema: .vscode/mcp.json, top-level key "servers" (not
    # "mcpServers"). Registers the same myai stdio bridge so Copilot/Codex-in-
    # VS-Code agent mode gets tasks/brain/mailbox/swarm tools.
    mcp = os.path.join(repo, ".vscode", "mcp.json")
    if not os.path.isfile(mcp):
        # Not rolled out yet is a WARN, never a FAIL: Claude's .mcp.json is the
        # hard requirement; a FAIL here turned the whole fleet RED (31/32 repos,
        # 2026-10-03) before scripts/rollout_vscode_copilot.sh had ever run.
        return "WARN", short, "no .vscode/mcp.json — run: scripts/rollout_vscode_copilot.sh --apply (or myai mcp vscode " + repo + ")"
    try:
        servers = json.load(open(mcp)).get("servers") or {}
    except ValueError as e:
        return "FAIL", short, f".vscode/mcp.json invalid: {e}"
    myai = servers.get("myai")
    if not myai:
        return "FAIL", short, "no myai server declared"
    if "url" in myai:
        return "FAIL", short, "myai is an http-type entry (VS Code MCP expects stdio here)"
    if STATIC:
        ok, detail = static_resolve(repo, myai)
    else:
        # VS Code substitutes ${workspaceFolder} itself before spawning the
        # server — the shell this harness spawns under does not, so do the
        # same substitution here or every repo-local candidate 404s.
        cfg = dict(myai)
        cfg["args"] = [a.replace("${workspaceFolder}", repo) for a in (myai.get("args") or [])]
        ok, detail, secs = spawn_probe(repo, cfg)
        detail = f"{detail} ({secs:.1f}s)"
    return ("OK" if ok else "FAIL"), short, detail

repos = [l.strip() for l in os.environ.get("REPOS", "").splitlines() if l.strip()]
with ThreadPoolExecutor(max_workers=1 if STATIC else 4) as ex:
    rows = [r for pair in ex.map(check, repos) for r in pair]
counts = {"OK": 0, "WARN": 0, "FAIL": 0}
for tool, st, short, detail in rows:
    counts[st] += 1
    if not QUIET:
        print(f"{st:<5} {tool:<7} {short:<40} {detail}")
mode = "static" if STATIC else "handshake"
print(f"fleet MCP ({mode}): {counts['OK']} ok · {counts['WARN']} warn · {counts['FAIL']} fail ({len(rows)} checks over {len(repos)} repos)")
sys.exit(1 if counts["FAIL"] else 0)
PY
