# Windows Runner Support — WSL2 (recommended) & native Task Scheduler (experimental)

> How to make a Windows machine a per-machine *worker* for the autonomous CLI
> task runner. The shared queue lives in the gateway; each box that should work
> it needs a schedule installed once. On macOS that's launchd, on Linux a
> systemd user timer — this page covers the two Windows options.
>
> **Support tier: best-effort.** The runner (`scripts/cli_task_runner.sh`) is a
> bash script developed and CI-tested on macOS + Linux. **WSL2 is the
> recommended path** because inside WSL2 the runner *is* on Linux and the
> standard installer applies unchanged. The **native Task Scheduler path is
> experimental** — it works via Git Bash but is not covered by CI.

---

## Which path?

| | Path A — WSL2 (recommended) | Path B — native Task Scheduler (experimental) |
|---|---|---|
| Scheduler | systemd user timer (`myai-cli-runner.timer`) | Windows Task Scheduler (`schtasks`, task `myai-cli-task-runner`) |
| Installer | `scripts/setup_cli_runner_schedule.sh` (auto-routes to the Linux installer) | `scripts/setup_cli_runner_windows.ps1` |
| Runner environment | real Linux (bash, GNU coreutils, tzdata) | Git Bash (MSYS2) on Windows |
| CI coverage | yes — same code path as Linux (40-case hermetic suite) | static checks only |
| Survives logoff | yes, with `loginctl enable-linger` + a WSL keep-alive task | no — interactive schtasks tasks run only while logged on |
| When to pick | always, when WSL2 is available | locked-down machines where WSL2 can't be enabled |

Both paths share the exact same runner semantics — cadence installer only
controls *when* fires happen; slots (`MAX_CONCURRENT`=5), the 30-minute busy
backoff, and the Sydney off-hours guard (weekdays 6pm–9am + all weekend) live
in `cli_task_runner.sh` and are identical everywhere.

---

## Path A — WSL2 (RECOMMENDED)

Inside WSL2 this is just the Linux install. The entry point detects Linux and
routes to `setup_cli_runner_linux.sh` (systemd user timer, crontab fallback).

### 1. One-time WSL2 setup

```powershell
# PowerShell (admin)
wsl --install -d Ubuntu     # installs WSL2 + Ubuntu; reboot if prompted
```

Ensure systemd is enabled (default on current WSL; older installs need this):

```bash
# inside WSL
cat /etc/wsl.conf   # want:  [boot]\nsystemd=true
# if missing: add it, then from PowerShell:  wsl --shutdown   (restarts with systemd)
```

### 2. Prerequisites inside WSL

- Clone/access the repo inside WSL (a native path like `~/ci-workspaces/ai_management`
  is much faster than `/mnt/c/...`).
- Install the Claude CLI and log in with the **claude-tech** profile
  (`CLAUDE_CONFIG_DIR=~/.claude-tech` — the runner sets this itself).
- Gateway reachability: with the gateway on Docker Desktop, `localhost:3100`
  resolves from WSL2 out of the box (localhost forwarding). Verify:
  `curl -sf http://localhost:3100/health && echo OK`.

### 3. Install the schedule

```bash
./scripts/setup_cli_runner_schedule.sh              # every 10 minutes (systemd user timer)
./scripts/setup_cli_runner_schedule.sh --status     # timer state + last session log
./scripts/setup_cli_runner_schedule.sh --uninstall  # remove
loginctl enable-linger $USER                        # timer survives logout
```

### 4. Keep WSL alive (the one Windows-specific step)

WSL2 shuts its VM down when no WSL process is running — a stopped VM means a
stopped timer. Register a tiny logon task that keeps a WSL process alive:

```powershell
# PowerShell — keep-alive at logon, hidden
schtasks /Create /F /TN myai-wsl-keepalive /SC ONLOGON /TR "wsl.exe -d Ubuntu --exec sleep infinity"
```

Also stop the machine sleeping on AC power (the Windows analogue of macOS
`sudo pmset -c sleep 0`):

