/**
 * Scalar API Documentation Route (CLAUDE.md rule 7)
 *
 * Serves interactive, human-facing API docs at /docs, reading the spec
 * from /api/openapi.json (app/api/openapi.json/route.ts).
 *
 * Public — exempt from the operator gate (proxy.ts PUBLIC_PATHS), same as
 * the spec route itself, so the contract is browsable without a session.
 */
import { ApiReference } from "@scalar/nextjs-api-reference";

export const GET = ApiReference({
  spec: {
    url: "/api/openapi.json",
  },
  theme: "kepler",
});
