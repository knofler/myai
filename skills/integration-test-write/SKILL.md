---
name: integration-test-write
description: "Write integration tests for API endpoints — test full request-response cycle with database, fixtures, and cleanup. Triggers: integration test, API test, endpoint test, supertest, test API"
---

# Integration Test Write

Write integration tests that exercise API endpoints through the full stack.

## Tech Stack

Supertest | Jest/Vitest | MongoDB (Docker or in-memory) | factory fixtures

## Playbook

### 1. Set up test database

- Use Docker Compose or `mongodb-memory-server` for isolation.
- Configure `.env.test` with dedicated connection string.
- Connect in `beforeAll`, disconnect in `afterAll`.

### 2. Create test fixtures

- Build factory functions for test data with unique identifiers.

```typescript
function createUserFixture(overrides = {}) {
  return { name: 'Test User', email: `test-${Date.now()}@example.com`, ...overrides };
}
```

### 3. Initialize the app for testing

- Import the app without calling `listen()`. Pass to Supertest.

```typescript
import app from '../src/app';
import request from 'supertest';
const agent = request(app);
```

### 4. Test full request-response cycle

```typescript
it('should create a user and return 201', async () => {
  const res = await agent
    .post('/api/users')
    .send({ name: 'Alice', email: 'alice@test.com' })
    .expect(201);
  expect(res.body).toHaveProperty('id');
});
```

### 5. Verify database state

- Query the database directly to confirm writes.
- Check cascading effects, computed fields, and timestamps.

### 6. Test auth and error scenarios

- Verify 401 for unauthenticated, 403 for unauthorized requests.
- Test invalid body (400), not found (404), conflict (409).
- Confirm consistent error response format.

### 7. Clean up after each test

```typescript
afterEach(async () => { await User.deleteMany({}); });
```

- Ensure tests can run in any order with no shared state.

### 8. Run and verify

- Run: `npx vitest run tests/integration`.
- Confirm all endpoints are covered and assertions are meaningful.
