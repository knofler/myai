#!/usr/bin/env bash
# qwen_statusline.sh — ONE line of qwen-lane state for the claude-qwen chat's
# statusLine (installed by `scripts/qwen_lane.sh install-statusline`).
#
# The operator's qwen tab is the claude-qwen CHAT; the job runner runs headless
# (LaunchAgent com.myai.qwen-lane). This is how the runner shows up inside that
# chat window:
#   qwen lane: idle · last job 6s ago from personal (done)
#   qwen lane: working on job from tech (12s)
#   qwen lane: paused — on battery
#   qwen lane: DOWN
#
# Reads only local files (the state file the loop keeps current + the lock
# pid) — no gateway or Ollama call, so it is instant and never hangs the chat.
# Claude Code pipes session JSON on stdin; it is ignored.
# Env: QWEN_STATE (~/.myai/qwen-lane) · QWEN_STATE_FILE. Tests: scripts/tests/test_qwen_lane.sh
QWEN_STATE="${QWEN_STATE:-${MYAI_HOME:-$HOME/.myai}/qwen-lane}"
STATE_FILE="${QWEN_STATE_FILE:-$QWEN_STATE/state.json}"
pid="$(cat "$QWEN_STATE/lock/pid" 2>/dev/null)"
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "qwen lane: DOWN"
  exit 0
fi
STATE_FILE="$STATE_FILE" python3 - <<'PY' 2>/dev/null || echo "qwen lane: up"
import json, os, time
try:
    s = json.load(open(os.environ["STATE_FILE"]))
except Exception:
    print("qwen lane: up"); raise SystemExit
now = int(time.time())
def ago(t):
    d = max(0, now - int(t or now))
    return "%ds" % d if d < 90 else "%dm" % (d // 60) if d < 5400 else "%dh" % (d // 3600)
short = lambda a: (a or "?").split("/")[-1]
st = s.get("state", "idle")
if st == "working":
    print("qwen lane: working on job from %s (%s)" % (short(s.get("job_from")), ago(s.get("since"))))
elif st == "paused":
    print("qwen lane: paused — %s" % s.get("reason", "waiting"))
elif st == "retrying":
    print("qwen lane: retrying — %s" % s.get("reason", "gateway unreachable"))
elif s.get("last_at"):
    print("qwen lane: idle · last job %s ago from %s (%s)" % (ago(s["last_at"]), short(s.get("last_from")), s.get("last_kind", "done")))
else:
    print("qwen lane: idle · no jobs yet")
PY
