// /api/ask — the dashboard's one interactive lane to a specialist agent.
//
// WHY THIS EXISTS. Every LLM path in this repo ran through a terminal: the CLI
// runner, `agent mode`, a Claude session. The dashboard could SHOW what the
// fleet had already done, but you could not ask it anything from the screen you
// were looking at. The gateway has carried `agents_invoke` the whole time — 62
// agents, an LLM call, an optional memory_context graft — with no caller on the
// web side at all. This is that caller.
//
// ROUTING / SPEND. Pinned to the `budget` tier, which the router resolves to
// DeepSeek (runtime/src/llm/router.ts: budget → chain ['deepseek', 'api'], with
// the api hop as the backstop if DeepSeek is down). DeepSeek is API-billed and
// sits OUTSIDE the Max/Fable subscription bucket, so every question here costs
// real money — small (a grounded ask measures ~700 in / a few hundred out) but
// never zero. The tier is deliberately NOT caller-selectable: an unbounded
// `tier` on an authenticated web route is a spend amplifier, and the operator
// asked for an ask-box, not a model picker.
//
// AUTH. No explicit guard here on purpose. `/ask` and `/api/ask` appear in
// neither PUBLIC_PREFIXES nor OPERATOR_PUBLIC in src/middleware.ts, whose
// matcher covers everything by default — so the operator-session wall already
// fronts both. Demo deployments reject the POST at that same choke point
// (DEMO_MODE blocks mutating requests), which is the correct default for a
// route that spends money.
//
// NOT `callGateway`. That helper hardcodes an 8s AbortSignal — right for the
// status reads it was written for, far too short for a model answer, which
// would surface as a silent `null` and read to the operator as "the gateway is
// down". Same URL and headers, its own timeout.
import { NextResponse } from 'next/server';
import { callGateway, GATEWAY_URL, gatewayHeaders } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A model answer is allowed far longer than a status read. */
const ASK_TIMEOUT_MS = 60_000;

/** Bounds one question's input cost. Well above any real question. */
const MAX_MESSAGE_CHARS = 4_000;

export interface AskResult {
  content: string;
  agent: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  elapsedMs: number;
  memoryContextIncluded: boolean;
}

interface AgentsListResponse {
  count: number;
  agents: { name: string; category: string; description: string }[];
}

/** GET → the agent roster for the picker. A plain read, so the 8s helper is fine. */
export async function GET() {
  const list = await callGateway<AgentsListResponse>('agents_list');
  if (!list) {
    return NextResponse.json(
      { error: 'could not reach the gateway', code: 'GATEWAY_UNREACHABLE', agents: [] },
      { status: 502 },
    );
  }
  return NextResponse.json({
    agents: (list.agents ?? []).map((a) => ({ name: a.name, category: a.category })),
  });
}

export async function POST(req: Request) {
  let body: { agent?: unknown; message?: unknown; repo?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'malformed JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined;

  if (!agent) {
    return NextResponse.json({ error: 'agent is required', code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: 'message is required', code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `message is longer than ${MAX_MESSAGE_CHARS} characters`, code: 'MESSAGE_TOO_LONG' },
      { status: 413 },
    );
  }

  // `includeMemoryContext` REQUIRES a repo (the gateway ignores it otherwise),
  // so the two always travel together. This is what makes an answer about this
  // fleet rather than a generic one.
  const args: Record<string, unknown> = {
    agent,
    message,
    tier: 'budget',
    ...(repo ? { repo, includeMemoryContext: true } : {}),
  };

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'agents_invoke', arguments: args },
        id: 1,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `gateway returned ${res.status}`, code: 'GATEWAY_ERROR' },
        { status: 502 },
      );
    }

    const json = await res.json();
    const text = json?.result?.content?.find?.((c: { type: string }) => c.type === 'text')?.text;
    if (!text) {
      return NextResponse.json(
        { error: 'gateway returned no content', code: 'EMPTY_RESPONSE' },
        { status: 502 },
      );
    }

    let parsed: Partial<AskResult> & { content?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: 'gateway returned malformed JSON', code: 'MALFORMED_RESPONSE' },
        { status: 502 },
      );
    }

    if (!parsed.content) {
      return NextResponse.json(
        { error: 'the agent returned an empty answer', code: 'EMPTY_ANSWER' },
        { status: 502 },
      );
    }

    // Echo the routing metadata through verbatim. The operator needs to see
    // WHICH provider and model actually answered: an agent's own prose will
    // happily claim to be something else (a DeepSeek call through a Claude-
    // authored agent file opens with "I'm running as Claude"), and only this
    // metadata is authoritative.
    const result: AskResult = {
      content: parsed.content,
      agent,
      provider: parsed.provider ?? 'unknown',
      model: parsed.model ?? 'unknown',
      inputTokens: parsed.inputTokens ?? 0,
      outputTokens: parsed.outputTokens ?? 0,
      costUsd: parsed.costUsd ?? 0,
      elapsedMs: parsed.elapsedMs ?? 0,
      memoryContextIncluded: parsed.memoryContextIncluded ?? false,
    };
    return NextResponse.json(result);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return NextResponse.json(
      {
        error: timedOut
          ? `the agent did not answer within ${ASK_TIMEOUT_MS / 1000}s`
          : 'could not reach the gateway',
        code: timedOut ? 'TIMEOUT' : 'GATEWAY_UNREACHABLE',
      },
      { status: timedOut ? 504 : 502 },
    );
  }
}
