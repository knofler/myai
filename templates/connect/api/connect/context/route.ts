import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { connectDB } from "__DB_IMPORT__"; // Replace with your DB connection import
import { getAuthUser, AuthError } from "__AUTH_IMPORT__"; // Replace with your auth helper import

// ---------------------------------------------------------------------------
// GET /api/connect/context
// ---------------------------------------------------------------------------

/**
 * Return the app knowledge base for AI agent context.
 * Provides app metadata, tech stack, route list, and recent changes.
 *
 * NOTE: Customize the appName, techStack, routes, and apiRoutes below
 * to match your application.
 *
 * Auth: required
 * Response 200: { data: { appName, techStack, routes, recentChanges } }
 * Response 401: { error: string }
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await getAuthUser(request);

    // TODO: Customize for your application
    const appName = "MyApp";

    // TODO: Update with your actual tech stack
    const techStack = {
      framework: "Next.js (App Router)",
      language: "TypeScript",
      ui: ["React", "Tailwind CSS"],
      database: "MongoDB (Mongoose)",
      auth: "JWT",
      validation: "Zod",
    };

    // TODO: Update with your application routes
    const routes = [
      { path: "/", description: "Home page" },
      { path: "/connect", description: "Connect Hub (bugs, features, help)" },
    ];

    // TODO: Update with your API routes
    const apiRoutes = [
      "GET  /api/connect/bugs",
      "POST /api/connect/bugs",
      "GET  /api/connect/bugs/[id]",
      "PATCH /api/connect/bugs/[id]",
      "GET  /api/connect/features",
      "POST /api/connect/features",
      "GET  /api/connect/features/[id]",
      "PATCH /api/connect/features/[id]",
      "POST /api/connect/features/[id]/vote",
      "GET  /api/connect/help",
      "POST /api/connect/help/[id]/feedback",
      "GET  /api/connect/context",
    ];

    // Read recent changes from STATE.md (first 50 lines)
    let recentChanges = "Unable to read state file";
    try {
      const statePath = path.resolve(process.cwd(), "AI/state/STATE.md");
      const stateContent = await fs.readFile(statePath, "utf-8");
      const lines = stateContent.split("\n").slice(0, 50);
      recentChanges = lines.join("\n");
    } catch {
      // STATE.md may not exist in all environments
      recentChanges = "State file not available in this environment";
    }

    return NextResponse.json(
      {
        data: {
          appName,
          techStack,
          routes,
          apiRoutes,
          recentChanges,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[api/connect/context] GET error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
