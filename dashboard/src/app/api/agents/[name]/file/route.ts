import { NextResponse } from 'next/server';
import { connectDB, Agent } from '@/lib/db';
import { containRoot, readFileAt, writeFileAndCommit, contentHashOf, parseFrontmatter } from '@/lib/md-editor';

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  await connectDB();
  const agent = (await Agent.findOne({ name }).select('filePath').lean()) as { filePath?: string } | null;
  if (!agent?.filePath) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const filePath = containRoot(agent.filePath);
  if (!filePath) return NextResponse.json({ error: 'Source file path is invalid' }, { status: 500 });

  try {
    const content = await readFileAt(filePath);
    return NextResponse.json({ filePath, content });
  } catch {
    return NextResponse.json({ error: 'Source file unreadable' }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }

  await connectDB();
  const agent = (await Agent.findOne({ name }).select('filePath').lean()) as { filePath?: string } | null;
  if (!agent?.filePath) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const filePath = containRoot(agent.filePath);
  if (!filePath) return NextResponse.json({ error: 'Source file path is invalid' }, { status: 500 });

  const commitMessage =
    typeof body.commitMessage === 'string' && body.commitMessage.trim()
      ? body.commitMessage.trim()
      : `chore(agent): edit ${name} via dashboard editor`;

  let result;
  try {
    result = await writeFileAndCommit(filePath, body.content, commitMessage);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Write failed' }, { status: 500 });
  }

  const { data, body: instructions } = parseFrontmatter(body.content);
  await Agent.updateOne(
    { name },
    {
      $set: {
        ...(data.description ? { description: data.description } : {}),
        ...(data.tools ? { tools: data.tools.split(',').map((t: string) => t.trim()) } : {}),
        instructions,
        contentHash: contentHashOf(body.content),
        loadedAt: new Date(),
      },
    },
  );

  return NextResponse.json({ ok: true, ...result });
}
