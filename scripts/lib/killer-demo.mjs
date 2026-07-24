// =============================================================================
// killer-demo.mjs — the adoption demo engine (pure, testable functions + CLI).
//
// THE THESIS: connect your context through the myAI platform and the cheapest
// free/local model punches like a frontier model. This module asks the SAME
// question to the SAME cheap model TWICE:
//   (A) raw / no context  → a generic, useless "I don't know you" answer
//   (B) booted with the operator's context via the gateway `context_boot`
//       bundle (the betaC shim, wrap-it tier) → an expert, personalized,
//       correct answer.
// It captures both, times both, and emits a reproducible side-by-side artifact
// (terminal render + JSON for the dashboard /demo page + a GIF-record script).
//
// The functions below are PURE and unit-tested (tests/unit/killer-demo.test.ts).
// The CLI at the bottom wires them to the live gateway + Ollama. Consumed by
// scripts/killer_demo.sh.
//
// Node >= 20 (global fetch). No deps.
// =============================================================================

export const DEMO_SCHEMA = 'myai.killer-demo/1';

export const DEFAULT_QUESTION = 'What am I currently working on, and what should I do next?';

export const THESIS =
  'Connect your context through myAI and the cheapest free/local model answers like a frontier model.';

/**
 * Compose the "with context" prompt: the operator brief prepended to the
 * question. Mirrors the betaC shim (wrap-it tier) — the model did not fetch
 * this; the launcher prepended it, and there is no live recall in this tier.
 */
export function composeContextPrompt(bundle, deeper, question) {
  const lines = [String(bundle || '').trim()];
  if (Array.isArray(deeper) && deeper.length) {
    lines.push('', '## Deeper context (recalled for this question)');
    for (const s of deeper) lines.push(`- [${s.repo}] (${s.source}) ${s.snippet}`);
  }
  lines.push(
    '',
    '---',
    'The operator context above was PREPENDED for you — answer from it directly.',
    'Never ask the operator to re-explain who they are or what they are working on.',
    '',
    `Operator question: ${String(question || '').trim()}`,
  );
  return lines.join('\n');
}

/** Strip ANSI / terminal control sequences and normalize whitespace. */
export function cleanAnswer(text) {
  return String(text || '')
    // Full ANSI/CSI escape sequences (ESC [ ... final byte).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Bare CSI leftovers from non-TTY spinner output (e.g. "[3DK").
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')
    // Stray control characters (keep \n and \t).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the reproducible artifact from the two model runs. Pure — no I/O.
 * `raw` / `booted` are { answer, ms }. Returns the object serialized to
 * dashboard/public/demo/killer-demo.json.
 */
export function buildArtifact({
  model,
  question,
  repo,
  activeProject,
  tokenEstimate,
  deeperCount = 0,
  raw,
  booted,
  generatedAt,
}) {
  const rawAnswer = cleanAnswer(raw?.answer);
  const bootedAnswer = cleanAnswer(booted?.answer);
  return {
    schema: DEMO_SCHEMA,
    generatedAt: generatedAt || new Date().toISOString(),
    provider: 'ollama',
    model,
    question,
    repo: repo || activeProject || null,
    thesis: THESIS,
    context: {
      activeProject: activeProject ?? null,
      tokenEstimate: tokenEstimate ?? null,
      deeperCount,
    },
    raw: { answer: rawAnswer, ms: raw?.ms ?? null, chars: rawAnswer.length },
    booted: { answer: bootedAnswer, ms: booted?.ms ?? null, chars: bootedAnswer.length },
  };
}

/** Wrap a paragraph to `width` columns (word-safe). Returns an array of lines. */
export function wrapText(text, width) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line.length + word.length + 1 > width && line) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Render the artifact as a two-column side-by-side terminal block. */
export function renderSideBySide(artifact, { width = 76 } = {}) {
  const col = Math.floor((width - 3) / 2);
  const rawLines = wrapText(artifact.raw.answer, col);
  const bootLines = wrapText(artifact.booted.answer, col);
  const n = Math.max(rawLines.length, bootLines.length);
  const pad = (s) => (s || '').padEnd(col).slice(0, col);
  const bar = '─'.repeat(width);

  const out = [];
  out.push(bar);
  out.push(`  KILLER DEMO — ${artifact.model} (${artifact.provider}) · same question, two runs`);
  out.push(`  Q: ${artifact.question}`);
  out.push(bar);
  out.push(`${pad(`(A) RAW — no context   [${fmtMs(artifact.raw.ms)}]`)} │ ${pad(`(B) via myAI context   [${fmtMs(artifact.booted.ms)}]`)}`);
  out.push(`${'─'.repeat(col)}─┼─${'─'.repeat(col)}`);
  for (let i = 0; i < n; i++) out.push(`${pad(rawLines[i])} │ ${pad(bootLines[i])}`);
  out.push(bar);
  out.push(`  Context booted: ~${artifact.context.tokenEstimate ?? '?'} tokens · project: ${artifact.context.activeProject ?? '?'}`);
  out.push(`  ${THESIS}`);
  out.push(bar);
  return out.join('\n');
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ── live I/O (not unit-tested; exercised by the CLI + shell script) ──────────

/** Fetch the operator context bundle from the gateway `context_boot` tool. */
export async function fetchContextBoot(gatewayUrl, token, { repo, query, budget } = {}) {
  const args = {};
  if (repo) args.repo = repo;
  if (query) args.query = query;
  if (Number.isFinite(budget) && budget > 0) args.budget = budget;
  const r = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-local-token': token || '' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_boot', arguments: args } }),
  });
  if (!r.ok) throw new Error(`gateway HTTP ${r.status} on context_boot`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  const text = d.result?.content?.[0]?.text ?? '';
  let boot;
  try { boot = JSON.parse(text); } catch { throw new Error('context_boot returned non-JSON payload'); }
  if (boot?.error) throw new Error(`context_boot: ${boot.error}`);
  if (!boot?.bundle) throw new Error('context_boot returned no bundle');
  return {
    bundle: boot.bundle,
    deeper: Array.isArray(boot.deeper) ? boot.deeper : [],
    tokenEstimate: boot.tokenEstimate ?? Math.ceil(boot.bundle.length / 4),
    activeProject: boot.parts?.activeProject ?? null,
  };
}

