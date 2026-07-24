#!/usr/bin/env node
/**
 * build_docs.mjs — zero-dependency static docs site generator.
 *
 * Renders docs/*.md into a static HTML site (docs/_site/) for GitHub Pages,
 * and auto-generates two reference pages from the code itself:
 *
 *   - CLI reference      ← COMMANDS table exported by bin/myai.cjs
 *   - MCP tool reference ← TOOL_DEFINITIONS array in runtime/src/mcp/tools.ts
 *                          (extracted by slicing the literal array out of the
 *                          TypeScript source and evaluating it in a bare vm —
 *                          the array is pure object literals, no imports)
 *
 * No npm install, no framework: plain Node 20+, built-in markdown renderer.
 * Run:  node scripts/build_docs.mjs [--out <dir>]     (default docs/_site)
 * CI:   .github/workflows/docs.yml builds + deploys on merge to main.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

const outFlag = process.argv.indexOf('--out');
const OUT_DIR = outFlag > -1 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(DOCS_DIR, '_site');

// ── Markdown → HTML (minimal, covers what our docs use) ─────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // images (`![alt](src)`) must run before links — image syntax is a link with a `!` prefix
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  return out;
}

function slugify(s) {
  return s.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9_\s-]/g, '').trim().replace(/\s+/g, '-');
}

/** Strip markdown inline syntax down to plain text (for TOC labels + search index). */
function stripMarkdownInline(text) {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

// ── In-page navigation + search index ────────────────────────────────────────
// Both walk the raw markdown (not the rendered HTML) so headings/anchors match
// exactly what renderMarkdown() assigns via slugify() — one source of truth.

/** Collect every level-`level` heading as {id, text}, for the "on this page" TOC. */
function extractHeadings(md, level = 2) {
  const marker = '#'.repeat(level);
  const headings = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.startsWith(marker + ' ') && !line.startsWith(marker + '#')) {
      const text = line.slice(marker.length).trim();
      headings.push({ id: slugify(text), text: stripMarkdownInline(text) });
    }
  }
  return headings;
}

/**
 * Split a page into per-heading (h1-h3) search entries: {url, title, heading,
 * anchor, excerpt}. Client-side search matches against these — a hit deep-links
 * straight to the section via #anchor instead of dumping the prospect at the
 * top of a long page. Splitting down to h3 (not just the h1/h2 the TOC uses)
 * matters for the generated reference pages — cli.html/mcp-tools.html pack
 * every command/tool under one h2 "Details" section, so without h3-level
 * splits an excerpt's 160-char cap would bury everything past the first entry.
 */
