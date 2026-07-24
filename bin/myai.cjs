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
  { name: 'init', args: '[path]', script: 'myai_init.sh',
    desc: 'Greenfield by default: drop a ~30-line kernel CLAUDE.md + gitignored .myai-local (no AI/ folder) — framework resolves from the installed module. --managed forces the legacy AI/-scaffold (portable docker-compose + .env + guided wizard); --force replaces a non-kernel CLAUDE.md; --zero-prompt (or env MYAI_ZERO_PROMPT=1) guarantees a scripted/headless run never blocks on stdin, regardless of TTY state' },
  { name: 'up', args: '[args...]', script: 'myai_up.sh',
    desc: 'Start the self-contained stack (gateway + dashboard + mongo) on localhost, wait for health, print the dashboard URL' },
  { name: 'down', args: '[args...]', script: 'myai_down.sh',
    desc: 'Stop the stack cleanly (--volumes also drops the mongo data volume)' },
  { name: 'status', args: '[args...]', script: 'myai_status.sh',
    desc: 'Gateway/runner/queue health at a glance: gateway/dashboard HTTP health, docker compose ps, task-queue counts, continuity meter, and the local off-hours runner\'s installed/active state (--json for scripts; exit 0 = healthy)' },
  { name: 'boot', args: '[args...]', script: 'myai_boot.sh',
    desc: 'TOKEN-FREE session boot — the deterministic spine of `agent mode -min` with zero LLM cost: git sync (ff-only pull), brain delta since last boot (pure git), schedule banner, remote-control status. Run BEFORE opening Claude. --no-fetch | --no-pull | --quiet' },
  { name: 'logs', args: '[service...]', script: 'myai_logs.sh',
    desc: 'Live-tail stack logs — wraps `docker compose logs -f` (optionally one service: gateway | dashboard | mongo; --no-follow, --tail N); --runner also tails the local off-hours CLI runner\'s latest job log alongside it, prefixed [runner]' },
  { name: 'queue', args: '[args...]', script: 'myai_queue.sh',
    desc: 'Inspect and control the runner task queue — the CLI mirror of the dashboard /work orchestration view. `queue` / `queue list` [--repo][--status][--priority][--all][--json]; `queue cancel <taskId>` [--reason][--force] marks it blocked (reversible); `queue reprioritize <taskId> <P0|P1|P2|P3>` changes its priority' },
  { name: 'scan', args: '[path]', script: 'myai_scan.sh',
    desc: 'Spider git repos under a dir → register each in the gateway directory + seed RAG awareness (--register also lists in managed_repos.txt; --dry-run previews)' },
  { name: 'demo', args: '[args...]', script: 'myai_demo.sh',
    desc: 'Seed the dashboard with realistic sample data — tasks, schedules, plan, repo cards, memory, budget rows (idempotent; --clean removes, --force re-seeds)' },
  { name: 'new-app', args: '[path]', script: 'init_blueprint.sh',
    desc: 'Scaffold a new full-stack app from the powerhouse blueprint' },
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
    desc: 'Authenticate this terminal against a hosted myAI gateway — validates a per-tenant API key via GET /api/auth/whoami and persists it (`--key <apiKey>` or $MYAI_API_KEY or an interactive hidden prompt; `--gateway-url URL`; `--json`). End-user session identity — distinct from `myai config` (raw key setting, no validation) and tenant-key rotation (operator CRUD)' },
  { name: 'whoami', args: '[args...]', script: 'myai_whoami.sh',
    desc: 'Print the active org/tenant/plan/quota for the session `myai login` established — always round-trips to the gateway for live quota (`--gateway-url URL` override; `--json`)' },
  { name: 'mcp', args: '[args...]', script: 'myai_mcp.sh',
    desc: 'Propagate the MCP server config through the installed module (not update_all): `mcp repo [path]` writes/refreshes a repo .mcp.json from the bundled template (deep-merge — framework servers canonical, custom preserved); `mcp sync [museum|tech|personal|all]` refreshes the per-org Claude config dirs from the template; `mcp print` shows the base config. --dry-run supported' },
  { name: 'mirror', args: '[args...]', script: 'mongo_mirror.sh',
    desc: 'Keep a LOCAL copy of the gateway memory + registry so localhost is not single-point-of-failure on Atlas. Streams mongodump→mongorestore (Atlas → local by default) in a throwaway mongo:7 container — no host mongo tools. --dry-run previews; --collections a,b scopes; --reverse (local → Atlas) is guarded behind --yes' },
  { name: 'rotate-keys', args: '<local|tenant> [args...]', script: 'myai_rotate_keys.sh',
    desc: 'Self-rotate a gateway credential with a dual-valid grace window (zero-downtime): `rotate-keys local [--grace-minutes N]` rewrites GATEWAY_LOCAL_TOKEN in .env, keeping the old value valid for the grace window; `rotate-keys tenant <tenantId> [--grace-minutes N] [--env live|test]` mints a new tenant bootstrap API key via the gateway (local-trust only), old key stays valid server-side until grace elapses — new key is shown ONCE' },
  { name: 'runner', args: '[args...]', script: 'myai_runner.sh',
    desc: 'Manage the local off-hours CLI runner schedule (launchd/systemd) — install [--every-minutes N|--every-hours N] | uninstall | start | stop | status (+ next-fire) | logs [-f] [-n N]. Distinct from `myai status`/`myai logs` (gateway health) — this controls the local worker' },
  { name: 'brain', args: '[args...]', script: 'myai_brain.sh',
    desc: 'Git-versioned agent memory — init | status | write | stash | pop | branch | checkout | merge | log | diff | blame | revert | gc | session | distill (sessions = commits, wrap up = merge; walkthrough: TRY_BRAIN.md)' },
  { name: 'memory', args: '[args...]', script: 'myai_memory.sh',
    desc: 'Portable memory bundle — export [dir] pulls the corpus (state/handoff/patterns source texts) as JSON manifest + markdown; import <dir> re-embeds on this gateway with dedup-by-hash' },
  { name: 'context', args: '[args...]', script: 'myai_context.sh',
    desc: 'FULL portable context bundle — export [dir] tars memory corpus + vectors (embeddings) + brain atoms + config into ONE versioned, checksummed, secret-redacted .tar.gz; import <archive> verifies integrity and re-imports (memory always, brain/config opt-in); import-external <source> ingests FROM ChatGPT/Claude export, Obsidian, markdown, or a raw vector store (re-embed + dedup, tenant-scoped). Own + download your whole context.' },
  { name: 'recall', args: '<query...>', script: 'myai_recall.sh',
    desc: 'TOKEN-FREE semantic recall over the repo-local SQLite index (code symbols + brain atoms) via sparse BM25 + local embeddings — NO LLM, NO network, NO tokens. Builds the index on first use. --k N | --json | --rebuild' },
  { name: 'backup', args: '[args...]', script: 'myai_backup.sh',
    desc: 'Snapshot the git-versioned brain repo + ~/.myai config files into one dated .tar.gz archive (--out <file> or [dir] to place it; round-trips with `myai restore`)' },
  { name: 'restore', args: '[args...]', script: 'myai_restore.sh',
    desc: 'Restore a `myai backup` archive — brain repo → this machine\'s resolved dir (or --to <dir>) + config → ~/.myai; refuses to clobber without --force (existing state → .bak; --dry-run previews)' },
  { name: 'upgrade', args: '[args...]', script: 'myai_upgrade.sh',
    desc: 'Self-update the global CLI (`npm update -g`) then run pending config + brain schema migrations idempotently (--check reports without applying, exit 20 if pending; --dry-run previews; --no-self-update skips the npm step; --json for scripts)' },
  { name: 'doctor', args: '[args...]', handler: doctor,
    desc: 'Run preflight checks: docker (+engine), node, claude CLI, ANTHROPIC_API_KEY, cloud reachability, ollama availability, brain freshness, ports free. --dry-run previews the safe auto-fixes; --fix applies them idempotently (backfill non-secret .env keys from .env.example, redeploy statusline, correct runner cadence, pull latest gateway image) — never touches secrets or restarts the shared stack (--json for CI/scripts; exit 0 = passed)' },
  { name: 'root', args: '[args...]', handler: root,
    desc: 'Print the installed ai-management module path — the framework-as-module resolver a kernel-only repo (no per-repo AI/ copy) uses to find agents/skills/hooks/rule bodies. Fails loud (exit 1) if the resolved dir is not a valid install, so safety hooks never silently go missing (--json for scripts)' },
  { name: 'release', args: '[args...]', script: 'myai_release.sh',
    desc: 'One-command release cut: `release [patch|minor|major]` bumps package.json + CHANGELOG.md from Conventional Commits, clean-room-validates (shell unit suite + publish_guard.sh leak scan + a Docker install/smoke check), and commits locally — any validation failure auto-reverts the bump. `release --tag` (run on main after the commit merges) tags + pushes the release and prints the `gh release create` follow-up. --dry-run previews; --skip-tests/--skip-guard/--skip-docker skip a validation stage; --json for scripts' },
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
function recordInto(checks) {
  return (label, ok, detail) => {
    const status = ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'fail';
    checks.push({ label, status, detail: detail || '' });
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

// Look for ANTHROPIC_API_KEY in the environment, then in a local .env (cwd or
// package root). A placeholder value (your_..., empty) does not count as set.
function findAnthropicKey() {
  const envVal = process.env.ANTHROPIC_API_KEY;
  if (envVal && envVal.trim() && !/^your_/i.test(envVal.trim())) return 'environment';
  for (const dir of [process.cwd(), REPO_ROOT]) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, 'utf8').match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m && m[1] && m[1].trim() && !/^your_/i.test(m[1].trim())) {
      return path.relative(process.cwd(), f) || '.env';
    }
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
function brainFreshness() {
  const os = require('node:os');
  const home = process.env.MYAI_HOME || path.join(os.homedir(), '.myai');
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

  // Engine must actually be RUNNING, not merely installed.
  if (docker) {
    const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
    const running = info.status === 0 && info.stdout.trim();
    allOk &= check('docker engine running', running ? true : 'fail',
      running ? `server ${info.stdout.trim()}` : 'engine not reachable — start Docker');
  }

  const compose = bin('docker', ['compose', 'version']);
  allOk &= check('docker compose', compose ? true : 'fail', compose || 'v2 plugin not found');

  const git = bin('git');
  allOk &= check('git on PATH', git ? true : 'warn', git || 'not found');

  // ── credentials: claude CLI and/or ANTHROPIC_API_KEY ─────────────────────
  const claude = bin('claude', ['--version']);
  check('claude CLI', claude ? true : 'warn',
    claude || 'not found — needed for the off-hours runner (or use ANTHROPIC_API_KEY)');

  const keySrc = findAnthropicKey();
  // The runner can authenticate EITHER via the Claude CLI login OR via the key.
  // It is only a hard blocker when NEITHER is present.
  const credOk = !!keySrc || !!claude;
  allOk &= check('ANTHROPIC_API_KEY', keySrc ? true : credOk ? 'warn' : 'fail',
    keySrc ? `set (${keySrc})`
      : credOk ? 'not set — Claude CLI login will be used instead'
        : 'not set and no Claude CLI — set one for api/runner access');

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

  const brain = brainFreshness();
  check('brain freshness', brain.exists ? (brain.ageDays !== null && brain.ageDays > 7 ? 'warn' : true) : 'warn',
    !brain.exists ? `no brain repo at ${brain.dir} — run \`myai brain init\` (degraded-read needs it)`
      : brain.ageDays === null ? `${brain.dir} — last-commit age unknown`
        : brain.ageDays > 7 ? `${brain.dir} — last commit ${Math.round(brain.ageDays)}d ago (stale; run \`wrap up\` / \`myai brain session merge\`)`
          : `${brain.dir} — last commit ${brain.ageDays < 1 ? 'today' : Math.round(brain.ageDays) + 'd ago'}`);

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
  for (const [port, svc] of STACK_PORTS) {
    const used = portInUse(port);
    // A busy port is a warning, not a fatal: it may be a prior `myai up` still
    // running. We flag it so the operator can stop the conflicting process.
    allOk &= check(`port ${port} free`, used ? 'warn' : true,
      used ? `IN USE — needed by ${svc} (stop the process or run \`myai down\`)` : `free (${svc})`);
  }

  return { checks, ok: !!allOk };
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

// ── commander path (used when the dep is installed) ──────────────────────────
function runWithCommander(Command) {
  const program = new Command();
  program
    .name('myai')
    .description('CLI for the AI Management Framework')
    .version(PKG.version, '-v, --version');

  for (const c of COMMANDS) {
    const sub = program
      .command(c.args ? `${c.name} ${c.args}` : c.name)
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
  const width = Math.max(...COMMANDS.map((c) => (c.name + ' ' + c.args).length));
  for (const c of COMMANDS) {
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

// ── entrypoint ────────────────────────────────────────────────────────────────
function main() {
  // Intercept a subcommand's -h/--help BEFORE either parser — otherwise it
  // falls through to the passthrough script and RUNS it (see helpRequestedFor).
  const helpCmd = helpRequestedFor(process.argv.slice(2));
  if (helpCmd) {
    printCommandHelp(helpCmd);
    process.exit(0);
  }
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
  helpRequestedFor,
  printCommandHelp,
  SECRET_KEY_RE,
  PLACEHOLDER_VALUE_RE,
  moduleRoot,
  root,
  MODULE_MARKERS,
  findAnthropicKey,
  portInUse,
  hostReachable,
  probeOllamaDaemon,
  brainFreshness,
  printHelp,
  runFallback,
  main,
};

if (require.main === module) main();
