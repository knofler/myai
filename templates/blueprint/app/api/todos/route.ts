import { NextResponse } from "next/server";
import { z } from "zod";
import { connectToDatabase } from "@/app/lib/mongodb";
import { TodoModel } from "@/app/models/Todo";

export const dynamic = "force-dynamic";

const createTodoSchema = z.object({
  title: z.string().min(1).max(200),
});

/** GET /api/todos — list todos (demo CRUD endpoint). */
export async function GET() {
  try {
    await connectToDatabase();
    const todos = await TodoModel.find().sort({ createdAt: -1 }).lean();
    return NextResponse.json({ todos });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

/** POST /api/todos — create a todo. */
export async function POST(request: Request) {
  const parsed = createTodoSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    await connectToDatabase();
    const todo = await TodoModel.create({ title: parsed.data.title });
    return NextResponse.json({ todo }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
