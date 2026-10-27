// Boot reports — each Mac's 08:00 warm-up verdict, for Today's "Your Macs"
// card (dashboard redesign phase 4). scripts/morning_boot.sh writes one
// state/boot/BOOT_REPORT.<host>.md per Mac; the dashboard container reads them
// through its AI_ROOT mount. Parsing is pure (unit-tested); only
// readBootReports touches the filesystem.
//
// A report is a snapshot of the last boot, not of now: a Mac that hasn't booted
// for a week still shows last week's verdict. So every report carries when it
// ran, and the card says so.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type BootVerdict = 'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN';

export interface BootProblem {
  status: 'FAIL' | 'WARN';
  phase: string;
  detail: string;
}

export interface BootReport {
  host: string;
  verdict: BootVerdict;
  /** "3 failed, 3 warned" / "all phases passed". */
  summary: string;
  startedAt: string | null;
  problems: BootProblem[];
}

const VERDICTS: BootVerdict[] = ['GREEN', 'AMBER', 'RED'];
const TZ_OFFSET: Record<string, string> = { AEDT: '+11:00', AEST: '+10:00' };

/** Parse one BOOT_REPORT.<host>.md. `fallbackHost` comes from the file name. */
export function parseBootReport(md: string, fallbackHost: string): BootReport {
  const head = md.match(/^# BOOT REPORT\s+—\s+([A-Z]+)\s+—\s+(.+)$/m);
  const verdict = (head && (VERDICTS as string[]).includes(head[1]) ? head[1] : 'UNKNOWN') as BootVerdict;
  const host = md.match(/^- \*\*Host:\*\*\s+(\S+)/m)?.[1] ?? fallbackHost;
  const started = md.match(/^- \*\*Started:\*\*\s+(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]{4})/m);
  const startedAt =
    started && TZ_OFFSET[started[3]] ? new Date(`${started[1]}T${started[2]}${TZ_OFFSET[started[3]]}`).toISOString() : null;
  const problems: BootProblem[] = [];
  for (const m of md.matchAll(/^\|\s*(FAIL|WARN)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/gm)) {
    problems.push({ status: m[1] as BootProblem['status'], phase: m[2], detail: m[3].replace(/\s+/g, ' ').slice(0, 160) });
  }
  problems.sort((a, b) => (a.status === b.status ? 0 : a.status === 'FAIL' ? -1 : 1));
  return { host, verdict, summary: head?.[2]?.trim() ?? 'no verdict line', startedAt, problems };
}

const ORDER: Record<BootVerdict, number> = { RED: 0, AMBER: 1, UNKNOWN: 2, GREEN: 3 };

/** Worst first, then by host — the Mac that needs you leads. */
export function sortReports(reports: BootReport[]): BootReport[] {
  return [...reports].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.host.localeCompare(b.host));
}

/** Days since the boot ran (0 = today), or null when the report has no start time. */
export function bootAgeDays(r: Pick<BootReport, 'startedAt'>, now: Date = new Date()): number | null {
  if (!r.startedAt) return null;
  return Math.floor((now.getTime() - Date.parse(r.startedAt)) / 86_400_000);
}

/** Every report under <AI_ROOT>/state/boot, worst first. Missing dir → []. */
export async function readBootReports(dir = path.join(process.env.AI_ROOT ?? process.cwd(), 'state', 'boot')): Promise<BootReport[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const reports = await Promise.all(
    names
      .filter((n) => /^BOOT_REPORT\..+\.md$/.test(n))
      .map(async (n) => {
        try {
          return parseBootReport(await fs.readFile(path.join(dir, n), 'utf8'), n.slice('BOOT_REPORT.'.length, -'.md'.length));
        } catch {
          return null;
        }
      }),
  );
  return sortReports(reports.filter((r): r is BootReport => r !== null));
}
