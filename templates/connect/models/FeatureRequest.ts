import mongoose, { Schema, Document, Model, Types } from "mongoose";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FEATURE_PRIORITIES = [
  "must-have",
  "should-have",
  "nice-to-have",
] as const;

export const FEATURE_STATUSES = [
  "reported",
  "triaged",
  "working",
  "solved",
  "deployed",
  "rejected",
  "duplicate",
] as const;

export const FEATURE_REQUESTERS = ["user", "ai"] as const;

// ---------------------------------------------------------------------------
// TypeScript Types
// ---------------------------------------------------------------------------

export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export type FeatureRequester = (typeof FEATURE_REQUESTERS)[number];

export interface IFeatureRequest {
  title: string;
  description: string;
  userProblem: string;
  proposedSolution?: string;
  priority: FeaturePriority;
  status: FeatureStatus;
  requestedBy: FeatureRequester;
  requesterEmail?: string;
  userId?: Types.ObjectId;
  assignedAgent?: string;
  aiAnalysis?: string;
  implementationPlan?: string;
  prUrl?: string;
  linkedCommit?: string;
  duplicateOf?: Types.ObjectId;
  rejectionReason?: string;
  upvotes: number;
  upvotedBy: Types.ObjectId[];
  triagedAt?: Date;
  workStartedAt?: Date;
  solvedAt?: Date;
  deployedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeatureRequestDocument extends IFeatureRequest, Document {}

export interface IFeatureRequestModel
  extends Model<IFeatureRequestDocument> {}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeatureRequestSchema = new Schema<IFeatureRequestDocument>(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    description: {
      type: String,
      required: [true, "Description is required"],
      maxlength: [5000, "Description cannot exceed 5000 characters"],
    },
    userProblem: {
      type: String,
      required: [true, "User problem statement is required"],
      maxlength: [2000, "User problem cannot exceed 2000 characters"],
    },
    proposedSolution: {
      type: String,
      maxlength: [3000, "Proposed solution cannot exceed 3000 characters"],
    },
    priority: {
      type: String,
      enum: {
        values: FEATURE_PRIORITIES,
        message: "Feature priority must be one of: {VALUE}",
      },
      required: [true, "Priority is required"],
      default: "nice-to-have",
    },
    status: {
      type: String,
      enum: {
        values: FEATURE_STATUSES,
        message: "Feature status must be one of: {VALUE}",
      },
      default: "reported",
    },
    requestedBy: {
      type: String,
      enum: {
        values: FEATURE_REQUESTERS,
        message: "Requester type must be one of: {VALUE}",
      },
      required: [true, "Requester type is required"],
    },
    requesterEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    assignedAgent: {
      type: String,
      trim: true,
    },
    aiAnalysis: {
      type: String,
    },
    implementationPlan: {
      type: String,
    },
    prUrl: {
      type: String,
      trim: true,
    },
    linkedCommit: {
      type: String,
      trim: true,
    },
    duplicateOf: {
      type: Schema.Types.ObjectId,
      ref: "FeatureRequest",
    },
    rejectionReason: {
      type: String,
    },
    upvotes: {
      type: Number,
      default: 0,
      min: [0, "Upvotes cannot be negative"],
    },
    upvotedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    triagedAt: { type: Date },
    workStartedAt: { type: Date },
    solvedAt: { type: Date },
    deployedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Index: { status: 1, priority: 1 }
// Reason: Primary query pattern — filter feature requests by status and
// priority. Supports the feature triage board where items are grouped by
// status and ordered by priority within each group.
FeatureRequestSchema.index({ status: 1, priority: 1 });

// Index: { upvotes: -1 }
// Reason: Sort feature requests by popularity (most upvoted first). Powers
// the "Popular Requests" view for community-driven prioritisation.
FeatureRequestSchema.index({ upvotes: -1 });

// Index: { userId: 1, createdAt: -1 }
// Reason: Lookup a user's feature requests sorted newest-first. Powers the
// "My Feature Requests" view for logged-in users.
FeatureRequestSchema.index({ userId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Model Export (Next.js compatible)
// ---------------------------------------------------------------------------

const FeatureRequest: IFeatureRequestModel =
  (mongoose.models.FeatureRequest as IFeatureRequestModel) ||
  mongoose.model<IFeatureRequestDocument, IFeatureRequestModel>(
    "FeatureRequest",
    FeatureRequestSchema
  );

export default FeatureRequest;
