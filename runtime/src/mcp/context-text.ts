/**
 * Shared text helpers for the betaC context read/render path.
 *
 * `tighten` lived in context-bundle.ts; it is factored out here so both the
 * context-bundle renderer AND the context-read-service seam (ADR-016 phase 1)
 * can use the exact same truncation algorithm without an import cycle. No
 * behaviour change — the implementation is verbatim.
 */

/** Collapse whitespace and hard-truncate to `max` chars with an ellipsis. */
export function tighten(text: string | undefined | null, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
