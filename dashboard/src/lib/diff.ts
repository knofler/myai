// Line-based diff for the agent/skill source editor's preview pane. Pure and
// dependency-free (no npm add) — an O(n*m) LCS table is plenty for the
// hundred-or-so-line markdown files agents/skills ship as.

export type DiffLineType = 'add' | 'remove' | 'context';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] });
    j++;
  }
  return result;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  return lines.reduce<DiffStats>(
    (acc, l) => {
      if (l.type === 'add') acc.additions++;
      if (l.type === 'remove') acc.deletions++;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
}
