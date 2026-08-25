#!/usr/bin/env python3
# org-statusline.sh — Claude Code statusline showing the ACTIVE org profile in colour.
#
# Multi-Org-Auth: each org runs in its own CLAUDE_CONFIG_DIR (~/.claude,
# ~/.claude-museum, ~/.claude-tech, ~/.claude-personal). Claude Code does NOT
# pass the config dir / account to the statusline, but it DOES pass
# `transcript_path`, which always lives UNDER the active config dir — so we
# resolve the profile from that (env-independent, reliable).
#
# Output (single line, coloured): "● claude-museum› Powerhouse Museum · Opus · 8%"
#   museum   -> bold magenta   tech -> bold cyan
#   personal -> bold green     bare default -> bold yellow
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

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    tp = (data.get("transcript_path") or "")
    home = os.path.expanduser("~")

    # Resolve the active profile from the transcript path (preferred), then
    # fall back to CLAUDE_CONFIG_DIR, then the bare default.
    if "/.claude-museum/" in tp:
        key = "museum"
    elif "/.claude-tech/" in tp:
        key = "tech"
    elif "/.claude-personal/" in tp:
        key = "personal"
    elif "/.claude/" in tp:
        key = "default"
    else:
        base = os.path.basename(os.environ.get("CLAUDE_CONFIG_DIR", "").rstrip("/"))
        key = {".claude-museum": "museum", ".claude-tech": "tech",
               ".claude-personal": "personal"}.get(base, "default")

    # 256-colour codes (not basic ANSI) so the dark-daltonized palette can't
    # remap museum/tech into looking alike. Orange↔cyan is colour-blind-safe.
    profiles = {
        "museum":   (home + "/.claude-museum",   "claude-museum",   "1;38;5;208"),  # bold orange
        "tech":     (home + "/.claude-tech",     "claude-tech",     "1;38;5;45"),   # bold cyan
        "personal": (home + "/.claude-personal", "claude-personal", "1;38;5;214"),   # bold gold-orange
        "default":  (home + "/.claude",          "claude",          "1;38;5;220"),  # bold yellow
    }
    cfgdir, label, color = profiles[key]

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

    out = c + "● " + label + "›" + RESET
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
    if repo:
        out += "  " + BLUE + BOLD + "📁 " + repo + RESET

    sys.stdout.write(out)

if __name__ == "__main__":
    main()
