#!/usr/bin/env python3
# org-statusline.sh — Claude Code statusline showing the ACTIVE org profile in colour.
#
# Multi-Org-Auth: each org runs in its own CLAUDE_CONFIG_DIR (~/.claude, or
# ~/.claude-<name> per named profile). Claude Code does NOT
# pass the config dir / account to the statusline, but it DOES pass
# `transcript_path`, which always lives UNDER the active config dir — so we
# resolve the profile from that (env-independent, reliable).
#
# Output (single line, coloured): "📁 my-repo  ● claude-work› My Org · Opus · 8%"
#   The FOLDER/REPO comes FIRST (operator, 2026-09-18): with several shells open
#   the pane is narrow and the statusline is clipped from the RIGHT, so the last
#   segment is the one that vanishes — and the repo name was the last segment.
#   Leftmost = always visible, whatever the pane width.
#   Colour is by ROLE, never by name (v1 G6 P4): the swarm master's profile
#   (~/.myai/swarm/master.<host> lane=) -> bold orange; bare default -> bold
#   yellow; every other profile takes cyan, gold, violet, green … in the
#   master config's order= (then by name), so the colours stay stable.
#
# Registered as `statusLine` in each profile's settings.json by setup_org_dirs.sh.
# (Named .sh for repo convention; interpreter is python3 via the shebang.)
import sys, os, json

# ── Context-window usage bar (W5.1) ──────────────────────────────────────────
# Headroom (the third-party proxy) computes this by intercepting model traffic
# — rejected (plan/BRAIN_V2_CAPTURE_AND_OFFLOAD.md §3: new trust boundary while
# GHSA-ffgf-pmmg-cjj5 is open). We get the same number for free by reading the
# session transcript JSONL that Claude Code already writes locally — no proxy,
# no MITM. This is a LOCAL ESTIMATE (sum of the last assistant turn's real
# usage: input + cache_creation + cache_read + output tokens against the
# model's context window), not a value Claude Code hands the statusline.
#
# Claude 5-family models (Sonnet 5 / Opus 5 / Fable 5) run the 1M-token
# context beta; everything else defaults to the standard 200k window.
# Override with MYAI_CONTEXT_WINDOW_TOKENS if a model's window differs.
_CTX_TAIL_BYTES = 400_000  # last-turn usage lives near EOF; avoids reading huge transcripts

def _last_assistant_usage(transcript_path):
    try:
        size = os.path.getsize(transcript_path)
    except OSError:
        return None
    try:
        with open(transcript_path, "rb") as f:
            f.seek(max(0, size - _CTX_TAIL_BYTES))
            data = f.read()
    except OSError:
        return None
    for raw in reversed(data.split(b"\n")):
        if b'"type":"assistant"' not in raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if obj.get("type") != "assistant":
            continue
        usage = ((obj.get("message") or {}).get("usage")) or {}
        if usage:
            return usage
    return None

def _model_context_window(model):
    override = os.environ.get("MYAI_CONTEXT_WINDOW_TOKENS", "")
    if override.isdigit():
        return int(override)
    combined = ((model or {}).get("id", "") + " " + (model or {}).get("display_name", "")).lower()
    for tag in ("sonnet-5", "opus-5", "fable-5", "sonnet 5", "opus 5", "fable 5"):
        if tag in combined:
            return 1_000_000
    return 200_000

def _context_usage(data):
    """Return (used_tokens, max_tokens, pct) from the local transcript, or None."""
    tp = data.get("transcript_path") or ""
    if not tp or not os.path.isfile(tp):
        return None
    usage = _last_assistant_usage(tp)
    if not usage:
        return None
    used = (
        (usage.get("input_tokens") or 0)
        + (usage.get("cache_creation_input_tokens") or 0)
        + (usage.get("cache_read_input_tokens") or 0)
        + (usage.get("output_tokens") or 0)
    )
    max_tokens = _model_context_window(data.get("model"))
    if max_tokens <= 0:
        return None
    pct = max(0.0, min(100.0, used / max_tokens * 100))
    return used, max_tokens, pct

