# Wrap Up Banner (MANDATORY on every session close)

The `wrap up` keyword MUST end with this ASCII banner as the **final output**. Fill in values dynamically from git and session context. This makes it instantly visible when scrolling back to a closed session.

## Org colour (Multi-Org-Auth — match the statusline from PR #181)

The banner's status dots and the `ORG:` line MUST be tinted to the **active org profile**, mirroring the coloured statusline (`scripts/org-statusline.sh`). Assistant markdown can't carry raw ANSI, so use the **colored-circle emoji** whose hue matches the statusline's palette. Resolve the profile the same way the statusline does — from the session `transcript_path` (it lives under the active `CLAUDE_CONFIG_DIR`), falling back to `$CLAUDE_CONFIG_DIR`:

| Profile | Config dir | Statusline colour | Banner dot |
|---|---|---|---|
| `claude-museum` | `~/.claude-museum` | bold magenta | 🟣 |
| `claude-tech` | `~/.claude-tech` | bold cyan | 🔵 |
| `claude-personal` | `~/.claude-personal` | bold green | 🟢 |
| `claude` (bare default) | `~/.claude` | bold yellow | 🟡 |

Use the resolved dot (call it `{DOT}` below) for **every** status line in the banner, and fill `ORG:` with `{profile-label} · {organizationName}` read from that profile's `.claude.json` `oauthAccount.organizationName` (fall back to the email, then "unknown").

**Default-profile precedence (resolves the bare-`claude` colour):**
- **Multi-org IS set up** (any of `~/.claude-museum` / `~/.claude-tech` / `~/.claude-personal` exists) and the active profile is the bare `claude` → dot is 🟡 per the table (yellow = "default/unscoped profile while orgs are configured").
- **Multi-org is NOT set up** (only `~/.claude` exists, the legacy single-profile case) → dot is 🟢 (green = all good) and `ORG:` shows `claude · {org or "default"}`, preserving the old all-green look.

In short: 🟡 means "you have org profiles but are on the unscoped default"; 🟢 means "no multi-org setup at all".

```
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   ██╗    ██╗██████╗  █████╗ ██████╗ ██████╗ ███████╗██████╗     ║
║   ██║    ██║██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗   ║
║   ██║ █╗ ██║██████╔╝███████║██████╔╝██████╔╝█████╗  ██║  ██║   ║
║   ██║███╗██║██╔══██╗██╔══██║██╔═══╝ ██╔═══╝ ██╔══╝  ██║  ██║   ║
║   ╚███╔███╔╝██║  ██║██║  ██║██║     ██║     ███████╗██████╔╝   ║
║    ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═════╝    ║
║                                                                  ║
║          ██╗   ██╗██████╗     ██╗                                ║
║          ██║   ██║██╔══██╗    ██║                                ║
║          ██║   ██║██████╔╝    ██║                                ║
║          ██║   ██║██╔═══╝     ╚═╝                                ║
║          ╚██████╔╝██║         ██╗                                ║
║           ╚═════╝ ╚═╝         ╚═╝                                ║
║                                                                  ║
║──────────────────────────────────────────────────────────────────║
║                                                                  ║
║   {DOT} ORG:      {profile-label} · {organizationName}           ║
║   {DOT} REPO:     {folder name} ({standalone/master/sub-repo})   ║
║   {DOT} BRANCH:   {current git branch}                           ║
║   {DOT} REMOTE:   {git remote url}                               ║
║   {DOT} SESSION:  {CLI/Mobile} ({hostname})                      ║
║   {DOT} WRAPPED:  {YYYY-MM-DD HH:MM UTC}                         ║
║                                                                  ║
║   {DOT} PRs:      {any PRs merged this session, or "none"}       ║
║   {DOT} STATUS:   {summary — e.g. "All green — nothing pending"} ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
```
