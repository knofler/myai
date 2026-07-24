import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** Demo model — a TODO item. Replace with your domain models.
 *  Demonstrates schema validation, timestamps, and the
 *  "reuse-existing-model-on-hot-reload" pattern Next.js needs. */
const todoSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    completed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type Todo = InferSchemaType<typeof todoSchema> & { _id: mongoose.Types.ObjectId };

export const TodoModel: Model<Todo> =
  (mongoose.models.Todo as Model<Todo>) ??
  mongoose.model<Todo>("Todo", todoSchema);
