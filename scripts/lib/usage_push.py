#!/usr/bin/env python3
"""usage_push.py — ship THIS Mac's per-account usage to the shared ledger
(gateway tool account_usage_record; multi-Mac phase 2, plan/MULTI_MAC_SWARM_BRIEF.md).

Two things per run:
  1. Hourly token BUCKETS per account × model, recomputed from this Mac's own
     Claude Code transcripts (<profile>/projects/**/*.jsonl), DEDUPED by
     message.id (fallback requestId): Claude Code repeats the same usage on
     every content-block line of one message. Whole hours are recomputed and
     SET on the gateway, so re-pushing never double-counts.
  2. REAL READINGS: ~/.myai/usage-live/<account>.json (written by
     scripts/org-statusline.sh from the statusLine rate_limits) and agy's
     ~/.myai/agy-statusline-last.json quota (gemini-5h / gemini-weekly).

Usage: usage_push.py [--hours N] [--dry-run]
Env: USAGE_PROFILES ("<name>:<dir> …"; default every ~/.claude-<name> dir — usage_push.sh
     passes the configured profile names),
     USAGE_HOST, MYAI_HOME, USAGE_GATEWAY_URL (http://localhost:3100/mcp), GATEWAY_LOCAL_TOKEN.
Stdlib only. Tests: scripts/tests/test_usage_ledger.sh
"""
import glob
import json
import os
import socket
import sys
import time
import urllib.request
from datetime import datetime, timezone

CHUNK = 2000


def env(k, d):
    v = os.environ.get(k, "")
    return v if v else d


def host():
    return env("USAGE_HOST", socket.gethostname().split(".")[0]).lower()


def profiles():
    spec = env("USAGE_PROFILES", "")
    if not spec:
        # Profile names are user data (v1 G6 P4): every ~/.claude-<name> dir.
        home = os.path.expanduser("~")
        spec = " ".join("%s:%s" % (os.path.basename(d)[len(".claude-"):], d)
                        for d in sorted(glob.glob(os.path.join(home, ".claude-*")))
                        if os.path.isdir(d))
    out = []
    for item in spec.split():
        acct, _, path = item.partition(":")
        if acct and path:
            out.append((acct, os.path.expanduser(path)))
    return out


def iso_hour(ts):
    """'2026-10-05T03:47:12.123Z' → '2026-10-05T03:00:00Z' (None if unparseable)."""
    if not isinstance(ts, str) or len(ts) < 13:
        return None
    return ts[:13] + ":00:00Z"


