import { NextResponse } from 'next/server';
import { connectDB, Agent } from '@/lib/db';

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  await connectDB();
  const agent = await Agent.findOne({ name }).select('-__v -contentHash -embedding').lean();
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(agent);
}
