#!/usr/bin/env python3
"""Bounded tool-calling agent over an OpenAI-compatible chat-completions API.

The runner's non-Claude agentic FALLBACK lane (task-4f813e39, see
plan/ADR_AGENTIC_FALLBACK_LANE.md): when the Claude subscription's session
window is exhausted, DeepSeek / Kimi (Moonshot) — both OpenAI-compatible,
separately billed — can keep draining the queue. This is the tool loop that
gives them real repo access: list/read/write files plus a workdir-scoped,
deny-listed run_command so they can run tests. Git commit/push stays with the
shell wrapper (scripts/lib/agentic_fallback.sh), mirroring the Ollama lane.

Stdlib only (no `requests`) so it runs with the system python3 the rest of
this repo's scripts already assume. The API key is read from the environment,
then REMOVED from os.environ before any run_command executes, and masked in
any tool output — the model can never echo its own key into the session log.
"""
import argparse
import datetime
import json
import os
import subprocess
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
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": (
                "Run a shell command inside the repo (tests, linters, builds, git status/diff/log). "
                "Not allowed: git push/commit (the harness commits and pushes for you), sudo, "
                "package installs on the host. Output is truncated."
            ),
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
]

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".next", "dist", ".worktrees"}

# Commands the model may NOT run. The harness owns git commit/push (single
# commit, test branch, rebase retry); everything host-mutating is out of scope
# for a headless fallback lane. Substring match on the whole command line.
COMMAND_DENYLIST = (
    "git push",
    "git commit",
    "sudo ",
    "shutdown",
    "reboot",
    "npm install",
    "npm ci",
    "pip install",
    "brew install",
    "docker compose up",
    "docker compose down",
    "--force",
    "rm -rf /",
)

SYSTEM_PROMPT = (
    "You are a headless coding agent working ONE task in a git repo. You have four tools: "
    "list_files, read_file, write_file, run_command. Never guess file contents: read a file "
    "before rewriting it; write_file always takes the COMPLETE new file content, not a diff. "
    "Use run_command to run the repo's tests/typecheck and verify your work (git push/commit "
    "are handled by the harness — do NOT attempt them). Stay on the current branch. "
    "When the task is fully done, reply with plain text (no tool call) that includes a line "
    'starting with "RESULT: " summarizing what you changed and how you verified it. '
    "If you cannot complete the task, reply with plain text containing "
    '"RESULT: BLOCKED — <reason>".'
)

# USD per 1M tokens (input, output) — refreshed 2026-07 from public price pages;
# override per run with AGENTIC_PRICE_IN_PER_M / AGENTIC_PRICE_OUT_PER_M.
# Unknown model ids fall back to the most expensive known row (fail-safe: the
# budget gate overestimates rather than under-counts).
PRICES_PER_M = {
    "deepseek-chat": (0.28, 0.42),
    "deepseek-reasoner": (0.28, 0.42),
    "kimi-k2.6": (0.60, 2.50),
    "kimi-k2": (0.60, 2.50),
    "moonshot-v1-8k": (0.20, 2.00),
}
FALLBACK_PRICE = (0.60, 2.50)

# plan/ADR_AGENTIC_FALLBACK_LANE.md Consequences/Follow-ups: "pricing table
# refresh cadence (unit prices drift)". PRICES_PER_M is hand-refreshed from
# vendor price pages, not pulled live (this lane is stdlib-only, no vendor
# pricing API), so PRICING_LAST_CHECKED records when that refresh happened.
# pricing_staleness_warning() is the pre-run check the ADR asked for: it
# warns once the table is older than PRICING_MAX_AGE_DAYS, so the
# AGENTIC_FALLBACK_DAILY_USD_CAP enforcement doesn't silently run on stale
# rates. Bump PRICING_LAST_CHECKED whenever PRICES_PER_M is verified/updated.
PRICING_LAST_CHECKED = "2026-07-25"
PRICING_MAX_AGE_DAYS = int(os.environ.get("AGENTIC_PRICING_MAX_AGE_DAYS", "45"))


