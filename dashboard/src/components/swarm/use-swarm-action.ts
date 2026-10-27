'use client';

// useSwarmAction — run one audited operator action (POST /api/swarm/action)
// and keep a one-line notice of how it went. `pending` is the id of the thing
// being acted on, so only that button shows progress. A 401 means the browser
// is on the loopback auto-login without an operator sign-in: the notice then
// carries a sign-in link back to this page.
import { useCallback, useState } from 'react';
import type { SwarmActionRequest, SwarmActionResult } from '@/lib/swarm-control';

export interface ActionNotice {
  tone: 'ok' | 'err';
  text: string;
  signIn?: boolean;
}

const DONE: Record<SwarmActionRequest['verb'], string> = {
  tell: 'Message sent',
  ack: 'Marked read',
  release_claim: 'Claim released',
  handoff: 'Coordinator stepped down',
  stop_swarm: 'Swarm stopped',
};

export function useSwarmAction(onDone: () => void) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  const run = useCallback(
    async (id: string, req: SwarmActionRequest): Promise<boolean> => {
      setPending(id);
      setNotice(null);
      try {
        const res = await fetch('/api/swarm/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        const body = (await res.json().catch(() => null)) as (SwarmActionResult & { code?: string }) | null;
        if (res.ok && body?.ok) {
          setNotice({ tone: 'ok', text: `${DONE[req.verb]} · ${body.target}` });
          return true;
        }
        setNotice({
          tone: 'err',
          text: body && !body.ok ? body.error : `Action failed (HTTP ${res.status})`,
          signIn: res.status === 401,
        });
        return false;
      } catch {
        setNotice({ tone: 'err', text: 'The dashboard couldn’t reach its server. Nothing was done.' });
        return false;
      } finally {
        setPending(null);
        onDone();
      }
    },
    [onDone],
  );

  return { run, pending, notice, clearNotice: () => setNotice(null) };
}
