# Mobile Control — Remote Sessions & Channels

> Control your Claude Code sessions from anywhere: phone, tablet, or another machine.

---

## Overview

Three methods for accessing Claude Code remotely:

| Method | How It Works | Best For | Requires |
|--------|-------------|----------|----------|
| **Remote Control** | Run `claude --remote-control` locally, connect via QR/URL from phone | Driving an existing session from mobile | Claude subscription |
| **Telegram Channel** | Telegram bot forwards messages to Claude Code session | Async task delegation, status checks | Bun, BotFather bot |
| **Dispatch** | Send task from Claude mobile app to Desktop app | Fire-and-forget tasks from phone | Claude Desktop app |

```
┌──────────────────────────────────────────────────────────┐
│  Your Machine (session runs here)                        │
│                                                          │
│  claude --remote-control ←── Phone / Browser / Tablet    │
│       ↑                                                  │
│  claude --channels ←── Telegram Bot ←── Phone DM         │
│       ↑                                                  │
│  Claude Desktop ←── Claude Mobile App (Dispatch)         │
└──────────────────────────────────────────────────────────┘
```

All three methods run the session **locally on your machine**. No code or data leaves your filesystem.

---

## 1. Remote Control (Recommended)

Connect to a local Claude Code session from your phone, tablet, or another computer's browser.

### Prerequisites
- Claude Code CLI installed and authenticated
- Active Claude subscription (not API-key-only)

### Setup

**In an already-running session (fastest):** type `/remote-control` (or `/rc`) — enables
Remote Control on the spot, no restart. `/rc active` shows status.