def pricing_staleness_warning(today=None, last_checked=None, max_age_days=None):
    """None when PRICES_PER_M was last verified within max_age_days, else a
    human-readable warning string. `last_checked` defaults to
    AGENTIC_PRICING_LAST_CHECKED (env override, for testing/ops) or
    PRICING_LAST_CHECKED; `today`/`max_age_days` default similarly."""
    if last_checked is None:
        last_checked = os.environ.get("AGENTIC_PRICING_LAST_CHECKED", PRICING_LAST_CHECKED)
    if max_age_days is None:
        max_age_days = PRICING_MAX_AGE_DAYS
    if today is None:
        today = datetime.date.today()
    try:
        checked_date = datetime.date.fromisoformat(last_checked)
    except ValueError:
        return f"PRICING_LAST_CHECKED is not a valid YYYY-MM-DD date: {last_checked!r}"
    age_days = (today - checked_date).days
    if age_days > max_age_days:
        return (
            f"pricing table last refreshed {last_checked} ({age_days}d ago, "
            f"exceeds {max_age_days}d) -- DeepSeek/Kimi $/token rates may have "
            "drifted; verify PRICES_PER_M in scripts/lib/openai_agent.py against "
            "current vendor price pages and bump PRICING_LAST_CHECKED"
        )
    return None


def price_for_model(model):
    in_env = os.environ.get("AGENTIC_PRICE_IN_PER_M")
    out_env = os.environ.get("AGENTIC_PRICE_OUT_PER_M")
    if in_env and out_env:
        try:
            return float(in_env), float(out_env)
        except ValueError:
            pass
    for key, price in PRICES_PER_M.items():
        if model.startswith(key):
            return price
    return FALLBACK_PRICE


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


def tool_read_file(workdir, rel, max_chars=40000):
    p = sandboxed_path(workdir, rel)
    with open(p, "r", errors="replace") as f:
        data = f.read(max_chars + 1)
    if len(data) > max_chars:
        data = data[:max_chars] + "\n...(truncated)"
    return data


def tool_write_file(workdir, rel, content):
    p = sandboxed_path(workdir, rel)
    parent = os.path.dirname(p)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(p, "w") as f:
        f.write(content)
    return f"wrote {len(content)} bytes to {rel}"


def command_denied(command):
    """Return the matched deny-list entry, or None when the command is allowed."""
    low = " ".join(command.split()).lower()
    for bad in COMMAND_DENYLIST:
        if bad in low:
            return bad
    return None


