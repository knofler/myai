import { NextResponse } from 'next/server';
import { connectDB, Skill } from '@/lib/db';

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  await connectDB();
  const skill = await Skill.findOne({ name }).select('-__v -contentHash -embedding').lean();
  if (!skill) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(skill);
}
