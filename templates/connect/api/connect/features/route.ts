import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { z } from "zod";
import { connectDB } from "__DB_IMPORT__";
import { getAuthUser, AuthError } from "__AUTH_IMPORT__";
import FeatureRequest from "__MODELS_PATH__/FeatureRequest";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const createFeatureSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200, "Title cannot exceed 200 characters"),
  description: z.string().min(10, "Description must be at least 10 characters").max(5000, "Description cannot exceed 5000 characters"),
  userProblem: z.string().max(2000, "User problem cannot exceed 2000 characters").optional(),
  proposedSolution: z.string().max(3000, "Proposed solution cannot exceed 3000 characters").optional(),
  priority: z.enum(["must-have", "should-have", "nice-to-have"]).default("nice-to-have"),
});

// ---------------------------------------------------------------------------
// GET /api/connect/features
// ---------------------------------------------------------------------------

/**
 * List feature requests with optional filtering, sorting, and pagination.
 *
 * Auth: required
 * Query: status?, priority?, sort? (newest|votes), limit? (default 50), page? (default 1)
 * Response 200: { data: FeatureRequest[], total: number, page: number, pages: number }
 * Response 401: { error: string }
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await getAuthUser(request);
    await connectDB();

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const priority = searchParams.get("priority");
    const sort = searchParams.get("sort") || "newest";
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10) || 50, 1), 100);
    const page = Math.max(parseInt(searchParams.get("page") || "1", 10) || 1, 1);
    const skip = (page - 1) * limit;

    // Build filter
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    // Build sort
    const sortOption: Record<string, 1 | -1> =
      sort === "votes" ? { upvotes: -1 } : { createdAt: -1 };

    const [features, total] = await Promise.all([
      FeatureRequest.find(filter)
        .populate("userId", "name email")
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      FeatureRequest.countDocuments(filter),
    ]);

    return NextResponse.json(
      {
        data: features,
        total,
        page,
        pages: Math.ceil(total / limit),
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/features] GET error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/connect/features
// ---------------------------------------------------------------------------

/**
 * Create a new feature request.
 *
 * Auth: required
 * Body: { title, description, userProblem, proposedSolution?, priority? }
 * Response 201: { data: FeatureRequest }
 * Response 400: { error: string }
 * Response 401: { error: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await getAuthUser(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const validation = createFeatureSchema.safeParse(body);
    if (!validation.success) {
      const firstError = validation.error.errors[0];
      return NextResponse.json(
        { error: firstError.message },
        { status: 400 }
      );
    }

    await connectDB();

    const feature = await FeatureRequest.create({
      ...validation.data,
      requestedBy: "user",
      userId: new Types.ObjectId(userId),
      status: "reported",
    });

    const created = await FeatureRequest.findById(feature._id).lean();

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/features] POST error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