function buildSearchEntries(url, md) {
  const pageTitle = firstHeading(md);
  const entries = [];
  let current = null;
  let inFence = false;
  const flush = () => { if (current) entries.push(current); };
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      const text = h[2].trim();
      current = { heading: stripMarkdownInline(text), anchor: slugify(text), body: '' };
      continue;
    }
    if (current && line.trim()) current.body += (current.body ? ' ' : '') + line.trim();
  }
  flush();
  return entries.map((e) => ({
    url,
    title: pageTitle,
    heading: e.heading,
    anchor: e.anchor,
    excerpt: stripMarkdownInline(e.body).replace(/\s+/g, ' ').slice(0, 160),
  }));
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;
  let inList = null; // 'ul' | 'ol'

  const closeList = () => { if (inList) { html.push(`</${inList}>`); inList = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      closeList();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      const cls = fence[1] ? ` class="language-${fence[1]}"` : '';
      html.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = h[2].trim();
      html.push(`<h${level} id="${slugify(text)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) { closeList(); html.push('<hr>'); i++; continue; }

    // blockquote
    if (line.startsWith('>')) {
      closeList();
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      html.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) html.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      html.push('</tbody></table>');
      continue;
    }

    // list item
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (inList !== want) { closeList(); html.push(`<${want}>`); inList = want; }
      html.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++;
      continue;
    }

    // blank line
    if (line.trim() === '') { closeList(); i++; continue; }

    // paragraph (merge consecutive text lines)
    closeList();
    const para = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() !== '' &&
           !/^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s|---+\s*$)/.test(lines[i + 1]) &&
           !(lines[i + 1].includes('|') && i + 2 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 2]))) {
      para.push(lines[i + 1]);
      i++;
    }
    html.push(`<p>${inline(para.join(' '))}</p>`);
    i++;
  }
  closeList();
  return html.join('\n');
}

// ── Reference generators ─────────────────────────────────────────────────────

function generateCliReference() {
  const { COMMANDS } = require(path.join(REPO_ROOT, 'bin', 'myai.cjs'));
  const md = [];
  md.push('# CLI reference — `myai`');
  md.push('');
  md.push('> Auto-generated from the `COMMANDS` table in `bin/myai.cjs` — do not edit by hand.');
  md.push('');
  md.push('The `myai` CLI (aliased `ai-manage`, npm package `ai-management`) is a thin dispatcher: each subcommand shells into the repo\'s `scripts/*.sh` playbooks, which remain the single source of truth. It has zero required runtime dependencies — `myai --help` and `myai doctor` work before any `npm install`.');
  md.push('');
  md.push('| Command | Arguments | What it does |');
  md.push('|---------|-----------|--------------|');
  for (const c of COMMANDS) {
    md.push(`| \`myai ${c.name}\` | \`${c.args || '—'}\` | ${c.desc.replace(/\|/g, '\\|')} |`);
  }
  md.push('');
  md.push('## Details');
  md.push('');
  for (const c of COMMANDS) {
    md.push(`### \`myai ${c.name}${c.args ? ' ' + c.args : ''}\``);
    md.push('');
    md.push(c.desc);
    md.push('');
    if (c.script) md.push(`Dispatches to \`scripts/${c.script}\`.`);
    else if (c.handler) md.push('Runs in-process (no shell script).');
    md.push('');
  }
  md.push('---');
  md.push('');
  md.push('Global options: `-h, --help` · `-v, --version`.');
  return md.join('\n');
}

function extractToolDefinitions() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'runtime', 'src', 'mcp', 'tools.ts'), 'utf8');
  const marker = 'TOOL_DEFINITIONS: McpToolDef[] = [';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('TOOL_DEFINITIONS marker not found in runtime/src/mcp/tools.ts');
  const open = src.indexOf('[', start);
  const close = src.indexOf('\n];', open);
  if (close === -1) throw new Error('TOOL_DEFINITIONS closing "];" not found');
  const arrayText = src.slice(open, close + 2); // "[ ... ]"
  // The array is pure object literals (strings, arrays, nested objects) — safe
  // to evaluate in an empty vm context. If someone adds a computed value this
  // throws, which is exactly the signal we want in CI.
  const tools = vm.runInNewContext('(' + arrayText + ')', {});

  // Map each tool to its section header comment ("// ── MEMORY / RAG ──…")
  const sections = [];
  let cursor = 0;
  const sectionRe = /\/\/ ── ([^─\n]+?) ─+/g;
  let m;
  while ((m = sectionRe.exec(arrayText)) !== null) {
    sections.push({ pos: m.index, title: m[1].trim() });
  }
  for (const tool of tools) {
    const needle = `name: '${tool.name}'`;
    const pos = arrayText.indexOf(needle, cursor);
    if (pos > -1) cursor = pos;
    let title = 'Other';
    for (const s of sections) { if (s.pos < pos) title = s.title; else break; }
    tool._section = title;
  }
  return tools;
}

function generateMcpReference() {
  const tools = extractToolDefinitions();
  const md = [];
  md.push('# MCP tool reference — gateway');
  md.push('');
  md.push('> Auto-generated from `TOOL_DEFINITIONS` in `runtime/src/mcp/tools.ts` — do not edit by hand.');
  md.push('');
  md.push(`The myai gateway exposes **${tools.length} MCP tools** at \`http://localhost:3100/mcp\`. Any MCP-capable agent (Claude Code, Cursor, Windsurf, Codex CLI — see \`myai connect-agent\`) can call them. Required parameters are marked **bold**.`);
  md.push('');

  // group by section, preserving first-seen order
  const groups = new Map();
  for (const t of tools) {
    if (!groups.has(t._section)) groups.set(t._section, []);
    groups.get(t._section).push(t);
  }

  // table of contents
  for (const [section, list] of groups) {
    md.push(`- [${section}](#${slugify(section)}) — ${list.map((t) => `\`${t.name}\``).join(', ')}`);
  }
  md.push('');

  for (const [section, list] of groups) {
    md.push(`## ${section}`);
    md.push('');
    for (const t of list) {
      md.push(`### \`${t.name}\``);
      md.push('');
      md.push(t.description);
      md.push('');
      const props = t.inputSchema?.properties || {};
      const req = new Set(t.inputSchema?.required || []);
      const keys = Object.keys(props);
      if (keys.length === 0) {
        md.push('*No parameters.*');
      } else {
        md.push('| Parameter | Type | Description |');
        md.push('|-----------|------|-------------|');
        for (const k of keys) {
          const p = props[k] || {};
          let type = p.type || 'any';
          if (p.enum) type = p.enum.map((e) => `\`${e}\``).join(' \\| ');
          else if (type === 'array' && p.items?.type) type = `${p.items.type}[]`;
          const name = req.has(k) ? `**\`${k}\`**` : `\`${k}\``;
          const desc = (p.description || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
          md.push(`| ${name} | ${type} | ${desc} |`);
        }
      }
      md.push('');
    }
  }
  return md.join('\n');
}

// ── Site shell ───────────────────────────────────────────────────────────────

const NAV = [
  { title: 'Home', file: 'index.html' },
  { title: 'Quickstart', file: 'quickstart.html' },
  { title: 'Concepts', file: 'concepts.html' },
  { title: 'Walkthroughs', file: 'media.html' },
  { title: 'Comparisons', file: 'compare.html' },
  { title: 'CLI reference', file: 'reference/cli.html' },
  { title: 'MCP tool reference', file: 'reference/mcp-tools.html' },
  { title: 'API reference', file: 'reference/api.html' },
];

// Redoc version pinned for reproducible builds. jsDelivr resolves `redoc@2` to
// the latest 2.x standalone bundle.
const REDOC_CDN = 'https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js';

// Interactive REST/MCP API reference. Renders the committed OpenAPI document
// (docs/reference/openapi.json — generated from buildOpenApiSpec() by
// scripts/gen_openapi.mjs) with Redoc. Full-bleed page with a slim bar back to
// the docs; the JSON sits next to it so integrators can download the raw spec.
function apiReferenceHtml(generatedAt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API reference · myAI docs</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .topbar { display: flex; align-items: center; gap: 16px; padding: 10px 20px;
            background: #0f1117; color: #e6e8ee; border-bottom: 1px solid #262b36;
            font-size: 14px; position: sticky; top: 0; z-index: 20; }
  .topbar a { color: #8b95ff; text-decoration: none; }
  .topbar a:hover { text-decoration: underline; }
  .topbar .spacer { flex: 1; }
  redoc { display: block; }
</style>
</head>
<body>
<div class="topbar">
  <a href="../index.html">← myAI docs</a>
  <span class="spacer"></span>
  <a href="openapi.json" download>Download openapi.json</a>
</div>
<redoc spec-url="openapi.json"></redoc>
<script src="${REDOC_CDN}"></script>
<!-- Generated ${generatedAt} from docs/reference/openapi.json -->
</body>
</html>
`;
}

const CSS = `
:root { --bg:#ffffff; --fg:#1a1f2e; --muted:#5b6472; --accent:#4353ff; --border:#e4e7ec; --code-bg:#f4f5f7; --sidebar:#f9fafb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1117; --fg:#e6e8ee; --muted:#9aa3b2; --accent:#8b95ff; --border:#262b36; --code-bg:#1a1f2b; --sidebar:#141821; }
}
* { box-sizing: border-box; }
body { margin:0; font:16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:var(--fg); background:var(--bg); }
.layout { display:flex; min-height:100vh; }
nav.sidebar { width:240px; flex-shrink:0; background:var(--sidebar); border-right:1px solid var(--border); padding:24px 16px; position:sticky; top:0; height:100vh; overflow-y:auto; }
nav.sidebar .brand { font-weight:700; font-size:18px; margin-bottom:20px; display:block; color:var(--fg); text-decoration:none; }
nav.sidebar a.item { display:block; padding:6px 10px; border-radius:6px; color:var(--muted); text-decoration:none; font-size:14.5px; }
nav.sidebar a.item:hover { color:var(--fg); background:var(--border); }
nav.sidebar a.item.active { color:var(--accent); font-weight:600; }
.search-box { position:relative; margin-bottom:20px; }
.search-box input { width:100%; padding:7px 10px; font:inherit; font-size:13.5px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg); }
.search-box input:focus { outline:2px solid var(--accent); outline-offset:1px; }
.search-results { position:absolute; top:calc(100% + 4px); left:0; width:100%; background:var(--bg); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); max-height:60vh; overflow-y:auto; z-index:30; }
.search-result { display:block; padding:8px 10px; text-decoration:none; border-bottom:1px solid var(--border); }
.search-result:last-child { border-bottom:none; }
.search-result:hover, .search-result:focus { background:var(--border); }
.sr-heading { display:block; font-size:13px; font-weight:600; color:var(--fg); }
.sr-page { display:block; font-size:11px; color:var(--accent); margin-top:1px; }
.sr-excerpt { display:block; font-size:11.5px; color:var(--muted); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.search-empty { padding:10px; font-size:12.5px; color:var(--muted); }
main { flex:1; min-width:0; padding:40px 48px 80px; }
.page { display:flex; gap:40px; max-width:1180px; }
.markdown-body { flex:1; min-width:0; max-width:900px; }
aside.toc { width:190px; flex-shrink:0; position:sticky; top:40px; align-self:flex-start; font-size:13px; max-height:calc(100vh - 80px); overflow-y:auto; }
aside.toc .toc-title { font-weight:600; color:var(--fg); text-transform:uppercase; letter-spacing:.04em; font-size:11px; margin-bottom:10px; }
aside.toc a { display:block; padding:4px 0 4px 10px; color:var(--muted); text-decoration:none; border-left:2px solid transparent; }
aside.toc a:hover { color:var(--fg); border-left-color:var(--accent); }
@media (max-width: 1100px) { aside.toc { display:none; } }
h1,h2,h3,h4 { line-height:1.3; scroll-margin-top:16px; }
h1 { font-size:30px; margin-top:0; }
h2 { font-size:22px; margin-top:2em; border-bottom:1px solid var(--border); padding-bottom:6px; }
h3 { font-size:17px; margin-top:1.6em; }
a { color:var(--accent); }
code { background:var(--code-bg); border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:87%; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:14px 16px; overflow-x:auto; }
pre code { background:none; border:none; padding:0; font-size:13.5px; }
img { max-width:100%; height:auto; border:1px solid var(--border); border-radius:8px; margin:0.5em 0; }
table { border-collapse:collapse; width:100%; margin:1em 0; font-size:14.5px; display:block; overflow-x:auto; }
th,td { border:1px solid var(--border); padding:7px 11px; text-align:left; vertical-align:top; }
th { background:var(--sidebar); }
blockquote { margin:1em 0; padding:8px 16px; border-left:3px solid var(--accent); background:var(--sidebar); color:var(--muted); border-radius:0 6px 6px 0; }
blockquote p { margin:6px 0; }
hr { border:none; border-top:1px solid var(--border); margin:2em 0; }
footer { margin-top:60px; padding-top:16px; border-top:1px solid var(--border); color:var(--muted); font-size:13px; }
@media (max-width: 760px) { .layout { flex-direction:column; } nav.sidebar { width:100%; height:auto; position:static; } main { padding:24px 20px 60px; } .page { flex-direction:column; } }
`;

// Client-side search over search-index.json (one entry per h1/h2 section,
// built by buildSearchEntries()). Plain vanilla JS — no bundler, matches the
// zero-dependency generator. Fetch requires the site be served over http(s);
// it won't resolve opened directly via file://, which is fine since the only
// deploy target is GitHub Pages (.github/workflows/docs.yml).
const SEARCH_JS = `
(function () {
  var root = document.documentElement.dataset.docsRoot || '';
  var input = document.getElementById('docs-search');
  var results = document.getElementById('docs-search-results');
  if (!input || !results) return;

  var index = null;
  function loadIndex() {
    if (index) return Promise.resolve(index);
    return fetch(root + 'search-index.json')
      .then(function (r) { return r.json(); })
      .then(function (data) { index = data; return data; });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render(matches, query) {
    if (!matches.length) {
      results.innerHTML = '<div class="search-empty">No results for &quot;' + escapeHtml(query) + '&quot;</div>';
      results.hidden = false;
      return;
    }
    results.innerHTML = matches.slice(0, 8).map(function (m) {
      var href = root + m.url + (m.anchor ? '#' + m.anchor : '');
      return '<a class="search-result" href="' + href + '">' +
        '<span class="sr-heading">' + escapeHtml(m.heading) + '</span>' +
        '<span class="sr-page">' + escapeHtml(m.title) + '</span>' +
        '<span class="sr-excerpt">' + escapeHtml(m.excerpt) + '</span>' +
        '</a>';
    }).join('');
    results.hidden = false;
  }

  function search(query) {
    var q = query.trim().toLowerCase();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    loadIndex().then(function (data) {
      var scored = [];
      for (var i = 0; i < data.length; i++) {
        var e = data[i];
        var titleHeading = (e.heading + ' ' + e.title).toLowerCase();
        var body = (e.excerpt || '').toLowerCase();
        var score = -1;
        if (titleHeading.indexOf(q) !== -1) score = 2;
        else if (body.indexOf(q) !== -1) score = 1;
        if (score >= 0) scored.push({ e: e, score: score });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      render(scored.map(function (s) { return s.e; }), query);
    });
  }

  input.addEventListener('input', function () { search(input.value); });
  input.addEventListener('focus', function () { if (input.value.trim()) search(input.value); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { results.hidden = true; input.blur(); }
    if (ev.key === 'Enter') {
      var first = results.querySelector('.search-result');
      if (first) window.location.href = first.getAttribute('href');
    }
  });
  document.addEventListener('click', function (ev) {
    if (ev.target !== input && !results.contains(ev.target)) results.hidden = true;
  });
})();
`;

function pageShell({ title, bodyHtml, depth, activeFile, generatedAt, toc = [] }) {
  const root = depth === 0 ? '' : '../'.repeat(depth);
  const nav = NAV.map((n) => {
    const active = n.file === activeFile ? ' active' : '';
    return `<a class="item${active}" href="${root}${n.file}">${n.title}</a>`;
  }).join('\n    ');
  const tocHtml = toc.length
    ? `<aside class="toc">
      <div class="toc-title">On this page</div>
      ${toc.map((h) => `<a href="#${h.id}">${escapeHtml(h.text)}</a>`).join('\n      ')}
    </aside>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" data-docs-root="${root}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · myAI docs</title>
<link rel="stylesheet" href="${root}style.css">
</head>
<body>
<div class="layout">
  <nav class="sidebar">
    <a class="brand" href="${root}index.html">myAI docs</a>
    <div class="search-box">
      <input type="search" id="docs-search" placeholder="Search docs…" autocomplete="off" spellcheck="false" aria-label="Search docs">
      <div class="search-results" id="docs-search-results" hidden></div>
    </div>
    ${nav}
  </nav>
  <main>
    <div class="page">
      <article class="markdown-body">
${bodyHtml}
<footer>Generated ${generatedAt} · <a href="https://github.com/knofler/ai_management">knofler/ai_management</a></footer>
      </article>
      ${tocHtml}
    </div>
  </main>
</div>
<script src="${root}search.js" defer></script>
</body>
</html>
`;
}

// ── Build ────────────────────────────────────────────────────────────────────

function firstHeading(md) {
  const m = md.match(/^#\s+(.*)$/m);
  return m ? m[1].replace(/`/g, '').trim() : 'myAI docs';
}

function build() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'reference'), { recursive: true });

  const generatedAt = new Date().toISOString().slice(0, 10);
  const pages = [];
  const searchIndex = [];

  // authored pages: every top-level docs/*.md
  for (const f of fs.readdirSync(DOCS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const md = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8');
    pages.push({ out: f.replace(/\.md$/, '.html'), md, depth: 0 });
  }

  // generated reference pages
  pages.push({ out: 'reference/cli.html', md: generateCliReference(), depth: 1 });
  pages.push({ out: 'reference/mcp-tools.html', md: generateMcpReference(), depth: 1 });

  for (const p of pages) {
    const toc = extractHeadings(p.md);
    const html = pageShell({
      title: firstHeading(p.md),
      bodyHtml: renderMarkdown(p.md),
      depth: p.depth,
      activeFile: p.out,
      generatedAt,
      toc,
    });
    fs.writeFileSync(path.join(OUT_DIR, p.out), html);
    searchIndex.push(...buildSearchEntries(p.out, p.md));
    console.log(`  built ${p.out}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'search-index.json'), JSON.stringify(searchIndex));
  fs.writeFileSync(path.join(OUT_DIR, 'search.js'), SEARCH_JS.trim() + '\n');
  console.log(`  built search-index.json (${searchIndex.length} entries) + search.js`);

  // interactive API reference (Redoc) — copies the committed OpenAPI document
  // next to a full-bleed Redoc page. Kept separate from the markdown shell so
  // Redoc owns the whole viewport.
  const specSrc = path.join(DOCS_DIR, 'reference', 'openapi.json');
  if (fs.existsSync(specSrc)) {
    fs.copyFileSync(specSrc, path.join(OUT_DIR, 'reference', 'openapi.json'));
    fs.writeFileSync(path.join(OUT_DIR, 'reference', 'api.html'), apiReferenceHtml(generatedAt));
    console.log('  built reference/api.html (Redoc) + reference/openapi.json');
  } else {
    console.warn('  WARN — docs/reference/openapi.json missing; run node scripts/gen_openapi.mjs');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'style.css'), CSS.trim() + '\n');
  fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '');

  // static media assets (posters + walkthrough GIFs) → _site/media/img/**.
  // Raw capture frames (docs/media/frames) and the source scripts (docs/media/scripts)
  // are NOT copied — they're intermediates / GitHub-linked source, not site assets.
  const assetsSrc = path.join(DOCS_DIR, 'media', 'img');
  if (fs.existsSync(assetsSrc)) {
    const assetsOut = path.join(OUT_DIR, 'media', 'img');
    fs.cpSync(assetsSrc, assetsOut, { recursive: true });
    const n = fs.readdirSync(assetsSrc).filter((f) => !f.startsWith('.')).length;
    console.log(`  copied ${n} media asset(s) → media/img/`);
  }

  console.log(`docs site → ${path.relative(REPO_ROOT, OUT_DIR)} (${pages.length} pages)`);
}

build();