```powershell
powercfg /change standby-timeout-ac 0
```

---

## Path B — native Task Scheduler (EXPERIMENTAL)

For machines where WSL2 is unavailable. Runs the bash runner under **Git Bash**,
fired by a `schtasks` job that mirrors the launchd/systemd cadence.

### Prerequisites

- **Git for Windows** (provides `bash.exe`; WSL's `System32\bash.exe` is
  deliberately not used — if that's what you have, use Path A).
- **Docker Desktop** with the myAI gateway up at `http://localhost:3100`.
- **Claude CLI** installed and logged in *inside Git Bash*
  (`~/.claude-tech` profile).
- `python3` resolvable in Git Bash (the runner parses gateway JSON with it).

### Install / manage

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1                  # every 10 minutes
powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -EveryMinutes 5  # custom cadence
powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -RunNow          # install + one-shot test fire
powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -Status          # task state + last log
powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -Uninstall       # remove task + wrappers
powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -BashPath "D:\PortableGit\bin\bash.exe"  # non-standard Git
```

### What gets registered

```
Task Scheduler:  myai-cli-task-runner  (every N minutes, schtasks /SC MINUTE /MO N)
      └─ wscript.exe %USERPROFILE%\.ai-cli-runner\run-task.vbs   (hides the console window)
            └─ %USERPROFILE%\.ai-cli-runner\run-task.cmd          (owns quoting; dodges the 261-char /TR limit)
                  └─ "C:\Program Files\Git\bin\bash.exe" -lc scripts/cli_task_runner.sh
                        └─ logs → %USERPROFILE%\.ai-cli-runner\runner.out / runner.err
```

Same task name family (`myai-cli-task-runner` ↔ `com.myai.cli-task-runner` ↔
`myai-cli-runner.timer`), same log locations (`~/.ai-cli-runner/`), same
`--status`/`--uninstall` verbs as the other platforms.

### Known limitations (why this tier is experimental)

- **Runs only while logged on** — interactive `schtasks` default. Running
  "whether user is logged on or not" requires storing credentials (`/RU`/`/RP`)
  and breaks Git Bash's profile assumptions; not supported.
- **Not CI-tested** — the bash runner under MSYS2 is best-effort. The off-hours
  guard uses `TZ=Australia/Sydney date`, which Git Bash supports, but other
  GNU/BSD divergences may surface.
- **Sleep** — the task can't wake the machine; disable AC sleep
  (`powercfg /change standby-timeout-ac 0`).
- **Locks/slots** — the runner's slot files live under the MSYS2 `/tmp`
  (per-Git-Bash-installation). Fine single-install; don't mix multiple Git
  installations firing the same queue from one machine.
- If anything here fights you, switch to Path A — that's the supported route.

### Troubleshooting

| Symptom | Check |
|---|---|
| Task fires but nothing happens | `type %USERPROFILE%\.ai-cli-runner\runner.err` — usually `claude` or `python3` not on Git Bash PATH |
| `claude: command not found` | Install the CLI inside Git Bash; the runner prepends `~/.local/bin` itself |
| Gateway calls fail | Docker Desktop running? `curl -sf http://localhost:3100/health` from Git Bash |
| Runs no-op during the day | Expected — off-hours guard (weekday 6pm–9am + weekends, Sydney). Manual override: `./scripts/cli_task_runner.sh --force` from Git Bash |
| Console flashes every 10 min | You bypassed the `.vbs` hop — reinstall via the `.ps1` so `/TR` targets `wscript.exe` |

---

## Silencing a Windows box that should never be a worker

Same as everywhere else — create the opt-out marker (from Git Bash or WSL):

```bash
mkdir -p ~/.ai-cli-runner && touch ~/.ai-cli-runner/.no-runner
```

---

*Related: `scripts/setup_cli_runner_schedule.sh` (cross-platform entry point) ·
`scripts/setup_cli_runner_linux.sh` (WSL2/systemd path) ·
`scripts/setup_cli_runner_windows.ps1` (native path) ·
README → "Installing the runner on a machine".*
