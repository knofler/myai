import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { z } from "zod";
import { connectDB } from "__DB_IMPORT__"; // Replace with your DB connection import
import { getAuthUser, AuthError } from "__AUTH_IMPORT__"; // Replace with your auth helper import
import FeatureRequest from "__MODELS_PATH__/FeatureRequest";

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

const updateFeatureSchema = z.object({
  status: z.enum(["reported", "triaged", "working", "solved", "deployed", "rejected", "duplicate"]).optional(),
  priority: z.enum(["must-have", "should-have", "nice-to-have"]).optional(),
  assignedAgent: z.string().optional(),
  aiAnalysis: z.string().optional(),
  implementationPlan: z.string().optional(),
  prUrl: z.string().optional(),
  linkedCommit: z.string().optional(),
  rejectionReason: z.string().optional(),
  duplicateOf: z.string().refine((val) => Types.ObjectId.isValid(val), { message: "Invalid ObjectId for duplicateOf" }).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/connect/features/[id]
// ---------------------------------------------------------------------------

/**
 * Get a single feature request by ID.
 *
 * Auth: required
 * Response 200: { data: FeatureRequest }
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
        { error: "Invalid feature request ID" },
        { status: 400 }
      );
    }

    await connectDB();

    const feature = await FeatureRequest.findById(id).lean();

    if (!feature) {
      return NextResponse.json(
        { error: "Feature request not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: feature }, { status: 200 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/features/[id]] GET error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/connect/features/[id]
// ---------------------------------------------------------------------------

/**
 * Update a feature request. Auto-sets timestamp fields based on status changes.
 *
 * Auth: required
 * Body: Partial<{ status, priority, assignedAgent, aiAnalysis, implementationPlan, prUrl, linkedCommit, rejectionReason, duplicateOf }>
 * Response 200: { data: FeatureRequest }
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
        { error: "Invalid feature request ID" },
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

    const validation = updateFeatureSchema.safeParse(body);
    if (!validation.success) {
      const firstError = validation.error.errors[0];
      return NextResponse.json(
        { error: firstError.message },
        { status: 400 }
      );
    }

    await connectDB();

    const feature = await FeatureRequest.findById(id);

    if (!feature) {
      return NextResponse.json(
        { error: "Feature request not found" },
        { status: 404 }
      );
    }

    const updates = validation.data;

    // Auto-set timestamp fields based on status transitions
    if (updates.status) {
      switch (updates.status) {
        case "triaged":
          feature.triagedAt = new Date();
          break;
        case "working":
          feature.workStartedAt = new Date();
          break;
        case "solved":
          feature.solvedAt = new Date();
          break;
        case "deployed":
          feature.deployedAt = new Date();
          break;
      }
      feature.status = updates.status;
    }

    if (updates.priority !== undefined) feature.priority = updates.priority;
    if (updates.assignedAgent !== undefined) feature.assignedAgent = updates.assignedAgent;
    if (updates.aiAnalysis !== undefined) feature.aiAnalysis = updates.aiAnalysis;
    if (updates.implementationPlan !== undefined) feature.implementationPlan = updates.implementationPlan;
    if (updates.prUrl !== undefined) feature.prUrl = updates.prUrl;
    if (updates.linkedCommit !== undefined) feature.linkedCommit = updates.linkedCommit;
    if (updates.rejectionReason !== undefined) feature.rejectionReason = updates.rejectionReason;
    if (updates.duplicateOf !== undefined) feature.duplicateOf = new Types.ObjectId(updates.duplicateOf);

    await feature.save();

    const updated = await FeatureRequest.findById(id).lean();

    return NextResponse.json({ data: updated }, { status: 200 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/features/[id]] PATCH error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
