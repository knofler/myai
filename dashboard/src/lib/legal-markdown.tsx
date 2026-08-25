// Tiny markdown → JSX renderer for the gateway-served legal documents
// (/terms, /privacy, /acceptable-use). The copy is trusted (it comes from our
// own gateway's versioned docs, not user input) but we still render to real
// React nodes — no dangerouslySetInnerHTML. Supports exactly what the legal
// pack uses: ## / ### headings, paragraphs, - bullet lists, **bold**, and
// [links](href) (internal hrefs become <Link>, external open in a new tab).
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface LegalDoc {
  slug: string;
  title: string;
  version: string;
  updated: string;
  markdown: string;
}

/** Fetch one legal doc from the gateway; null on any failure so the caller
 *  can fall back to its static copy (the trust pages must never 500). */
export async function fetchLegalDoc(gatewayHttpUrl: string, slug: string): Promise<LegalDoc | null> {
  try {
    const res = await fetch(`${gatewayHttpUrl}/api/legal/docs/${slug}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as LegalDoc;
    if (!doc?.markdown || !doc.version) return null;
    return doc;
  } catch {
    return null;
  }
}

// ── Inline rendering: **bold** + [text](href) ──────────────────────────────

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on links and bold spans, preserving the delimiters.
  const parts = text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g);
  parts.forEach((part, i) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const [, label, href] = link;
      if (href.startsWith('/')) {
        out.push(
          <Link key={`${keyBase}-${i}`} href={href} className="text-teal-300 hover:underline">
            {label}
          </Link>,
        );
      } else {
        out.push(
          <a key={`${keyBase}-${i}`} href={href} target="_blank" rel="noopener noreferrer" className="text-teal-300 hover:underline">
            {label}
          </a>,
        );
      }
      return;
    }
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      out.push(
        <strong key={`${keyBase}-${i}`} className="text-[rgb(var(--text-primary))]">
          {bold[1]}
        </strong>,
      );
      return;
    }
    if (part) out.push(part);
  });
  return out;
}

// ── Block rendering ─────────────────────────────────────────────────────────

export function LegalMarkdown({ markdown }: { markdown: string }) {
  const blocks: ReactNode[] = [];
  const lines = markdown.split(/\r?\n/);
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = (key: string) => {
    if (!para.length) return;
    blocks.push(
      <p key={key} className="text-sm text-[rgb(var(--text-secondary))] leading-relaxed">
        {renderInline(para.join(' '), key)}
      </p>,
    );
    para = [];
  };
  const flushList = (key: string) => {
    if (!list.length) return;
    blocks.push(
      <ul key={key} className="list-disc pl-5 space-y-1.5 text-sm text-[rgb(var(--text-secondary))] leading-relaxed">
        {list.map((item, i) => (
          <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const key = `b${idx}`;
    if (line.startsWith('### ')) {
      flushPara(`${key}p`);
      flushList(`${key}l`);
      blocks.push(
        <h3 key={key} className="text-base font-semibold text-[rgb(var(--text-primary))] pt-2">
          {line.slice(4)}
        </h3>,
      );
    } else if (line.startsWith('## ')) {
      flushPara(`${key}p`);
      flushList(`${key}l`);
      blocks.push(
        <h2 key={key} className="text-lg font-semibold text-[rgb(var(--text-primary))] pt-4">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith('- ')) {
      flushPara(`${key}p`);
      list.push(line.slice(2));
    } else if (line.trim() === '') {
      flushPara(`${key}p`);
      flushList(`${key}l`);
    } else {
      flushList(`${key}l`);
      para.push(line.trim());
    }
  });
  flushPara('tailp');
  flushList('taill');

  return <div className="space-y-4">{blocks}</div>;
}
