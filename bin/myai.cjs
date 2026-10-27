#!/usr/bin/env node
'use strict';

/**
 * myai / ai-manage — CLI for the AI Management Framework.
 *
 * A thin dispatcher: each subcommand shells into an existing `scripts/*.sh`
 * (or `docker compose`) so the bash playbooks stay the single source of truth.
 *
 * Docker-only / no-host-build: this file has ZERO required runtime deps. It
 * uses `commander` for help + parsing WHEN it is installed, and falls back to a
 * tiny built-in parser otherwise — so `myai --help` and `myai doctor` work even
 * before `npm install` runs (e.g. in this repo, where npm install is Docker-only).
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PKG = require('../package.json');
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

// ── Command table ─────────────────────────────────────────────────────────
// One source of truth consumed by both the commander path and the fallback.
//   script  → scripts/<script> invoked with the user's extra args
//   docker  → `docker <args...>` invoked with the user's extra args appended
//   handler → in-process JS (used by `doctor`)
const COMMANDS = [
  { name: 'setup', args: '[args...]', script: 'myai_setup.sh',
    desc: 'Global first-run wizard (once per machine, BEFORE any repo work): the ONE question — connect an existing brain (--brain <url> / $MYAI_BRAIN_REMOTE) or provision a new one (local by default, states the ownership/data-locality deal + consent, optional private remote). --yes for non-interactive consent. Auto-triggered by any other stateful command when ~/.myai/config is missing (see needsAutoSetup below) — never re-triggers once set up; --force redoes it. `setup --machine` is the separate machine-arrival path: idempotently checks/fixes Dropbox conflicts, git re-attach across the repo fleet, the Docker stack, npm\'s global prefix, and runner registration in one pass — reports fixed vs. needs-operator (--dry-run/--yes/--install-runner/--rebuild-docker/--json)' },
  { name: 'init', args: '[path]', script: 'myai_init.sh',
    desc: 'Greenfield by default: drop a ~30-line kernel CLAUDE.md + gitignored .myai-local (no AI/ folder) — framework resolves from the installed module. --managed forces the legacy AI/-scaffold (portable docker-compose + .env + guided wizard); --force replaces a non-kernel CLAUDE.md; --zero-prompt (or env MYAI_ZERO_PROMPT=1) guarantees a scripted/headless run never blocks on stdin, regardless of TTY state' },
  { name: 'up', args: '[args...]', script: 'myai_up.sh',
    desc: 'Start the self-contained stack (gateway + dashboard + mongo) on localhost, wait for health, print the dashboard URL' },
  { name: 'down', args: '[args...]', script: 'myai_down.sh',
    desc: 'Stop the stack cleanly (--volumes also drops the mongo data volume)' },
  { name: 'status', args: '[args...]', script: 'myai_status.sh',
    desc: 'Gateway/runner/queue health at a glance: gateway/dashboard HTTP health, docker compose ps, task-queue counts, continuity meter, and the local off-hours runner\'s installed/active state (--json for scripts; exit 0 = healthy)' },
  { name: 'boot', args: '[args...]', script: 'myai_boot.sh',
    desc: 'TOKEN-FREE session boot — the deterministic spine of `agent mode -min` with zero LLM cost: git sync (ff-only pull), brain delta since last boot (pure git) INCLUDING the compiled brief.md/working.md read straight off brain main on disk (zero gateway dependency, BRAIN_OFFLINE.md Layer 3), schedule banner, remote-control status. Run BEFORE opening Claude. --no-fetch | --no-pull | --working (also print working.md) | --offline (skip git fetch + the two gateway-backed banners entirely — guaranteed to complete with the stack fully down) | --quiet' },
  { name: 'logs', args: '[service...]', script: 'myai_logs.sh',
    desc: 'Live-tail stack logs — wraps `docker compose logs -f` (optionally one service: gateway | dashboard | mongo; --no-follow, --tail N); --runner also tails the local off-hours CLI runner\'s latest job log alongside it, prefixed [runner]' },
  { name: 'queue', args: '[args...]', script: 'myai_queue.sh',
    desc: 'Inspect and control the runner task queue — the CLI mirror of the dashboard /work orchestration view. `queue` / `queue list` [--repo][--status][--priority][--all][--json]; `queue cancel <taskId>` [--reason][--force] marks it blocked (reversible); `queue reprioritize <taskId> <P0|P1|P2|P3>` changes its priority' },
  { name: 'open', args: '[target...]', script: 'myai_open.sh',
    desc: 'Jump from the terminal to the right dashboard view in one keystroke: `open`/`open dashboard` (root), `open board` (THIS repo\'s /work board — repo auto-detected from the git checkout, --repo overrides), `open task <id>` (deep-link a queue task — tab + repo resolved via the gateway when reachable, graceful /work fallback when not), `open repo` (App Directory /apps), or any named dashboard page (work | fleet | apps | brain | memory | system | …). Localhost vs hosted resolves from DASHBOARD_URL / MYAI_DASHBOARD_PORT (env wins over .env). Cross-platform launcher: macOS open / Linux xdg-open / WSL wslview / Windows start, MYAI_OPEN_CMD override, $BROWSER fallback; --print prints the URL instead of launching' },
  { name: 'scan', args: '[path]', script: 'myai_scan.sh',
    desc: 'Spider git repos under a dir → register each in the gateway directory + seed RAG awareness (--register also lists in managed_repos.txt; --dry-run previews)' },
  { name: 'demo', args: '[args...]', script: 'myai_demo.sh',
    desc: 'Seed the dashboard with realistic sample data — tasks, schedules, plan, repo cards, memory, budget rows (idempotent; --clean removes, --force re-seeds)' },
  { name: 'new-app', args: '[args...]', script: 'myai_new_app.sh',
    desc: 'Two modes, one verb: `new-app <path>` scaffolds a full-stack app offline from the bundled myAI blueprint (init_blueprint.sh flags all still work — --gh-create, --vercel, --mode, etc.); `new-app "<idea>"` (or `--idea "<idea>"`) drives agentFlow\'s headless idea→app pipeline (POST /api/headless/new-app, x-gateway-local-token) and self-registers the produced repo via repos_upsert (ADR-021). Dispatches on argument shape: any whitespace in the first arg means idea mode' },
  { name: 'connect', args: '[path]', script: 'init_connect.sh',
    desc: 'Install the Connect Hub module into a project' },
  { name: 'plug', args: '[agent...]', script: 'myai_plug.sh',
    desc: 'Plug ANY agent into your brain — one front door over both tiers. `myai plug` lists every agent + its one-liner; `myai plug <agent>` routes (claude|cursor|windsurf|codex|gemini|opencode = MCP auto-boot; ollama|chatgpt|print = blank-agent wrap) and forwards extra flags; `myai plug proof` runs the live continuity round-trip with no agent installed' },
  { name: 'connect-agent', args: '[args...]', script: 'myai_connect_agent.sh',
    desc: 'Cooperating (MCP) tier of `myai plug` — print/install MCP config (claude | cursor | windsurf | codex | all) pointing at the local gateway, then verify the context_boot round-trip (--install writes, --no-verify skips)' },
  { name: 'shim', args: '[args...]', script: 'betac_shim.sh',
    desc: 'Wrap-it tier of `myai plug` — fetch the operator context bundle and PREPEND it for a non-MCP agent: launch Ollama pre-loaded, or compose a paste-ready ChatGPT primer; a prompt is forwarded as a lazy-recall query (--model, --repo, --no-deep, --copy)' },
  { name: 'schedule', args: '[args...]', script: 'schedule_task.sh',
    desc: 'Queue an autonomous task for the CLI runner (pass --title, etc.)' },
  { name: 'login', args: '[args...]', script: 'myai_login.sh',
    desc: 'Authenticate this terminal against a hosted myAI gateway — validates a per-tenant API key via GET /api/auth/whoami and persists it (`--key <apiKey>` or $MYAI_API_KEY or an interactive hidden prompt; `--gateway-url URL`; `--json`). End-user session identity — distinct from `myai config` (local schema-validated key editing, no gateway round-trip) and tenant-key rotation (operator CRUD)' },
  { name: 'whoami', args: '[args...]', script: 'myai_whoami.sh',
    desc: 'Print the active org/tenant/plan/quota for the session `myai login` established — always round-trips to the gateway for live quota (`--gateway-url URL` override; `--json`)' },
  { name: 'config', args: '[args...]', script: 'myai_config.sh',
    desc: 'Safe front-end for the per-user ~/.myai/config store — view/set keys (org, gateway URL, brain wiring, model routing) with SCHEMA VALIDATION instead of hand-editing the JSON: `config`/`config list` [--json][--reveal] (values redacted where secret-shaped, unknown keys flagged); `config keys` (the schema: every known key + type + description); `config get <key>`; `config set <key> <value>` (per-key validation — URL/enum/path/model-id; unknown keys refused unless --force; secret-named keys ALWAYS refused — credentials live in ~/.myai/credentials via `myai login`/`myai rotate-keys`, never in config); `config unset <key>`; `config path`. Purely local (no gateway round-trip)' },
  { name: 'mcp', args: '[args...]', script: 'myai_mcp.sh',
    desc: 'Propagate the MCP server config through the installed module (not update_all): `mcp repo [path]` writes/refreshes a repo .mcp.json from the bundled template (deep-merge — framework servers canonical, custom preserved); `mcp add <name>... | --list` adds opt-in servers (shadcn-ui, playwright, dropbox, github, vercel, or all) to a repo .mcp.json; `mcp vscode [path]` does the same for the VS Code .vscode/mcp.json (Copilot/Codex-in-VS-Code agent mode); `mcp sync [<profile>|all]` refreshes the per-org Claude config dirs from the template; `mcp print` shows the base config. --dry-run supported' },
  { name: 'mirror', args: '[args...]', script: 'mongo_mirror.sh',
    desc: 'Keep a LOCAL copy of the gateway memory + registry so localhost is not single-point-of-failure on Atlas. Streams mongodump→mongorestore (Atlas → local by default) in a throwaway mongo:7 container — no host mongo tools. --dry-run previews; --collections a,b scopes; --reverse (local → Atlas) is guarded behind --yes; --install-schedule [--every-minutes N] / --schedule-status / --uninstall-schedule manage the periodic (hourly default) launchd/cron refresh' },
  { name: 'sync', args: '[args...]', script: 'mongo_sync.sh',
    desc: 'ADR-022 local-first mongo mode: converge Atlas and the local myai-mongo in whichever direction is designated PRIMARY. Plain call syncs PRIMARY → SECONDARY (idempotent); `sync status` shows primary + last successful sync; `sync set-primary atlas|local` flips the designation; --dry-run previews; --collections a,b scopes. `sync schedule install|status|uninstall [--every-minutes N|--every-hours N]` installs/inspects/removes BOTH the periodic sync job and an independent staleness canary that raises a notification-engine alert once the last successful sync exceeds a threshold — never installed automatically' },
  { name: 'rotate-keys', args: '<local|tenant> [args...]', script: 'myai_rotate_keys.sh',
    desc: 'Self-rotate a gateway credential with a dual-valid grace window (zero-downtime): `rotate-keys local [--grace-minutes N]` rewrites GATEWAY_LOCAL_TOKEN in .env, keeping the old value valid for the grace window; `rotate-keys tenant <tenantId> [--grace-minutes N] [--env live|test]` mints a new tenant bootstrap API key via the gateway (local-trust only), old key stays valid server-side until grace elapses — new key is shown ONCE' },
  { name: 'tenant', args: '<create|list|suspend|reactivate|rotate-key> [args...]', script: 'myai_tenant.sh',
    desc: 'Operator tenant lifecycle CRUD, scriptable from the terminal (wraps the gateway\'s admin-gated /api/tenants endpoints — needs ADMIN_API_TOKEN configured on the gateway): `tenant create --tenant-id <id> --name <name> [--plan free|solo|team|scale] [--owner-email <email>] [--env live|test]` provisions a tenant + first API key (shown ONCE); `tenant list [--status active|suspended|deleted] [--plan <plan>] [--limit N]`; `tenant suspend <tenantId> [--reason "..."]` blocks every key call instantly; `tenant reactivate <tenantId>` restores it; `tenant rotate-key <tenantId> [--grace-minutes N] [--env live|test]` delegates to `rotate-keys tenant` (local-trust only, zero-downtime grace window)' },
  { name: 'runner', args: '[args...]', script: 'myai_runner.sh',
    desc: 'Manage the local off-hours CLI runner schedule (launchd/systemd) — install [--every-minutes N|--every-hours N] | uninstall | start | stop | status (+ next-fire) | logs [-f] [-n N]. Distinct from `myai status`/`myai logs` (gateway health) — this controls the local worker' },
  { name: 'brain', args: '[args...]', script: 'myai_brain.sh',
    desc: 'Git-versioned agent memory — init | status | write | stash | pop | branch | checkout | merge | log | diff | blame | revert | gc | session | distill (sessions = commits, wrap up = merge; walkthrough: TRY_BRAIN.md)' },
  { name: 'wrapup', args: '[args...]', script: 'myai_wrapup.sh',
    desc: 'The mechanical half of `wrap up` in ONE call (BRAIN W4.2): rotate_state.sh + repo_card.sh + memory_reindex + brain atom/merge/verify + the WRAPPED UP banner. `wrapup --mechanical` runs all five; pipe the ~300-token session summary on stdin (or --atom-file <path>) to also write + merge the brain atom (--no-atom skips it). Every step is individually non-fatal — a missing script or unreachable gateway degrades that one step and the run continues; exits 0. --topic <t> --repo <name> --slug <s> --profile <p> --reindex-scope master|all --no-rotate --no-card --no-reindex --quiet' },
  { name: 'memory', args: '[args...]', script: 'myai_memory.sh',
    desc: 'Portable memory bundle — export [dir] pulls the corpus (state/handoff/patterns source texts) as JSON manifest + markdown; import <dir> re-embeds on this gateway with dedup-by-hash' },
  { name: 'context', args: '[args...]', script: 'myai_context.sh',
    desc: 'FULL portable context bundle — export [dir] tars memory corpus + vectors (embeddings) + brain atoms + config into ONE versioned, checksummed, secret-redacted .tar.gz; import <archive> verifies integrity and re-imports (memory always, brain/config opt-in); import-external <source> ingests FROM ChatGPT/Claude export, Obsidian, markdown, or a raw vector store (re-embed + dedup, tenant-scoped). Own + download your whole context.' },
  { name: 'recall', args: '<query...>', script: 'myai_recall.sh',
    desc: 'TOKEN-FREE semantic recall over the repo-local SQLite index (code symbols + brain atoms) via sparse BM25 + local embeddings — NO LLM, NO network, NO tokens. Builds the index on first use. --k N | --json | --rebuild' },
  { name: 'ctx', args: '<query...>', script: 'myai_ctx.sh',
    desc: 'TOKEN-FREE context lookup — the primitive that replaces bulk Read/Grep: bare `file:line` pointers + `atom:<ref>` refs, one per line, over the same repo-local SQLite index `recall` uses (NO LLM, NO network, NO tokens, fully offline — works with the gateway down). --k N | --json | --rebuild | --db PATH' },
  { name: 'backup', args: '[args...]', script: 'myai_backup.sh',
    desc: 'Snapshot the git-versioned brain repo + ~/.myai config files into one dated .tar.gz archive (--out <file> or [dir] to place it; round-trips with `myai restore`)' },
  { name: 'restore', args: '[args...]', script: 'myai_restore.sh',
    desc: 'Restore a `myai backup` archive — brain repo → this machine\'s resolved dir (or --to <dir>) + config → ~/.myai; refuses to clobber without --force (existing state → .bak; --dry-run previews)' },
  { name: 'uninstall', args: '[args...]', script: 'myai_uninstall.sh',
    desc: 'Remove what myAI installed on this machine. Dry run by default (lists exactly what it found); --yes removes it: com.myai.* scheduled jobs, our marked shell-rc blocks only, the statusline, our myai entry in other agents\' MCP configs (every other byte kept), myAI containers/network/images, and the state dir EXCEPT the brain. --volumes also drops the database volume; --purge-brain saves the brain to ~/myai-brain-final-<ts>.bundle first, then removes it; --repo <path> cleans that repo\'s .myai-local, .gitignore line and .mcp.json entry (never commits). Finish with `npm rm -g ai-management`' },
  { name: 'upgrade', args: '[args...]', script: 'myai_upgrade.sh',
    desc: 'Self-update the global CLI (`npm update -g`) then run pending config + brain schema migrations idempotently (--check reports without applying, exit 20 if pending; --dry-run previews; --no-self-update skips the npm step; --json for scripts)' },
  { name: 'swarm', args: 'master [set|show|list|check|migrate|who|take|release|stop] [args...]', script: 'myai_swarm.sh',
    desc: 'This device\'s swarm master — every device has exactly one, chosen at install: `swarm master set` lists the agents and profiles detected here and asks which one coordinates (flags --agent/--profile/--repo for scripts), writing the per-host ~/.myai/swarm/master.<host> (never Dropbox); `show` / `list`; `check` = OK/WARN/RED (configured master holds the coordinator lease AND runs its mail watcher); `migrate` writes legacy hosts\' current master + order (run by `myai upgrade`); any other verb goes to scripts/swarm_master.sh (who/take/release/stop)' },
  { name: 'doctor', args: '[args...]', handler: doctor,
    desc: 'Run preflight checks: docker (+engine), node, claude CLI, ANTHROPIC_API_KEY, cloud reachability, ollama availability, brain freshness, mongo mirror schedule (+last run), ports free. --dry-run previews the safe auto-fixes; --fix applies them idempotently (backfill non-secret .env keys from .env.example, redeploy statusline, correct runner cadence, pull latest gateway image) — never touches secrets or restarts the shared stack (--json for CI/scripts; exit 0 = passed)' },
  { name: 'root', args: '[args...]', handler: root,
    desc: 'Print the installed ai-management module path — the framework-as-module resolver a kernel-only repo (no per-repo AI/ copy) uses to find agents/skills/hooks/rule bodies. Fails loud (exit 1) if the resolved dir is not a valid install, so safety hooks never silently go missing (--json for scripts)' },
  { name: 'release', args: '[args...]', script: 'myai_release.sh',
    desc: 'One-command release cut: `release [patch|minor|major]` bumps package.json + CHANGELOG.md from Conventional Commits, clean-room-validates (shell unit suite + publish_guard.sh leak scan + a Docker install/smoke check), and commits locally — any validation failure auto-reverts the bump. `release --tag` (run on main after the commit merges) tags + pushes the release and prints the `gh release create` follow-up. --dry-run previews; --skip-tests/--skip-guard/--skip-docker skip a validation stage; --json for scripts' },
  { name: 'completions', args: '<shell>', handler: completions,
    desc: 'Generate a shell completion script (commands, flags, and dynamic --repo names) for bash | zsh | fish. Prints to stdout; install instructions are inline as comments in the generated script. Command list is read straight off this table, so it can never drift from `myai --help` — enforced by runtime/tests/unit/cli-dispatch.test.ts' },
  { name: 'repos', args: '[--paths] [--json]', handler: reposCommand,
    desc: 'Fleet roster (ADR-021 Phase 3 resolver shim): gateway DB `repos` collection preferred, config/managed_repos.txt bootstrap-seed fallback. Default prints repo names; --paths prints one absolute checkout path per line (for shell consumers); --json prints entries with name/path/source plus which resolver answered. MYAI_REPOS_NO_GATEWAY=1 forces the seed file' },
  { name: '__repos', args: '[args...]', handler: printRepos, hidden: true,
    desc: 'Internal: list managed repo names (one per line) from config/managed_repos.txt — used by shell completion to fill in --repo values' },
];

// ── Dispatch ────────────────────────────────────────────────────────────────
function runScript(scriptName, extraArgs) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`myai: missing script: ${path.relative(REPO_ROOT, scriptPath)}`);
    return 1;
  }
  // Run from the user's CWD (not the package dir): commands like `up`/`down`
  // need to find the init'd project there, and `[path]` args are already
  // resolved to absolute, so scripts (which locate themselves via $0) are
  // unaffected by cwd.
  const res = spawnSync('bash', [scriptPath, ...extraArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  return res.status == null ? 1 : res.status;
}

function runDocker(dockerArgs, extraArgs) {
  const res = spawnSync('docker', [...dockerArgs, ...extraArgs], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (res.error && res.error.code === 'ENOENT') {
    console.error('myai: docker not found on PATH. Install Docker Desktop / engine.');
    return 127;
  }
  return res.status == null ? 1 : res.status;
}

// Scripts run with cwd = REPO_ROOT (the installed package dir). A `[path]`
// command therefore must have its relative path arg resolved against the user's
// REAL cwd, or `myai init my-app` would scaffold inside node_modules. A missing
// path defaults to the user's cwd.
function resolvePathArg(extraArgs) {
  if (extraArgs.length === 0) return [process.cwd()];
  const first = extraArgs[0];
  if (first.startsWith('-')) return [process.cwd(), ...extraArgs];
  if (path.isAbsolute(first)) return extraArgs;
  return [path.resolve(process.cwd(), first), ...extraArgs.slice(1)];
}

function dispatch(cmd, extraArgs) {
  if (cmd.handler) return cmd.handler(extraArgs) ? 0 : 1;
  if (cmd.docker) return runDocker(cmd.docker, extraArgs);
  if (cmd.script) {
    const args = cmd.args === '[path]' ? resolvePathArg(extraArgs) : extraArgs;
    return runScript(cmd.script, args);
  }
  console.error(`myai: command '${cmd.name}' has no action wired up.`);
  return 1;
}

// ── doctor: preflight ────────────────────────────────────────────────────────
// Every check is recorded as {label, status, detail} into a shared array; the
// human and --json output paths both render from that ONE result set, so the
// two can never drift.
// swarmMasterStatus → {status: 'ok'|'warn'|'fail', detail} from
// scripts/swarm_master.sh check: rc 0 OK · 1 WARN (incl. "no master yet, and no
// agent detected" — a fresh install) · 2 lease not held · 3 none configured
// while an agent/profile exists (FAIL, with its fix).
function swarmMasterStatus() {
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'swarm_master.sh'), 'check'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, KL_TIMEOUT: process.env.KL_TIMEOUT || '3' },
  });
  const line = String((r && r.stdout) || '').trim().split('\n')[0] || 'check gave no answer';
  if (r && r.status === 0) return { status: 'ok', detail: line.replace(/^OK — /, '') };
  if (r && r.status === 3) return { status: 'fail', detail: line.replace(/^RED — /, '') };
  return { status: 'warn', detail: line.replace(/^(WARN|RED) — /, '') };
}

// `myai doctor` explains every WARN/FAIL in plain words (v1 gate G6): one
// entry per check — why it matters and what to do. Keys are the check labels;
// dynamic labels map through explainKey(). Agent-agnostic on purpose: no
// lane or profile names, "your agent" where an agent is meant.
// runtime/tests/unit/doctor-explain.test.ts fails if a check has no entry.
const DOCTOR_EXPLAIN = {
  'node >= 20': {
    why: 'The myai CLI and gateway use Node 20+ features; an older Node fails at start-up.',
    fix: 'Install Node 20 or newer (nodejs.org, `brew install node`, or your package manager), then re-run `myai doctor`.' },
  'docker on PATH': {
    why: 'The gateway, dashboard and database all run as Docker containers.',
    fix: 'Install Docker Desktop (macOS/Windows) or Docker Engine (Linux).' },
  'docker engine running': {
    why: 'Docker is installed but its engine is not running, so no container can start.',
    fix: 'Start Docker Desktop (or `sudo systemctl start docker` on Linux) and wait until it reports running.' },
  'docker compose': {
    why: '`myai up` starts the stack with the Docker Compose v2 plugin.',
    fix: 'Update Docker Desktop, or install the `docker-compose-plugin` package on Linux.' },
  'git on PATH': {
    why: 'The brain is a git repository, and connecting a repo reads its git metadata.',
    fix: 'Install git (`xcode-select --install` on macOS, or your package manager).' },
  'tmux on PATH': {
    why: 'Remote (phone-driven) sessions run inside tmux so they survive the terminal closing.',
    fix: 'Install tmux (`brew install tmux` or your package manager). Only needed for remote sessions.' },
  'claude CLI': {
    why: 'The background task runner drives an agent CLI; with no CLI and no API key, queued tasks cannot run.',
    fix: "Install your agent's CLI and sign in, or set ANTHROPIC_API_KEY. Optional if you don't use the runner." },
  'ANTHROPIC_API_KEY': {
    why: 'A Claude agent (model calls, the task runner) needs either an API key or a signed-in Claude CLI. Not needed without a Claude agent.',
    fix: 'Add ANTHROPIC_API_KEY=... to the .env next to docker-compose.yml, or sign in to your agent CLI.' },
  'GATEWAY_LOCAL_TOKEN': {
    why: 'This token lets local tools call the gateway. The published default is public, so anyone who can reach the port could use it.',
    fix: 'Run `myai rotate-keys local` to generate a private token.' },
  'GATEWAY_LOCAL_TOKEN_PREVIOUS': {
    why: 'The rotation slot accepts an old token for a grace period; holding the public default re-opens the hole.',
    fix: 'Remove GATEWAY_LOCAL_TOKEN_PREVIOUS from .env, or rotate again with `myai rotate-keys local`.' },
  'cloud provider reachable': {
    why: 'Without network access to the model provider, cloud inference is unavailable and myAI falls back to local models.',
    fix: 'Check your network or proxy settings, or install Ollama for offline use.' },
  'ollama available': {
    why: 'Ollama is the offline fallback for inference.',
    fix: 'Optional: install Ollama (ollama.com) and pull a model with `ollama pull <model>`.' },
  'offline inference path': {
    why: 'With neither the cloud nor Ollama available, only read-only access to the brain works.',
    fix: 'Restore network access, or install Ollama.' },
  'MCP mode': {
    why: 'The gateway is not answering, so agents fall back to the local brain server: brain and recall work, but the rest of the myAI tools are missing.',
    fix: 'Run `myai up`, then restart your agent so it reconnects to the gateway.' },
  'brain freshness': {
    why: 'The brain is where sessions are saved. If it is missing or unchanged for a week, your agent starts without recent context.',
    fix: 'Run `myai brain init` if it is missing; otherwise end sessions with a wrap-up so they commit to the brain.' },
  'brain integrity': {
    why: 'A brain with a broken HEAD or missing objects cannot be read or merged, and an upgrade cannot snapshot it safely.',
    fix: 'Run `git -C <brain dir> fsck` to see the damage, then restore from your latest `myai backup` or a remote copy of the brain.' },
  'config migrations': {
    why: 'Your ~/.myai config or brain layout is older than this version expects.',
    fix: 'Run `myai upgrade` (it snapshots the brain first).' },
  'scheduled job': {
    why: 'A myAI background job is installed but not loaded, or points at a script that no longer exists, so it silently never runs.',
    fix: 'Re-run the matching `--install-schedule` command from your current install, or remove the job with its uninstall option.' },
  'agent MCP': {
    why: "Your agent's MCP config is how it reaches the myAI gateway; without the entry it starts without your context.",
    fix: 'Run `myai plug <agent> --install` (`myai plug` lists the agents), then restart the agent.' },
  'repo connected': {
    why: 'This git repo is not connected to myAI, so sessions here will not load or save context.',
    fix: 'Run `myai init` in this repo.' },
  'mongo mirror schedule': {
    why: 'The mirror keeps a local copy of the cloud database for fast and offline reads.',
    fix: 'Optional: install or repair it with `myai mirror --install-schedule`; see ~/.myai/logs/mongo-mirror.err when runs fail.' },
  'swarm master': {
    why: 'Each device has one master session that coordinates the others; without one, parallel sessions are not coordinated.',
    fix: 'Run `myai swarm master set` and pick your main agent profile.' },
  'runner backlog well': {
    why: 'The task runner draws background work from this list; when it runs low a planning task refills it.',
    fix: 'Usually nothing to do. If it stays low, check the task runner logs.' },
  'session hook timing': {
    why: 'Slow start-up hooks delay every new agent session.',
    fix: 'Run `myai doctor --json` to see the timing, then disable or speed up the slowest hook.' },
  'scripts/ directory': {
    why: 'The install is incomplete: the CLI cannot find its scripts.',
    fix: 'Reinstall with `npm i -g ai-management`.' },
  'docker-compose.yml': {
    why: 'Without the compose file, `myai up` cannot start the stack.',
    fix: 'Reinstall the package, or run from the directory that has docker-compose.yml.' },
  '.mcp.json': {
    why: 'Without .mcp.json in this folder, your agent will not connect to the gateway when started here.',
    fix: 'Run `myai init` in this repo, or `myai mcp repo`.' },
  'port free': {
    why: 'Another process holds a port the stack needs, so that container will not start.',
    fix: 'Stop the process (`lsof -i :<port>` shows it), or run `myai down` if it is an old myAI stack.' },
};

function explainKey(label) {
  if (/^port \d+ free$/.test(label)) return 'port free';
  if (label.startsWith('scheduled job ')) return 'scheduled job';
  if (label.endsWith(' MCP')) return 'agent MCP';
  return label;
}

function explainFor(label) {
  const key = explainKey(label);
  const e = DOCTOR_EXPLAIN[key];
  return e ? { id: key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), ...e } : null;
}

function recordInto(checks) {
  return (label, ok, detail) => {
    const status = ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'fail';
    const row = { label, status, detail: detail || '' };
    if (status !== 'ok') {
      const e = explainFor(label);
      if (e) Object.assign(row, { id: e.id, why: e.why, fix: e.fix });
    }
    checks.push(row);
    return ok === true || ok === 'warn';
  };
}

function bin(name, versionArgs) {
  const r = spawnSync(name, versionArgs || ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr || '').trim().split('\n')[0];
}

// Synchronous, dependency-free port probe: spawn a tiny node child that tries to
// connect to 127.0.0.1:<port>. Exit 0 → something is listening (port IN USE);
// exit 1 → connection refused / timeout (port FREE). Uses process.execPath so it
// works on any machine running this CLI (node is, by definition, present).
function portInUse(port) {
  const probe =
    `const net=require('net');` +
    `const s=net.connect({host:'127.0.0.1',port:${port}},()=>{s.destroy();process.exit(0)});` +
    `s.on('error',()=>process.exit(1));` +
    `s.setTimeout(700,()=>{s.destroy();process.exit(1)});`;
  const r = spawnSync(process.execPath, ['-e', probe]);
  return r.status === 0;
}

// parseDockerPorts(`docker ps --format '{{.Names}}\t{{.Ports}}'` output) →
// Map<hostPort, containerName>. Handles "0.0.0.0:3210->3210/tcp", ranges
// ("0.0.0.0:3200-3201->3200-3201/tcp") and IPv6 ("[::]:3000->3000/tcp").
function parseDockerPorts(text) {
  const owners = new Map();
  for (const line of String(text || '').split('\n')) {
    const [name, ports] = line.split('\t');
    if (!name || !ports) continue;
    for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
      const lo = Number(m[1]); const hi = Number(m[2] || m[1]);
      for (let p = lo; p <= hi; p++) if (!owners.has(p)) owners.set(p, name.trim());
    }
  }
  return owners;
}

// A busy stack port held by OUR OWN stack (a container named <project>-*) is
// the stack running, not a conflict (2026-10-27: doctor WARNed 3200/3201/3210/
// 27200 on every box with myAI up). Empty map when docker is absent or down.
function stackPortOwners() {
  const r = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { encoding: 'utf8', timeout: 10000 });
  return r && r.status === 0 ? parseDockerPorts(r.stdout) : new Map();
}

// claudeAgentConfigured → true when this machine is set up for a Claude agent
// even without the CLI on PATH: CLAUDE_CONFIG_DIR is set, or a ~/.claude /
// ~/.claude-<x> profile dir exists. Used to decide whether a missing
// ANTHROPIC_API_KEY is worth a WARN (task-51235f67).
function claudeAgentConfigured() {
  if (process.env.CLAUDE_CONFIG_DIR) return true;
  const home = require('node:os').homedir();
  try {
    return fs.readdirSync(home).some((n) => (n === '.claude' || n.startsWith('.claude-'))
      && fs.statSync(path.join(home, n)).isDirectory());
  } catch { return false; }
}

// isPlaceholderKey → true for a value that is SET but obviously not a key:
// your_api_key_here / your-key-here, sk-ant-xxx, <your key>, changeme,
// anything containing "placeholder".
function isPlaceholderKey(v) {
  const t = String(v || '').trim().replace(/^["']|["']$/g, '');
  return /^your[_-]/i.test(t) || /^<.*>$/.test(t) || /^sk-ant-x+$/i.test(t)
    || /^x{3,}$/i.test(t) || /^(changeme|change-me|replace[_-]?me|todo)$/i.test(t)
    || /placeholder/i.test(t);
}

// anthropicKeyCandidates → every place ANTHROPIC_API_KEY is SET (non-empty),
// in lookup order: the environment, then a local .env (cwd, package root).
function anthropicKeyCandidates() {
  const out = [];
  const envVal = process.env.ANTHROPIC_API_KEY;
  if (envVal && envVal.trim()) out.push({ src: 'environment', value: envVal.trim() });
  for (const dir of [process.cwd(), REPO_ROOT]) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, 'utf8').match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m && m[1] && m[1].trim()) out.push({ src: path.relative(process.cwd(), f) || '.env', value: m[1].trim() });
  }
  return out;
}

// Look for ANTHROPIC_API_KEY in the environment, then in a local .env (cwd or
// package root). A placeholder value (see isPlaceholderKey) or an empty one
// does not count as set.
function findAnthropicKey() {
  const c = anthropicKeyCandidates().find((k) => !isPlaceholderKey(k.value));
  return c ? c.src : null;
}

// findAnthropicPlaceholder → where a placeholder ANTHROPIC_API_KEY is set (the
// first one), or null. A misconfiguration doctor names, never a FAIL.
function findAnthropicPlaceholder() {
  const c = anthropicKeyCandidates().find((k) => isPlaceholderKey(k.value));
  return c ? c.src : null;
}

// The GATEWAY_LOCAL_TOKEN fallback docker-compose.yml/.mcp.json/templates used
// to ship (`${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}`) — public knowledge,
// since it's in the npm package. Kept here in sync with
// runtime/src/shared/config.ts's KNOWN_DEFAULT_LOCAL_TOKEN (SECURITY task-7f8b20a3).
const KNOWN_DEFAULT_LOCAL_TOKEN = 'myai-local-bridge-dev';

// Look for GATEWAY_LOCAL_TOKEN (or a sibling var like the rotation-grace
// GATEWAY_LOCAL_TOKEN_PREVIOUS) in the environment, then in a local .env (cwd
// or package root) — same resolution order as findAnthropicKey.
function findGatewayLocalToken(varName) {
  const name = varName || 'GATEWAY_LOCAL_TOKEN';
  const envVal = process.env[name];
  if (envVal && envVal.trim()) return { value: envVal.trim(), src: 'environment' };
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm');
  for (const dir of [process.cwd(), REPO_ROOT]) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, 'utf8').match(re);
    if (m && m[1] && m[1].trim()) return { value: m[1].trim(), src: path.relative(process.cwd(), f) || '.env' };
  }
  return null;
}

// TCP reachability probe to an arbitrary host:port — same dependency-free
// node-child pattern as portInUse. Exit 0 → reachable, exit 1 → not.
function hostReachable(host, port, timeoutMs) {
  const t = timeoutMs || 1500;
  const probe =
    `const net=require('net');` +
    `const s=net.connect({host:${JSON.stringify(host)},port:${port}},()=>{s.destroy();process.exit(0)});` +
    `s.on('error',()=>process.exit(1));` +
    `s.setTimeout(${t},()=>{s.destroy();process.exit(1)});`;
  const r = spawnSync(process.execPath, ['-e', probe]);
  return r.status === 0;
}

// The gateway's /health, as the stdio bridge (scripts/lib/mcp_myai_stdio.sh)
// probes it to pick gateway vs local MCP: MYAI_GATEWAY_MCP_URL, else
// localhost:${MCP_PORT:-3100}. Up = HTTP 200 within ~1 s.
function probeGatewayHealth() {
  const mcpUrl = process.env.MYAI_GATEWAY_MCP_URL || `http://localhost:${process.env.MCP_PORT || 3100}/mcp`;
  const url = mcpUrl.replace(/\/mcp$/, '') + '/health';
  const probe =
    `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(1000)})` +
    `.then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))`;
  const r = spawnSync(process.execPath, ['-e', probe]);
  return { up: r.status === 0, url: mcpUrl };
}

// Probe the local Ollama daemon (BRAIN B6): GET /api/tags on OLLAMA_BASE_URL
// (default 127.0.0.1:11434). Exit 0 + model count on stdout when it answers.
function probeOllamaDaemon() {
  let host = '127.0.0.1';
  let port = 11434;
  const raw = process.env.OLLAMA_BASE_URL;
  if (raw) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch { /* malformed URL — fall back to the default endpoint */ }
  }
  const probe =
    `const http=require('http');` +
    `const req=http.get({host:${JSON.stringify(host)},port:${port},path:'/api/tags',timeout:1500},res=>{` +
    `let b='';res.on('data',d=>b+=d);res.on('end',()=>{` +
    `try{const j=JSON.parse(b);console.log((j.models||[]).length);process.exit(0)}catch(e){process.exit(1)}})});` +
    `req.on('error',()=>process.exit(1));` +
    `req.on('timeout',()=>{req.destroy();process.exit(1)});`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  const models = r.status === 0 ? parseInt((r.stdout || '').trim(), 10) || 0 : 0;
  return { available: r.status === 0, models, host, port };
}

