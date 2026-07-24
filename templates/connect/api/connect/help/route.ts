import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "__DB_IMPORT__"; // Replace with your DB connection import
import { getAuthUser, AuthError } from "__AUTH_IMPORT__"; // Replace with your auth helper import
import HelpArticle from "__MODELS_PATH__/HelpArticle";

// ---------------------------------------------------------------------------
// GET /api/connect/help
// ---------------------------------------------------------------------------

/**
 * List help articles with optional category filter and text search.
 *
 * Auth: required
 * Query: category?, q? (text search)
 * Response 200: { data: HelpArticle[] }
 * Response 401: { error: string }
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await getAuthUser(request);
    await connectDB();

    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    const q = searchParams.get("q");

    // Build filter
    const filter: Record<string, unknown> = {};
    if (category) filter.category = category.toLowerCase();
    if (q) filter.$text = { $search: q };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = HelpArticle.find(filter);

    if (q) {
      query = query.select({ score: { $meta: "textScore" } });
      query = query.sort({ score: { $meta: "textScore" } });
    } else {
      query = query.sort({ category: 1, createdAt: -1 });
    }

    const articles = await query.lean();

    return NextResponse.json({ data: articles }, { status: 200 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/help] GET error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
