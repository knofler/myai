/**
 * Scalar API Documentation Route
 *
 * Serves interactive API docs at /docs powered by Scalar.
 * Reads the OpenAPI spec from /api/openapi.json.
 *
 * Usage: Copy to src/app/docs/route.ts
 * Install: docker compose exec app npm install @scalar/nextjs-api-reference
 *
 * Tailwind v4 note: Add to globals.css BEFORE @import "tailwindcss":
 *   @layer scalar, base, components, utilities;
 */

import { ApiReference } from '@scalar/nextjs-api-reference';

export const GET = ApiReference({
  spec: {
    url: '/api/openapi.json',
  },
  theme: 'kepler',
});