// Locate the brain repo (mirrors scripts/lib/brain.sh resolution order:
// $MYAI_BRAIN_DIR → $MYAI_HOME/brain.path pointer → $MYAI_HOME/brain) and
// report how fresh brain main is (age of the last commit).
// The per-user state dir, by the same rule as scripts/lib/brain.sh brain_home():
// MYAI_HOME, unless it points at a framework checkout (its old meaning) —
// then ~/.myai. Without this, a host exporting MYAI_HOME=<framework repo>
// had its brain looked up inside the repo.
function myaiStateHome() {
  const os = require('node:os');
  const h = process.env.MYAI_HOME;
  const isFramework = h && fs.existsSync(path.join(h, 'scripts', 'lib', 'brain.sh')) && fs.existsSync(path.join(h, 'runtime'));
  return h && !isFramework ? h : path.join(process.env.HOME || os.homedir(), '.myai');
}

// Brain repo integrity: HEAD resolves, objects connect, and how many atoms
// (markdown files) it holds. Read-only.
function brainIntegrity(dir) {
  const head = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) return { ok: false, detail: `${dir} — HEAD does not resolve (empty or damaged repo)` };
  const fsck = spawnSync('git', ['-C', dir, 'fsck', '--connectivity-only', '--no-progress'], { encoding: 'utf8', timeout: 60000 });
  const files = spawnSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const atoms = (files.stdout || '').split('\n').filter((f) => f.endsWith('.md')).length;
  const sha = (head.stdout || '').trim().slice(0, 8);
  if (fsck.status !== 0) {
    const why = ((fsck.stderr || fsck.stdout || '').trim().split('\n')[0] || `fsck exited ${fsck.status}`);
    return { ok: false, detail: `${dir} @ ${sha} — git fsck failed: ${why}` };
  }
  return { ok: true, detail: `${dir} @ ${sha} — ${atoms} atom(s), objects connected` };
}

