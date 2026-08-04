#!/usr/bin/env python3
"""Bounded tool-calling agent for the runner's TRIVIAL -> LOCAL tier.

`claude -p --model <ollama-model>` does not route to Ollama (verified
2026-07-18 -- Claude Code sends the model name straight to Anthropic, which
naturally doesn't know it). This talks to the Ollama HTTP API directly
instead, giving the model a small read/write/list toolset scoped to
--workdir so it can actually make the mechanical edit a trivial task asks
for, then stops as soon as it returns a plain-text (non-tool-call) answer.

Stdlib only (no `requests`) so it runs with the system python3 the rest of
this repo's scripts already assume.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files in a directory relative to the repo root.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory, relative to repo root. Default '.'"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file's contents, relative to the repo root.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Overwrite (or create) a text file relative to the repo root. "
                "Always pass the COMPLETE new file content, not a diff/patch."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
]

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".next", "dist"}

# Ollama 0.31.2 + qwen2.5-coder:7b (live smoke test, 2026-07-19) doesn't reliably
# populate the native message.tool_calls field, and left to its own devices will
# sometimes hallucinate an entire multi-turn tool-call transcript as one reply
# instead of making one call and waiting. This system message plus the
# parse_fallback_tool_calls()/_leading_json_value() recovery below is the
# workaround: push the model toward exactly one call per turn, and recover
# gracefully (take just the leading call) when it doesn't listen.
SYSTEM_PROMPT = (
    "You are a small coding agent with exactly three tools: list_files, read_file, "
    "write_file. On EVERY turn, respond with EITHER (a) a single JSON object "
    '{"name": "<tool>", "arguments": {...}} and NOTHING else -- no prose, no code '
    "fences, no markdown, no second call -- OR (b) plain text starting with "
    '"RESULT: " once the task is fully done. Never guess file contents: read a '
    "file before rewriting it. write_file always takes the COMPLETE new file "
    "content, not a diff."
)


def sandboxed_path(workdir, rel):
    """Resolve `rel` under `workdir`, refusing anything that escapes it."""
    root = os.path.realpath(workdir)
    p = os.path.realpath(os.path.join(root, rel or "."))
    if p != root and not p.startswith(root + os.sep):
        raise ValueError(f"path escapes workdir: {rel!r}")
    return p


def tool_list_files(workdir, rel="."):
    base = sandboxed_path(workdir, rel)
    if not os.path.isdir(base):
        return f"error: not a directory: {rel}"
    entries = []
    for name in sorted(os.listdir(base)):
        if name in SKIP_DIRS:
            continue
        entries.append(name + ("/" if os.path.isdir(os.path.join(base, name)) else ""))
    return "\n".join(entries) or "(empty)"


def tool_read_file(workdir, rel, max_chars=20000):
    p = sandboxed_path(workdir, rel)
    with open(p, "r", errors="replace") as f:
        data = f.read(max_chars + 1)
    if len(data) > max_chars:
        data = data[:max_chars] + "\n...(truncated)"
    return data


class WriteGuardError(ValueError):
    """Raised by tool_write_file when a write is blocked by the local-tier write
    guard (protected path, or content that looks destructive/hallucinated)."""


# ── WRITE GUARD (operator directive 2026-07-26, tightened after commit 4ece268) ──
# ollama_local_tier.sh's ollama_guard_check() inspects the STAGED diff before
# commit, but only for a curated list of protected globs (CLAUDE.md, plan/*.md,
# AI/**, lockfiles) -- .gitignore was never on that list, which is exactly how
# commit 4ece268 gutted 90 lines of it and let machine-local ledgers (state/*)
# get committed. This is the earlier, complementary layer: block the write
# itself, at the tool call, before anything ever reaches disk or a diff.
PROTECTED_TOP_DIRS = {".github", "hooks", "plan", "state"}

# Raw chat-template / tool-transcript markers. Observed failure mode: a local
# 7B model asked to make a small edit instead emits (and the loop then writes
# verbatim) an entire hallucinated multi-turn transcript as file content.
TRANSCRIPT_MARKERS = (
    "<tool_response>", "</tool_response>",
    "<tool_call>", "</tool_call>",
    "<|im_start|>", "<|im_end|>",
)

# A write that shrinks an existing file by more than this fraction is refused
# outright -- the mechanical backstop for the overnight incident where a
# "fix" clobbered GRAND_PRODUCT_ROADMAP.md down to a fraction of its size.
SHRINK_RATIO_THRESHOLD = 0.5


def _protected_path_reason(rel):
    norm = rel.replace(os.sep, "/")
    parts = [p for p in norm.split("/") if p and p != "."]
    if not parts:
        return None
    if parts[-1] == ".gitignore":
        return f"protected path: {rel!r} (.gitignore is denylisted for local-tier writes)"
    if parts[0] in PROTECTED_TOP_DIRS:
        return f"protected path: {rel!r} (under denylisted directory {parts[0]}/)"
    return None


def _transcript_marker_reason(content):
    for marker in TRANSCRIPT_MARKERS:
        if marker in content:
            return f"content looks like a raw LLM transcript (found {marker!r}) -- refusing to write"
    return None


def _shrink_reason(existing_path, rel, content):
    if not os.path.isfile(existing_path):
        return None
    try:
        with open(existing_path, "r", errors="replace") as f:
            old = f.read()
    except OSError:
        return None
    old_len = len(old)
    if old_len == 0:
        return None
    new_len = len(content)
    if new_len < old_len * SHRINK_RATIO_THRESHOLD:
        pct = 100 - (new_len * 100 // old_len)
        return (
            f"write shrinks {rel!r} by ~{pct}% ({old_len} -> {new_len} chars) "
            "-- refusing (looks destructive)"
        )
    return None


def write_guard_reason(rel, content, existing_path):
    """None when the write is safe; else a human-readable rejection reason."""
    return (
        _protected_path_reason(rel)
        or _transcript_marker_reason(content)
        or _shrink_reason(existing_path, rel, content)
    )


def tool_write_file(workdir, rel, content):
    p = sandboxed_path(workdir, rel)
    reason = write_guard_reason(rel, content, p)
    if reason:
        raise WriteGuardError(reason)
    parent = os.path.dirname(p)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(p, "w") as f:
        f.write(content)
    return f"wrote {len(content)} bytes to {rel}"


TOOL_NAMES = {t["function"]["name"] for t in TOOLS}


def _coerce_call(obj):
    """A single {"name": ..., "arguments": {...}} dict -> native tool_call shape, else None."""
    if not isinstance(obj, dict):
        return None
    name = obj.get("name")
    if name not in TOOL_NAMES:
        return None
    return {"function": {"name": name, "arguments": obj.get("arguments", obj.get("parameters", {}))}}


def _leading_json_value(text):
    """Extract just the first balanced {...}/[...] value from the start of
    `text`, ignoring anything after it. A weakly-instruction-following small
    model sometimes hallucinates trailing prose (or even a second call) after
    a perfectly valid leading tool call -- json.loads on the whole string
    would reject that; this recovers the leading value on its own."""
    if not text or text[0] not in "{[":
        return None
    opens, closes = "{[", "}]"
    depth = 0
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in opens:
            depth += 1
        elif ch in closes:
            depth -= 1
            if depth == 0:
                candidate = text[: i + 1]
                try:
                    return json.loads(candidate)
                except Exception:
                    return None
    return None


def parse_fallback_tool_calls(content):
    """Some Ollama models/versions don't populate message.tool_calls and instead
    emit the call as JSON text in `content` (observed with qwen2.5-coder:7b on
    Ollama 0.31.2 -- e.g. content == '{"name": "read_file", "arguments": {...}}',
    sometimes followed by hallucinated extra text/turns). Best-effort recovery:
    strip markdown fences, then try the whole text as JSON and fall back to
    just the leading balanced JSON value. Returns [] when nothing recognizable
    is found, in which case the caller correctly falls back to treating the
    reply as prose.
    """
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    if not text.startswith("{") and not text.startswith("["):
        return []
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = _leading_json_value(text)
        if parsed is None:
            return []
    if isinstance(parsed, dict):
        call = _coerce_call(parsed)
        return [call] if call else []
    if isinstance(parsed, list):
        calls = [c for c in (_coerce_call(item) for item in parsed) if c]
        return calls if len(calls) == len(parsed) else []
    return []


def default_transport(base_url, payload, timeout=90):
    req = urllib.request.Request(
        base_url.rstrip("/") + "/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_agent(workdir, model, prompt, base_url="http://localhost:11434",
              keep_alive="2m", max_iters=6, transport=None, log=print):
    """Drive the bounded tool-call loop. Returns (ok, edited)."""
    transport = transport or default_transport
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}]
    edited = False

    for _ in range(max_iters):
        payload = {
            "model": model,
            "messages": messages,
            "tools": TOOLS,
            "stream": False,
            "keep_alive": keep_alive,
        }
        try:
            data = transport(base_url, payload)
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            log(f"[ollama-agent] transport error: {e}")
            return False, edited

        msg = (data or {}).get("message") or {}
        tool_calls = msg.get("tool_calls") or []
        content = msg.get("content") or ""

        if not tool_calls and content:
            tool_calls = parse_fallback_tool_calls(content)
            if tool_calls:
                log(f"[ollama-agent] recovered tool call from content text (no native tool_calls): {content.strip()[:120]}")

        if not tool_calls:
            if content.strip():
                log(content.strip())
                if "RESULT:" not in content:
                    first_line = content.strip().splitlines()[0][:200]
                    log(f"RESULT: {first_line}")
                return True, edited
            log("[ollama-agent] empty response with no tool calls -- stopping")
            return False, edited

        messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
        for tc in tool_calls:
            fn = tc.get("function") or {}
            name = fn.get("name")
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            try:
                if name == "list_files":
                    result = tool_list_files(workdir, args.get("path", "."))
                elif name == "read_file":
                    result = tool_read_file(workdir, args["path"])
                elif name == "write_file":
                    result = tool_write_file(workdir, args["path"], args.get("content", ""))
                    edited = True
                else:
                    result = f"error: unknown tool {name!r}"
            except Exception as e:
                result = f"error: {e}"
            log(f"[tool] {name}({args.get('path', '')}) -> {result[:200]}")
            messages.append({"role": "tool", "content": result})

    log(f"[ollama-agent] hit max_iters={max_iters} without a final answer -- giving up")
    return False, edited


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--base-url", default=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434"))
    ap.add_argument("--keep-alive", default=os.environ.get("OLLAMA_LOCAL_KEEP_ALIVE", "2m"))
    ap.add_argument("--max-iters", type=int, default=int(os.environ.get("OLLAMA_LOCAL_MAX_ITERS", "6")))
    args = ap.parse_args()

    prompt = sys.stdin.read()
    ok, edited = run_agent(
        args.workdir, args.model, prompt,
        base_url=args.base_url, keep_alive=args.keep_alive, max_iters=args.max_iters,
    )
    print(f"[ollama-agent] done ok={ok} edited={edited}")
    sys.exit(0 if (ok and edited) else 1)


if __name__ == "__main__":
    main()
