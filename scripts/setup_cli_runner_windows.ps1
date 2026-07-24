<#
.SYNOPSIS
  setup_cli_runner_windows.ps1 — EXPERIMENTAL native-Windows installer for the
  myAI CLI task runner. Registers a Windows Task Scheduler job (schtasks) that
  fires cli_task_runner.sh via Git Bash on the same 10-minute cadence as the
  macOS launchd / Linux systemd installers.

  ⚠ RECOMMENDED PATH ON WINDOWS IS WSL2, NOT THIS SCRIPT. Inside WSL2 the
  standard cross-platform entry point (scripts/setup_cli_runner_schedule.sh)
  auto-routes to the systemd-user-timer installer and everything behaves like
  a normal Linux box. Use this native path only when WSL2 is unavailable.
  Full guide: documentation/WINDOWS_RUNNER.md

  The slot/backoff semantics (MAX_CONCURRENT=5, 30-minute busy backoff,
  weekday 6pm–9am + weekend Sydney off-hours guard) live in
  cli_task_runner.sh itself and are shared across all three platforms — this
  installer only controls the fire cadence, exactly like its siblings.

.DESCRIPTION
  What it registers:
    Task name : myai-cli-task-runner            (mirrors com.myai.cli-task-runner)
    Trigger   : every N minutes (default 10) via  schtasks /SC MINUTE /MO N
    Action    : wscript.exe → run-task.vbs → run-task.cmd → Git Bash → cli_task_runner.sh
                (the .vbs hop hides the console window that cmd would flash
                 every 10 minutes; the .cmd hop dodges schtasks' 261-char /TR
                 limit and its quoting rules — both files are generated into
                 %USERPROFILE%\.ai-cli-runner and are safe to inspect)
    Logs      : %USERPROFILE%\.ai-cli-runner\runner.out / runner.err
                (same paths, via $HOME, that the macOS/Linux installers use)

  Requirements (native path):
    • Git for Windows (provides bash.exe — WSL's System32 bash.exe is
      deliberately NOT used here; if that's all you have, use the WSL2 path)
    • The myAI gateway reachable at http://localhost:3100 (Docker Desktop)
    • The Claude CLI installed and logged in inside Git Bash
      (profile: ~/.claude-tech — the runner sets CLAUDE_CONFIG_DIR itself)

.PARAMETER EveryMinutes
  Fire cadence in minutes (default 10, max 1439). Mirrors --every-minutes.
.PARAMETER EveryHours
  Fire cadence in hours (1–23, legacy). Mirrors --every-hours. Overrides
  EveryMinutes when set.
.PARAMETER Status
  Show the scheduled task state + last runner log. Mirrors --status.
.PARAMETER Uninstall
  Remove the scheduled task and generated wrapper files. Mirrors --uninstall.
.PARAMETER RunNow
  After installing, fire the task once immediately (schtasks /Run) — the
  native-path equivalent of --in-minutes for a quick smoke test. The runner's
  off-hours guard still applies unless you fire manually with --force.
.PARAMETER BashPath
  Explicit path to Git Bash's bash.exe when auto-detection fails
  (e.g. a portable Git install).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -EveryMinutes 5 -RunNow
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -Status
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 1439)][int]$EveryMinutes = 10,
    [ValidateRange(0, 23)][int]$EveryHours = 0,
    [switch]$Status,
    [switch]$Uninstall,
    [switch]$RunNow,
    [string]$BashPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName  = 'myai-cli-task-runner'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner    = Join-Path $ScriptDir 'cli_task_runner.sh'
$LogDir    = Join-Path $env:USERPROFILE '.ai-cli-runner'
$CmdFile   = Join-Path $LogDir 'run-task.cmd'
$VbsFile   = Join-Path $LogDir 'run-task.vbs'