/** One non-streaming Ollama generation. Returns { answer, ms }. */
export async function ollamaGenerate(baseUrl, model, prompt, { timeoutMs = 120000 } = {}) {
  const started = Date.now();
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status} — is 'ollama serve' running? model '${model}' pulled?`);
  const d = await r.json();
  const ms = Number.isFinite(d.total_duration) ? Math.round(d.total_duration / 1e6) : Date.now() - started;
  return { answer: d.response ?? '', ms };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const gateway = process.env.GATEWAY_MCP || 'http://localhost:3100/mcp';
  const token = process.env.GATEWAY_LOCAL_TOKEN || 'myai-local-bridge-dev';
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = opt('model', process.env.BETAC_OLLAMA_MODEL || 'gemma3:4b');
  const question = opt('question', DEFAULT_QUESTION);
  const repo = opt('repo', '');
  const budget = Number(opt('budget', '')) || undefined;
  const jsonOnly = argv.includes('--json-only');

  process.stderr.write(`killer-demo: fetching operator context (context_boot)…\n`);
  const boot = await fetchContextBoot(gateway, token, { repo, query: question, budget });
  process.stderr.write(`killer-demo: context ~${boot.tokenEstimate} tokens · project ${boot.activeProject}\n`);

  process.stderr.write(`killer-demo: (A) raw ${model}…\n`);
  const raw = await ollamaGenerate(ollamaUrl, model, question);
  process.stderr.write(`killer-demo: (B) context-booted ${model}…\n`);
  const contextPrompt = composeContextPrompt(boot.bundle, boot.deeper, question);
  const booted = await ollamaGenerate(ollamaUrl, model, contextPrompt);

  const artifact = buildArtifact({
    model, question, repo,
    activeProject: boot.activeProject,
    tokenEstimate: boot.tokenEstimate,
    deeperCount: boot.deeper.length,
    raw, booted,
  });

  if (jsonOnly) { process.stdout.write(JSON.stringify(artifact, null, 2) + '\n'); return; }
  process.stdout.write(renderSideBySide(artifact) + '\n\n');
  process.stdout.write(JSON.stringify(artifact) + '\n'); // last line = machine-readable
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`killer-demo: ${e.message}\n`); process.exit(1); });
}
