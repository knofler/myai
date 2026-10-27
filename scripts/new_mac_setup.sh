#!/usr/bin/env bash
# shellcheck disable=SC2088  # "~/…" appears only in human-readable row text, never as a path
# new_mac_setup.sh — the LEAN new-Mac path (keyword: `new mac`).
#
# Order is the operator's priority (2026-09-28): myAI first, then the Claude
# profiles, then git metadata + every fleet repo fetched, then the stack, the
# brain and fleet MCP. Brew, Docker, git and node are assumed present — they
# are CHECKED, never reinstalled. No Xcode, no .NET, no editor casks
# (bootstrap_mac.sh is the full-fleet version; this is not it).
#
# Every step checks before it acts and SKIPs what is already done, so re-running
# is cheap. Never stops on a failed step: each prints OK / SKIP / FAIL and the run
# continues. What a human must do is printed at the end as copy-paste lines.
#
# Usage: ./scripts/new_mac_setup.sh [--check]     --check = report only, change nothing
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
# The stack comes up on THIS Mac's caps (host row → fleet-role profile → `*`):
# without it compose's 1g gateway default wins on a new office Mac.
# shellcheck source=scripts/lib/stack_limits.sh
[ -f "$REPO/scripts/lib/stack_limits.sh" ] && . "$REPO/scripts/lib/stack_limits.sh" \
  && export GATEWAY_MEM_LIMIT="${GATEWAY_MEM_LIMIT:-$(resolve_gateway_mem 2>/dev/null)}"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
# Whose brain and repos: MYAI_BRAIN_REMOTE / MYAI_GIT_OWNER, from the environment
# or the operator defaults file (not shipped) — see scripts/lib/operator_defaults.sh.
# shellcheck source=scripts/lib/operator_defaults.sh
. "$REPO/scripts/lib/operator_defaults.sh"
operator_defaults_load "$REPO"
# shellcheck source=scripts/lib/swarm_roles.sh
. "$REPO/scripts/lib/swarm_roles.sh"
# The named Claude profiles this Mac gets (MYAI_PROFILES, else the dirs on disk).
PROFILE_DIRS="~/.claude"; PROFILE_LOGINS="claude → /login"
while IFS= read -r _n; do
  PROFILE_DIRS="$PROFILE_DIRS ~/.claude-$_n"; PROFILE_LOGINS="$PROFILE_LOGINS, claude-$_n"
