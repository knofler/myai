/**
 * Uptime tracking for the myAI gateway.
 *
 * A lightweight, in-process availability recorder. Each time the gateway runs
 * its periodic deep health check (see health-alerter), the result is fed here
 * via `recordSample`. We keep a bounded ring buffer of recent samples and
 * derive availability percentages over rolling windows — the numbers a public
 * status page shows paying customers ("99.9% over 24h").
 *
 * In-memory by design: it resets on restart (a restart is itself downtime the
 * external uptime monitor records). For long-horizon SLA reporting an external
 * probe (UptimeRobot / Better Stack hitting `/health`) is the source of truth;
 * this gives an at-a-glance number without a second service.
 */

export type SampleStatus = 'healthy' | 'degraded' | 'unhealthy';

interface UptimeSample {
  at: number; // epoch ms
  status: SampleStatus;
}

export interface UptimeWindow {
  windowMs: number;
  samples: number;
  /** Fraction (0–1) of samples that were healthy OR degraded (i.e. "up"). */
  uptime: number;
  /** Fraction (0–1) of samples that were fully healthy. */
  healthy: number;
}

export interface UptimeStats {
  startedAt: string;
  uptimeSeconds: number;
  totalSamples: number;
  current: SampleStatus | null;
  lastSampleAt: string | null;
  windows: {
    hour: UptimeWindow;
    day: UptimeWindow;
    week: UptimeWindow;
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// Bounded ring buffer. At a 30-min sample cadence a week is ~336 samples; cap
// well above that so a faster cadence still retains a full week.
const MAX_SAMPLES = 5000;

const samples: UptimeSample[] = [];
let startedAt = 0;

/** Reset all state (used by tests and on explicit re-init). */
export function resetUptime(now = Date.now()): void {
  samples.length = 0;
  startedAt = now;
}

/** Record a single health sample. Trims the buffer to `MAX_SAMPLES`. */
export function recordSample(status: SampleStatus, now = Date.now()): void {
  if (startedAt === 0) startedAt = now;
  samples.push({ at: now, status });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function windowStats(windowMs: number, now: number): UptimeWindow {
  const cutoff = now - windowMs;
  const inWindow = samples.filter((s) => s.at >= cutoff);
  const n = inWindow.length;
  if (n === 0) {
    return { windowMs, samples: 0, uptime: 1, healthy: 1 };
  }
  const up = inWindow.filter((s) => s.status !== 'unhealthy').length;
  const healthy = inWindow.filter((s) => s.status === 'healthy').length;
  return {
    windowMs,
    samples: n,
    uptime: up / n,
    healthy: healthy / n,
  };
}

/** Compute rolling-window availability from the recorded samples. */
export function getUptimeStats(now = Date.now()): UptimeStats {
  const last = samples.length > 0 ? samples[samples.length - 1] : null;
  const begin = startedAt || now;
  return {
    startedAt: new Date(begin).toISOString(),
    uptimeSeconds: Math.floor((now - begin) / 1000),
    totalSamples: samples.length,
    current: last ? last.status : null,
    lastSampleAt: last ? new Date(last.at).toISOString() : null,
    windows: {
      hour: windowStats(HOUR_MS, now),
      day: windowStats(DAY_MS, now),
      week: windowStats(WEEK_MS, now),
    },
  };
}
