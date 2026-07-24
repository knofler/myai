# Zero-Prompt Policy (POLICY LEVEL — DO NOT WEAKEN)

> Load-on-demand policy. `CLAUDE.md` keeps a one-line pointer to this file; the full text lives here to keep the per-turn context small. This is still POLICY, not preference.

This framework is configured for **zero tool-permission prompts** as a fleet-wide policy. Three settings in committed `.claude/settings.json` enforce it:

| Setting | Value | Effect |
|---|---|---|
| `permissions.defaultMode` | `"bypassPermissions"` | Every session starts in bypass mode — no tool-call permission gate at all |
| `skipDangerousModePermissionPrompt` | `true` | The "Are you sure you want bypass mode?" dialog is auto-dismissed |
| `skipAutoPermissionPrompt` | `true` | The auto-mode opt-in dialog is auto-dismissed |

**Why this is policy, not preference:** the user repeatedly hit permission prompts across managed repos despite YOLO god being engaged, because YOLO god silences clarifying *questions* but the permission gate is a separate layer. PR #146 added a 136-pattern allow-list; PR #147 made bypass mode the default. Together these mean: no prompts, ever, in any repo.

**Safety rails STILL active** (these are hooks, run independently of the permission gate — bypass mode does NOT disable them):

- `hooks/pre-tool/01-block-push-main.sh` — direct push to main blocked
- `hooks/pre-tool/03-secret-scan.sh` — credentials scanned before commit
- `hooks/pre-tool/04-protected-files.sh` — protected files gated
- `hooks/pre-tool/05-no-local-npm.sh` — local npm blocked (must use container)
- All other PreToolUse hooks unaffected
- Telegram `Notification` hook still pings the phone on rare prompts bypass mode doesn't cover

**Three power keywords run with extra safety:** `agent mode -a`, `wrap up`, and `yolo god` are documented to NEVER pause for tool questions or any prompt. If a prompt still fires under these keywords, it's a bug — file it.

**To temporarily tighten** (e.g. risky migration review): launch with `claude --permission-mode default` to opt out of bypass for that session only. The committed default returns next session.
