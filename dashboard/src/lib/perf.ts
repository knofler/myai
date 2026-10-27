// Page-speed telemetry (speed plan step 0, 2026-10-04). The operator reports
// "every click is slow" but nothing reproduces on the dev Mac — so measure the
// operator's REAL sessions: Web Vitals on hard loads, click→render on in-app
// (soft) navigations, tagged with route + device class. Pure helpers here; the
// beacon is components/perf-beacon.tsx, storage + summary is /api/perf.

export const PERF_METRICS = ['TTFB', 'FCP', 'LCP', 'INP', 'CLS', 'NAV'] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];
export type DeviceClass = 'phone' | 'tablet' | 'desktop';

export interface PerfSample {
  route: string;
  metric: PerfMetric;
  value: number;
  device: DeviceClass;
  vw: number;
  nav: 'hard' | 'soft';
}

export const MAX_BATCH = 50;
// 2 min is far past anything worth recording; CLS is unitless and tiny.
const MAX_VALUE = 120_000;

const ID_SEGMENT = /^(?:[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f-]{27,}|\d+|(?:task|mail|sv|wf|swarm|run)-[0-9a-z-]+)$/i;

/** "/work/task-1a2b…?tab=plans&repo=x" → "/work/:id?tab=plans". Only `tab` survives: it picks the page. */
export function normalizeRoute(input: string): string {
  let path = input;
  let query = '';
  const q = input.indexOf('?');
  if (q >= 0) {
    path = input.slice(0, q);
    query = input.slice(q + 1);
  }
  const segs = path.split('/').map((s) => (s && ID_SEGMENT.test(s) ? ':id' : s));
  let route = segs.join('/') || '/';
  if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
  const tab = new URLSearchParams(query).get('tab');
  if (tab && /^[a-z0-9-]{1,32}$/i.test(tab)) route += `?tab=${tab}`;
  return route.slice(0, 120);
}

export function deviceClass(viewportWidth: number): DeviceClass {
  if (viewportWidth < 640) return 'phone';
  if (viewportWidth < 1024) return 'tablet';
  return 'desktop';
}

/** Validate one untrusted sample from the beacon; null when malformed. */
export function sanitizeSample(raw: unknown): PerfSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.route !== 'string' || !r.route.startsWith('/')) return null;
  if (!PERF_METRICS.includes(r.metric as PerfMetric)) return null;
  const value = Number(r.value);
  if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) return null;
  const vw = Math.round(Number(r.vw));
  if (!Number.isFinite(vw) || vw <= 0 || vw > 10_000) return null;
  return {
    route: normalizeRoute(r.route),
    metric: r.metric as PerfMetric,
    value: r.metric === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value),
    device: deviceClass(vw),
    vw,
    nav: r.nav === 'soft' ? 'soft' : 'hard',
  };
}

export interface PerfSummaryRow {
  route: string;
  device: DeviceClass;
  metric: PerfMetric;
  n: number;
  p50: number;
  p95: number;
  max: number;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Group samples by route × device × metric; slowest p95 first. */
export function summarize(samples: Pick<PerfSample, 'route' | 'device' | 'metric' | 'value'>[]): PerfSummaryRow[] {
  const groups = new Map<string, number[]>();
  for (const s of samples) {
    const k = `${s.route}\u0000${s.device}\u0000${s.metric}`;
    const g = groups.get(k);
    if (g) g.push(s.value);
    else groups.set(k, [s.value]);
  }
  const rows: PerfSummaryRow[] = [];
  for (const [k, vals] of groups) {
    const [route, device, metric] = k.split('\u0000');
    vals.sort((a, b) => a - b);
    rows.push({
      route,
      device: device as DeviceClass,
      metric: metric as PerfMetric,
      n: vals.length,
      p50: pct(vals, 50),
      p95: pct(vals, 95),
      max: vals[vals.length - 1],
    });
  }
  return rows.sort((a, b) => b.p95 - a.p95);
}