// Pending config/brain migrations, via the same migrator `myai upgrade` runs.
function pendingMigrations(home, brainDir) {
  const migrator = path.join(SCRIPTS_DIR, 'lib', 'myai_migrate.py');
  if (!fs.existsSync(migrator)) return { status: 'unknown', detail: 'migrator not found in this install' };
  const r = spawnSync('python3', [migrator, '--home', home, '--brain', brainDir, '--check'], { encoding: 'utf8', timeout: 30000 });
  if (r.status === 0) return { status: 'ok', detail: 'config and brain layout are current' };
  if (r.status === 20) return { status: 'pending', detail: 'migrations pending — run `myai upgrade`' };
  return { status: 'unknown', detail: `could not check (migrator exited ${r.status ?? 'with an error'})` };
}

// Installed com.myai.* launchd jobs (macOS): loaded, and every script path in
// ProgramArguments still exists. Elsewhere → [].
function scheduledJobs() {
  if (process.platform !== 'darwin') return [];
  const agents = path.join(process.env.HOME || require('node:os').homedir(), 'Library', 'LaunchAgents');
  let names = [];
  try { names = fs.readdirSync(agents).filter((n) => /^com\.myai\..+\.plist$/.test(n)); } catch { return []; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return names.sort().map((n) => {
    const label = n.replace(/\.plist$/, '');
    const file = path.join(agents, n);
    const pa = spawnSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', file], { encoding: 'utf8' });
    let args = [];
    try { args = JSON.parse(pa.stdout || '[]'); } catch { /* unreadable → no path check */ }
    const missing = args.filter((a) => typeof a === 'string' && a.startsWith('/') && /\.(sh|py|cjs|js)$/.test(a) && !fs.existsSync(a));
    const loaded = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' }).status === 0;
    const problems = [];
    if (!loaded) problems.push('not loaded');
    if (missing.length) problems.push(`missing ${missing.join(', ')}`);
    return { label, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'loaded' };
  });
}

// Other agents' MCP configs written by `myai connect`: reported only when the
// agent's config file exists (the agent is installed).
function agentMcpEntries() {
  const home = process.env.HOME || require('node:os').homedir();
  const out = [];
  for (const [name, rel] of [['Cursor', '.cursor/mcp.json'], ['Windsurf', '.codeium/windsurf/mcp_config.json']]) {
    const file = path.join(home, rel);
    if (!fs.existsSync(file)) continue;
    let has = false;
    try { has = !!(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}).myai; } catch { /* invalid JSON → not connected */ }
    out.push({ name, has, file });
  }
  const codex = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(codex)) {
    let has = false;
    try { has = fs.readFileSync(codex, 'utf8').split('\n').some((l) => l.trim() === '[mcp_servers.myai]'); } catch { /* unreadable */ }
    out.push({ name: 'Codex', has, file: codex });
  }
  return out;
}

