import mongoose, { Schema, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// TypeScript Types
// ---------------------------------------------------------------------------

export interface IHelpArticle {
  question: string;
  answer: string;
  category: string;
  relatedRoutes: string[];
  generatedByAI: boolean;
  helpful: number;
  notHelpful: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IHelpArticleDocument extends IHelpArticle, Document {}

export interface IHelpArticleModel extends Model<IHelpArticleDocument> {}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HelpArticleSchema = new Schema<IHelpArticleDocument>(
  {
    question: {
      type: String,
      required: [true, "Question is required"],
      trim: true,
      maxlength: [500, "Question cannot exceed 500 characters"],
    },
    answer: {
      type: String,
      required: [true, "Answer is required"],
      maxlength: [5000, "Answer cannot exceed 5000 characters"],
    },
    category: {
      type: String,
      required: [true, "Category is required"],
      trim: true,
      lowercase: true,
    },
    relatedRoutes: {
      type: [String],
      default: [],
    },
    generatedByAI: {
      type: Boolean,
      default: false,
    },
    helpful: {
      type: Number,
      default: 0,
      min: [0, "Helpful count cannot be negative"],
    },
    notHelpful: {
      type: Number,
      default: 0,
      min: [0, "Not-helpful count cannot be negative"],
    },
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

// Index: { category: 1 }
// Reason: Help articles are filtered by category (e.g. "getting-started",
// "technical", "billing"). This index supports the category sidebar filter.
HelpArticleSchema.index({ category: 1 });

// Index: text index on question + answer
// Reason: Full-text search across help articles. Allows users to search for
// articles by keyword in both the question and answer fields.
HelpArticleSchema.index(
  { question: "text", answer: "text" },
  { name: "help_article_text_search" }
);

// ---------------------------------------------------------------------------
// Model Export (Next.js compatible)
// ---------------------------------------------------------------------------

const HelpArticle: IHelpArticleModel =
  (mongoose.models.HelpArticle as IHelpArticleModel) ||
  mongoose.model<IHelpArticleDocument, IHelpArticleModel>(
    "HelpArticle",
    HelpArticleSchema
  );

export default HelpArticle;
