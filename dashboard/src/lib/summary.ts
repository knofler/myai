// Sentence helpers for the §5.1 "one-line answer" (plan/DESIGN_LANGUAGE.md §5,
// §5a). Every primary screen leads with a plain-English sentence that says
// what happened and what needs the operator — counts in words, never a stat
// dump. These four helpers keep that prose grammatical across 30+ pages
// without each page hand-rolling its own pluralisation.

/** "1 repo" / "20 repos". Pass an irregular plural as the third argument. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Third-person verb agreement: verb(1, 'needs', 'need') → "needs". */
export function verb(n: number, singularForm: string, pluralForm: string): string {
  return n === 1 ? singularForm : pluralForm;
}

/** Join clauses like prose: "a" · "a and b" · "a, b and c". Empty strings are dropped. */
export function joinClauses(parts: Array<string | null | undefined | false>): string {
  const p = parts.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (p.length <= 1) return p[0] ?? '';
  return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

/** Capitalise the first character only — for a clause that opens a sentence. */
export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * A rate written the way a person would say it: "about 379 a day", not
 * "about 379.0 a day". A decimal only earns its place when the whole number
 * would lose real information (under 10), and a thousands separator goes in
 * above 9,999.
 */
export function rate(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n > 0 && n < 10) return String(Math.round(n * 10) / 10);
  return Math.round(n).toLocaleString('en-AU');
}