**Auto-enable every session:** set `"remoteControlAtStartup": true` in the profile's
`settings.json` (CLI >= 2.1.119; also via `/config` -> "Enable Remote Control for all
sessions"). Set per-org profile, e.g. `~/.claude-work/settings.json`.

**Phone connection:** remote sessions appear automatically in the Claude mobile app
under **Code** (same account/org) — QR/URL scan is optional.

```bash
# From any project directory:
claude --remote-control ai_management

# Or use the framework script (auto-detects project root):
./scripts/remote.sh          # from AI root
./AI/scripts/remote.sh       # from project root
```

Claude Code displays a **QR code** and a **URL**. Open either on your phone:
- Scan QR with camera app
- Or open the URL in a browser on any device

### How It Works
1. Session runs on your machine with full filesystem access
2. Your phone acts as a remote terminal — you type, Claude responds
3. All MCP servers, hooks, agents, and skills remain available
4. Session reconnects automatically if your machine sleeps or network drops

### Limitations
- Organization-managed accounts may have remote-control disabled by policy
- Requires your machine to be running and online

### Enterprise orgs (org-managed account setup)
- **Policy:** Remote Control on an org-managed account is controlled by the org.
  If the session fails to start with a policy error, the org's primary owner/admin
  enables it in the claude.ai **Admin console → Claude Code settings**.
- **Same org on both ends:** the phone's Claude app must be signed into the SAME
  org/account that started the session. If you run per-org Claude profiles, start
  the session under the matching profile (e.g. `CLAUDE_CONFIG_DIR=~/.claude-work`)
  and sign the phone into the same work email (e.g. `you@your-org.example`).
- **Wake policy:** the host Mac must stay awake — `sudo pmset -c sleep 0` (already
  standard on runner hosts).
- **Complementary path (Mac off):** Claude Code web/mobile cloud sessions on the
  GitHub repo work without this machine — they land as `claude/*` branches that
  CLI `agent mode` merges (see "CLI-Mobile Agent Workflow" in CLAUDE.md).

---

## 2. Telegram Channel

A Telegram bot that forwards messages to your Claude Code session. Claude can reply, react, and edit messages in the chat.

### Prerequisites
- **Bun** runtime: `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Quick Setup

Use the guided setup script:

```bash
./scripts/telegram-setup.sh
```

Or set up manually:

```bash
# 1. Install the plugin (one-time)
claude plugin install telegram@claude-plugins-official

# 2. Configure the bot token
# In a Claude Code session:
/telegram:configure 123456789:AAHfiqksKZ8...

# 3. Launch with the channel flag
claude --channels plugin:telegram@claude-plugins-official

# 4. DM your bot on Telegram — it sends a pairing code

# 5. Approve the pairing in your Claude Code session
/telegram:access pair <code>

# 6. Lock down access (important!)
/telegram:access policy allowlist
```

### Tools Available to Claude

When a message arrives via Telegram, Claude has these tools:

| Tool | Purpose |
|------|---------|
| `reply` | Send text or files to a chat. Images preview inline. Max 50MB per file. |
| `react` | Add an emoji reaction (Telegram's fixed whitelist only). |
| `edit_message` | Edit a message the bot previously sent (useful for progress updates). |

### Access Control

**Default policy is `pairing`** — anyone who DMs the bot gets a pairing code. This is for initial setup only.

**Always lock down after pairing:**

```
/telegram:access policy allowlist    # Only allowlisted users can reach you
/telegram:access allow 412587349     # Add a user by numeric ID
/telegram:access remove 412587349    # Remove a user
```

Get your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot).

### Group Support

```
/telegram:access group add -1001654782309              # Enable a group
/telegram:access group add -1001654782309 --no-mention # Respond to all messages (not just @mentions)
/telegram:access group add -1001654782309 --allow 412587349,628194073  # Restrict to specific members
/telegram:access group rm -1001654782309               # Disable a group
```

Groups require `requireMention: true` by default — the bot only responds when @mentioned or replied to. To process all messages, disable privacy mode via BotFather (`/setprivacy` → Disable).

### Photos

- Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/`
- Claude can read them (multimodal). Send as "document" for original quality.
- No message history — the bot only sees messages as they arrive in real-time.

### Multiple Bots

To run separate bots (different tokens, separate allowlists):

```bash
TELEGRAM_STATE_DIR=~/.claude/channels/telegram-project2 claude --channels plugin:telegram@claude-plugins-official
```

---

## 3. Dispatch (Desktop App Only)

Send a task from the Claude mobile app to Claude Desktop on your machine. Desktop spawns a session and executes the task.

### How It Differs from Remote Control

| | Remote Control | Dispatch |
|---|---|---|
| **Interaction** | Interactive — you drive the session | Fire-and-forget — send task, get result |
| **Platform** | CLI (`claude --remote-control`) | Desktop app only |
| **Session** | Connects to existing session | Creates a new session |

### Setup
1. Install Claude Desktop app on your machine
2. Open Claude mobile app on your phone
3. Use the Dispatch feature to send tasks to your Desktop

**Note:** Dispatch is a Desktop app feature — there is no CLI command for it.

---

## 4. Per-Project Setup

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/remote.sh` | Start remote-control session with project context |
| `scripts/telegram-setup.sh` | Guided Telegram bot setup (checks prerequisites, configures token) |

### Keywords

Use these in any Claude Code session:

| Keyword | Action |
|---------|--------|
| `remote` | Start `claude --remote-control` for this project |
| `telegram setup` | Run guided Telegram bot setup |
| `telegram start` | Launch Claude Code with Telegram channel active |

### Session Hook

The `10-channel-status.sh` hook runs on every session start. If a Telegram bot is configured, it shows the channel status (policy, allowed users). Silent if no channel is configured.

---

## 5. Security Considerations

### Remote Control
- Session runs **entirely on your machine** — no code or data is transmitted to Anthropic's servers beyond normal API calls
- The connection is end-to-end encrypted
- Session ends when you close it or your machine goes offline
- Organization admins can disable remote-control via policy

### Telegram
- **Bot token is a credential** — the setup script sets `chmod 600` on the `.env` file
- **Always switch to allowlist policy** after pairing — `pairing` mode lets anyone who finds your bot's username trigger a pairing code
- Bot messages are routed through Telegram's servers — don't send secrets via Telegram
- The MCP server runs locally; Telegram only sees message content, not your filesystem

### General
- All three methods run the session on your machine — your project files never leave your network
- MCP servers remain localhost-only — no ports exposed to the internet
- Hooks and permissions still apply — remote sessions have the same guardrails as local ones

---

## Quick Reference

```bash
# Remote Control
./scripts/remote.sh                    # Start remote session
claude --remote-control <name>         # Direct CLI command

# Telegram — first time
./scripts/telegram-setup.sh            # Guided setup
# or:
claude plugin install telegram@claude-plugins-official
/telegram:configure <token>

# Telegram — daily use
claude --channels plugin:telegram@claude-plugins-official

# Telegram — access management
/telegram:access                       # Show status
/telegram:access pair <code>           # Approve a user
/telegram:access policy allowlist      # Lock down
/telegram:access allow <id>            # Add user by ID
/telegram:access remove <id>           # Remove user
/telegram:access group add <id>        # Enable a group
```