function brainFreshness() {
  const home = myaiStateHome();
  let dir = process.env.MYAI_BRAIN_DIR;
  if (!dir) {
    const ptr = path.join(home, 'brain.path');
    if (fs.existsSync(ptr)) {
      try {
        const p = fs.readFileSync(ptr, 'utf8').split('\n')[0].trim();
        if (p) dir = p;
      } catch { /* unreadable pointer — fall through to the default dir */ }
    }
  }
  if (!dir) dir = path.join(home, 'brain');
  if (!fs.existsSync(path.join(dir, '.git'))) return { exists: false, dir };
  const r = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%ct'], { encoding: 'utf8' });
  const epoch = r.status === 0 ? parseInt((r.stdout || '').trim(), 10) : NaN;
  if (!Number.isFinite(epoch)) return { exists: true, dir, ageDays: null };
  const ageDays = (Date.now() / 1000 - epoch) / 86400;
  return { exists: true, dir, ageDays };
}

// Mongo-mirror schedule status (OPS follow-up 2026-07-24): is the periodic
// Atlas→local mirror scheduled on this machine, and how did its last run go?
// scripts/setup_mongo_mirror_schedule.sh installs the job (launchd on macOS,
// tagged crontab line on Linux); every scripts/mongo_mirror.sh run records its
// outcome in $MYAI_HOME/mongo-mirror.last. MYAI_MIRROR_PLIST overrides the
// plist path (tests pin it so a host's real install can't leak in).
function mirrorScheduleStatus() {
  const os = require('node:os');
  const home = process.env.MYAI_HOME || path.join(os.homedir(), '.myai');
  let installed = false;
  let intervalSec = null;
  const plist = process.env.MYAI_MIRROR_PLIST
    || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.myai.mongo-mirror.plist');
  if (process.env.MYAI_MIRROR_PLIST || process.platform === 'darwin') {
    if (fs.existsSync(plist)) {
      installed = true;
      const m = fs.readFileSync(plist, 'utf8').match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
      if (m) intervalSec = parseInt(m[1], 10);
    }
  } else {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    installed = r.status === 0 && /mongo_mirror\.sh/.test(r.stdout || '');
  }
  let last = null;
  const lastFile = path.join(home, 'mongo-mirror.last');
  if (fs.existsSync(lastFile)) {
    try {
      const kv = {};
      for (const line of fs.readFileSync(lastFile, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
      }
      const epoch = parseInt(kv.epoch, 10);
      if (Number.isFinite(epoch)) last = { epoch, rc: parseInt(kv.rc, 10) || 0, db: kv.db || '' };
    } catch { /* unreadable record — treated as no run */ }
  }
  return { installed, intervalSec, last };
}

// Runner-backlog WELL health (task-618ccbe7): queue_topup.sh already
// auto-enqueues a PLANNER task when the backlog well runs low, but that only
// fires from inside a queue_topup.sh cycle — there was no operator-facing way
// to see well health otherwise. This mirrors queue_topup.sh's own counting
// exactly (TOTAL = non-blank/non-comment lines in the backlog file, CONSUMED
// = the cursor file's digits, REMAINING = TOTAL - CONSUMED) so the two can
// never drift apart. MYAI_RUNNER_BACKLOG / MYAI_RUNNER_BACKLOG_CURSOR override
// the paths — tests pin them so a host's real backlog file can't leak in
// (same discipline as MYAI_MIRROR_PLIST for the mirror check). The cursor
// defaults to a SIBLING of the resolved backlog (not a fixed repo path) so a
// test that overrides only the backlog can't accidentally read the host's real
// cursor — the two always resolve together. With the default backlog this is
// still config/.runner_backlog.cursor, so production behaviour is unchanged.
function runnerBacklogWellStatus(repoRoot) {
  const backlogPath = process.env.MYAI_RUNNER_BACKLOG || path.join(repoRoot, 'config', 'runner_backlog.jsonl');
  const cursorPath = process.env.MYAI_RUNNER_BACKLOG_CURSOR || path.join(path.dirname(backlogPath), '.runner_backlog.cursor');
  if (!fs.existsSync(backlogPath)) return { exists: false, backlogPath };
  const lines = fs.readFileSync(backlogPath, 'utf8').split('\n');
  const total = lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  let consumed = 0;
  if (fs.existsSync(cursorPath)) {
    const digits = fs.readFileSync(cursorPath, 'utf8').replace(/[^0-9]/g, '');
    consumed = digits ? parseInt(digits, 10) : 0;
  }
  const remaining = Math.max(total - consumed, 0);
  return { exists: true, total, consumed, remaining, backlogPath };
}

// SessionStart hook timing (OPS task-085b3748): every hooks/session/*.sh runs
// through hooks/hook_share/timing/timed_hook.sh, which appends
// `<boot_id> <start_ms> <dur_ms> <exit> <hook_basename>` per hook to a
// per-machine, gitignored log (state/.hook-timing.log.<host>). This reads the
// LAST recorded boot and returns its wall-clock (hooks run in parallel, so
// wall = latest finish - earliest start, not the sum) plus the slowest hooks,
// so `myai doctor` exposes where boot latency went. MYAI_HOOK_TIMING_LOG
// overrides the path (tests pin it so a host's real log can't leak in).
function sessionHookTimingStatus(repoRoot) {
  let logPath = process.env.MYAI_HOOK_TIMING_LOG || '';
  if (!logPath) {
    // Newest .hook-timing.log* in state/ or AI/state/ (cwd first, then the
    // install root) — dir scan instead of recomputing the hostname suffix.
    const stateDirs = [
      path.join(process.cwd(), 'state'),
      path.join(process.cwd(), 'AI', 'state'),
      path.join(repoRoot, 'state'),
      path.join(repoRoot, 'AI', 'state'),
    ];
    let newest = 0;
    for (const dir of stateDirs) {
      if (!fs.existsSync(dir)) continue;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith('.hook-timing.log')) continue;
        if (name.includes('.reported.') || name.includes('.tmp.')) continue;
        const f = path.join(dir, name);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (st.isFile() && st.mtimeMs > newest) { newest = st.mtimeMs; logPath = f; }
      }
    }
  }
  if (!logPath || !fs.existsSync(logPath)) return { exists: false };

  const rows = fs.readFileSync(logPath, 'utf8').split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 5 && /^[0-9]+$/.test(p[1]) && /^[0-9]+$/.test(p[2]));
  if (rows.length === 0) return { exists: false };

  const lastBootId = rows[rows.length - 1][0];
  const boot = rows.filter((p) => p[0] === lastBootId)
    // p[5] (out bytes) is optional — logs written before TOKEN task-2a431e9b
    // have only 5 fields, so default the byte count to 0.
    .map((p) => ({ start: Number(p[1]), dur: Number(p[2]), exit: p[3], name: p[4], bytes: Number(p[5] || 0) }));
  const minStart = Math.min(...boot.map((h) => h.start));
  const maxEnd = Math.max(...boot.map((h) => h.start + h.dur));
  const slowest = boot.slice().sort((a, b) => b.dur - a.dur).slice(0, 3);

  let budgetMs = 20000;
  const confCandidates = [
    path.join(process.cwd(), 'config', 'session-limits.json'),
    path.join(process.cwd(), 'AI', 'config', 'session-limits.json'),
    path.join(repoRoot, 'config', 'session-limits.json'),
  ];
  const conf = confCandidates.find((f) => fs.existsSync(f));
  if (conf) {
    try {
      const b = JSON.parse(fs.readFileSync(conf, 'utf8'))?.session_hooks?.budget_ms;
      if (Number.isFinite(b)) budgetMs = b;
    } catch { /* malformed config — keep the default budget */ }
  }

  return {
    exists: true,
    logPath,
    hooks: boot.length,
    wallMs: maxEnd - minStart,
    budgetMs,
    bootEpochMs: maxEnd,
    // Boot-cost KPI (TOKEN task-2a431e9b): bytes of visible hook stdout this
    // boot. scripts/boot_cost.sh adds CLAUDE.md for the full per-session total.
    hookOutBytes: boot.reduce((s, h) => s + (Number.isFinite(h.bytes) ? h.bytes : 0), 0),
    slowest,
    failures: boot.filter((h) => h.exit !== '0').map((h) => `${h.name} (exit ${h.exit})`),
  };
}