def _pct_color(p):
    if   p >= 95: return "\033[1;38;5;196m"   # red    — critical
    elif p >= 80: return "\033[1;38;5;208m"   # orange — high
    elif p >= 50: return "\033[1;38;5;220m"   # yellow — mid
    else:         return "\033[1;38;5;51m"    # cyan   — low

def _bar(p, width=10):
    filled = max(0, min(width, int(round(p / 100 * width))))
    return "█" * filled + "░" * (width - filled)

def persist_rate_limits(data, key):
    """Multi-Mac phase 2: Claude Code's statusLine payload carries the REAL quota
    (rate_limits.five_hour / seven_day: used_percentage + resets_at). Save it per
    account so scripts/usage_push.sh can ship it to the shared ledger — the
    ground truth the runner/balancer otherwise could only estimate. Atomic,
    silent, never raises (a statusline must never break)."""
    rl = data.get("rate_limits")
    if not isinstance(rl, dict) or key == "default" or not _NAME.match(key):
        return
    try:
        import time, socket
        # MYAI_HOME is the STATE dir; a framework checkout there (old portable
        # meaning) wrote usage-live/ into the AI repo root (2026-10-18).
        h = os.environ.get("MYAI_HOME") or ""
        if h and os.path.isfile(os.path.join(h, "scripts", "lib", "brain.sh")) \
                and os.path.isdir(os.path.join(h, "runtime")):
            h = ""
        d = os.path.join(h or os.path.expanduser("~/.myai"), "usage-live")
        os.makedirs(d, exist_ok=True)
        rec = {"account": key, "host": socket.gethostname().split(".")[0].lower(),
               "at": int(time.time()), "five_hour": rl.get("five_hour"), "seven_day": rl.get("seven_day")}
        tmp = os.path.join(d, ".%s.%d.tmp" % (key, os.getpid()))
        with open(tmp, "w") as fh:
            json.dump(rec, fh)
        os.replace(tmp, os.path.join(d, key + ".json"))
    except Exception:
        pass


import re
_NAME = re.compile(r"^[a-z0-9_-]+$")
_PROFILE_IN_PATH = re.compile(r"/\.claude-([a-z0-9_-]+)/")
# 256-colour codes (not basic ANSI) so the dark-daltonized palette can't remap
# two profiles into looking alike. Orange↔cyan is colour-blind-safe.
MASTER_COLOR, DEFAULT_COLOR = "1;38;5;208", "1;38;5;220"   # bold orange / yellow
WORKER_COLORS = ("1;38;5;45", "1;38;5;214", "1;38;5;141", "1;38;5;118")  # cyan, gold-orange, violet, green


def _master_config():
    """(master lane, order list) from ~/.myai/swarm/master.<host>, or ("", [])."""
    import socket
    d = os.environ.get("SWARM_DIR") or os.path.expanduser("~/.myai/swarm")
    host = socket.gethostname().split(".")[0].lower()
    lane, order = "", []
    try:
        with open(os.path.join(d, "master." + host)) as fh:
            for line in fh:
                k, _, v = line.strip().partition("=")
                if k == "lane":
                    lane = v
                elif k == "order":
                    order = v.split()
    except Exception:
        pass
    return lane, order


