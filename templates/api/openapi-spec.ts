/**
 * OpenAPI 3.0 Specification Route
 *
 * Serves the OpenAPI spec as JSON. This is the single source of truth for:
 * - Scalar docs at /docs (human-facing)
 * - OpenAPI MCP server (AI-facing)
 * - API client generation
 *
 * Usage: Copy to src/app/api/openapi.json/route.ts
 * Update: Add paths as you build endpoints
 */

import { NextResponse } from 'next/server';

const spec = {
  openapi: '3.0.0',
  info: {
    title: '__PROJECT_NAME__ API',
    version: '1.0.0',
    description: 'API documentation for __PROJECT_NAME__',
  },
  servers: [
    { url: '/api', description: 'Current environment' },
  ],
  tags: [
    { name: 'meta', description: 'Health and status endpoints' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['meta'],
        summary: 'Health check',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    timestamp: { type: 'string', format: 'date-time' },
                    db: { type: 'string', example: 'connected' },
                  },
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
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}
