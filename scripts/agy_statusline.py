#!/usr/bin/env python3
# agy_statusline.py — Antigravity's bottom status line, matching the Claude
# sessions' (~/.claude-org-statusline.sh): repo first, lane, model, context,
# myAI badge. agy pipes a JSON payload on stdin to a custom `statusLine`
# command (see `agy changelog`: conversation_title, cost, ...); installed by
# `scripts/agy_session.sh statusline` with stack_with_default so agy's own
# line still renders underneath.
#
# agy's payload schema is not documented, so every field is read defensively
# (string or {display_name|name|id} object) and the last payload is saved to
# ~/.myai/agy-statusline-last.json for inspection. Never raises: a broken
# status line must not break the session.
import json
import os
import subprocess
import sys
import time


def _name(v):
    if isinstance(v, dict):
        return v.get("display_name") or v.get("displayName") or v.get("name") or v.get("id") or ""
    return v if isinstance(v, str) else ""


def _first(d, *keys):
    for k in keys:
        cur = d
        for part in k.split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
        if cur not in (None, "", {}):
            return cur
    return None


def main():
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}
    try:
        p = os.path.expanduser("~/.myai/agy-statusline-last.json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(raw)
    except Exception:
        pass
    if not isinstance(data, dict):
        data = {}

    cwd = _first(data, "workspace.current_dir", "workspace.project_dir", "cwd", "workspace_dir") or os.getcwd()
    if not isinstance(cwd, str):
        cwd = os.getcwd()
    repo, branch = "", ""
    try:
        top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=2).stdout.strip()
        repo = os.path.basename(top) if top else ""
        branch = subprocess.run(["git", "-C", cwd, "branch", "--show-current"],
                                capture_output=True, text=True, timeout=2).stdout.strip()
    except Exception:
        pass
    repo = repo or os.path.basename(cwd.rstrip("/"))

    model = _name(_first(data, "model", "model_name", "modelName", "session.model"))
    title = _first(data, "conversation_title", "conversationTitle")
    cost = _first(data, "cost", "cost.total_cost_usd", "session.cost")
    pct = _first(data, "context_window.used_percentage", "context.used_percentage", "context_percent")

    RESET, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"
    BLUE, ORANGE, WHITE = "\033[38;5;39m", "\033[1;38;5;208m", "\033[1;38;5;255m"
    sep = " " + DIM + "·" + RESET + " "

    out = BLUE + BOLD + "📁 " + repo + RESET
    if branch:
        out += " " + DIM + "⎇ " + branch + RESET
    out += "  " + ORANGE + "● Antigravity›" + RESET
    host = (os.uname().nodename.split(".")[0] or "").lower()
    out += " " + DIM + (host + "/agy" if host else "agy") + RESET
    if model:
        out += sep + WHITE + str(model) + RESET
    if pct is not None:
        try:
            out += sep + str(int(round(float(pct)))) + "%"
        except Exception:
            pass
    if isinstance(cost, (int, float)):
        out += sep + DIM + "$%.2f" % cost + RESET
    if isinstance(title, str) and title:
        out += sep + DIM + (title[:40] + "…" if len(title) > 40 else title) + RESET
    try:
        bj = json.load(open(os.path.expanduser("~/.myai/statusline-badge.json")))
        if time.time() - float(bj.get("ts") or 0) < 3 * 3600 and bj.get("sha"):
            sc = bj.get("score")
            sc_s = (" " + str(int(sc))) if isinstance(sc, (int, float)) else ""
            out += sep + "\033[38;5;208m🧠 myAI " + str(bj["sha"])[:8] + sc_s + RESET
        else:
            out += " " + DIM + "· 🧠 myAI off" + RESET
    except Exception:
        out += " " + DIM + "· 🧠 myAI off" + RESET
    sys.stdout.write(out)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stdout.write("● Antigravity")
