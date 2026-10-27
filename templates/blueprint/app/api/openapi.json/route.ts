/**
 * OpenAPI 3.0 Specification Route (CLAUDE.md rule 7)
 *
 * Serves the OpenAPI spec as JSON — the single source of truth for:
 * - Scalar docs at /docs (human-facing, app/docs/route.ts)
 * - The OpenAPI MCP server (AI-facing, .mcp.json)
 * - API client generation
 *
 * Public — exempt from the operator gate (proxy.ts PUBLIC_PATHS), same as
 * /api/health, so the contract is discoverable without a session.
 *
 * Every new endpoint MUST be added to `paths` below — undocumented
 * endpoints are not considered complete.
 */
import { NextResponse } from "next/server";

const spec = {
  openapi: "3.0.0",
  info: {
    title: "__DISPLAY_NAME__ API",
    version: "1.0.0",
    description: "API documentation for __DISPLAY_NAME__, generated from the myAI Blueprint.",
  },
  servers: [{ url: "/api", description: "Current environment" }],
  tags: [
    { name: "meta", description: "Health and status endpoints" },
    { name: "todos", description: "Demo CRUD resource" },
    { name: "auth", description: "Single-operator control-plane login" },
  ],
  components: {
    securitySchemes: {
      operatorSession: {
        type: "apiKey",
        in: "cookie",
        name: "myai_operator",
        description:
          "Session cookie issued by POST /api/auth/operator. Every route not listed in proxy.ts PUBLIC_PATHS requires it (fail-closed single-operator gate).",
      },
    },
    schemas: {
      Todo: {
        type: "object",
        required: ["_id", "title", "completed"],
        properties: {
          _id: { type: "string", example: "6710b1f2a1b2c3d4e5f6a7b8" },
          title: { type: "string", example: "Buy milk" },
          completed: { type: "boolean", default: false },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { description: "Message string, or a zod .flatten() validation object." },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["meta"],
        summary: "Liveness probe",
        description:
          "Dependency-free health check used by the Docker healthcheck and uptime monitors. Public.",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "service", "timestamp"],
                  properties: {
                    status: { type: "string", example: "ok" },
                    service: { type: "string", example: "__PROJECT_NAME__" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/todos": {
      get: {
        tags: ["todos"],
        summary: "List todos",
        operationId: "listTodos",
        security: [{ operatorSession: [] }],
        responses: {
          "200": {
            description: "Todos, most-recently-created first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["todos"],
                  properties: {
                    todos: { type: "array", items: { $ref: "#/components/schemas/Todo" } },
                  },
                },
              },
            },
          },
          "401": {
            description: "No valid operator session",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      post: {
        tags: ["todos"],
        summary: "Create a todo",
        operationId: "createTodo",
        security: [{ operatorSession: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Todo created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["todo"],
                  properties: { todo: { $ref: "#/components/schemas/Todo" } },
                },
              },
            },
          },
          "400": {
            description: "Invalid body (zod validation failure)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "No valid operator session",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/auth/operator": {
      post: {
        tags: ["auth"],
        summary: "Operator sign-in",
        description:
          "Public — must be reachable to log in. Issues the myai_operator session cookie on success.",
        operationId: "operatorLogin",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["user", "password"],
                properties: { user: { type: "string" }, password: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed in; sets the myai_operator cookie",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "user"],
                  properties: { ok: { type: "boolean" }, user: { type: "string" } },
                },
              },
            },
          },
          "400": {
            description: "Missing user or password",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": {
            description: "Invalid credentials",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "503": {
            description: "Operator login not configured on this deployment (no MYAI_ADMIN_* set)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      delete: {
        tags: ["auth"],
        summary: "Operator sign-out",
        operationId: "operatorLogout",
        responses: {
          "200": {
            description: "Signed out; clears the myai_operator cookie",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function GET() {
  return NextResponse.json(spec, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
