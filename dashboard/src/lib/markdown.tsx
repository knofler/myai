// Dependency-free server-side Markdown → React renderer.
//
// The dashboard image ships no markdown library (npm is Docker-only and the
// build stays lean), so this is a deliberately small block-level parser that
// covers the GitHub-flavoured subset our README / SHOWCASE / docs actually use:
// ATX headings, fenced + inline code, bold/italic, links, ordered/unordered
// lists, blockquotes, horizontal rules, pipe tables, and paragraphs.
// It is NOT a full CommonMark implementation — it is the 90% that renders our
// own markdown cleanly with the teal/gel skin.

import React from 'react';

let keySeed = 0;
function k(prefix: string): string {
  return `${prefix}-${keySeed++}`;
}

/* ── Inline formatting ──────────────────────────────────────────
 * Order matters: code spans first (so their contents aren't re-parsed),
 * then links, then bold, then italic. */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenise on the constructs we support; everything else is literal text.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={k('c')} className="px-1.5 py-0.5 rounded bg-zinc-800/80 text-teal-300 font-mono text-[0.85em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(<strong key={k('b')} className="font-semibold text-zinc-100">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      nodes.push(<em key={k('i')} className="italic text-zinc-200">{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('[')) {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (lm) {
        const href = lm[2];
        const external = /^https?:\/\//.test(href);
        nodes.push(
          <a
            key={k('a')}
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer' : undefined}
            className="text-teal-400 hover:text-teal-300 underline decoration-zinc-700 underline-offset-2"
          >
            {lm[1]}
          </a>,
        );
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'text-2xl font-bold text-zinc-100 mt-8 mb-4 tracking-tight border-b border-zinc-800 pb-2',
  2: 'text-xl font-bold text-zinc-100 mt-7 mb-3 tracking-tight',
  3: 'text-lg font-semibold text-teal-300 mt-6 mb-2',
  4: 'text-base font-semibold text-zinc-200 mt-5 mb-2',
  5: 'text-sm font-semibold text-zinc-300 mt-4 mb-1 uppercase tracking-wider',
  6: 'text-xs font-semibold text-zinc-400 mt-4 mb-1 uppercase tracking-wider',
};

/** Render a GitHub-flavoured markdown string to a React tree. */
export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line → skip.
    if (line.trim() === '') { i++; continue; }

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence
      blocks.push(
        <pre key={k('pre')} className="my-4 p-4 rounded-lg bg-zinc-950/80 border border-zinc-800 overflow-x-auto">
          {lang && <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-2 font-mono">{lang}</div>}
          <code className="text-xs font-mono text-zinc-300 whitespace-pre">{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={k('hr')} className="my-6 border-zinc-800" />);
      i++;
      continue;
    }

    // ATX heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const Tag = (`h${level}`) as keyof React.JSX.IntrinsicElements;
      blocks.push(<Tag key={k('h')} className={HEADING_CLASSES[level]}>{renderInline(h[2].replace(/\s+#+\s*$/, ''))}</Tag>);
      i++;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(
        <blockquote key={k('q')} className="my-4 pl-4 border-l-2 border-teal-500/40 text-zinc-400 italic">
          {renderInline(buf.join(' '))}
        </blockquote>,
      );
      continue;
    }

    // Pipe table — header row + separator row + body.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const splitRow = (r: string) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line);
      i += 2; // skip header + separator
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { body.push(splitRow(lines[i])); i++; }
      blocks.push(
        <div key={k('tbl')} className="my-4 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-[11px] text-zinc-400 uppercase tracking-wider">
                {header.map((c, ci) => <th key={ci} className="px-3 py-2 font-medium">{renderInline(c)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {body.map((row, ri) => (
                <tr key={ri} className="hover:bg-zinc-800/30">
                  {row.map((c, ci) => <td key={ci} className="px-3 py-2 text-zinc-300 align-top">{renderInline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      blocks.push(
        <ul key={k('ul')} className="my-3 ml-5 space-y-1.5 list-disc marker:text-teal-500/70">
          {items.map((it) => <li key={k('li')} className="text-zinc-300 leading-relaxed">{renderInline(it)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(
        <ol key={k('ol')} className="my-3 ml-5 space-y-1.5 list-decimal marker:text-teal-500/70">
          {items.map((it) => <li key={k('li')} className="text-zinc-300 leading-relaxed">{renderInline(it)}</li>)}
        </ol>,
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-block lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      blocks.push(<p key={k('p')} className="my-3 text-zinc-300 leading-relaxed">{renderInline(para.join(' '))}</p>);
    }
  }

  return <div className="markdown-body max-w-none">{blocks}</div>;
}