// ── Docker gate ──────────────────────────────────────────────────────────────
// scripts/lib/docker_gate.sh owns the WORDS (what Docker is, why myAI needs it,
// the exact per-OS step) so doctor, `myai setup` and `myai up` can never drift.
// A missing bash (native Windows) falls back to one generic line.
const DOCKER_GATE = path.join(SCRIPTS_DIR, 'lib', 'docker_gate.sh');
const DOCKER_FALLBACK_REMEDY = 'Install Docker: https://docs.docker.com/get-docker/';
function dockerGate(verb, state) {
  const r = spawnSync('bash', [DOCKER_GATE, verb, ...(state ? [state] : [])], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').replace(/\s+$/, '') || null;
}

// The next command after a setup that finished WITHOUT Docker re-offers the
// resume: still missing → a one-line reminder; now up → "run myai up".
const DOCKER_REMINDER_EXEMPT = new Set(['setup', 'doctor', 'up', 'completions', '__repos', 'root', 'config']);
function dockerPendingReminder(argv) {
  const first = (argv || []).slice(2)[0];
  if (!first || DOCKER_REMINDER_EXEMPT.has(first) || !COMMANDS.some((c) => c.name === first)) return false;
  if (process.env.MYAI_SKIP_DOCKER_GATE === '1') return false;
  const os = require('node:os');
  const home = process.env.MYAI_HOME || path.join(os.homedir(), '.myai');
  if (!fs.existsSync(path.join(home, 'docker-pending'))) return false;
  spawnSync('bash', [DOCKER_GATE, 'pending-check'], { stdio: 'inherit' });
  return true;
}

// Host ports the self-contained stack binds (docker-compose.yml).
const STACK_PORTS = [
  [3100, 'gateway HTTP/MCP'],
  [3200, 'gateway ws'],
  [3201, 'gateway aux'],
  [3210, 'dashboard'],
  [27200, 'mongo'],
];

function runDoctorChecks() {
  const checks = [];
  const check = recordInto(checks);
  let allOk = true;

  // ── runtime ────────────────────────────────────────────────────────────
  const nodeOk = process.versions.node.split('.')[0] >= 20;
  allOk &= check('node >= 20', nodeOk ? true : 'warn', `found v${process.versions.node}`);

  const docker = bin('docker');
  allOk &= check('docker on PATH', docker ? true : 'fail', docker || 'not found — install Docker');
  let dockerState = docker ? 'ok' : 'missing';

  // Engine must actually be RUNNING, not merely installed.
  if (docker) {
    const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
    const running = info.status === 0 && (info.stdout || '').trim();
    if (!running) dockerState = /permission denied/i.test(info.stderr || '') ? 'no-permission' : 'not-running';
    allOk &= check('docker engine running', running ? true : 'fail',
      running ? `server ${info.stdout.trim()}` : 'engine not reachable — start Docker');
  }

  const compose = bin('docker', ['compose', 'version']);
  if (dockerState === 'ok' && !compose) dockerState = 'no-compose';
  allOk &= check('docker compose', compose ? true : 'fail', compose || 'v2 plugin not found');

  // Every failing docker row carries the exact next step (--json consumers too).
  if (dockerState !== 'ok') {
    const remedy = dockerGate('remedy', dockerState) || DOCKER_FALLBACK_REMEDY;
    for (const c of checks) if (c.label.startsWith('docker') && c.status === 'fail') c.remedy = remedy;
  }

  const git = bin('git');
  allOk &= check('git on PATH', git ? true : 'warn', git || 'not found');

  // tmux backs `remote_fleet.sh start` (task-52b349fb): every master-doorway session
  // is a named tmux session so the claude process survives iTerm quitting.
  // Without tmux, `remote start` hard-fails outright — surface that here
  // instead of letting an operator discover it while reaching for their phone.
  const tmux = bin('tmux', ['-V']);
  check('tmux on PATH', tmux ? true : 'warn',
    tmux || 'not found — `remote_fleet.sh start` will hard-fail; install with `brew install tmux` (macOS) or your package manager');

  // ── credentials: claude CLI and/or ANTHROPIC_API_KEY ─────────────────────
  const claude = bin('claude', ['--version']);
  check('claude CLI', claude ? true : 'warn',
    claude || 'not found — needed for the off-hours runner (or use ANTHROPIC_API_KEY)');

  const keySrc = findAnthropicKey();
  const placeholderSrc = keySrc ? null : findAnthropicPlaceholder();
  // v1 is agent-agnostic (task-51235f67): the key only matters to a Claude
  // agent. Never a FAIL — the stack and MCP run without it. With a Claude agent
  // configured it is a WARN (the CLI login covers it when the CLI is there);
  // with no Claude agent at all it is not needed. A PLACEHOLDER key is always a
  // WARN: it was set on purpose but is not a key — a misconfiguration to name.
  const claudeConfigured = !!claude || claudeAgentConfigured();
  allOk &= check('ANTHROPIC_API_KEY', keySrc || (!placeholderSrc && !claudeConfigured) ? true : 'warn',
    keySrc ? `set (${keySrc})`
      : placeholderSrc ? `set to a placeholder value (${placeholderSrc}) — replace it with a real key, or remove the line`
        : !claudeConfigured ? 'not set — not needed: no Claude agent configured (the stack and MCP run without it)'
          : claude ? 'not set — Claude CLI login will be used instead'
            : 'not set and no Claude CLI — a Claude profile exists, but the Claude runner/api cannot authenticate');

  // ── GATEWAY_LOCAL_TOKEN: never the published default (SECURITY task-7f8b20a3) ──
  // The gateway itself now refuses this value under TENANT_ENFORCE=true
  // (config.ts loadConfig), so this isn't a hard blocker — but it's a fixable
  // finding worth surfacing since it's a publicly-known credential.
  const localToken = findGatewayLocalToken();
  if (localToken && localToken.value === KNOWN_DEFAULT_LOCAL_TOKEN) {
    check('GATEWAY_LOCAL_TOKEN', 'warn',
      `set to the published default ("${KNOWN_DEFAULT_LOCAL_TOKEN}", public in the npm package) via ${localToken.src} — run \`myai rotate-keys local\` to generate a private one`);
  } else if (!localToken) {
    check('GATEWAY_LOCAL_TOKEN', 'warn',
      'not set — fine for loopback-only use; `myai up` generates a random one into .env on first boot');
  } else {
    check('GATEWAY_LOCAL_TOKEN', true, `set (${localToken.src})`);
  }
  // The rotation-grace PREVIOUS slot must never carry the published default
  // either — `myai rotate-keys local` persists the old value there, so a
  // rotation away from the default used to leave the public credential live in
  // .env for the grace window. The gateway now refuses it at load (config.ts)
  // and rotateLocalToken grants it no grace; surface any stale .env entry so
  // the operator cleans it up. Silent when absent or a real (private) token.
  const prevToken = findGatewayLocalToken('GATEWAY_LOCAL_TOKEN_PREVIOUS');
  if (prevToken && prevToken.value === KNOWN_DEFAULT_LOCAL_TOKEN) {
    check('GATEWAY_LOCAL_TOKEN_PREVIOUS', 'warn',
      `rotation-grace slot holds the published default ("${KNOWN_DEFAULT_LOCAL_TOKEN}", public in the npm package) via ${prevToken.src} — the gateway refuses it under enforcement; remove GATEWAY_LOCAL_TOKEN_PREVIOUS and _PREVIOUS_EXPIRES_AT from .env`);
  }

  // ── offline / degraded mode (BRAIN B6) — all warn-only: offline is a
  //    SUPPORTED mode (Ollama auto-connect + brain degraded-read), so none of
  //    these gate the preflight. See documentation/BRAIN_OFFLINE.md.
  const cloudUp = hostReachable('api.anthropic.com', 443);
  check('cloud provider reachable', cloudUp ? true : 'warn',
    cloudUp ? 'api.anthropic.com:443'
      : 'unreachable — OFFLINE: the gateway auto-connects to local Ollama for inference');

  const ollama = probeOllamaDaemon();
  check('ollama available', ollama.available ? true : 'warn',
    ollama.available ? `${ollama.host}:${ollama.port} — ${ollama.models} model(s) installed`
      : `not running on ${ollama.host}:${ollama.port} — install/start Ollama for offline inference fallback`);

  if (!cloudUp && !ollama.available) {
    check('offline inference path', 'warn',
      'no cloud AND no Ollama — only degraded-read works (git pull brain → read compiled brief/working files)');
  }

  // Which MCP server an agent gets right now (v1 G2 B2): the stdio bridge
  // probes the same /health at spawn and falls back to the local brain server.
  const gw = probeGatewayHealth();
  check('MCP mode', gw.up ? true : 'warn',
    gw.up ? `gateway — full tool set (${gw.url})`
      : `offline — agents get the local brain server (brain + recall only); \`myai up\` and restart the agent for the full tool set`);

  const brain = brainFreshness();
  check('brain freshness', brain.exists ? (brain.ageDays !== null && brain.ageDays > 7 ? 'warn' : true) : 'warn',
    !brain.exists ? `no brain repo at ${brain.dir} — run \`myai brain init\` (degraded-read needs it)`
      : brain.ageDays === null ? `${brain.dir} — last-commit age unknown`
        : brain.ageDays > 7 ? `${brain.dir} — last commit ${Math.round(brain.ageDays)}d ago (stale; run \`wrap up\` / \`myai brain session merge\`)`
          : `${brain.dir} — last commit ${brain.ageDays < 1 ? 'today' : Math.round(brain.ageDays) + 'd ago'}`);

  if (brain.exists) {
    const integrity = brainIntegrity(brain.dir);
    allOk &= check('brain integrity', integrity.ok ? true : 'fail', integrity.detail);
  }
  const mig = pendingMigrations(myaiStateHome(), brain.dir);
  check('config migrations', mig.status === 'ok' ? true : 'warn', mig.detail);

  for (const job of scheduledJobs()) check(`scheduled job ${job.label}`, job.ok ? true : 'warn', job.detail);
  for (const a of agentMcpEntries()) {
    check(`${a.name} MCP`, a.has ? true : 'warn',
      a.has ? `connected (${a.file})` : `${a.file} has no myai entry — run \`myai connect ${a.name.toLowerCase()}\``);
  }
  // The repo you run doctor in: connected to myAI (has .myai-local)?
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status === 0) {
    const repo = (top.stdout || '').trim();
    const linked = fs.existsSync(path.join(repo, '.myai-local'));
    check('repo connected', linked ? true : 'warn', linked ? `${repo} (.myai-local present)` : `${repo} has no .myai-local`);
  }

  // ── mongo mirror schedule — warn-only: the periodic Atlas→local mirror is
  //    optional by design (never auto-installed, MONGO_MIRROR.md), but once
  //    installed it should be firing and succeeding.
  const mirror = mirrorScheduleStatus();
  const mirrorAgeMin = mirror.last ? Math.round((Date.now() / 1000 - mirror.last.epoch) / 60) : null;
  const mirrorAgo = mirrorAgeMin === null ? null
    : mirrorAgeMin < 120 ? `${mirrorAgeMin}m ago` : `${Math.round(mirrorAgeMin / 60)}h ago`;
  const mirrorCadence = mirror.intervalSec ? `every ${Math.round(mirror.intervalSec / 60)}m` : 'scheduled';
  // Stale = two missed fires (floor 2h); unknown interval (cron) → 26h.
  const mirrorStaleMin = mirror.intervalSec ? Math.max((mirror.intervalSec / 60) * 2, 120) : 26 * 60;
  if (!mirror.installed) {
    check('mongo mirror schedule', 'warn', mirror.last
      ? `not scheduled — last manual run ${mirror.last.rc === 0 ? 'ok' : `FAILED (rc=${mirror.last.rc})`} ${mirrorAgo} (install: myai mirror --install-schedule)`
      : 'not scheduled (optional) — install: myai mirror --install-schedule');
  } else if (!mirror.last) {
    check('mongo mirror schedule', 'warn', `${mirrorCadence} — installed but no run recorded yet`);
  } else if (mirror.last.rc !== 0) {
    check('mongo mirror schedule', 'warn',
      `${mirrorCadence} — last run FAILED (rc=${mirror.last.rc}, ${mirrorAgo}); see ~/.myai/logs/mongo-mirror.err`);
  } else if (mirrorAgeMin > mirrorStaleMin) {
    check('mongo mirror schedule', 'warn',
      `${mirrorCadence} — last success ${mirrorAgo} (STALE — the job may not be firing)`);
  } else {
    check('mongo mirror schedule', true, `${mirrorCadence} — last run ok ${mirrorAgo}`);
  }

  // ── swarm master (operator rule 2026-10-22): every device has exactly one,
  //    chosen at install. No config is a FAIL with its fix; a master that does
  //    not hold the lease or has no mail watcher is a warning here (doctor runs
  //    outside the master's session) — boot phase 9c is the strict gate.
  const swarm = swarmMasterStatus();
  check('swarm master', swarm.status === 'ok' ? true : swarm.status, swarm.detail);

  // ── runner-backlog WELL health — warn-only: queue_topup.sh already
  //    auto-enqueues a PLANNER task when this drops low, but only from inside
  //    its own cycle. Surface the same well health here so a human running
  //    `myai doctor` doesn't have to wait for the next topup fire to see it.
  const backlogMinEnv = parseInt(process.env.RUNNER_BACKLOG_MIN, 10);
  const backlogMin = Number.isFinite(backlogMinEnv) ? backlogMinEnv : 6; // matches queue_topup.sh default
  const well = runnerBacklogWellStatus(REPO_ROOT);
  if (!well.exists) {
    check('runner backlog well', 'warn', 'no config/runner_backlog.jsonl in this install (optional)');
  } else {
    const low = well.remaining < backlogMin;
    check('runner backlog well', low ? 'warn' : true,
      `${well.remaining} remaining / ${well.total} total (consumed ${well.consumed})`
      + (low ? ` — below RUNNER_BACKLOG_MIN (${backlogMin}); queue_topup.sh will enqueue a PLANNER task on its next cycle` : ''));
  }

  // ── session hook timing — warn-only: the boot latency budget
  //    (hooks/hook_share/timing/timed_hook.sh). Over-budget boots also print
  //    a slowest-3 line inline at session start; this exposes the last boot's
  //    breakdown on demand.
  const timing = sessionHookTimingStatus(REPO_ROOT);
  if (!timing.exists) {
    check('session hook timing', true,
      'no boot recorded yet — the timing log appears after the next Claude session start');
  } else {
    const ageMin = Math.round((Date.now() - timing.bootEpochMs) / 60000);
    const ago = ageMin < 120 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
    const slow = timing.slowest.map((h) => `${h.name} ${h.dur}ms`).join(', ');
    const over = timing.wallMs > timing.budgetMs;
    check('session hook timing', over ? 'warn' : true,
      `last boot (${ago}): ${timing.hooks} hooks, ${timing.wallMs}ms wall`
      + `${over ? ` — OVER budget (${timing.budgetMs}ms)` : ` (budget ${timing.budgetMs}ms)`}`
      + ` — slowest: ${slow}`
      + (timing.failures.length ? ` — failed: ${timing.failures.join(', ')}` : ''));
  }

  // ── packaged framework files ─────────────────────────────────────────────
  const scriptsOk = fs.existsSync(SCRIPTS_DIR) && fs.statSync(SCRIPTS_DIR).isDirectory();
  allOk &= check('scripts/ directory', scriptsOk ? true : 'fail',
    scriptsOk ? path.relative(process.cwd(), SCRIPTS_DIR) || '.' : 'missing');

  const composeFile = fs.existsSync(path.join(REPO_ROOT, 'docker-compose.yml'));
  allOk &= check('docker-compose.yml', composeFile ? true : 'warn',
    composeFile ? 'present' : 'not in package root');

  const mcp = fs.existsSync(path.join(REPO_ROOT, '.mcp.json'));
  check('.mcp.json', mcp ? true : 'warn', mcp ? 'present' : 'not present (optional)');

  // ── ports free (the stack can't bind a port already in use) ──────────────
  let owners = null;
  const ownPrefix = `${process.env.MYAI_PROJECT_NAME || 'myai'}-`;
  for (const [port, svc] of STACK_PORTS) {
    const used = portInUse(port);
    if (used && owners === null) owners = stackPortOwners();
    const owner = used ? owners.get(port) : undefined;
    if (owner && owner.startsWith(ownPrefix)) {
      check(`port ${port} free`, true, `in use by this stack (${owner}) — ${svc}`);
      continue;
    }
    // A busy port is a warning, not a fatal: it may be a prior `myai up` still
    // running. We flag it so the operator can stop the conflicting process.
    allOk &= check(`port ${port} free`, used ? 'warn' : true,
      used ? `IN USE${owner ? ` by ${owner}` : ''} — needed by ${svc} (stop the process or run \`myai down\`)` : `free (${svc})`);
  }

  return { checks, ok: !!allOk, dockerState };
}

