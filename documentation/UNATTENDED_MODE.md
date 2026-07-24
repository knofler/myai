# Unattended Mode — Hands-Off Sessions

Three independent layers control how autonomously Claude Code runs. Understanding the difference is the difference between "stuck on a prompt for 1 hour" and "everything done when you come back."

| Layer | What it controls | Where it lives |
|---|---|---|
| **1. YOLO god** (project) | Whether *Claude* asks clarifying questions | `state/.yolo` file (managed by `./scripts/yolo.sh`) |
| **2. Permission gate** (Claude Code) | Whether *Claude Code* prompts for tool calls | `.claude/settings.json` + `.claude/settings.local.json` allow/deny lists, OR `--dangerously-skip-permissions` |
| **3. Notifications** (Claude Code) | Whether you get pinged when Claude needs you or finishes | `Notification` + `Stop` hooks in `.claude/settings.json` |

YOLO god alone does NOT bypass the permission gate. They are independent. If a tool isn't in the allow list, Claude Code still pops the "Do you want to proceed?" prompt regardless of YOLO state.

## Recommended setup (the framework now ships this)

1. **Broadened allowlist** — `.claude/settings.local.json` has ~270 safe patterns covering common read-only tools (cat/jq/head/tail/awk), git read ops, gh CLI, docker reads, project scripts. **90% of routine prompts vanish.**
2. **Telegram notifications** — `Notification` hook (fires on permission prompts) and `Stop` hook (fires when Claude finishes a turn) both call `scripts/notify-telegram.sh`. The script reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHATS` from `.env` and POSTs a Markdown message to your bot.
3. **`claude-auto` shell function** — opt-in unattended launcher with `--dangerously-skip-permissions` baked in (see below).

## Pairing your phone with the bot

The bot is `@ai_mgt_bot`. Until you message it from your phone, `TELEGRAM_ALLOWED_CHATS` will be empty and notifications go nowhere.

**One-time setup (3 minutes):**

1. Open Telegram on your phone.
2. Search for `@ai_mgt_bot` and tap **Start** (or send any message, e.g. `/start`).
3. Run this from the master repo:

```bash
TOKEN=$(grep ^TELEGRAM_BOT_TOKEN .env | cut -d= -f2-)
curl -sf "https://api.telegram.org/bot${TOKEN}/getUpdates" | jq -r '.result[-1].message.chat | "chat_id=\(.id), name=\(.first_name)"'
```

4. Copy the `chat_id` into `.env`:

```bash
TELEGRAM_ALLOWED_CHATS=<your_chat_id>
```

5. Smoke test:

```bash
./scripts/notify-telegram.sh test "pairing complete"
```

You should get a Telegram message within 1–2 seconds.

## Three modes of operation

### Mode A — Normal (default)

Just run `claude`. The allowlist covers most things; you get prompted only for genuinely new tool patterns.

**You should still see:** maybe 1–3 prompts per session for novel commands. Each "Yes, allow X going forward" widens the allowlist forever.

### Mode B — Stay reachable while you're out

Run `claude` normally. Stay logged into Telegram on your phone. When Claude hits a tool that isn't in the allowlist, you get a notification — tap into your terminal, approve, work resumes.

Drawback: Claude Code does NOT support remote approval (yet). You still have to be at the terminal. Telegram just tells you *that* a prompt is waiting, not approve it for you.

If you need true remote approval, look at the `remote` keyword (`./scripts/remote.sh`) which exposes Claude Code via a web UI you can tap into from your phone.

### Mode C — Full autonomy (`claude-auto`)

For "I'm out for an hour, finish this task, I trust you" sessions.

**Add to your `~/.zshrc` (or `~/.bashrc`):**

```bash
# Claude Code unattended mode — no permission prompts at all.
# Use deliberately: Claude can do anything tools allow.
claude-auto() {
  # Pre-arm YOLO god so Claude doesn't ask clarifying questions either
  if [ -d "./scripts" ] && [ -x "./scripts/yolo.sh" ]; then
    ./scripts/yolo.sh start god >/dev/null 2>&1
  fi
  command claude --dangerously-skip-permissions "$@"
}
```

Reload: `source ~/.zshrc`

Then:

```bash
claude-auto -p "agent mode -a; ship it; wrap up"
```

`-p` runs Claude with a one-shot prompt (no interactive shell). When the prompt completes, Claude exits, the Stop hook fires, you get a Telegram message.

**Safety rails that still apply:**

- The framework's `block-push-main` hook is a Git pre-push hook on the filesystem — `--dangerously-skip-permissions` doesn't bypass it.
- The `keyword execution protocol` still requires Claude to announce + report each step. The protocol is in CLAUDE.md and Claude follows it because it's an instruction, not a permission check.
- `state/.yolo` god mode auto-deactivates after a commit (per `./scripts/yolo.sh`).

**What `--dangerously-skip-permissions` removes:**

- Per-tool "Do you want to proceed?" popup
- Allow/deny list checks in `settings.json`
- That's it. It does not disable hooks, git pre-push protections, GitHub branch protection, file permissions, or anything filesystem-level.

## Troubleshooting

### "I still see the permission prompt for `gh pr create`"

`gh pr create` with a multiline `--body` (heredoc) can confuse Claude Code's pattern matcher. The allowlist has `Bash(gh pr:*)` and `Bash(gh:*)` blanket, both of which should match. If you still see the prompt:

1. Check both `.claude/settings.json` and `.claude/settings.local.json`.
2. Check the user-global `~/.claude/settings.json` — deny rules there override project allows.
3. Try the exact command in `claude` REPL `/permissions` to see what pattern matcher reports.

### "Telegram notifications never arrive"

```bash
# 1. Token alive?
TOKEN=$(grep ^TELEGRAM_BOT_TOKEN .env | cut -d= -f2-)
curl -sf "https://api.telegram.org/bot${TOKEN}/getMe" | jq

# 2. Chat ID set?
grep TELEGRAM_ALLOWED_CHATS .env

# 3. Direct send works?
./scripts/notify-telegram.sh test "manual ping"
```

If step 3 fails silently, the script has `set +e` and exits 0 on any error — by design (hooks must never break the chain). To debug: copy the curl block out of `scripts/notify-telegram.sh` and run it directly.

### "Stop hook runs but no notification"

The Stop hook calls `./scripts/notify-telegram.sh done`. Verify:

```bash
jq '.hooks.Stop' .claude/settings.json
```

You should see `notify-telegram.sh done` as the last entry in the hooks array.

## What's next

- `Notification` hook ships in this commit. Wired to fire on every permission prompt.
- `Stop` hook ships in this commit. Wired to fire on every Claude turn-stop.
- Future: route notifications through the MCP gateway's existing Telegram channel registry so messages get persistence + replay (currently they're fire-and-forget over curl).
