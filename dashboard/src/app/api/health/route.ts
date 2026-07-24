import { NextResponse } from 'next/server';
import {
  connectDB,
  Agent,
  Skill,
  Task,
  Vector,
  Pattern,
  Session,
  Schedule,
  BudgetUsage,
} from '@/lib/db';

export const dynamic = 'force-dynamic';

interface CheckResult {
  status: 'ok' | 'error';
  latencyMs: number;
  toolCount?: number;
}

interface ModelCounts {
  agents: number;
  skills: number;
  tasks: number;
  vectors: number;
  patterns: number;
  sessions: number;
  schedules: number;
  budgetUsages: number;
}

async function checkDatabase(): Promise<{ check: CheckResult; models: ModelCounts }> {
  const start = Date.now();
  try {
    await connectDB();

    const [agents, skills, tasks, vectors, patterns, sessions, schedules, budgetUsages] =
      await Promise.all([
        Agent.countDocuments(),
        Skill.countDocuments(),
        Task.countDocuments(),
        Vector.countDocuments(),
        Pattern.countDocuments(),
        Session.countDocuments(),
        Schedule.countDocuments(),
        BudgetUsage.countDocuments(),
      ]);

    return {
      check: { status: 'ok', latencyMs: Date.now() - start },
      models: { agents, skills, tasks, vectors, patterns, sessions, schedules, budgetUsages },
    };
  } catch {
    return {
      check: { status: 'error', latencyMs: Date.now() - start },
      models: {
        agents: 0,
        skills: 0,
        tasks: 0,
        vectors: 0,
        patterns: 0,
        sessions: 0,
        schedules: 0,
        budgetUsages: 0,
      },
    };
  }
}

async function checkGateway(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    // In Docker the gateway is reachable via its compose service name, not localhost
    const gatewayUrl = process.env.GATEWAY_MCP_URL ?? 'http://gateway:3100/mcp';
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { status: 'error', latencyMs: Date.now() - start, toolCount: 0 };
    }

    const data = (await res.json()) as { result?: { tools?: unknown[] } };
    const toolCount = data?.result?.tools?.length ?? 0;

    return { status: 'ok', latencyMs: Date.now() - start, toolCount };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, toolCount: 0 };
  }
}

export async function GET() {
  const [dbResult, gatewayCheck] = await Promise.all([
    checkDatabase(),
    checkGateway(),
  ]);

  const dbUp = dbResult.check.status === 'ok';
  const gwUp = gatewayCheck.status === 'ok';

  let status: 'ok' | 'degraded' | 'error';
  if (dbUp && gwUp) {
    status = 'ok';
  } else if (!dbUp && !gwUp) {
    status = 'error';
  } else {
    status = 'degraded';
  }

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    checks: {
      database: dbResult.check,
      gateway: gatewayCheck,
      models: dbResult.models,
    },
    version: '0.1.0',
  });
}