def tool_run_command(workdir, command, timeout=300, max_chars=20000):
    denied = command_denied(command)
    if denied:
        return f"error: command refused (deny-listed: {denied!r}). The harness handles git commit/push."
    try:
        proc = subprocess.run(
            command, shell=True, cwd=workdir,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {timeout}s"
    out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
    if len(out) > max_chars:
        out = out[:max_chars] + "\n...(truncated)"
    return f"exit={proc.returncode}\n{out}".strip()


def default_transport(base_url, api_key, payload, timeout=180):
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_agent(workdir, model, prompt, base_url, api_key,
              max_iters=24, cmd_timeout=300, transport=None, log=print):
    """Drive the bounded tool-call loop. Returns (ok, edited, usage) where
    usage = {"prompt_tokens": int, "completion_tokens": int, "cost_usd": float}."""
    transport = transport or default_transport
    # Key hygiene: run_command children must never see (or be able to echo) the
    # key. Drop it from our own env and mask any accidental occurrence in output.
    for var in ("DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "OPENAI_API_KEY"):
        os.environ.pop(var, None)

    def mask(text):
        return text.replace(api_key, "***") if api_key and api_key in text else text

    staleness = pricing_staleness_warning()
    if staleness:
        log(f"[openai-agent] WARNING: {staleness}")

    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}]
    edited = False
    p_in, p_out = price_for_model(model)
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0}

    for _ in range(max_iters):
        payload = {"model": model, "messages": messages, "tools": TOOLS, "stream": False}
        try:
            data = transport(base_url, api_key, payload)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            log(f"[openai-agent] HTTP {e.code} from {base_url}: {mask(body)}")
            return False, edited, usage
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            log(f"[openai-agent] transport error: {mask(str(e))}")
            return False, edited, usage

        u = (data or {}).get("usage") or {}
        usage["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
        usage["completion_tokens"] += int(u.get("completion_tokens") or 0)
        usage["cost_usd"] = (usage["prompt_tokens"] * p_in + usage["completion_tokens"] * p_out) / 1e6

        choices = (data or {}).get("choices") or []
        msg = (choices[0].get("message") if choices else {}) or {}
        tool_calls = msg.get("tool_calls") or []
        content = msg.get("content") or ""

        if not tool_calls:
            if content.strip():
                log(mask(content.strip()))
                if "RESULT:" not in content:
                    first_line = content.strip().splitlines()[0][:200]
                    log(f"RESULT: {mask(first_line)}")
                return True, edited, usage
            log("[openai-agent] empty response with no tool calls -- stopping")
            return False, edited, usage

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
                elif name == "run_command":
                    result = tool_run_command(workdir, args.get("command", ""), timeout=cmd_timeout)
                else:
                    result = f"error: unknown tool {name!r}"
            except Exception as e:
                result = f"error: {e}"
            result = mask(result)
            label = args.get("path", args.get("command", ""))
            log(f"[tool] {name}({str(label)[:120]}) -> {result[:200]}")
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": result,
            })

    log(f"[openai-agent] hit max_iters={max_iters} without a final answer -- giving up")
    return False, edited, usage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir")
    ap.add_argument("--model")
    ap.add_argument("--base-url")
    ap.add_argument("--api-key-env",
                    help="Name of the env var holding the API key (never the key itself).")
    ap.add_argument("--max-iters", type=int, default=int(os.environ.get("AGENTIC_MAX_ITERS", "24")))
    ap.add_argument("--cmd-timeout", type=int, default=int(os.environ.get("AGENTIC_CMD_TIMEOUT_SEC", "300")))
    ap.add_argument("--check-pricing", action="store_true",
                    help=("Pre-run check (no agent run, no network, no API key needed): "
                          "print a warning and exit 1 if PRICES_PER_M is stale, else exit 0. "
                          "Called by agentic_fallback.sh before every lane run."))
    args = ap.parse_args()

    if args.check_pricing:
        staleness = pricing_staleness_warning()
        if staleness:
            print(f"[openai-agent] {staleness}")
            sys.exit(1)
        print(f"[openai-agent] pricing table OK (last checked {PRICING_LAST_CHECKED})")
        sys.exit(0)

    if not (args.workdir and args.model and args.base_url and args.api_key_env):
        print("[openai-agent] --workdir/--model/--base-url/--api-key-env are required (unless --check-pricing)")
        sys.exit(2)

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        print(f"[openai-agent] no API key in ${args.api_key_env} -- cannot run")
        sys.exit(1)

    prompt = sys.stdin.read()
    ok, edited, usage = run_agent(
        args.workdir, args.model, prompt,
        base_url=args.base_url, api_key=api_key,
        max_iters=args.max_iters, cmd_timeout=args.cmd_timeout,
    )
    # Machine-readable spend line — agentic_fallback.sh parses this into the
    # lane's own USD day-ledger (separate from the Claude pacing ledger).
    print("[openai-agent] usage " + json.dumps({
        "model": args.model,
        "prompt_tokens": usage["prompt_tokens"],
        "completion_tokens": usage["completion_tokens"],
        "cost_usd": round(usage["cost_usd"], 6),
    }, separators=(",", ":")))
    print(f"[openai-agent] done ok={ok} edited={edited}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