// ── doctor --fix: idempotent auto-remediation ────────────────────────────────
// Remediates the SAFE, common doctor findings only. HARD INVARIANTS — never
// weaken:
//   • Secrets are never written. A missing env key is scaffolded ONLY when its
//     name is non-secret AND its .env.example value is a concrete default (no
//     placeholders) — so no credential is ever invented, copied, or overwritten.
//   • The shared gateway stack is never build/up/restart/down-ed. The gateway
//     remediation is `docker compose pull` — image DOWNLOAD only; running
//     containers stay untouched and a pulled image only takes effect on a later,
//     operator-run `up` (which this never performs).
//   • Dry-run is the DEFAULT. Nothing on disk or the host changes unless --fix
//     is passed; plain `doctor` and `doctor --dry-run` only inspect/preview.
//   • Every remediation is idempotent: re-running against an already-healed
//     state is a no-op that reports "nothing to do".

// A key is treated as a secret (never auto-written) when its NAME matches this.
// Deliberately broad — better to skip a benign URL than scaffold a credential.
const SECRET_KEY_RE = /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE|_KEY|APIKEY|_URI|_DSN|CONN(ECTION)?_?STR|DATABASE_URL|DSN)/i;

// A .env.example value that is empty or an obvious fill-me-in placeholder is not
// a safe default to copy — it usually marks a secret / operator-required field.
const PLACEHOLDER_VALUE_RE = /^(|your[_-].*|change[_-]?me|xxx+|<.*>|replace.*|todo|placeholder|example|\.\.\.|""|'')$/i;

