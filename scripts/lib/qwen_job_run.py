#!/usr/bin/env python3
"""qwen_job_run.py — the deterministic core of the qwen swarm lane.

WHY: an 8B local model cannot be a Claude-Code-style agent. Live, claude-qwen
(qwen3:8b) spent 2.5 min on "read state/boot/BOOT_REPORT.*.md, summarise, report
via tell.sh", claimed the files did not exist (they did), asked a question and
never reported. So the qwen lane gives the model NO tools and NO choices: this
script reads the files, makes ONE no-tools Ollama /api/chat call, and ALWAYS
mails the sender back — the answer (kind=done) or the reason it failed
(kind=blocker) — and only THEN acks the job (a crash re-runs, never loses).

Driven by scripts/qwen_lane.sh (the visible-tab loop + quiet governor); jobs
are queued with scripts/qwen_job.sh. Stdlib only.

  qwen_job_run.py next     → print the oldest unacked job id for $QWEN_ADDR, or nothing
  qwen_job_run.py process  → handle that oldest job end to end; one log line per step
  qwen_job_run.py state k=v [k=v ...] → merge keys into the lane state file
                             (read by scripts/qwen_statusline.sh for the chat statusLine)

Job = a mail to <host>/qwen, kind=request, body = JSON:
  {"files": ["state/boot/BOOT_REPORT.*.md"], "prompt": "...", "maxLines": 40,
   "model": "qwen3:8b", "maxChars": 48000, "timeout": 180}

Env: QWEN_ADDR (default <this host>/qwen) · QWEN_REPO_ROOT (globs resolve here; files
outside it are refused) · QWEN_GATEWAY_URL (http://localhost:3100/mcp) ·
GATEWAY_LOCAL_TOKEN · QWEN_OLLAMA_URL (http://localhost:11434) · QWEN_MODEL
(qwen3:8b) · QWEN_STATE_DIR (re-run markers) · QWEN_MAX_CHARS · QWEN_TIMEOUT.
Tests: scripts/tests/test_qwen_lane.sh
"""
import glob
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

DEFAULT_MAX_CHARS = 48000
HARD_MAX_CHARS = 120000
DEFAULT_TIMEOUT = 180
HARD_MAX_TIMEOUT = 600
DEFAULT_MAX_LINES = 60
# This host's qwen mailbox (`hostname -s`, lowercased), e.g. "office-mac/qwen".
DEFAULT_QWEN_ADDR = socket.gethostname().split(".")[0].lower() + "/qwen"

SYSTEM_PROMPT = (
    "You are a careful, concise assistant working for a software team. "
    "The files you need are pasted below between FILE markers - they exist and "
    "you have their full text (or a clearly marked truncation). Answer ONLY from "
    "that text. Do not ask questions back; if something is missing, say so in one "
    "line and answer what you can. Plain text or short markdown, no preamble."
)


def env(name, default):
    v = os.environ.get(name, "")
    return v if v else default


def log(msg):
    print(msg, flush=True)