def buckets_for(account, cfg, since_iso):
    """{(hour, model): [output, input, cacheCreate, cacheRead]} for lines at/after since_iso."""
    since_epoch = datetime.fromisoformat(since_iso.replace("Z", "+00:00")).timestamp()
    last = {}       # dedupe key → (hour, model, usage)
    anon = []       # lines with no id: each counts once
    for f in glob.glob(os.path.join(cfg, "projects", "**", "*.jsonl"), recursive=True):
        try:
            if os.path.getmtime(f) < since_epoch:
                continue    # a file with lines in the window was written in it
            fh = open(f, encoding="utf-8", errors="ignore")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != "assistant":
                    continue
                ts = d.get("timestamp")
                if not isinstance(ts, str) or ts < since_iso:
                    continue
                m = d.get("message") or {}
                u = m.get("usage") or {}
                hour = iso_hour(ts)
                if not hour:
                    continue
                rec = (hour, str(m.get("model") or "unknown"), u)
                k = m.get("id") or d.get("requestId")
                if k:
                    last[k] = rec
                else:
                    anon.append(rec)
    agg = {}
    for hour, model, u in list(last.values()) + anon:
        a = agg.setdefault((hour, model), [0, 0, 0, 0])
        for i, f in enumerate(("output_tokens", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")):
            try:
                a[i] += int(u.get(f, 0) or 0)
            except (TypeError, ValueError):
                pass
    return [{"account": account, "host": host(), "hour": h, "model": mdl,
             "output": v[0], "input": v[1], "cacheCreate": v[2], "cacheRead": v[3]}
            for (h, mdl), v in sorted(agg.items())]


def iso_epoch(sec):
    try:
        return datetime.fromtimestamp(int(sec), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def state_home():
    """MYAI_HOME is the per-user STATE dir; a framework checkout there (the old
    portable-compose meaning) put usage-live/ at the AI repo root — ignore it."""
    h = env("MYAI_HOME", "")
    if h and os.path.isfile(os.path.join(h, "scripts", "lib", "brain.sh")) \
            and os.path.isdir(os.path.join(h, "runtime")):
        h = ""
    return h or os.path.expanduser("~/.myai")


def live_readings():
    out = []
    d = os.path.join(state_home(), "usage-live")
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        try:
            r = json.load(open(f))
        except (OSError, ValueError):
            continue
        five, seven = r.get("five_hour") or {}, r.get("seven_day") or {}
        rec = {"account": r.get("account"), "host": r.get("host") or host(), "source": "statusline",
               "at": iso_epoch(r.get("at"))}
        if isinstance(five.get("used_percentage"), (int, float)):
            rec["fiveHourPct"] = five["used_percentage"]
            rec["fiveHourResetsAt"] = iso_epoch(five.get("resets_at"))
        if isinstance(seven.get("used_percentage"), (int, float)):
            rec["sevenDayPct"] = seven["used_percentage"]
            rec["sevenDayResetsAt"] = iso_epoch(seven.get("resets_at"))
        if rec["account"] and rec["at"] and ("fiveHourPct" in rec or "sevenDayPct" in rec):
            out.append({k: v for k, v in rec.items() if v is not None})
    return out


def agy_reading():
    f = os.path.join(env("MYAI_HOME", os.path.expanduser("~/.myai")), "agy-statusline-last.json")
    try:
        d = json.load(open(f))
        at = iso_epoch(os.path.getmtime(f))
    except (OSError, ValueError):
        return []
    q = d.get("quota") or {}
    rec = {"account": "agy", "host": host(), "source": "agy", "at": at}
    for key, pct, resets in (("gemini-5h", "fiveHourPct", "fiveHourResetsAt"), ("gemini-weekly", "sevenDayPct", "sevenDayResetsAt")):
        w = q.get(key) or {}
        rem = w.get("remaining_fraction")
        if isinstance(rem, (int, float)):
            rec[pct] = round(max(0.0, min(1.0, 1 - rem)) * 100, 1)
            if w.get("reset_time"):
                rec[resets] = w["reset_time"]
    return [rec] if ("fiveHourPct" in rec or "sevenDayPct" in rec) else []


def call(args):
    url = env("USAGE_GATEWAY_URL", "http://localhost:%s/mcp" % env("MCP_PORT", "3100"))
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                       "params": {"name": "account_usage_record", "arguments": args}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "x-gateway-local-token": env("GATEWAY_LOCAL_TOKEN", "myai-local-bridge-dev")})
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.loads(r.read().decode())
    res = json.loads(out["result"]["content"][0]["text"])
    if res.get("error"):
        raise RuntimeError(res["error"])
    return res


def main(argv):
    hours = 48
    dry = "--dry-run" in argv
    if "--hours" in argv:
        hours = max(1, int(argv[argv.index("--hours") + 1]))
    now = time.time()
    # Whole hours: the oldest bucket recomputed is complete.
    since_iso = datetime.fromtimestamp(now - hours * 3600, tz=timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    buckets = []
    for acct, cfg in profiles():
        if os.path.isdir(cfg):
            buckets += buckets_for(acct, cfg, since_iso)
    readings = live_readings() + agy_reading()
    summary = "usage_push: host %s · %d bucket(s) since %s · %d reading(s)" % (host(), len(buckets), since_iso, len(readings))
    if dry:
        print(summary + " (dry-run)")
        print(json.dumps({"buckets": buckets[:5], "readings": readings}, indent=1))
        return 0
    try:
        for i in range(0, max(1, len(buckets)), CHUNK):
            call({"buckets": buckets[i:i + CHUNK], "readings": readings if i == 0 else []})
    except Exception as e:  # gateway down: try again next tick, never fail the caller
        print("usage_push: gateway unreachable or refused (%s) — will retry next tick" % e, file=sys.stderr)
        return 2
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