// Parse KEY=VALUE lines (ignoring comments / blanks / `export ` prefix) into a
// Map preserving the raw right-hand side. Shared by detect + apply so the set of
// keys is computed identically on both sides.
function parseEnvKeys(text) {
  const map = new Map();
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function stripQuotes(v) {
  const t = String(v).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Read a launchd plist's StartInterval via plutil (macOS). Returns the integer
// seconds, or null when unreadable / plutil is absent.
function readPlistInterval(plist) {
  const r = spawnSync('plutil', ['-extract', 'StartInterval', 'raw', plist], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── individual remediations ──────────────────────────────────────────────────
// Each returns { id, label, needed, detail, apply? }. apply() returns
// { ok, detail, changed?, needsRestart? } and is only invoked with --fix.

// 1. Backfill missing NON-SECRET env keys from .env.example (pure fs).
function envKeysRemediation(cwd) {
  const envPath = path.join(cwd, '.env');
  const examplePath = path.join(cwd, '.env.example');
  const r = { id: 'env-keys', label: 'missing non-secret env keys' };
  if (!fs.existsSync(examplePath)) { r.needed = false; r.detail = 'no .env.example in project'; return r; }
  if (!fs.existsSync(envPath)) {
    r.needed = false;
    r.detail = 'no .env to backfill — copy .env.example first (never auto-created: it holds secrets)';
    return r;
  }
  const example = parseEnvKeys(fs.readFileSync(examplePath, 'utf8'));
  const env = parseEnvKeys(fs.readFileSync(envPath, 'utf8'));
  const additions = [];
  let skipped = 0;
  for (const [k, v] of example) {
    if (env.has(k)) continue;
    if (SECRET_KEY_RE.test(k) || PLACEHOLDER_VALUE_RE.test(stripQuotes(v))) { skipped += 1; continue; }
    additions.push([k, v]);
  }
  r.additions = additions;
  r.needed = additions.length > 0;
  const skipNote = skipped ? ` (${skipped} secret/placeholder key${skipped > 1 ? 's' : ''} left for you)` : '';
  r.detail = additions.length
    ? `add ${additions.map(([k]) => k).join(', ')}${skipNote}`
    : `up to date${skipNote}`;
  r.apply = () => {
    // Append only the keys computed missing at detect time. Idempotent: after
    // this runs they are present, so the next detect finds nothing to add.
    let block = '\n# --- added by `myai doctor --fix` (non-secret defaults from .env.example) ---\n';
    for (const [k, v] of additions) block += `${k}=${v}\n`;
    fs.appendFileSync(envPath, block);
    return { ok: true, changed: true, detail: `appended ${additions.length} key(s) to ${path.relative(cwd, envPath) || '.env'}` };
  };
  return r;
}

// 2. Redeploy the machine-local statusline from the packaged source (pure fs).
function statuslineRemediation(repoRoot, homeDir) {
  const src = path.join(repoRoot, 'scripts', 'org-statusline.sh');
  const dest = path.join(homeDir, '.claude-org-statusline.sh');
  const r = { id: 'statusline', label: 'statusline redeploy' };
  if (!fs.existsSync(src)) { r.needed = false; r.detail = 'no scripts/org-statusline.sh in this install'; return r; }
  let drift;
  if (!fs.existsSync(dest)) drift = 'not deployed';
  else drift = fs.readFileSync(src).equals(fs.readFileSync(dest)) ? '' : 'stale (differs from packaged source)';
  r.needed = !!drift;
  r.detail = drift ? `${drift} → redeploy ${dest}` : `up to date (${dest})`;
  r.apply = () => {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    return { ok: true, changed: true, detail: `redeployed ${dest}` };
  };
  return r;
}

// 3. Correct a legacy hour+ launchd runner cadence back to the 10-min default.
//    macOS-only; NEVER installs the runner and leaves deliberate sub-hour
//    intervals alone (mirrors scripts/machine_selfheal.sh §2).
function runnerCadenceRemediation(homeDir, platform) {
  const DESIRED = 600; // 10 min — matches setup_cli_runner_schedule.sh default
  const plist = path.join(homeDir, 'Library', 'LaunchAgents', 'com.myai.cli-task-runner.plist');
  const r = { id: 'runner-cadence', label: 'runner cadence drift' };
  if (platform !== 'darwin') { r.needed = false; r.detail = 'launchd runner is macOS-only'; return r; }
  if (!fs.existsSync(plist)) { r.needed = false; r.detail = 'no launchd runner on this Mac (opt-in per machine)'; return r; }
  const cur = readPlistInterval(plist);
  if (cur == null) { r.needed = false; r.detail = 'runner interval unreadable (plutil missing?)'; return r; }
  if (cur < 3600) { r.needed = false; r.detail = `interval ${cur}s (<1h — deliberate cadence left alone)`; return r; }
  r.needed = true;
  r.detail = `legacy interval ${cur}s → ${DESIRED}s (bump + reload)`;
  r.apply = () => {
    const set = spawnSync('plutil', ['-replace', 'StartInterval', '-integer', String(DESIRED), plist]);
    if (set.status !== 0) return { ok: false, detail: 'plutil replace failed' };
    // Reload so launchd picks up the new interval. Unload may report an error
    // if not currently loaded — that is fine, the load is what matters.
    spawnSync('launchctl', ['unload', plist]);
    const load = spawnSync('launchctl', ['load', plist]);
    return { ok: load.status === 0, changed: true, detail: `runner cadence set to ${DESIRED}s and reloaded` };
  };
  return r;
}

// 4. Pull the latest gateway image (download only — running containers untouched,
//    so the SHARED STACK is never build/up/restart/down-ed). A pulled image only
//    takes effect on a later operator-run `up`, which this never performs.
function gatewayImageRemediation(cwd) {
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    .map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
  const r = { id: 'gateway-image', label: 'stale gateway image' };
  if (!compose) { r.needed = false; r.detail = 'no compose file in project'; return r; }
  if (!bin('docker')) { r.needed = false; r.detail = 'docker not on PATH'; return r; }
  const hasGateway = /^\s{2,}gateway\s*:/m.test(fs.readFileSync(compose, 'utf8'));
  const service = hasGateway ? 'gateway' : null;
  r.needed = true; // `pull` is idempotent (no-op when current); apply reports what actually changed.
  r.detail = `docker compose pull${service ? ' ' + service : ''} — image download only, running containers untouched`;
  r.apply = () => {
    const args = ['compose', 'pull', ...(service ? [service] : [])];
    const res = spawnSync('docker', args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) return { ok: false, detail: `docker ${args.join(' ')} failed` };
    const out = (res.stdout || '') + (res.stderr || '');
    // "Up to date" wins unless there is a concrete download signal — so a pull
    // that only re-confirms existing layers reads as the no-op it is.
    const upToDate = /up to date/i.test(out) && !/downloaded newer image|downloading|extracting/i.test(out);
    const changed = !upToDate;
    return changed
      ? { ok: true, changed: true, needsRestart: true, detail: 'pulled newer gateway image — apply it with `docker compose up -d gateway` from the master checkout' }
      : { ok: true, changed: false, detail: 'gateway image already current (no-op)' };
  };
  return r;
}

function computeRemediations(ctx) {
  const c = ctx || {};
  const cwd = c.cwd || process.cwd();
  const repoRoot = c.repoRoot || REPO_ROOT;
  const home = c.home || require('node:os').homedir();
  const platform = c.platform || process.platform;
  return [
    envKeysRemediation(cwd),
    statuslineRemediation(repoRoot, home),
    runnerCadenceRemediation(home, platform),
    gatewayImageRemediation(cwd),
  ];
}

// Run (or preview) the remediations. `apply` false → dry-run: needed items are
// reported but never executed. Returns one flat result record per remediation so
// the human and --json paths render from the same data (no drift), matching the
// checks contract.
function runRemediations(opts) {
  const apply = !!(opts && opts.apply);
  const rems = computeRemediations(opts);
  return rems.map((rem) => {
    const entry = { id: rem.id, label: rem.label, needed: !!rem.needed, detail: rem.detail || '', applied: false };
    if (rem.needed && apply && typeof rem.apply === 'function') {
      try {
        const res = rem.apply() || {};
        entry.applied = !!res.ok;
        entry.result = res.detail || (res.ok ? 'applied' : 'failed');
        if (res.needsRestart) entry.needsRestart = true;
      } catch (e) {
        entry.applied = false;
        entry.result = `error: ${e.message}`;
      }
    }
    return entry;
  });
}

function doctor(extraArgs) {
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const asJson = args.includes('--json');
  // Dry-run is the safe default: only --fix (without --dry-run) actually applies.
  const wantRemediation = args.includes('--fix') || args.includes('--dry-run');
  const apply = args.includes('--fix') && !args.includes('--dry-run');
  const result = runDoctorChecks();
  const remediations = wantRemediation ? runRemediations({ apply }) : null;
  // A fix run is only "ok" when every NEEDED remediation applied cleanly.
  const fixOk = !apply || remediations.every((r) => !r.needed || r.applied);

  if (asJson) {
    const payload = { checks: result.checks, ok: result.ok };
    if (remediations) { payload.remediations = remediations; payload.fixOk = fixOk; }
    console.log(JSON.stringify(payload, null, 2));
    return result.ok && fixOk;
  }

  console.log(`myai doctor — preflight checks (v${PKG.version})\n`);
  for (const c of result.checks) {
    const mark = c.status === 'ok' ? 'OK  ' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${mark}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    if (c.status !== 'ok' && c.why) {
      console.log(`         why: ${c.why}`);
      console.log(`         fix: ${c.fix}`);
    }
  }
  if (result.dockerState && result.dockerState !== 'ok') {
    console.log(dockerGate('explain', result.dockerState)
      || `\n  DOCKER REQUIRED — myAI's gateway, Mongo RAG, brain sync, runner and local CI all run in Docker.\n  ${DOCKER_FALLBACK_REMEDY}`);
  }
  console.log(`\n${result.ok ? 'Preflight passed (warnings are non-fatal).' : 'Preflight found blocking issues — fix the FAIL lines before `myai up`.'}`);

  if (remediations) {
    console.log(`\nRemediations (${apply ? 'applying --fix' : 'dry-run — pass --fix to apply'}):`);
    for (const rem of remediations) {
      if (!rem.needed) {
        console.log(`  [SKIP ] ${rem.label} — ${rem.detail}`);
      } else if (!apply) {
        console.log(`  [WOULD] ${rem.label} — ${rem.detail}`);
      } else {
        console.log(`  [${rem.applied ? 'FIXED' : 'FAIL '}] ${rem.label} — ${rem.result || rem.detail}`);
      }
    }
    const pending = remediations.filter((r) => r.needed);
    if (!apply) {
      console.log(pending.length
        ? `\n${pending.length} fixable finding(s) — run \`myai doctor --fix\` to apply.`
        : '\nNothing to remediate — everything is already in order.');
    } else {
      const restart = remediations.some((r) => r.needsRestart);
      console.log(`\n${fixOk ? 'Remediation complete' : 'Remediation finished with errors — see FAIL lines above'}${restart ? '; a gateway `up -d` (from the master checkout) is needed to apply the new image.' : '.'}`);
    }
  }

  return result.ok && fixOk;
}

// ── root: framework-as-module resolver (plan S-INIT-5, ADR-016 §0.5) ─────────
// A kernel-only repo carries no per-repo AI/ copy — its agents, skills, hooks,
// and rule bodies resolve at runtime from the globally-installed
// ai-management module. This prints that module's absolute path.
//
// REPO_ROOT is `path.resolve(__dirname, '..')` — the dir this file (bin/myai.cjs)
// lives under, i.e. the installed package root by construction — so no npm lookup
// is needed. We still VALIDATE it carries the framework markers and fail loud
// (exit 1, guidance on stderr) if any are missing, so a broken/partial install
// can never silently run a kernel-only repo WITHOUT its safety hooks.
const MODULE_MARKERS = ['hooks/pre-tool', 'skills', 'templates/CLAUDE_KERNEL.md'];

function moduleRoot() {
  const missing = MODULE_MARKERS.filter((m) => !fs.existsSync(path.join(REPO_ROOT, m)));
  return { dir: REPO_ROOT, ok: missing.length === 0, missing };
}

function root(extraArgs) {
  const asJson = Array.isArray(extraArgs) && extraArgs.includes('--json');
  const res = moduleRoot();

  if (asJson) {
    console.log(JSON.stringify({ root: res.dir, ok: res.ok, missing: res.missing }, null, 2));
    return res.ok;
  }

  if (!res.ok) {
    console.error(`myai root: '${res.dir}' is not a valid ai-management install`);
    console.error(`  missing framework markers: ${res.missing.join(', ')}`);
    console.error('  reinstall with:  npm i -g ai-management');
    return false;
  }

  // Plain path on stdout — consumable by `"$(myai root)/hooks/..."` in a
  // kernel repo's .claude/settings.json (templates/settings.kernel.json).
  console.log(res.dir);
  return true;
}

// ── completions: bash/zsh/fish shell-completion generator ────────────────────
// Everything below reads command names + descriptions straight off COMMANDS
// (the same table `--help` and dispatch() use), so a new/renamed/removed
// command is picked up automatically — nothing here needs to be hand-maintained
// in step with the registry. runtime/tests/unit/cli-dispatch.test.ts asserts
// every COMMANDS name appears in each generated script, which is what actually
// keeps this in sync (a command added to the table without a matching entry
// here would still show up — this only guards against the table changing shape
// out from under a hardcoded string list, which doesn't exist).

const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'];

// Trim a (possibly long, backtick/em-dash-heavy) COMMANDS desc down to a single
// short clause suitable for a completion menu line.
function completionShortDesc(desc) {
  const clause = String(desc || '').split(/ — | \(|\. /)[0];
  return clause.replace(/[`]/g, '').replace(/\s+/g, ' ').trim();
}

// POSIX single-quote escaping (bash/zsh): close the quote, insert an escaped
// quote, reopen — the standard '\'' trick, since single quotes don't support
// backslash escapes inside themselves.
function posixSingleQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// fish single-quote escaping: fish DOES support backslash escapes inside single
// quotes, so this is the simpler \\ / \' form (not the POSIX close-reopen trick).
function fishSingleQuote(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Read config/managed_repos.txt (the fleet roster) and return sorted, deduped
// basenames — used for dynamic `--repo <TAB>` completion. Absent file (a repo
// checked out without the master's fleet config) → empty list, not an error.
function reposList() {
  const file = path.join(REPO_ROOT, 'config', 'managed_repos.txt');
  if (!fs.existsSync(file)) return [];
  const names = new Set();
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const name = path.basename(line.replace(/\/+$/, ''));
    if (name) names.add(name);
  }
  return [...names].sort();
}

function printRepos() {
  for (const name of reposList()) console.log(name);
  return true;
}

// ── `myai repos` — ADR-021 Phase 3 fleet-roster resolver shim ───────────────
// Gateway DB roster preferred (GET /api/repos/paths, tenant `repos` collection
// ∪ txt seed resolved server-side); config/managed_repos.txt is only the
// bootstrap-seed fallback. Same dependency-free node-child HTTP pattern as
// probeOllamaDaemon so the CLI stays synchronous.
function reposPathsFromGateway() {
  const token = findGatewayLocalToken();
  let u;
  try { u = new URL(process.env.GATEWAY_BASE || 'http://localhost:3100'); } catch { return null; }
  const probe =
    `const http=require('http');` +
    `const req=http.get({host:${JSON.stringify(u.hostname)},port:${Number(u.port) || 80},path:'/api/repos/paths',timeout:4000,` +
    `headers:{'x-gateway-local-token':${JSON.stringify(token ? token.value : '')}}},res=>{` +
    `if(res.statusCode!==200){res.resume();process.exit(1)}` +
    `let b='';res.on('data',d=>b+=d);res.on('end',()=>process.stdout.write(b))});` +
    `req.on('error',()=>process.exit(1));` +
    `req.on('timeout',()=>{req.destroy();process.exit(1)});`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const j = JSON.parse(r.stdout);
    return Array.isArray(j.repos) && j.repos.length > 0 ? j.repos : null;
  } catch { return null; }
}

// managed_repos.txt → [{name, path, source:'seed'}] with raw (possibly ~-rooted) paths.
function reposSeedEntries() {
  const file = path.join(REPO_ROOT, 'config', 'managed_repos.txt');
  if (!fs.existsSync(file)) return [];
  const seen = new Set();
  const entries = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const name = path.basename(line.replace(/\/+$/, ''));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, path: line, source: 'seed' });
  }
  return entries;
}

function reposCommand(extraArgs) {
  const args = extraArgs || [];
  const os = require('node:os');
  const expand = (p) => String(p || '').replace(/^~\//, os.homedir() + '/');
  let entries = process.env.MYAI_REPOS_NO_GATEWAY === '1' ? null : reposPathsFromGateway();
  const source = entries ? 'gateway' : 'seed-file';
  if (!entries) entries = reposSeedEntries();
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      source,
      count: entries.length,
      repos: entries.map((r) => ({ name: r.name, path: expand(r.path), source: r.source })),
    }, null, 2));
  } else if (args.includes('--paths')) {
    for (const r of entries) if (r.path) console.log(expand(r.path));
  } else {
    for (const r of entries) console.log(r.name);
  }
  return true;
}

function generateBashCompletion() {
  const words = COMMANDS.filter((c) => !c.hidden).map((c) => c.name).concat(['-h', '--help', '-v', '--version']).join(' ');
  return `#!/usr/bin/env bash
# myai bash completion — generated by \`myai completions bash\` from the command
# table in bin/myai.cjs. Re-run after upgrading myai to pick up new commands.
#
# Install (pick one):
#   myai completions bash | sudo tee /usr/local/etc/bash_completion.d/myai >/dev/null   # Homebrew bash-completion@2 (macOS)
#   myai completions bash > "\${BASH_COMPLETION_USER_DIR:-$HOME/.local/share/bash-completion}/completions/myai"  # user-local
#   echo 'source <(myai completions bash)' >> ~/.bashrc                                 # load on every new shell
#
# Requires the \`bash-completion\` package for _init_completion; falls back to a
# minimal parse of COMP_WORDS if it isn't loaded.
_myai_completions() {
  local cur prev
  if declare -F _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  fi

  case "\$prev" in
    --repo)
      COMPREPLY=( \$(compgen -W "\$(myai __repos 2>/dev/null)" -- "\$cur") )
      return 0
      ;;
  esac

  if [[ \$COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "${words}" -- "\$cur") )
    return 0
  fi

  COMPREPLY=( \$(compgen -f -- "\$cur") )
}
complete -F _myai_completions myai
complete -F _myai_completions ai-manage
`;
}

function generateZshCompletion() {
  const entries = COMMANDS
    .filter((c) => !c.hidden)
    .map((c) => `    ${posixSingleQuote(`${c.name}:${completionShortDesc(c.desc)}`)}`)
    .join('\n');
  return `#compdef myai ai-manage
# myai zsh completion — generated by \`myai completions zsh\` from the command
# table in bin/myai.cjs. Re-run after upgrading myai to pick up new commands.
#
# Install:
#   mkdir -p ~/.zsh/completions && myai completions zsh > ~/.zsh/completions/_myai
#   # in ~/.zshrc, BEFORE compinit:  fpath=(~/.zsh/completions $fpath)
#   # then open a new shell (or: autoload -U compinit && compinit)
_myai() {
  local -a commands
  commands=(
${entries}
  )

  if (( CURRENT == 2 )); then
    _describe 'myai command' commands
    return
  fi

  if [[ "\${words[CURRENT-1]}" == "--repo" ]]; then
    local -a repos
    repos=(\${(f)"\$(myai __repos 2>/dev/null)"})
    _describe 'repo' repos
    return
  fi

  _files
}
_myai "\$@"
`;
}

function generateFishCompletion() {
  const lines = COMMANDS
    .filter((c) => !c.hidden)
    .map((c) => `complete -c myai -f -n '__fish_use_subcommand' -a ${fishSingleQuote(c.name)} -d ${fishSingleQuote(completionShortDesc(c.desc))}`)
    .join('\n');
  return `# myai fish completion — generated by \`myai completions fish\` from the command
# table in bin/myai.cjs. Re-run after upgrading myai to pick up new commands.
#
# Install:
#   myai completions fish > ~/.config/fish/completions/myai.fish
# (fish auto-loads completions/*.fish from that directory in every new shell)
complete -c myai -f
${lines}
complete -c myai -l help -s h -d 'Show help'
complete -c myai -l version -s v -d 'Print version'
complete -c myai -l repo -d 'Repo name' -a '(myai __repos 2>/dev/null)'
`;
}

function completions(extraArgs) {
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const shell = args.find((a) => !a.startsWith('-'));
  if (!shell) {
    console.error('myai completions: missing shell argument.');
    console.error(`Usage: myai completions <${COMPLETION_SHELLS.join('|')}>`);
    return false;
  }
  if (!COMPLETION_SHELLS.includes(shell)) {
    console.error(`myai completions: unknown shell '${shell}'.`);
    console.error(`Supported shells: ${COMPLETION_SHELLS.join(', ')}`);
    return false;
  }
  const script = shell === 'bash' ? generateBashCompletion()
    : shell === 'zsh' ? generateZshCompletion()
    : generateFishCompletion();
  console.log(script);
  return true;
}

// ── commander path (used when the dep is installed) ──────────────────────────
function runWithCommander(Command) {
  const program = new Command();
  program
    .name('myai')
    .description('CLI for the AI Management Framework')
    .version(PKG.version, '-v, --version');

  for (const c of COMMANDS) {
    const sub = program
      .command(c.args ? `${c.name} ${c.args}` : c.name, c.hidden ? { hidden: true } : undefined)
      .description(c.desc)
      .allowUnknownOption(true)
      .helpOption(false);
    sub.action((...callArgs) => {
      // commander passes (…declaredArgs, optsObject, commandObject)
      const command = callArgs[callArgs.length - 1];
      const extra = command.args || [];
      process.exit(dispatch(c, extra));
    });
  }
  program.parse(process.argv);
}

// ── fallback path (zero-dependency) ──────────────────────────────────────────
function printHelp() {
  console.log(`myai — CLI for the AI Management Framework (v${PKG.version})\n`);
  console.log('Usage: myai <command> [args...]\n');
  console.log('Commands:');
  const visible = COMMANDS.filter((c) => !c.hidden);
  const width = Math.max(...visible.map((c) => (c.name + ' ' + c.args).length));
  for (const c of visible) {
    const sig = `${c.name} ${c.args}`.trim();
    console.log(`  ${sig.padEnd(width + 2)}${c.desc}`);
  }
  console.log('\nOptions:');
  console.log('  -v, --version   Print version');
  console.log('  -h, --help      Show this help');
  console.log('\nEach command shells into the repo\'s scripts/*.sh or docker compose.');
}

// A subcommand's `-h`/`--help` MUST print usage and exit WITHOUT running its
// script. Commands are thin script passthroughs (commander path: allowUnknownOption
// + helpOption(false); fallback: raw forwarding), so an un-intercepted `--help`
// falls straight through to the script and RUNS it — e.g. `myai init --help`
// scaffolds a repo AND self-registers it in the fleet roster + seeds a task.
// Intercepted in main() so BOTH parser paths are covered. Only -h/--help is
// caught — every other unknown flag is still forwarded to the script
// (--greenfield, --managed, --force, --gh-create, … are real script flags).
function helpRequestedFor(args) {
  if (!Array.isArray(args) || args.length < 2) return null;
  const c = COMMANDS.find((x) => x.name === args[0]);
  if (!c) return null;
  return args.slice(1).some((a) => a === '-h' || a === '--help') ? c : null;
}

function printCommandHelp(c) {
  const sig = `${c.name}${c.args ? ' ' + c.args : ''}`;
  console.log(`myai ${sig}\n`);
  console.log(`  ${c.desc}\n`);
  console.log(`Usage: myai ${sig} [options...]`);
  console.log('Flags after the command are forwarded to the underlying script.');
}

function runFallback(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    printHelp();
    process.exit(0);
  }
  if (args[0] === '-v' || args[0] === '--version') {
    console.log(PKG.version);
    process.exit(0);
  }
  const cmd = COMMANDS.find((c) => c.name === args[0]);
  if (!cmd) {
    console.error(`myai: unknown command '${args[0]}'. Run 'myai --help'.`);
    process.exit(1);
  }
  process.exit(dispatch(cmd, args.slice(1)));
}

// ── first-run setup auto-trigger (PRODUCT_UX_NORTHSTAR.md §"Workflow 1") ──────
// Any STATEFUL command auto-triggers `myai setup` when ~/.myai/config is
// missing. Exempt: `setup` itself (avoid recursion), `doctor`/`root` (pure
// diagnostics, no brain access), any unknown command (let it fail normally),
// and -v/--help at any level (checked separately, before this ever runs) —
// those must never block. Lives in main() only (never dispatch()/runFallback()
// directly) so the existing dispatch-level unit tests, which assert exact
// spawnSync call counts/args, are untouched.
// `config` is exempt too: it is the tool that CREATES/edits ~/.myai/config, so
// auto-triggering the interactive setup wizard on its absence would both block
// scripted `config set` runs and gate the front-end on the very file it manages.
const SETUP_EXEMPT_COMMANDS = new Set(['setup', 'doctor', 'root', 'completions', 'repos', '__repos', 'config']);

function needsAutoSetup(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return false; // bare invocation → prints help, not stateful
  const first = args[0];
  if (first === '-h' || first === '--help' || first === 'help') return false;
  if (first === '-v' || first === '--version') return false;
  if (SETUP_EXEMPT_COMMANDS.has(first)) return false;
  if (!COMMANDS.some((c) => c.name === first)) return false;
  if (process.env.MYAI_SKIP_SETUP === '1') return false;
  const os = require('node:os');
  const home = process.env.MYAI_HOME || path.join(os.homedir(), '.myai');
  return !fs.existsSync(path.join(home, 'config'));
}

function autoRunSetup(argv) {
  const setupScript = path.join(SCRIPTS_DIR, 'myai_setup.sh');
  if (!fs.existsSync(setupScript)) return;
  console.log('myai: no ~/.myai/config found — running first-run setup (myai setup)…');
  // MYAI_SETUP_PARENT: the setup's Docker gate must not start the stack itself
  // when the command that triggered it is `myai up` (that would run it twice).
  const parent = ((argv || process.argv).slice(2)[0]) || '';
  spawnSync('bash', [setupScript], {
    stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, MYAI_SETUP_PARENT: parent },
  });
}

// ── entrypoint ────────────────────────────────────────────────────────────────
function main() {
  // Intercept a subcommand's -h/--help BEFORE either parser — otherwise it
  // falls through to the passthrough script and RUNS it (see helpRequestedFor).
  const helpCmd = helpRequestedFor(process.argv.slice(2));
  if (helpCmd) {
    printCommandHelp(helpCmd);
    process.exit(0);
  }
  if (needsAutoSetup(process.argv)) autoRunSetup(process.argv);
  else dockerPendingReminder(process.argv);
  let Command = null;
  try {
    ({ Command } = require('commander'));
  } catch {
    /* commander not installed — use the built-in fallback parser */
  }
  if (Command) runWithCommander(Command);
  else runFallback(process.argv);
}

// Exported for the unit suite (runtime/tests/unit/cli-dispatch.test.ts). As a
// bin, require.main === module and main() runs exactly as before.
module.exports = {
  DOCTOR_EXPLAIN,
  explainFor,
  myaiStateHome,
  COMMANDS,
  STACK_PORTS,
  resolvePathArg,
  dispatch,
  runScript,
  runDocker,
  doctor,
  runDoctorChecks,
  computeRemediations,
  runRemediations,
  envKeysRemediation,
  statuslineRemediation,
  runnerCadenceRemediation,
  gatewayImageRemediation,
  parseEnvKeys,
  parseDockerPorts,
  helpRequestedFor,
  printCommandHelp,
  SECRET_KEY_RE,
  PLACEHOLDER_VALUE_RE,
  moduleRoot,
  root,
  MODULE_MARKERS,
  COMPLETION_SHELLS,
  completions,
  generateBashCompletion,
  generateZshCompletion,
  generateFishCompletion,
  reposList,
  printRepos,
  reposCommand,
  reposSeedEntries,
  reposPathsFromGateway,
  findAnthropicKey,
  findAnthropicPlaceholder,
  isPlaceholderKey,
  portInUse,
  hostReachable,
  probeOllamaDaemon,
  brainFreshness,
  mirrorScheduleStatus,
  runnerBacklogWellStatus,
  sessionHookTimingStatus,
  printHelp,
  runFallback,
  needsAutoSetup,
  autoRunSetup,
  dockerGate,
  dockerPendingReminder,
  main,
};

if (require.main === module) main();
