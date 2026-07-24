import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { z } from "zod";
import { connectDB } from "__DB_IMPORT__"; // Replace with your DB connection import
import { getAuthUser, AuthError } from "__AUTH_IMPORT__"; // Replace with your auth helper import
import HelpArticle from "__MODELS_PATH__/HelpArticle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id);
}

type RouteContext = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const feedbackSchema = z.object({
  helpful: z.boolean({ required_error: "The 'helpful' field is required" }),
});

// ---------------------------------------------------------------------------
// POST /api/connect/help/[id]/feedback
// ---------------------------------------------------------------------------

/**
 * Submit feedback on a help article (helpful or not helpful).
 * Increments the appropriate counter.
 *
 * Auth: required
 * Body: { helpful: boolean }
 * Response 200: { data: { helpful: number, notHelpful: number } }
 * Response 400: { error: string }
 * Response 401: { error: string }
 * Response 404: { error: string }
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await getAuthUser(request);
    const { id } = await context.params;

    if (!isValidObjectId(id)) {
      return NextResponse.json(
        { error: "Invalid help article ID" },
        { status: 400 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const validation = feedbackSchema.safeParse(body);
    if (!validation.success) {
      const firstError = validation.error.errors[0];
      return NextResponse.json(
        { error: firstError.message },
        { status: 400 }
      );
    }

    await connectDB();

    const { helpful } = validation.data;

    const incrementField = helpful ? { helpful: 1 } : { notHelpful: 1 };

    const article = await HelpArticle.findByIdAndUpdate(
      id,
      { $inc: incrementField },
      { new: true }
    ).lean();

    if (!article) {
      return NextResponse.json(
        { error: "Help article not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { data: { helpful: article.helpful, notHelpful: article.notHelpful } },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/help/[id]/feedback] POST error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
