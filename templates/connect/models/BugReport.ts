import mongoose, { Schema, Document, Model, Types } from "mongoose";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BUG_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export const BUG_STATUSES = [
  "reported",
  "triaged",
  "working",
  "solved",
  "deployed",
  "rejected",
  "duplicate",
] as const;

export const BUG_REPORTERS = ["user", "ai"] as const;

// ---------------------------------------------------------------------------
// TypeScript Types
// ---------------------------------------------------------------------------

export type BugSeverity = (typeof BUG_SEVERITIES)[number];
export type BugStatus = (typeof BUG_STATUSES)[number];
export type BugReporter = (typeof BUG_REPORTERS)[number];

export interface IBugReport {
  title: string;
  description: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  severity: BugSeverity;
  status: BugStatus;
  reportedBy: BugReporter;
  reporterEmail?: string;
  userId?: Types.ObjectId;
  assignedAgent?: string;
  aiAnalysis?: string;
  resolution?: string;
  prUrl?: string;
  linkedCommit?: string;
  duplicateOf?: Types.ObjectId;
  rejectionReason?: string;
  appRoute?: string;
  browser?: string;
  screenshot?: string;
  triagedAt?: Date;
  workStartedAt?: Date;
  solvedAt?: Date;
  deployedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBugReportDocument extends IBugReport, Document {}

export interface IBugReportModel extends Model<IBugReportDocument> {}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BugReportSchema = new Schema<IBugReportDocument>(
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
    stepsToReproduce: {
      type: String,
      maxlength: [3000, "Steps to reproduce cannot exceed 3000 characters"],
    },
    expectedBehavior: {
      type: String,
      maxlength: [2000, "Expected behavior cannot exceed 2000 characters"],
    },
    actualBehavior: {
      type: String,
      maxlength: [2000, "Actual behavior cannot exceed 2000 characters"],
    },
    severity: {
      type: String,
      enum: {
        values: BUG_SEVERITIES,
        message: "Bug severity must be one of: {VALUE}",
      },
      required: [true, "Severity is required"],
      default: "medium",
    },
    status: {
      type: String,
      enum: {
        values: BUG_STATUSES,
        message: "Bug status must be one of: {VALUE}",
      },
      default: "reported",
    },
    reportedBy: {
      type: String,
      enum: {
        values: BUG_REPORTERS,
        message: "Reporter type must be one of: {VALUE}",
      },
      required: [true, "Reporter type is required"],
    },
    reporterEmail: {
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
    resolution: {
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
      ref: "BugReport",
    },
    rejectionReason: {
      type: String,
    },
    appRoute: {
      type: String,
      trim: true,
    },
    browser: {
      type: String,
      trim: true,
    },
    screenshot: {
      type: String,
      trim: true,
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

// Index: { status: 1, severity: -1 }
// Reason: Primary query pattern — filter bugs by status and sort by severity
// (critical first). Supports the bug triage dashboard view.
BugReportSchema.index({ status: 1, severity: -1 });

// Index: { userId: 1, createdAt: -1 }
// Reason: Lookup a user's bug reports sorted newest-first. Powers the
// "My Bug Reports" view for logged-in users.
BugReportSchema.index({ userId: 1, createdAt: -1 });

// Index: { reportedBy: 1, status: 1 }
// Reason: Filter AI-reported bugs by status. Allows the AI agent dashboard
// to show only AI-discovered bugs and their current resolution state.
BugReportSchema.index({ reportedBy: 1, status: 1 });

// ---------------------------------------------------------------------------
// Model Export (Next.js compatible)
// ---------------------------------------------------------------------------

const BugReport: IBugReportModel =
  (mongoose.models.BugReport as IBugReportModel) ||
  mongoose.model<IBugReportDocument, IBugReportModel>(
    "BugReport",
    BugReportSchema
  );

export default BugReport;
