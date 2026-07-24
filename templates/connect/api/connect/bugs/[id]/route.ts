import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { z } from "zod";
import { connectDB } from "__DB_IMPORT__"; // Replace with your DB connection import
import { getAuthUser, AuthError } from "__AUTH_IMPORT__"; // Replace with your auth helper import
import BugReport from "__MODELS_PATH__/BugReport";

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

const updateBugSchema = z.object({
  status: z.enum(["reported", "triaged", "working", "solved", "deployed", "rejected", "duplicate"]).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  assignedAgent: z.string().optional(),
  aiAnalysis: z.string().optional(),
  resolution: z.string().optional(),
  prUrl: z.string().optional(),
  linkedCommit: z.string().optional(),
  rejectionReason: z.string().optional(),
  duplicateOf: z.string().refine((val) => Types.ObjectId.isValid(val), { message: "Invalid ObjectId for duplicateOf" }).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/connect/bugs/[id]
// ---------------------------------------------------------------------------

/**
 * Get a single bug report by ID.
 *
 * Auth: required
 * Response 200: { data: BugReport }
 * Response 400: { error: string }
 * Response 401: { error: string }
 * Response 404: { error: string }
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await getAuthUser(request);
    const { id } = await context.params;

    if (!isValidObjectId(id)) {
      return NextResponse.json(
        { error: "Invalid bug report ID" },
        { status: 400 }
      );
    }

    await connectDB();

    const bug = await BugReport.findById(id).lean();

    if (!bug) {
      return NextResponse.json(
        { error: "Bug report not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: bug }, { status: 200 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/bugs/[id]] GET error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/connect/bugs/[id]
// ---------------------------------------------------------------------------

/**
 * Update a bug report. Auto-sets timestamp fields based on status changes.
 *
 * Auth: required
 * Body: Partial<{ status, severity, assignedAgent, aiAnalysis, resolution, prUrl, linkedCommit, rejectionReason, duplicateOf }>
 * Response 200: { data: BugReport }
 * Response 400: { error: string }
 * Response 401: { error: string }
 * Response 404: { error: string }
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { userId } = await getAuthUser(request);
    const { id } = await context.params;

    if (!isValidObjectId(id)) {
      return NextResponse.json(
        { error: "Invalid bug report ID" },
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

    const validation = updateBugSchema.safeParse(body);
    if (!validation.success) {
      const firstError = validation.error.errors[0];
      return NextResponse.json(
        { error: firstError.message },
        { status: 400 }
      );
    }

    await connectDB();

    const bug = await BugReport.findById(id);

    if (!bug) {
      return NextResponse.json(
        { error: "Bug report not found" },
        { status: 404 }
      );
    }

    const updates = validation.data;

    // Auto-set timestamp fields based on status transitions
    if (updates.status) {
      switch (updates.status) {
        case "triaged":
          bug.triagedAt = new Date();
          break;
        case "working":
          bug.workStartedAt = new Date();
          break;
        case "solved":
          bug.solvedAt = new Date();
          break;
        case "deployed":
          bug.deployedAt = new Date();
          break;
      }
      bug.status = updates.status;
    }

    if (updates.severity !== undefined) bug.severity = updates.severity;
    if (updates.assignedAgent !== undefined) bug.assignedAgent = updates.assignedAgent;
    if (updates.aiAnalysis !== undefined) bug.aiAnalysis = updates.aiAnalysis;
    if (updates.resolution !== undefined) bug.resolution = updates.resolution;
    if (updates.prUrl !== undefined) bug.prUrl = updates.prUrl;
    if (updates.linkedCommit !== undefined) bug.linkedCommit = updates.linkedCommit;
    if (updates.rejectionReason !== undefined) bug.rejectionReason = updates.rejectionReason;
    if (updates.duplicateOf !== undefined) bug.duplicateOf = new Types.ObjectId(updates.duplicateOf);

    await bug.save();

    const updated = await BugReport.findById(id).lean();

    return NextResponse.json({ data: updated }, { status: 200 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/bugs/[id]] PATCH error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
