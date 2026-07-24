---
name: unit-test-write
description: "Write unit tests for functions and modules — cover happy path, edge cases, and error cases with proper mocking and assertions. Triggers: unit test, write test, test function, test module, jest test, vitest"
---

# Unit Test Write

Write thorough unit tests for a given function or module.

## Tech Stack

Jest or Vitest | `vi.mock()` / `jest.mock()` | built-in `expect` API

## Playbook

### 1. Identify the function or module to test

- Read the source file and understand inputs, outputs, and side effects.
- List all public exports that need coverage.
- Identify dependencies that must be mocked.

### 2. Create the test file

- Place `<module>.test.ts` alongside `<module>.ts` (or in `tests/unit/`).
- Import the module under test and any test utilities.

### 3. Structure with describe/it blocks

```typescript
describe('ModuleName', () => {
  describe('functionName', () => {
    it('should return expected result for valid input', () => { ... });
    it('should handle edge case X', () => { ... });
    it('should throw on invalid input', () => { ... });
  });
});
```

### 4. Cover happy path

- Test the primary use case with typical valid inputs.
- Assert return value and verify expected side effects.

### 5. Cover edge cases

- Empty inputs (empty string, empty array, null, undefined).
- Boundary values (0, negative numbers, max integers).
- Special characters, Unicode, and large inputs.

### 6. Cover error cases

- Invalid argument types or shapes.
- Missing required parameters.
- Network/IO failures (mock rejections).
- Verify error messages and error types.

### 7. Mock dependencies

- Mock external modules with `vi.mock()` or `jest.mock()`.
- Use `vi.fn()` / `jest.fn()` for spies. Reset in `beforeEach`.
- Prefer dependency injection over global mocks when possible.

```typescript
vi.mock('../services/db', () => ({
  findUser: vi.fn().mockResolvedValue({ id: '1', name: 'Test' }),
}));
```

### 8. Assert expected behavior

- Use specific matchers: `toBe`, `toEqual`, `toContain`, `toThrow`.
- Verify mock calls with `toHaveBeenCalledWith`.
- For async code, always `await` and use `resolves`/`rejects`.

### 9. Run and verify

- Run: `npx vitest run <file>`. Check coverage: `--coverage`.
