<#
.SYNOPSIS
  setup_cli_runner_windows_service.ps1 — EXPERIMENTAL native-Windows SERVICE
  installer for the myAI CLI task runner. Registers a real Windows Service
  (nssm-wrapped fire loop, sc.exe for lifecycle) that fires cli_task_runner.sh
  via Git Bash on the same 10-minute cadence as the macOS launchd and Linux
  systemd installers — and, unlike the Task Scheduler path
  (setup_cli_runner_windows.ps1), KEEPS FIRING WHILE NOBODY IS LOGGED ON.

  ⚠ RECOMMENDED PATH ON WINDOWS IS STILL WSL2 (see documentation/WINDOWS_RUNNER.md).
  Pick THIS installer over the schtasks one only when the box must work the
  queue with no interactive session (headless worker, shared build box).

  Why nssm and not bare sc.exe: a Windows Service binary must speak the SCM
  control protocol (StartServiceCtrlDispatcher). powershell.exe / cmd.exe / a
  bash script don't, so `sc.exe create` pointed straight at a script is killed
  by the SCM after ~30s. nssm (https://nssm.cc) is the standard shim that owns
  the SCM handshake and supervises the loop; sc.exe is still used here for
  query/stop/delete so --status/--uninstall work even if nssm later vanishes.

  The slot/backoff semantics (MAX_CONCURRENT=5, 30-minute busy backoff,
  weekday 6pm–9am + weekend Sydney off-hours guard) live in
  cli_task_runner.sh itself and are shared across all platforms — this
  installer only controls the fire cadence, exactly like its siblings.

.DESCRIPTION
  What it registers:
    Service name : myai-cli-runner-svc          (family: com.myai.cli-task-runner
                                                 / myai-cli-runner.timer
                                                 / myai-cli-task-runner)
    Start type   : SERVICE_AUTO_START — starts at boot, survives logoff
    Account      : YOUR user account (prompted) — the runner needs your $HOME
                   (~/.claude-tech login, ~/.ai-cli-runner, git credentials).
                   nssm grants the "Log on as a service" right automatically.
    Process tree : nssm → powershell.exe service-loop.ps1 (forever loop:
                   fire + Start-Sleep N) → service-task.cmd → Git Bash →
                   cli_task_runner.sh
    Logs         : %USERPROFILE%\.ai-cli-runner\runner.out / runner.err
                   (runner output — same paths as the macOS/Linux installers)
                   %USERPROFILE%\.ai-cli-runner\service.out / service.err
                   (loop-wrapper diagnostics, nssm-managed)

  Idempotent: re-running install updates the existing service's config in
  place (cadence, bash path, account) and restarts it — no duplicate services,
  no manual uninstall needed between runs.

  Requirements:
    • Administrator PowerShell for install/uninstall (-Status works unelevated)
    • nssm on PATH or at a common install location (winget install NSSM.NSSM /
      choco install nssm / scoop install nssm), or pass -NssmPath
    • Git for Windows (provides bash.exe — WSL's System32 bash.exe is
      deliberately NOT used; if that's all you have, use the WSL2 path)
    • The myAI gateway reachable at http://localhost:3100. NOTE: with the
      gateway on Docker Desktop, Docker itself usually starts at LOGIN — for a
      truly logged-off worker either point the runner at a gateway on another
      machine or enable Docker Desktop's "start on boot" Windows-service mode.
    • The Claude CLI installed and logged in inside Git Bash
      (profile: ~/.claude-tech — the runner sets CLAUDE_CONFIG_DIR itself)

.PARAMETER EveryMinutes
  Fire cadence in minutes (default 10, max 1439). Mirrors --every-minutes.
.PARAMETER EveryHours
  Fire cadence in hours (1–23, legacy). Mirrors --every-hours. Overrides
  EveryMinutes when set.
.PARAMETER Status
  Show the service state + last runner log. Mirrors --status.
.PARAMETER Uninstall
  Stop + remove the service and generated wrapper files. Mirrors --uninstall.
.PARAMETER ServiceAccount
  Account the service runs as (default: the current user, .\%USERNAME%). The
  password is prompted — never passed on the command line into shell history.
.PARAMETER RunAsLocalSystem
  DISCOURAGED escape hatch: run as LocalSystem instead of your user. The
  runner then sees SYSTEM's profile ($HOME = C:\Windows\system32\config\
  systemprofile) — only useful if you deliberately provisioned the Claude CLI
  + repo access for SYSTEM. You almost certainly want the default instead.
.PARAMETER BashPath
  Explicit path to Git Bash's bash.exe when auto-detection fails.
.PARAMETER NssmPath
  Explicit path to nssm.exe when auto-detection fails.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows_service.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows_service.ps1 -EveryMinutes 5
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows_service.ps1 -Status
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup_cli_runner_windows_service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 1439)][int]$EveryMinutes = 10,
    [ValidateRange(0, 23)][int]$EveryHours = 0,
    [switch]$Status,
    [switch]$Uninstall,
    [string]$ServiceAccount = "",
    [switch]$RunAsLocalSystem,
    [string]$BashPath = "",
    [string]$NssmPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SvcName   = 'myai-cli-runner-svc'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner    = Join-Path $ScriptDir 'cli_task_runner.sh'
