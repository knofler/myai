// GET /api/notifications/stream — Server-Sent Events feed of new notifications.
//
// The gateway notifier does not (yet) expose a live SSE endpoint of its own —
// it persists history and serves it via the `notifications_history` MCP tool.
// This route bridges that gap for the dashboard: it polls the gateway on an
// interval and pushes only *new* entries to the browser as SSE events, so the
// client consumes a real EventSource stream (matching the Phase 4 client hook
// design) without the gateway needing per-connection fan-out. When the gateway
// grows a native SSE route, this proxy can forward it unchanged.
//
// Event shape:  data: {"type":"notification","entry":{...}}\n\n
//        also:  data: {"type":"hello","entries":[...]}\n\n   (initial snapshot)
//        also:  : ping\n\n                                    (keep-alive comment)
//
// REALTIME_NOTIFICATIONS plan, Phase 5.
import { fetchNotificationHistory, type NotificationEntry } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 10_000;
const PING_MS = 25_000;

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  // Highest sentAt we've already delivered — only newer entries are pushed.
  let watermark = 0;
  const seen = new Set<string>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller closed — abort handler will clean up */
        }
      };

      // Initial snapshot so the bell + toasts have state immediately, and set
      // the watermark so we don't toast the entire backlog on connect.
      const initial = await safeFetch();
      for (const e of initial) {
        seen.add(e.id);
        watermark = Math.max(watermark, new Date(e.sentAt).getTime());
      }
      send({ type: 'hello', entries: initial });

      const poll = async () => {
        const entries = await safeFetch();
        // Oldest-first so toasts arrive in chronological order.
        const fresh = entries
          .filter((e) => !seen.has(e.id) && new Date(e.sentAt).getTime() > watermark)
          .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
        for (const e of fresh) {
          seen.add(e.id);
          watermark = Math.max(watermark, new Date(e.sentAt).getTime());
          send({ type: 'notification', entry: e });
        }
      };

      pollTimer = setInterval(poll, POLL_MS);
      pingTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, PING_MS);
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
      if (pingTimer) clearInterval(pingTimer);
    },
  });

  // Belt-and-suspenders: also clear on the request abort signal.
  req.signal.addEventListener('abort', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function safeFetch(): Promise<NotificationEntry[]> {
  try {
    return await fetchNotificationHistory(50);
  } catch (err) {
    console.warn('[api/notifications/stream] poll failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
