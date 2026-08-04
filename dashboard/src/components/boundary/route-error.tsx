'use client';

import { useEffect } from 'react';

// Matches the shape of a gateway-down failure (fetch throws, proxy surfaces a
// 503, or a raw connection refusal) so we can show a distinct "it's not you,
// the gateway is restarting/failing over" message instead of a generic error.
const GATEWAY_UNREACHABLE_PATTERNS = [
  /fetch failed/i,
  /econnrefused/i,
  /\b503\b/,
  /service unavailable/i,
  /network ?error/i,
  /timed? ?out/i,
  /gateway/i,
];

function isGatewayUnreachable(error: Error): boolean {
  return GATEWAY_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(error.message));
}

export function RouteError({
  title,
  error,
  reset,
  logLabel,
}: {
  /** Human label used in the default copy, e.g. "Logs", "Audit & Permissions". */
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
  /** Override the console.error prefix; defaults to `title`. */
  logLabel?: string;
}) {
  useEffect(() => {
    console.error(`[myAI] ${logLabel ?? title} error:`, error);
  }, [error, logLabel, title]);

  const gatewayDown = isGatewayUnreachable(error);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mt-12 text-center space-y-4">
        <h2 className="text-lg font-semibold text-zinc-200">
          {gatewayDown ? 'Gateway unreachable' : `${title} unavailable`}
        </h2>
        <p className="text-sm text-zinc-500 max-w-md mx-auto">
          {gatewayDown
            ? "Couldn't reach the myAI gateway — it may be restarting or mid-failover. This usually clears up within a minute."
            : error.message || `Could not load ${title.toLowerCase()} data.`}
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
