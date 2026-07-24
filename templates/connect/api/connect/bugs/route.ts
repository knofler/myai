import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { z } from "zod";
import { connectDB } from "__DB_IMPORT__";
import { getAuthUser, AuthError } from "__AUTH_IMPORT__";
import BugReport from "__MODELS_PATH__/BugReport";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const createBugSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200, "Title cannot exceed 200 characters"),
  description: z.string().min(10, "Description must be at least 10 characters").max(5000, "Description cannot exceed 5000 characters"),
  stepsToReproduce: z.string().max(3000, "Steps to reproduce cannot exceed 3000 characters").optional(),
  expectedBehavior: z.string().max(2000, "Expected behavior cannot exceed 2000 characters").optional(),
  actualBehavior: z.string().max(2000, "Actual behavior cannot exceed 2000 characters").optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  appRoute: z.string().optional(),
  browser: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/connect/bugs
// ---------------------------------------------------------------------------

/**
 * List bug reports with optional filtering and pagination.
 *
 * Auth: required
 * Query: status?, severity?, limit? (default 50), page? (default 1)
 * Response 200: { data: BugReport[], total: number, page: number, pages: number }
 * Response 401: { error: string }
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await getAuthUser(request);
    await connectDB();

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10) || 50, 1), 100);
    const page = Math.max(parseInt(searchParams.get("page") || "1", 10) || 1, 1);
    const skip = (page - 1) * limit;

    // Build filter
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (severity) filter.severity = severity;

    const [bugs, total] = await Promise.all([
      BugReport.find(filter)
        .populate("userId", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BugReport.countDocuments(filter),
    ]);

    return NextResponse.json(
      {
        data: bugs,
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

    console.error("[api/connect/bugs] GET error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/connect/bugs
// ---------------------------------------------------------------------------

/**
 * Create a new bug report.
 *
 * Auth: required
 * Body: { title, description, stepsToReproduce?, expectedBehavior?, actualBehavior?, severity?, appRoute?, browser? }
 * Response 201: { data: BugReport }
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

    const validation = createBugSchema.safeParse(body);
    if (!validation.success) {
      const firstError = validation.error.errors[0];
      return NextResponse.json(
        { error: firstError.message },
        { status: 400 }
      );
    }

    await connectDB();

    const bug = await BugReport.create({
      ...validation.data,
      reportedBy: "user",
      userId: new Types.ObjectId(userId),
      status: "reported",
    });

    const created = await BugReport.findById(bug._id).lean();

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/bugs] POST error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