# ── gateway (JSON-RPC tools/call) ────────────────────────────────────────────
def gw_call(tool, args, timeout=10):
    url = env("QWEN_GATEWAY_URL", "http://localhost:%s/mcp" % env("MCP_PORT", "3100"))
    token = env("GATEWAY_LOCAL_TOKEN", "myai-local-bridge-dev")
    body = json.dumps({"jsonrpc": "2.0", "method": "tools/call", "id": 1,
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "x-gateway-local-token": token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        outer = json.loads(r.read().decode())
    if "error" in outer:
        raise RuntimeError("gateway %s error: %s" % (tool, outer["error"]))
    text = outer["result"]["content"][0]["text"]
    try:
        return json.loads(text)
    except ValueError:
        return {"text": text}


def oldest_job(addr):
    inbox = gw_call("mail_inbox", {"to": addr, "limit": 200})
    msgs = [m for m in inbox.get("messages", []) if not m.get("acked")]
    msgs.sort(key=lambda m: m.get("createdAt", ""))
    return msgs[0] if msgs else None


def send_reply(job, kind, subject, body):
    # No sender (mail_send always sets one): this host's coordinator, whichever
    # lane holds it — never a lane name (v1 G6).
    fallback = DEFAULT_QWEN_ADDR.split("/")[0] + "/coordinator"
    args = {"to": job.get("from") or fallback, "from": env("QWEN_ADDR", DEFAULT_QWEN_ADDR),
            "kind": kind, "subject": subject[:200], "body": body, "replyTo": job["messageId"]}
    res = gw_call("mail_send", args)
    if res.get("error"):
        raise RuntimeError("mail_send refused: %s" % res["error"])
    return (res.get("message") or {}).get("messageId") or res.get("messageId") or "?"


def ack(job):
    gw_call("mail_ack", {"id": job["messageId"], "ackedBy": env("QWEN_ADDR", DEFAULT_QWEN_ADDR)})


# ── job parsing + file reading ───────────────────────────────────────────────
class JobError(Exception):
    pass


def parse_job(job):
    raw = (job.get("body") or "").strip()
    try:
        spec = json.loads(raw)
    except ValueError:
        raise JobError("job body is not JSON — queue jobs with scripts/qwen_job.sh "
                       "(body = {\"files\": [...], \"prompt\": \"...\"})")
    if not isinstance(spec, dict) or not str(spec.get("prompt", "")).strip():
        raise JobError("job has no \"prompt\"")
    files = spec.get("files") or []
    if isinstance(files, str):
        files = [files]
    spec["files"] = [str(f) for f in files]
    return spec


def clamp_int(v, default, lo, hi):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def read_files(patterns, root, max_chars):
    """Expand globs under root. Returns (blocks, notes, n_files, n_chars)."""
    root_real = os.path.realpath(root)
    paths, notes = [], []
    for pat in patterns:
        full = pat if os.path.isabs(pat) else os.path.join(root, pat)
        hits = sorted(glob.glob(full, recursive=True))
        if not hits:
            notes.append("no match: %s" % pat)
        for h in hits:
            real = os.path.realpath(h)
            if not (real == root_real or real.startswith(root_real + os.sep)):
                notes.append("refused (outside repo): %s" % pat)
                continue
            if re.search(r"(^|/)\.env(\.|$)", os.path.relpath(real, root_real)) and not real.endswith(".example"):
                notes.append("refused (.env): %s" % os.path.relpath(real, root_real))
                continue
            if os.path.isfile(real) and real not in paths:
                paths.append(real)
    blocks, used = [], 0
    for p in paths:
        rel = os.path.relpath(p, root_real)
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError as e:
            notes.append("unreadable: %s (%s)" % (rel, e.strerror))
            continue
        room = max_chars - used
        if room <= 0:
            notes.append("skipped (size cap %d chars reached): %s" % (max_chars, rel))
            continue
        if len(text) > room:
            text = text[:room] + "\n[... TRUNCATED by qwen_lane: %d of %d chars shown ...]" % (room, len(text))
            notes.append("truncated: %s" % rel)
        used += min(len(text), room)
        blocks.append("===== FILE: %s =====\n%s\n===== END FILE: %s =====" % (rel, text, rel))
    return blocks, notes, len(blocks), used


# ── Ollama ────────────────────────────────────────────────────────────────────
def ollama_chat(model, user_text, timeout):
    url = env("QWEN_OLLAMA_URL", "http://localhost:11434").rstrip("/") + "/api/chat"
    body = json.dumps({
        "model": model, "stream": False, "think": False,
        "keep_alive": env("OLLAMA_KEEP_ALIVE", "5m"),
        "options": {"num_ctx": int(env("QWEN_NUM_CTX", "65536"))},
        "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                     {"role": "user", "content": user_text}],
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode())
    text = (out.get("message") or {}).get("content", "")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def trim_lines(text, max_lines):
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join(lines[:max_lines]) + "\n[... %d more line(s) trimmed to maxLines=%d ...]" % (len(lines) - max_lines, max_lines)


# ── re-run marker (a reply already went out but the ack did not) ─────────────
def marker_path(job_id):
    d = env("QWEN_STATE_DIR", os.path.join(env("MYAI_HOME", os.path.expanduser("~/.myai")), "qwen-lane", "replied"))
    return d, os.path.join(d, re.sub(r"[^A-Za-z0-9_.-]", "_", job_id))


def was_replied(job_id):
    return os.path.exists(marker_path(job_id)[1])


def mark_replied(job_id):
    d, p = marker_path(job_id)
    try:
        os.makedirs(d, exist_ok=True)
        with open(p, "w") as fh:
            fh.write(str(int(time.time())))
    except OSError:
        pass


# ── lane state (what the claude-qwen statusLine shows) ───────────────────────
def state_file():
    return env("QWEN_STATE_FILE", os.path.join(env("MYAI_HOME", os.path.expanduser("~/.myai")), "qwen-lane", "state.json"))


def write_state(**kw):
    """Merge kw into the state file atomically; last_* keys survive transitions."""
    p = state_file()
    try:
        with open(p) as fh:
            cur = json.load(fh)
    except (OSError, ValueError):
        cur = {}
    cur.update(kw)
    cur["updated"] = int(time.time())
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".%d.tmp" % os.getpid()
        with open(tmp, "w") as fh:
            json.dump(cur, fh)
        os.replace(tmp, p)
    except OSError:
        pass


# ── one job, end to end ──────────────────────────────────────────────────────
NO_REPLY_KINDS = ("done", "blocker", "result", "merge-go")


def process(job):
    jid, sender = job["messageId"], job.get("from", "?")
    # Never answer a result or ourselves — two automated lanes must not ping-pong.
    if job.get("kind") in NO_REPLY_KINDS or sender == env("QWEN_ADDR", DEFAULT_QWEN_ADDR):
        ack(job)
        log("acked %s without reply (kind=%s from %s — not a job)" % (jid, job.get("kind"), sender))
        return 0
    rerun = "(re-run) " if was_replied(jid) else ""
    write_state(state="working", job=jid, job_from=sender, since=int(time.time()))
    log("job %s from %s%s" % (jid, sender, " — RE-RUN (replied before, ack missing)" if rerun else ""))
    start = time.time()
    model = env("QWEN_MODEL", "qwen3:8b")
    try:
        spec = parse_job(job)
        model = str(spec.get("model") or model)
        max_chars = clamp_int(spec.get("maxChars"), int(env("QWEN_MAX_CHARS", DEFAULT_MAX_CHARS)), 1000, HARD_MAX_CHARS)
        timeout = clamp_int(spec.get("timeout"), int(env("QWEN_TIMEOUT", DEFAULT_TIMEOUT)), 5, HARD_MAX_TIMEOUT)
        max_lines = clamp_int(spec.get("maxLines"), DEFAULT_MAX_LINES, 1, 2000)
        root = env("QWEN_REPO_ROOT", os.getcwd())
        blocks, notes, nfiles, nchars = read_files(spec["files"], root, max_chars)
        log("reading %d file(s) (%.1fk chars)%s" % (nfiles, nchars / 1000.0, (" — " + "; ".join(notes)) if notes else ""))
        if spec["files"] and nfiles == 0:
            raise JobError("none of the files could be read: " + "; ".join(notes))
        user = spec["prompt"].strip()
        if blocks:
            user = "\n\n".join(blocks) + "\n\nTASK: " + user
        log("thinking (%s, timeout %ds)" % (model, timeout))
        try:
            answer = ollama_chat(model, user, timeout)
        except (socket.timeout, TimeoutError):
            raise JobError("Ollama timed out after %ds (model %s)" % (timeout, model))
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", e)
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise JobError("Ollama timed out after %ds (model %s)" % (timeout, model))
            raise JobError("Ollama unreachable at %s: %s" % (env("QWEN_OLLAMA_URL", "http://localhost:11434"), reason))
        if not answer:
            raise JobError("model returned an empty answer")
        secs = time.time() - start
        body = trim_lines(answer, max_lines) + "\n\n— qwen lane · %s · %d file(s), %.1fk chars%s · %.0fs" % (
            model, nfiles, nchars / 1000.0, (" · notes: " + "; ".join(notes)) if notes else "", secs)
        subject = "%sqwen: %s" % (rerun, spec["prompt"].strip().splitlines()[0][:120])
        kind = "done"
    except JobError as e:
        secs = time.time() - start
        kind, subject = "blocker", "%sqwen job failed: %s" % (rerun, str(e)[:150])
        body = "qwen lane could not complete job %s: %s\n\n— qwen lane · %s · %.0fs" % (jid, e, model, secs)
        log("failed: %s" % e)
    mid = send_reply(job, kind, subject, body)
    mark_replied(jid)
    now = int(time.time())
    write_state(state="idle", since=now, last_from=sender, last_kind=kind, last_at=now,
                last_secs=int(time.time() - start))
    log("replied %s to %s (%s, %.0fs)" % (kind, sender, mid, time.time() - start))
    ack(job)
    log("acked %s" % jid)
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "process"
    if cmd == "state":
        kv = {}
        for a in argv[2:]:
            k, _, v = a.partition("=")
            kv[k] = int(v) if v.isdigit() else v
        write_state(**kv)
        return 0
    addr = env("QWEN_ADDR", DEFAULT_QWEN_ADDR)
    try:
        job = oldest_job(addr)
    except Exception as e:  # gateway down → the loop retries later
        log("gateway unreachable: %s" % e)
        return 2
    if cmd == "next":
        if job:
            print(job["messageId"])
        return 0
    if cmd == "process":
        if not job:
            return 1
        try:
            return process(job)
        except Exception as e:  # reply/ack failed → leave unacked, retry next round
            log("could not reply/ack (left queued for retry): %s" % e)
            return 2
    print("usage: qwen_job_run.py next|process", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
