import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
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
// POST /api/connect/features/[id]/vote
// ---------------------------------------------------------------------------

/**
 * Toggle upvote on a feature request.
 * If the user has already voted, their vote is removed (decrement).
 * If they have not voted, their vote is added (increment).
 *
 * Auth: required
 * Response 200: { data: { upvotes: number, voted: boolean } }
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
        { error: "Invalid feature request ID" },
        { status: 400 }
      );
    }

    await connectDB();

    const userObjectId = new Types.ObjectId(userId);

    const feature = await FeatureRequest.findById(id);

    if (!feature) {
      return NextResponse.json(
        { error: "Feature request not found" },
        { status: 404 }
      );
    }

    // Check if user already voted
    const alreadyVoted = feature.upvotedBy.some(
      (voterId: Types.ObjectId) => voterId.toString() === userId
    );

    if (alreadyVoted) {
      // Remove vote
      await FeatureRequest.findByIdAndUpdate(id, {
        $pull: { upvotedBy: userObjectId },
        $inc: { upvotes: -1 },
      });

      const updated = await FeatureRequest.findById(id).lean();

      return NextResponse.json(
        { data: { upvotes: updated!.upvotes, voted: false } },
        { status: 200 }
      );
    } else {
      // Add vote
      await FeatureRequest.findByIdAndUpdate(id, {
        $addToSet: { upvotedBy: userObjectId },
        $inc: { upvotes: 1 },
      });

      const updated = await FeatureRequest.findById(id).lean();

      return NextResponse.json(
        { data: { upvotes: updated!.upvotes, voted: true } },
        { status: 200 }
      );
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/features/[id]/vote] POST error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
