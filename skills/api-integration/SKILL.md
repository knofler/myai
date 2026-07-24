---
name: api-integration
description: "Integrate frontend with backend API endpoints including types and error handling. Triggers: fetch, API call, integrate API, connect to backend, data fetching"
---

# Skill: Integrate Frontend with API Endpoints

Wire up frontend components to consume backend API endpoints with proper typing and error handling.

## Playbook

### 1. Read the API Contract

- Locate API documentation in `docs/API.md` or `documentation/`.
- If no docs exist, read the backend route/controller source directly.
- Extract: endpoint URL, method, auth requirements, request shape, response shape.

### 2. Define TypeScript Types

- Create request and response types in `src/types/` or co-located with the feature.
- Match types exactly to the API contract.
- Example:
  ```typescript
  interface CreateProjectRequest {
    name: string;
    description?: string;
  }
  interface ProjectResponse {
    id: string;
    name: string;
    createdAt: string;
  }
  ```

### 3. Create Fetch Utility

- If a shared fetch wrapper exists (`src/lib/api.ts` or similar), use it.
- If not, create one with:
  - Base URL from environment variable.
  - Default headers (Content-Type, Authorization).
  - Response parsing and error extraction.
  - Generic type parameter for response typing.

### 4. Create Data Hook or Server Fetch

Choose based on component type:

- **Server Component**: use `fetch()` directly in the async component with `cache` / `revalidate` options.
- **Client Component**: create a custom hook or use React Query / SWR.
  - Handle `loading`, `error`, and `data` states.
  - Return typed data and mutation functions.

### 5. Handle Error States

- Network errors: show retry option.
- 401: redirect to login or refresh token.
- 400: display validation errors inline.
- 500: show generic error with support contact.
- Use error boundaries for unexpected failures.

### 6. Implement Optimistic Updates (If Applicable)

- For mutations (POST/PUT/DELETE), update UI before server confirmation.
- Roll back on failure.
- Only apply to low-risk, user-facing interactions.

### 7. Wire into Components

- Import the hook or fetch function into the consuming component.
- Render loading skeletons, error messages, and success states.
- Pass typed data to child components.

### 8. Verify

- Test against running backend or mock server.
- Confirm TypeScript types match actual responses.
- Log action to `logs/claude_log.md`.
