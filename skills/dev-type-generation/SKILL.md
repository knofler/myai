---
name: dev-type-generation
description: "Generate TypeScript types from Mongoose schemas or API contracts to keep DB and API types in sync. Triggers: 'generate types', 'type generation', 'schema to types', 'sync types', 'TypeScript interfaces from schema'."
---

# Type Generation Playbook

## When to Use
- New Mongoose schema created and TypeScript types needed
- API contract defined and request/response types needed
- Schema changed and types are out of sync
- Frontend needs types matching backend API responses

## Prerequisites
- Source of truth identified: Mongoose schema, API contract doc, or OpenAPI spec
- TypeScript configured in the project with `strict: true`
- Types output directory decided (e.g., `src/types/`, `shared/types/`)

## Playbook

### 1. Identify Source Schemas
- Locate all Mongoose model files: `src/models/*.ts`
- Locate API contract docs: `AI/plan/api-contracts/*.md`
- Locate any OpenAPI/Swagger specs: `docs/openapi.yml`
- List each schema/contract that needs type generation
- Note the last modified date to detect stale types

### 2. Parse Schema Fields
- For each Mongoose schema, extract:
  - Field name, type (String, Number, Boolean, ObjectId, Date, Array, Mixed)
  - Required vs optional (check `required: true` and default values)
  - Enum constraints (map to TypeScript union types)
  - Ref fields (map to ObjectId | PopulatedType)
  - Nested schemas (map to nested interfaces)
  - Virtual fields (document separately, not in base interface)

### 3. Generate TypeScript Interfaces
- Create one interface per schema: `I{ModelName}`
- Create a document type: `I{ModelName}Document extends I{ModelName}, Document`
- Create input types: `Create{ModelName}Input` (omit id, timestamps, computed fields)
- Create update types: `Update{ModelName}Input` (all fields optional via Partial)
- Map Mongoose types: String->string, Number->number, ObjectId->Types.ObjectId, Date->Date
- Handle arrays: `[String]` -> `string[]`
- Handle enums: `enum: ['active', 'inactive']` -> `'active' | 'inactive'`

### 4. Generate API Types
- From API contracts, create request/response types:
  - `{Endpoint}Request` — request body shape
  - `{Endpoint}Response` — success response shape
  - `{Endpoint}Params` — URL parameters
  - `{Endpoint}Query` — query string parameters
- Create shared envelope types: `ApiResponse<T>`, `PaginatedResponse<T>`, `ApiError`

### 5. Write Type Files
- Output to `src/types/{domain}.ts` (one file per domain/model)
- Create `src/types/index.ts` barrel export
- Add JSDoc comments with source reference (which schema/contract it came from)
- Include a generated-file header comment with timestamp

### 6. Verify Sync
- Run `npx tsc --noEmit` to confirm no type errors
- Check that all model files import from the generated types
- Check that all route handlers use the generated request/response types
- Flag any schema fields that have no corresponding type field

## Output
- `src/types/{domain}.ts` — generated TypeScript interfaces per domain
- `src/types/index.ts` — barrel export of all types
- Type sync verification report (mismatches flagged)

## Review Checklist
- [ ] Every schema field has a corresponding type field
- [ ] Required/optional correctly mapped
- [ ] Enums mapped to union types, not plain strings
- [ ] ObjectId refs have both ID and populated variants
- [ ] API request/response types match contract exactly
- [ ] Barrel export updated with all new types
- [ ] `tsc --noEmit` passes with no errors
