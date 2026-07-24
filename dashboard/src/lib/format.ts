// Shared time/number formatters — every page renders Sydney time through these.

const SYDNEY = 'Australia/Sydney';

function toMs(date: Date | string): number {
  const ms = new Date(date).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

export function timeAgo(date?: Date | string | null): string {
  if (!date) return '—';
  const ms = toMs(date);
  if (Number.isNaN(ms)) return '—';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function timeUntil(date?: Date | string | null): string {
  if (!date) return '—';
  const ms = toMs(date);
  if (Number.isNaN(ms)) return '—';
  const mins = Math.floor((ms - Date.now()) / 60000);
  if (mins < 0) return 'overdue';
  if (mins < 1) return '<1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function fmtSydney(date?: Date | string | null, style: 'datetime' | 'date' | 'time' | 'full' = 'datetime'): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  if (style === 'date') return d.toLocaleDateString('en-AU', { timeZone: SYDNEY, day: 'numeric', month: 'short' });
  if (style === 'time') return d.toLocaleTimeString('en-AU', { timeZone: SYDNEY, hour: '2-digit', minute: '2-digit' });
  if (style === 'full') return d.toLocaleString('en-AU', { timeZone: SYDNEY, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('en-AU', { timeZone: SYDNEY, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtUtc(date?: Date | string | null): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(start?: Date | string | null, end?: Date | string | null): string {
  if (!start) return '—';
  const startMs = toMs(start);
  if (Number.isNaN(startMs)) return '—';
  const endMs = end ? toMs(end) : Date.now();
  if (Number.isNaN(endMs)) return '—';
  const ms = endMs - startMs;
  if (ms < 0) return '—';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