function Find-GitBash {
    param([string]$Override)
    if ($Override) {
        if (Test-Path $Override) { return $Override }
        throw "-BashPath '$Override' does not exist."
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    # PATH fallback — but never System32\bash.exe (that's the WSL shim; the
    # WSL2 path uses the Linux installer instead, see WINDOWS_RUNNER.md)
    $onPath = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($onPath -and $onPath.Source -notmatch '\\System32\\') { return $onPath.Source }
    throw ("Git Bash not found. Install Git for Windows (https://git-scm.com/download/win), " +
           "pass -BashPath explicitly, or — better — use the WSL2 path (documentation/WINDOWS_RUNNER.md).")
}

# ── status ────────────────────────────────────────────────────────────────────
if ($Status) {
    schtasks /Query /TN $TaskName /FO LIST /V 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "NOT installed ($TaskName)." }
    $logs = Join-Path $LogDir 'logs'
    if (Test-Path $logs) {
        $last = Get-ChildItem $logs -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($last) { Write-Host "Last session log: $($last.FullName)" }
    }
    Write-Host "Runner stdout: $(Join-Path $LogDir 'runner.out')"
    exit 0
}

# ── uninstall ─────────────────────────────────────────────────────────────────
if ($Uninstall) {
    schtasks /Delete /TN $TaskName /F 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "Uninstalled $TaskName." } else { Write-Host "Nothing to uninstall." }
    Remove-Item $CmdFile, $VbsFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# ── install ───────────────────────────────────────────────────────────────────
Write-Warning ("EXPERIMENTAL native-Windows path. The supported/recommended path on Windows " +
               "is WSL2 + scripts/setup_cli_runner_schedule.sh — see documentation/WINDOWS_RUNNER.md")

if (-not (Test-Path $Runner)) { throw "Runner not found at $Runner — run this script from a full repo checkout." }
$Bash = Find-GitBash -Override $BashPath
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Git Bash accepts forward-slash Windows paths (C:/Users/...) verbatim.
$RunnerPosix = $Runner -replace '\\', '/'

# .cmd wrapper: single place that owns the bash invocation (keeps /TR tiny and
# quoting sane). -l loads the login profile so PATH/claude resolve like an
# interactive Git Bash; the runner script hardens PATH + CLAUDE_CONFIG_DIR itself.
# Quoting chain: \" survives BOTH cmd's quote toggling AND bash.exe's MSVCRT
# argv parsing as a literal quote, so bash -lc receives properly-quoted $HOME
# redirects (usernames with spaces). A plain " would be stripped in transit.
$CmdContent = @"
@echo off
"$Bash" -lc "'$RunnerPosix' >> \"`$HOME/.ai-cli-runner/runner.out\" 2>> \"`$HOME/.ai-cli-runner/runner.err\""
"@
Set-Content -Path $CmdFile -Value $CmdContent -Encoding ASCII

# .vbs wrapper: run the .cmd with window style 0 (hidden) so a console doesn't
# flash on every 10-minute fire.
$VbsContent = "CreateObject(""Wscript.Shell"").Run """"""$CmdFile"""""", 0, False"
Set-Content -Path $VbsFile -Value $VbsContent -Encoding ASCII

if ($EveryHours -gt 0) {
    $Cadence = "every ${EveryHours}h"
    schtasks /Create /F /TN $TaskName /SC HOURLY /MO $EveryHours /TR "wscript.exe `"$VbsFile`"" | Out-Null
} else {
    $Cadence = "every ${EveryMinutes}m"
    schtasks /Create /F /TN $TaskName /SC MINUTE /MO $EveryMinutes /TR "wscript.exe `"$VbsFile`"" | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed (exit $LASTEXITCODE)." }

Write-Host "Installed $TaskName — fires $Cadence (slot-based, up to 5 concurrent; backs off 30m when full)."
Write-Host "  bash    : $Bash"
Write-Host "  runner  : $Runner"
Write-Host "  wrapper : $CmdFile (via hidden-window $VbsFile)"
Write-Host "  logs    : $LogDir\runner.out / runner.err"
Write-Host "NOTE: the task runs only while you are logged on (interactive schtasks default),"
Write-Host "      and the laptop must be awake — disable sleep on AC power (powercfg /change standby-timeout-ac 0)."
Write-Host "Docs + limitations: documentation/WINDOWS_RUNNER.md"

if ($RunNow) {
    Write-Host "One-shot test fire now (schtasks /Run)..."
    schtasks /Run /TN $TaskName | Out-Null
    Write-Host "  fired — watch $LogDir\runner.out (off-hours guard may no-op it during weekday work hours)."
}
