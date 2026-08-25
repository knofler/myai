/**
 * Cursor pagination helpers (task-690e3618).
 *
 * Opaque cursor = base64url JSON of the last row's sort-key values. Combined
 * with a stable (unique) tiebreaker field, this survives inserts/updates
 * between pages without the classic offset-pagination skip/dupe bugs.
 *
 * Encoding is intentionally uninterpreted by callers — treat `nextCursor` as
 * an opaque token, not a value to construct or parse.
 */

export interface SortKey {
  field: string;
  /** Value from the last row of the current page, in the same type the
   *  underlying store field holds (Date stays a Date, not an ISO string). */
  value: unknown;
}

/** Encode a cursor from an ordered list of sort-key values. */
export function encodeCursor(keys: SortKey[]): string {
  const payload = keys.map((k) => [k.field, k.value instanceof Date ? k.value.toISOString() : k.value]);
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/** Decode a cursor back into its raw [field, value] pairs. Returns null on any malformed input — callers should treat that as "start from the beginning" rather than error out on a corrupted/foreign token. */
export function decodeCursor(cursor: string): Array<[string, unknown]> | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (!Array.isArray(parsed)) return null;
    return parsed as Array<[string, unknown]>;
  } catch {
    return null;
  }
}

/**
 * Build the "rows after this cursor" Mongo filter for a compound ascending
 * sort `[a, b, c]`: `(a > va) OR (a = va AND b > vb) OR (a = va AND b = vb AND c > vc)`.
 * Every field in `sortFields` must be ascending (matches this repo's existing
 * list sorts) — descending compound cursors aren't needed by any caller yet.
 */
export function buildAfterFilter(sortFields: SortKey[]): Record<string, unknown> {
  const orClauses: Record<string, unknown>[] = [];
  for (let i = 0; i < sortFields.length; i++) {
    const clause: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) clause[sortFields[j].field] = sortFields[j].value;
    clause[sortFields[i].field] = { $gt: sortFields[i].value };
    orClauses.push(clause);
  }
  return { $or: orClauses };
}

/**
 * Reconstruct typed SortKey values from a decoded cursor against a template
 * (the field order + which fields are Dates). Returns null if the cursor's
 * field names don't match the template shape (stale/foreign cursor).
 */
export function hydrateCursor(cursor: string, template: Array<{ field: string; isDate?: boolean }>): SortKey[] | null {
  const decoded = decodeCursor(cursor);
  if (!decoded || decoded.length !== template.length) return null;
  const result: SortKey[] = [];
  for (let i = 0; i < template.length; i++) {
    const [field, value] = decoded[i];
    if (field !== template[i].field) return null;
    result.push({ field, value: template[i].isDate ? new Date(value as string) : value });
  }
  return result;
}