def profile_color(key, home):
    """The statusline colour for profile <key>, by role."""
    if key == "default":
        return DEFAULT_COLOR
    master, order = _master_config()
    if key == master:
        return MASTER_COLOR
    try:
        named = sorted(n[len(".claude-"):] for n in os.listdir(home)
                       if n.startswith(".claude-") and os.path.isdir(os.path.join(home, n)))
    except Exception:
        named = []
    ranked = [n for n in order if n != master and n != "default"]
    ranked += [n for n in named if n not in ranked and n != master]
    if key not in ranked:
        ranked.append(key)
    return WORKER_COLORS[ranked.index(key) % len(WORKER_COLORS)]


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    tp = (data.get("transcript_path") or "")
    home = os.path.expanduser("~")

    # Resolve the active profile from the transcript path (preferred), then
    # fall back to CLAUDE_CONFIG_DIR, then the bare default.
    m = _PROFILE_IN_PATH.search(tp)
    if m:
        key = m.group(1)
    elif "/.claude/" in tp:
        key = "default"
    else:
        base = os.path.basename(os.environ.get("CLAUDE_CONFIG_DIR", "").rstrip("/"))
        key = base[len(".claude-"):] if base.startswith(".claude-") else "default"
        if not _NAME.match(key):
            key = "default"

    persist_rate_limits(data, key)
    if key == "default":
        cfgdir, label = home + "/.claude", "claude"
    else:
        cfgdir, label = home + "/.claude-" + key, "claude-" + key
    color = profile_color(key, home)

    # Pull the real org/account name from the profile's own .claude.json.
    org = ""
    try:
        cj = json.load(open(os.path.join(cfgdir, ".claude.json")))
        oa = cj.get("oauthAccount") or {}
        org = oa.get("organizationName") or oa.get("emailAddress") or ""
    except Exception:
        pass

    model = (data.get("model") or {}).get("display_name", "")

    # Prefer our own local JSONL computation (W5.1); fall back to whatever
    # Claude Code itself hands the statusline, if anything, when the
    # transcript isn't readable (e.g. brand-new session, no turns yet).
    ctx = _context_usage(data)
    if ctx is not None:
        _used, _max, pct = ctx
    else:
        pct = (data.get("context_window") or {}).get("used_percentage")

    # Repo / dir name — so you never scroll to find which repo a session is in.
    # Prefer the git repo name; fall back through workspace/cwd to the script's
    # own cwd (Claude Code runs the statusline from the project root), so the
    # dir ALWAYS shows even on older payloads that omit workspace.repo.
    ws = data.get("workspace") or {}
    repo = (ws.get("repo") or {}).get("name") or ""
    if not repo:
        base = ws.get("project_dir") or ws.get("current_dir") or data.get("cwd") or os.getcwd()
        repo = os.path.basename((base or "").rstrip("/"))

    RESET, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"
    BLUE = "\033[38;5;39m"        # repo — colour-blind-safe, distinct from profile
    MODEL = "\033[1;38;5;255m"    # model — bold bright-white so it reads clearly
    c = "\033[" + color + "m"

    out = ""
    if repo:                      # repo/folder FIRST — leftmost never gets clipped
        out += BLUE + BOLD + "📁 " + repo + RESET + "  "
    out += c + "● " + label + "›" + RESET
    if org:                       # org/account — dim, secondary
        out += " " + DIM + org + RESET
    if model:                     # model — the bit you actually scan for: BOLD/bright
        out += (" " + DIM + "·" + RESET + " ") if org else " "
        out += MODEL + model + RESET
    if pct is not None:           # context % — BOLD, colour-coded usage bar + gauge
        try:
            p = int(round(float(pct)))
            pc = _pct_color(p)
            out += " " + DIM + "·" + RESET + " " + pc + "[" + _bar(p) + "]" + RESET
            out += " " + pc + str(p) + "%" + RESET
        except Exception:
            pass
    # myAI badge — is the myAI gateway/brain plugged into this session?
    # The brain boot hook (hooks/session/23-brain-status.sh) writes
    # ~/.myai/statusline-badge.json {sha, score, ts} on every session start.
    # Fresh (<3h) → green "🧠 myAI <sha8> <score>"; stale/missing → dim "myAI off".
    try:
        import time as _t
        _bp = os.path.expanduser("~/.myai/statusline-badge.json")
        _bj = json.load(open(_bp))
        _age = _t.time() - float(_bj.get("ts") or 0)
        if _age < 3 * 3600 and _bj.get("sha"):
            _sc = _bj.get("score")
            _sc_s = (" " + str(int(_sc))) if isinstance(_sc, (int, float)) else ""
            out += " " + DIM + "·" + RESET + " " + "\033[38;5;208m" + "🧠 myAI " + str(_bj["sha"])[:8] + _sc_s + RESET
        else:
            out += " " + DIM + "· 🧠 myAI off" + RESET
    except Exception:
        out += " " + DIM + "· 🧠 myAI off" + RESET

    sys.stdout.write(out)

if __name__ == "__main__":
    main()