$LogDir    = Join-Path $env:USERPROFILE '.ai-cli-runner'
$LoopFile  = Join-Path $LogDir 'service-loop.ps1'
$CmdFile   = Join-Path $LogDir 'service-task.cmd'

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

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

function Find-Nssm {
    param([string]$Override)
    if ($Override) {
        if (Test-Path $Override) { return $Override }
        throw "-NssmPath '$Override' does not exist."
    }
    $onPath = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $candidates = @(
        (Join-Path $env:ProgramData 'chocolatey\bin\nssm.exe'),
        (Join-Path $env:ProgramFiles 'nssm\win64\nssm.exe'),
        (Join-Path $env:ProgramFiles 'nssm\nssm.exe'),
        (Join-Path $env:USERPROFILE 'scoop\shims\nssm.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    throw ("nssm not found. Install it (winget install NSSM.NSSM  |  choco install nssm  |  " +
           "scoop install nssm  |  https://nssm.cc/download) or pass -NssmPath explicitly.")
}

function Get-ServiceOrNull { Get-Service -Name $SvcName -ErrorAction SilentlyContinue }

# ── status ────────────────────────────────────────────────────────────────────
if ($Status) {
    $svc = Get-ServiceOrNull
    if ($svc) {
        Write-Host "INSTALLED (Windows Service): $SvcName"
        Write-Host "  state      : $($svc.Status)"
        sc.exe qc $SvcName 2>$null | Select-String 'START_TYPE|SERVICE_START_NAME|BINARY_PATH_NAME' |
            ForEach-Object { Write-Host "  $($_.Line.Trim())" }
    } else {
        Write-Host "NOT installed ($SvcName)."
    }
    $logs = Join-Path $LogDir 'logs'
    if (Test-Path $logs) {
        $last = Get-ChildItem $logs -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($last) { Write-Host "Last session log: $($last.FullName)" }
    }
    Write-Host "Runner stdout : $(Join-Path $LogDir 'runner.out')"
    Write-Host "Loop wrapper  : $(Join-Path $LogDir 'service.out')"
    exit 0
}

# ── uninstall ─────────────────────────────────────────────────────────────────
if ($Uninstall) {
    if (-not (Test-IsAdmin)) { throw "Uninstall needs an elevated (Administrator) PowerShell." }
    $svc = Get-ServiceOrNull
    if ($svc) {
        if ($svc.Status -ne 'Stopped') {
            Stop-Service -Name $SvcName -Force -ErrorAction SilentlyContinue
            (Get-ServiceOrNull).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
        $nssm = $null
        try { $nssm = Find-Nssm -Override $NssmPath } catch { }
        if ($nssm) { & $nssm remove $SvcName confirm | Out-Null }
        else       { sc.exe delete $SvcName | Out-Null }
        Write-Host "Uninstalled $SvcName."
    } else {
        Write-Host "Nothing to uninstall."
    }
    Remove-Item $LoopFile, $CmdFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# ── install ───────────────────────────────────────────────────────────────────
Write-Warning ("EXPERIMENTAL native-Windows path. The supported/recommended path on Windows " +
               "is WSL2 + scripts/setup_cli_runner_schedule.sh — see documentation/WINDOWS_RUNNER.md. " +
               "Pick this service installer (over the schtasks one) when the box must run logged-off.")

if (-not (Test-IsAdmin)) { throw "Install needs an elevated (Administrator) PowerShell (services live in HKLM)." }
if (-not (Test-Path $Runner)) { throw "Runner not found at $Runner — run this script from a full repo checkout." }
$Bash = Find-GitBash -Override $BashPath
$Nssm = Find-Nssm -Override $NssmPath
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($EveryHours -gt 0) {
    $IntervalSeconds = $EveryHours * 3600
    $Cadence = "every ${EveryHours}h"
} else {
    $IntervalSeconds = $EveryMinutes * 60
    $Cadence = "every ${EveryMinutes}m"
}

# Git Bash accepts forward-slash Windows paths (C:/Users/...) verbatim.
$RunnerPosix = $Runner -replace '\\', '/'

# service-task.cmd: single place that owns the bash invocation (same proven
# quoting chain as the schtasks installer's run-task.cmd). -l loads the login
# profile so PATH/claude resolve like an interactive Git Bash; the runner
# script hardens PATH + CLAUDE_CONFIG_DIR itself.
# Quoting chain: \" survives BOTH cmd's quote toggling AND bash.exe's MSVCRT
# argv parsing as a literal quote, so bash -lc receives properly-quoted $HOME
# redirects (usernames with spaces). A plain " would be stripped in transit.
$CmdContent = @"
@echo off
"$Bash" -lc "'$RunnerPosix' >> \"`$HOME/.ai-cli-runner/runner.out\" 2>> \"`$HOME/.ai-cli-runner/runner.err\""
"@
Set-Content -Path $CmdFile -Value $CmdContent -Encoding ASCII

# service-loop.ps1: the long-lived service body nssm supervises — fire the
# runner, sleep the cadence, forever. Referenced by bare filename via
# AppDirectory so AppParameters never needs an embedded quoted path (dodges
# the PowerShell 5.1 native-argument quote-mangling on nested quotes).
$LoopContent = @"
# service-loop.ps1 — generated by setup_cli_runner_windows_service.ps1 (do not edit).
# Supervised by the '$SvcName' Windows Service via nssm; each iteration fires
# the myAI CLI task runner (slot-based — the runner itself no-ops/backs off
# when slots are full or the Sydney off-hours guard says no).
`$task = Join-Path `$PSScriptRoot 'service-task.cmd'
while (`$true) {
    & `$env:ComSpec /c `$task
    Start-Sleep -Seconds $IntervalSeconds
}
"@
Set-Content -Path $LoopFile -Value $LoopContent -Encoding ASCII

$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Idempotent: create only when absent; every config value is (re)applied via
# `nssm set` either way, so re-running updates cadence/paths in place.
$svc = Get-ServiceOrNull
if ($svc) {
    Write-Host "Service $SvcName already exists — updating config in place."
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $SvcName -Force
        (Get-ServiceOrNull).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
} else {
    & $Nssm install $SvcName $PsExe | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm install failed (exit $LASTEXITCODE)." }
}

# Every value below is a SINGLE argv entry (no nested quotes) — PowerShell
# quotes each one correctly on its own, even with spaces in paths.
& $Nssm set $SvcName Application $PsExe | Out-Null
& $Nssm set $SvcName AppDirectory $LogDir | Out-Null
& $Nssm set $SvcName AppParameters '-NoProfile -NoLogo -ExecutionPolicy Bypass -File service-loop.ps1' | Out-Null
& $Nssm set $SvcName AppStdout (Join-Path $LogDir 'service.out') | Out-Null
& $Nssm set $SvcName AppStderr (Join-Path $LogDir 'service.err') | Out-Null
& $Nssm set $SvcName AppExit Default Restart | Out-Null   # loop dies → nssm restarts it
& $Nssm set $SvcName AppThrottle 60000 | Out-Null          # ≥60s between restarts (no crash-spin)
& $Nssm set $SvcName Start SERVICE_AUTO_START | Out-Null   # start at boot, no login needed
& $Nssm set $SvcName DisplayName 'myAI CLI task runner (service)' | Out-Null
& $Nssm set $SvcName Description "Fires the myAI CLI task runner $Cadence (slot-based, off-hours-guarded). Managed by scripts/setup_cli_runner_windows_service.ps1." | Out-Null

if ($RunAsLocalSystem) {
    Write-Warning ("Running as LocalSystem — the runner sees SYSTEM's profile, not yours. " +
                   "Claude CLI login + repo access must have been provisioned for SYSTEM.")
    & $Nssm set $SvcName ObjName LocalSystem | Out-Null
} else {
    if (-not $ServiceAccount) { $ServiceAccount = ".\$env:USERNAME" }
    Write-Host "Service account: $ServiceAccount (the runner needs YOUR profile — claude login, git creds)."
    $cred = Get-Credential -UserName $ServiceAccount -Message "Password for $ServiceAccount (nssm grants 'Log on as a service' automatically)"
    $plain = $cred.GetNetworkCredential().Password
    & $Nssm set $SvcName ObjName $cred.UserName $plain | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm set ObjName failed (exit $LASTEXITCODE) — wrong password, or the account is denied the service-logon right by policy." }
}

Start-Service -Name $SvcName
Write-Host "Installed + started $SvcName — fires $Cadence (slot-based, up to 5 concurrent; backs off 30m when full)."
Write-Host "  nssm    : $Nssm"
Write-Host "  bash    : $Bash"
Write-Host "  runner  : $Runner"
Write-Host "  loop    : $LoopFile (via $CmdFile)"
Write-Host "  logs    : $LogDir\runner.out / runner.err (runner) · service.out / service.err (wrapper)"
Write-Host "Survives logoff + starts at boot — but the machine must be AWAKE:"
Write-Host "  disable AC sleep:  powercfg /change standby-timeout-ac 0"
Write-Host "  (a service cannot wake a sleeping machine; there is no RTC-wake equivalent of launchd here)"
Write-Host "Manage: sc.exe query $SvcName · Stop-Service $SvcName · -Status / -Uninstall on this script"
Write-Host "Docs + limitations: documentation/WINDOWS_RUNNER.md"