done < <(role_profile_names 2>/dev/null)
unset _n
RES=""; TODO=""; NFAIL=0
row()  { RES="$RES
$1|$2|$3"; [ "$1" = FAIL ] && NFAIL=$((NFAIL+1)); printf '[%s] %s — %s\n' "$1" "$2" "$3"; }
todo() { TODO="$TODO
  - $1"; }
act()  { [ "$CHECK" = 0 ]; }   # true when allowed to change things
have() { command -v "$1" >/dev/null 2>&1; }

# PATH for this run (and future shells): brew + the user npm prefix.
for p in /opt/homebrew/bin /usr/local/bin; do [ -x "$p/brew" ] && eval "$("$p/brew" shellenv)"; done
export PATH="$HOME/.local/bin:$PATH"
if act; then
  touch "$HOME/.zprofile"
  have brew && ! grep -q 'brew shellenv' "$HOME/.zprofile" && echo "eval \"\$($(command -v brew) shellenv)\"" >> "$HOME/.zprofile"
  # shellcheck disable=SC2016  # literal line for .zprofile — must expand at login, not now
  grep -q '.local/bin' "$HOME/.zprofile" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zprofile"
fi

echo "── 0. prerequisites (checked, not installed) ──"
for t in brew git node npm docker python3; do
  if have "$t"; then row OK "$t" "$(command -v "$t")"; else row FAIL "$t" "missing"; fi
done
if docker info >/dev/null 2>&1; then row OK docker-daemon running
else row FAIL docker-daemon "not running"; todo "Open Docker Desktop, wait for 'running', then type \`new mac\` again"; fi
# "Running now" is not "running after a reboot": the 08:00 boot and the CI
# runner need Docker up with nobody logged in at the keyboard. office-mac had
# AutoStart=false and its 2026-10-02 boot went RED (no rebuild, no code check)
# the morning after a reboot. Read-only check — Docker Desktop owns this file
# and rewrites it, so the fix is its own toggle, not an edit here.
dd_settings="$HOME/Library/Group Containers/group.com.docker/settings-store.json"
dd_auto="$(/usr/bin/python3 -c 'import json,sys
try: print(str(json.load(open(sys.argv[1])).get("AutoStart")).lower())
except Exception: print("")' "$dd_settings" 2>/dev/null)"
if [ "$dd_auto" = "true" ]; then row OK docker-autostart "Docker Desktop starts at login"
else
  row FAIL docker-autostart "Docker Desktop does NOT start at login (AutoStart=${dd_auto:-unknown}) — after a reboot the 08:00 boot + CI runner find no daemon"
  todo "Docker Desktop → Settings → General → tick 'Start Docker Desktop when you sign in to your computer' → Apply"
fi
# Only the small CLIs the hooks/scripts hard-depend on; installed only if absent.
for f in gh jq tmux; do
  if have "$f"; then row OK "$f" present
  elif act && have brew && brew install "$f" >/dev/null 2>&1; then row OK "$f" "installed now"
  else row FAIL "$f" "missing (brew install $f)"; fi
done

echo; echo "── 1. myAI (ai-management) ──"
if act && [ -x scripts/npm_prefix_preflight.sh ]; then bash scripts/npm_prefix_preflight.sh --fix --quiet >/dev/null 2>&1; fi
latest="$(npm view ai-management version 2>/dev/null)"
current="$(npm ls -g ai-management --depth=0 --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("dependencies",{}).get("ai-management",{}).get("version",""))' 2>/dev/null)"
if [ -n "$current" ] && [ "$current" = "$latest" ] && have myai; then
  row OK ai-management "v$current (latest) — skipped"
elif act && npm i -g ai-management >/dev/null 2>&1 && have myai; then
  row OK ai-management "installed v$(npm ls -g ai-management --depth=0 2>/dev/null | sed -n 's/.*ai-management@//p')"
elif [ -n "$current" ]; then
  row FAIL ai-management "v$current installed, v$latest available — run: npm i -g ai-management"
else
  row FAIL ai-management "not installed — run: npm i -g ai-management (prefix: $(npm config get prefix 2>/dev/null))"
fi
# The machine-local gateway token kernel-only repos use for the MCP handshake.
# Same value as this repo's .env (Dropbox-synced) — copied, never printed.
if grep -q '^GATEWAY_LOCAL_TOKEN=' "$HOME/.myai/.env" 2>/dev/null; then row OK myai-token "~/.myai/.env present — skipped"
elif [ -f .env ] && grep -q '^GATEWAY_LOCAL_TOKEN=' .env; then
  if act; then
    if mkdir -p "$HOME/.myai" && ( umask 077
      echo "# myAI machine-local secrets — mirrors the gateway's GATEWAY_LOCAL_TOKEN (new_mac_setup.sh)"
      grep '^GATEWAY_LOCAL_TOKEN=' .env ) > "$HOME/.myai/.env"; then
      chmod 600 "$HOME/.myai/.env"; row OK myai-token "~/.myai/.env written from repo .env"
    else row FAIL myai-token "could not write ~/.myai/.env"; fi
  else row SKIP myai-token "would write ~/.myai/.env"; fi
else row FAIL myai-token "no GATEWAY_LOCAL_TOKEN in $REPO/.env — has Dropbox finished syncing .env?"; fi
# Brain: connect the EXISTING brain, never provision a new one.
if [ -f "$HOME/.myai/config" ] && [ -d "$HOME/.myai/brain/.git" ]; then
  row OK brain-clone "~/.myai/brain present — skipped"
elif act && have myai; then
  # No remote configured: ask (interactive only) — never guess someone's brain.
  if [ -z "${MYAI_BRAIN_REMOTE:-}" ] && [ -t 0 ]; then
    printf 'Your existing brain repo (git URL; empty = skip): '
    read -r MYAI_BRAIN_REMOTE || MYAI_BRAIN_REMOTE=""
  fi
  if [ -z "${MYAI_BRAIN_REMOTE:-}" ]; then
    row SKIP brain-clone "no brain remote — set MYAI_BRAIN_REMOTE (or run \`myai init\` for a new brain)"
    todo "MYAI_BRAIN_REMOTE=<your brain repo URL> ./scripts/new_mac_setup.sh   (to connect an existing brain)"
  else
    url=""
    for cand in $(brain_remote_candidates "$MYAI_BRAIN_REMOTE"); do
      if git ls-remote "$cand" >/dev/null 2>&1; then url="$cand"; break; fi
    done
    url="${url:-$MYAI_BRAIN_REMOTE}"
    if myai setup --brain "$url" --yes >/dev/null 2>&1 && [ -d "$HOME/.myai/brain/.git" ]; then row OK brain-clone "connected $url"
    else row FAIL brain-clone "myai setup --brain failed"; todo "! gh auth login   (then type \`new mac\` again — the brain clone needs GitHub access)"; fi
  fi
else row SKIP brain-clone "needs myai first"; fi

echo; echo "── 1b. Vercel CLI ──"
# Global host-level CLI, deliberate exception to the Docker-only npm rule
# (CLAUDE.md §2 / AI_RULES §2) the same way `npm i -g ai-management` is
# (AI_RULES §19) — see AI_RULES §21. Needed on every Mac for the prod check
# (`vercel curl --deployment`, `vercel logs`) when a project's prod sits
# behind Vercel protection; office-mac was missing it while another office Mac had it
# (operator incident 2026-10-01, office-mac).
if have vercel; then row OK vercel-cli "$(vercel --version 2>/dev/null | head -1) — skipped"
elif act && npm i -g vercel >/dev/null 2>&1 && have vercel; then
  row OK vercel-cli "installed $(vercel --version 2>/dev/null | head -1)"
else row FAIL vercel-cli "not installed — run: npm i -g vercel"; fi
# EBADENGINE warnings from transitive deps (e.g. @renovatebot/pep440) and a
# skipped esbuild postinstall are known-benign noise on newer npm/node pairs —
# vercel still runs — so only `have vercel` gates OK/FAIL above.
if have vercel; then
  if vercel whoami >/dev/null 2>&1; then row OK vercel-auth "logged in as $(vercel whoami 2>/dev/null)"
  else row FAIL vercel-auth "not logged in"; todo "! vercel login   (needed before vercel curl --deployment / vercel logs against protected prod)"; fi
fi

echo; echo "── 2. Claude profiles ──"
if act; then
  if bash scripts/setup_org_dirs.sh >/dev/null 2>&1; then row OK profile-dirs "$PROFILE_DIRS + aliases"
  else row FAIL profile-dirs "setup_org_dirs.sh failed"; fi
  if out="$(bash scripts/claude_profiles_transfer.sh import 2>&1)"; then row OK profile-import "$(printf '%s' "$out" | grep -c 'already imported') already done, rest imported; remote control on"
  else row FAIL profile-import "$(printf '%s' "$out" | tail -1)"; fi
fi
bash scripts/claude_profiles_transfer.sh status 2>/dev/null | sed -n '2,5p'

echo; echo "── 2b. agy (Antigravity) ──"
# Parity with the Claude profiles above, but only when agy is actually present
# on this Mac — new_mac_setup.sh never installs Antigravity itself, and it
# never starts/stops/queries agy's remote-control daemon (that lives entirely
# in agy_session.sh's own start/status subcommands).
if ! have agy; then
  row SKIP agy "not installed — agy-rc alias + status line skipped"
elif act; then
  if out="$(bash scripts/agy_session.sh install-alias 2>&1)"; then row OK agy-alias "$(printf '%s' "$out" | tail -1)"
  else row FAIL agy-alias "install-alias failed: $(printf '%s' "$out" | tail -1)"; fi
  if out="$(bash scripts/agy_session.sh statusline 2>&1)"; then row OK agy-statusline "$(printf '%s' "$out" | tail -1)"
  else row FAIL agy-statusline "statusline failed: $(printf '%s' "$out" | tail -1)"; fi
else
  if grep -q '^agy-rc() {' "$HOME/.zshrc" 2>/dev/null; then row OK agy-alias "agy-rc already installed — skipped"
  else row SKIP agy-alias "would install agy-rc alias (./scripts/agy_session.sh install-alias)"; fi
  if [ -f "$HOME/.gemini/antigravity-cli/settings.json" ] && grep -q '"statusLine"' "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; then
    row OK agy-statusline "status line already installed — skipped"
  else row SKIP agy-statusline "would install agy status line (./scripts/agy_session.sh statusline)"; fi
fi

# Every device has exactly ONE swarm master, chosen here (operator rule
# 2026-10-22). Asked only on a terminal; an agent-driven run gets a FAIL with
# the one-liner instead. Already set → skipped (re-choose: myai swarm master set).
echo; echo "── 2c. swarm master (this device's coordinator) ──"
if [ -f scripts/swarm_master_set.sh ]; then
  if sm_show="$(bash scripts/swarm_master_set.sh show 2>/dev/null)"; then
    row OK swarm-master "$(printf '%s\n' "$sm_show" | sed -n 's/^  agent=//p') / lane $(printf '%s\n' "$sm_show" | sed -n 's/^  lane=//p') — skipped (change: myai swarm master set)"
  elif act && [ -t 0 ] && bash scripts/swarm_master_set.sh set; then
    row OK swarm-master "chosen now ($(bash scripts/swarm_master_set.sh show 2>/dev/null | sed -n 's/^  lane=/lane /p'))"
  else
    row FAIL swarm-master "none configured — this device has no swarm master"
    todo "! bash $REPO/scripts/swarm_master_set.sh   (or: myai swarm master set) — pick which agent coordinates this Mac"
  fi
else row SKIP swarm-master "swarm_master_set.sh absent"; fi

echo; echo "── 3. git metadata + fetch every repo ──"
if git rev-parse --git-dir >/dev/null 2>&1; then row OK git-AI "$(git branch --show-current) @ $(git rev-parse --short HEAD)"
elif act && owner="$(resolve_git_owner)" && [ -n "$owner" ] \
    && bash scripts/restore_git_metadata.sh --apply --remote "$owner/ai_management" . >/dev/null 2>&1; then row OK git-AI "restored .git from $owner/ai_management"
else row FAIL git-AI "no .git — set MYAI_GIT_OWNER (or \`gh auth login\`), then ./scripts/restore_git_metadata.sh --apply ."; fi
if act; then bash scripts/restore_git_metadata.sh --fleet --apply >/dev/null 2>&1 || true; fi
nok=0; nbad=0; bad=""; nogit=""
while IFS= read -r r; do
  r="${r%%#*}"; r="$(printf '%s' "$r" | sed "s#^~#$HOME#; s/[[:space:]]*$//")"
  [ -z "$r" ] && continue
  # Still no .git after the fleet restore = not a git repo (e.g. the CONTENT_API
  # workspace folder, whose sub-repos are listed separately) or no remote known.
  if [ ! -d "$r/.git" ]; then nogit="$nogit $(basename "$r")"; continue; fi
  if [ "$CHECK" = 1 ] || git -C "$r" fetch --all --prune --quiet >/dev/null 2>&1; then nok=$((nok+1))
  else nbad=$((nbad+1)); bad="$bad $(basename "$r")(fetch)"; fi
done < config/managed_repos.txt
if [ "$nbad" = 0 ]; then row OK fleet-fetch "$nok repos fetched"
else row FAIL fleet-fetch "$nok ok, $nbad failed:$bad"; fi
[ -n "$nogit" ] && row SKIP no-git "not git repos here:$nogit (./scripts/restore_git_metadata.sh --apply <dir> if one should be)"

echo; echo "── 4. stack ──"
if curl -fsS --max-time 5 http://localhost:3100/health >/dev/null 2>&1 && bash scripts/verify_local_stack.sh >/dev/null 2>&1; then
  row OK stack "gateway healthy + running HEAD — skipped rebuild"
elif docker info >/dev/null 2>&1 && act; then
  if docker compose up -d --build >/dev/null 2>&1 && sleep 10 && curl -fsS --max-time 10 http://localhost:3100/health >/dev/null 2>&1; then row OK stack "built + gateway healthy on :3100"
  else row FAIL stack "not healthy — docker compose logs gateway"; fi
else row SKIP stack "docker not running"; fi

echo; echo "── 5. brain sync + fleet MCP ──"
if curl -fsS --max-time 5 http://localhost:3100/health >/dev/null 2>&1; then
  if [ "$CHECK" = 1 ]; then row SKIP brain-sync "--check"
  elif bash scripts/resync.sh >/dev/null 2>&1; then row OK brain-sync "code + brain converged"
  else row FAIL brain-sync "scripts/resync.sh failed — run it to see why"; fi
  act && bash scripts/rollout_mcp_bridge.sh >/dev/null 2>&1
  if out="$(bash scripts/verify_fleet_mcp.sh 2>&1)"; then row OK fleet-mcp "$(printf '%s' "$out" | tail -1)"
  else row FAIL fleet-mcp "$(printf '%s' "$out" | tail -1)"; fi
else row SKIP brain-sync "gateway not up"; fi

echo; echo "── 6. remote control + no-sleep power ──"
rc_off="$(bash scripts/claude_profiles_transfer.sh status 2>/dev/null | awk '/remoteControl=/ && !/remoteControl=true/ {print $1}' | tr '\n' ' ')"
if [ -z "$rc_off" ]; then row OK remote-control "on in every profile"
elif act && bash scripts/claude_profiles_transfer.sh remote-control >/dev/null 2>&1; then row OK remote-control "turned on:  $rc_off"
else row FAIL remote-control "off in: $rc_off — ./scripts/claude_profiles_transfer.sh remote-control"; fi
# The 08:00 boot and the phone doorway need the Mac awake on the charger.
# pmset needs sudo (a password) — so this is reported, never attempted.
. "$REPO/scripts/lib/power_settings.sh"
displaysleep_want="$(resolve_displaysleep)"
ac_sleep="$(pmset -g custom 2>/dev/null | awk '/^AC Power/{ac=1} /^Battery Power/{ac=0} ac && $1=="sleep"{print $2; exit}')"
if [ "$ac_sleep" = "0" ]; then row OK power "no system sleep on charger"
else
  row FAIL power "system sleeps on charger after ${ac_sleep:-?} min"
  todo "In a normal Terminal (asks your password): sudo pmset -c sleep 0 disksleep 0 displaysleep $displaysleep_want womp 1 autorestart 1 powernap 1   — the Mac stays awake on the charger, screen still turns off"
fi
# Charger display-sleep minutes are a PER-HOST preference, not a fleet constant
# (config/power_settings.txt, resolved by scripts/lib/power_settings.sh —
# office-mac runs 5 min, operator 2026-10-02; every other Mac keeps the fleet
# default of 30 — never copy office-mac's value onto another host). Compare the
# live value against what THIS host is supposed to have; a drifted value is a
# WARN, not a FAIL — it never blocks the lid-close/battery guard below, which
# only forbids displaysleep=0 ("never").
ac_displaysleep="$(pmset -g custom 2>/dev/null | awk '/^AC Power/{ac=1} /^Battery Power/{ac=0} ac && $1=="displaysleep"{print $2; exit}')"
if [ -z "$ac_displaysleep" ]; then
  row SKIP power-displaysleep "could not read live AC displaysleep"
elif [ "$ac_displaysleep" = "$displaysleep_want" ]; then
  row OK power-displaysleep "AC displaysleep=${ac_displaysleep}m matches config/power_settings.txt"
else
  row WARN power-displaysleep "live AC displaysleep=${ac_displaysleep}m, config/power_settings.txt wants ${displaysleep_want}m for this host"
fi
# The charger row above does NOT cover lid close or battery: only
# SleepDisabled does, and only the sleep_guard root daemon keeps it set after
# an OS update. office-mac passed the charger row on 2026-09-28 yet slept on
# every lid close until 2026-10-02 — so the guard is its own gate here. Since
# 2026-10-21 it is power-aware: on battery disablesleep 0, so lid close sleeps natively (by design; no lid detection since 2026-10-23).
if bash scripts/sleep_guard.sh --check >/dev/null 2>&1; then row OK sleep-guard "on AC lid close won't sleep; on battery lid close sleeps, 5-min closed-lid backstop (power-aware daemon, every 60s)"
else
  row FAIL sleep-guard "lid close on AC WILL sleep this Mac, or the old always-awake daemon is installed — ./scripts/sleep_guard.sh --check"
  todo "In a normal Terminal (asks your password): sudo bash $REPO/scripts/sleep_guard.sh --install-daemon   — on AC the Mac stays awake with the lid closed; on battery it sleeps on lid close as normal, and a lid still closed after 5 min is put to sleep (override: --stay-awake 2h); screen still locks"
fi

# boot_machines.txt is universal ('*:0-6'): every Mac boots unless a host line
# overrides it. Only the launchd agent has to exist on THIS Mac.
if launchctl list 2>/dev/null | grep -q com.myai.morning-boot; then row OK boot-schedule "08:00 launchd agent installed"
elif act && bash scripts/setup_boot_schedule.sh >/dev/null 2>&1; then row OK boot-schedule "08:00 launchd agent installed now"
else row FAIL boot-schedule "run ./scripts/setup_boot_schedule.sh"; fi

# AI_RULES §12 hard rule: node_modules never syncs to Dropbox on any Mac — the
# 15-min sweeper marks every one under the Dropbox root com.dropbox.ignored.
if launchctl list 2>/dev/null | grep -q com.myai.dropbox-ignore; then row OK dropbox-ignore "node_modules sweeper installed (every 15 min)"
elif act && bash scripts/setup_dropbox_ignore_schedule.sh >/dev/null 2>&1; then row OK dropbox-ignore "node_modules sweeper installed now"
else row FAIL dropbox-ignore "run ./scripts/setup_dropbox_ignore_schedule.sh"; fi
have gh && ! gh auth status >/dev/null 2>&1 && todo "! gh auth login"

# Local myAI data: the gateway writes to Atlas, so the local myai-mongo is empty
# unless mirrored — keep an hourly Atlas → local copy (Compass myAI_DOCKER shows
# real data; Atlas-down still has a warm local copy). One-way, local is overwritten.
if launchctl list 2>/dev/null | grep -q com.myai.mongo-mirror; then row OK mongo-mirror "hourly Atlas → local myai-mongo"
elif act && bash scripts/mongo_mirror.sh --install-schedule >/dev/null 2>&1; then row OK mongo-mirror "hourly Atlas → local myai-mongo installed now"
else row FAIL mongo-mirror "run ./scripts/mongo_mirror.sh --install-schedule"; fi

# Dev apps: Bruno collections + MongoDB Compass with EVERY app's database
# (Atlas + local Docker, passwords from the Dropbox-synced, git-ignored
# api_management local file) — part of every new Mac, not a separate step.
if [ -f scripts/dev_apps.sh ]; then
  if act && bash scripts/dev_apps.sh >/dev/null 2>&1; then row OK dev-apps "Bruno + Compass provisioned (./scripts/dev_apps.sh)"
  elif act; then row FAIL dev-apps "run ./scripts/dev_apps.sh to see which app failed"
  else row SKIP dev-apps "would run ./scripts/dev_apps.sh (Bruno + Compass)"; fi
fi

echo; echo "── new mac: summary ($NFAIL failed) ──"
printf '%s\n' "$RES" | sed '/^$/d' | awk -F'|' '{printf "  %-5s %-15s %s\n", $1, $2, $3}'
[ -n "$TODO" ] && { echo; echo "YOU NEED TO DO:$TODO"; }
echo
echo "Then: source ~/.zshrc; log in once per profile in its own terminal ($PROFILE_LOGINS)."
echo "Restart claude here and type: agent mode -min"
[ "$NFAIL" = 0 ]
