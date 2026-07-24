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
    if pct is not None:           # context % — BOLD, colour-coded as a usage gauge
        try:
            p = int(float(pct))
            if   p >= 95: pc = "\033[1;38;5;196m"   # red    — critical
            elif p >= 80: pc = "\033[1;38;5;208m"   # orange — high
            elif p >= 50: pc = "\033[1;38;5;220m"   # yellow — mid
            else:         pc = "\033[1;38;5;51m"    # cyan   — low
            out += " " + DIM + "·" + RESET + " " + pc + str(p) + "%" + RESET
        except Exception:
            pass
    if repo:
        out += "  " + BLUE + BOLD + "📁 " + repo + RESET

    sys.stdout.write(out)

if __name__ == "__main__":
    main()
