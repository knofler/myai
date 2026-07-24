---
name: dev-refactor-extract
description: "Extract method or component refactoring with dependency analysis and test verification. Triggers: 'extract method', 'extract component', 'refactor extract', 'pull out function', 'split component'."
---

# Extract Refactoring Playbook

## When to Use
- A function or component has grown too large (>50 lines for functions, >200 lines for components)
- Duplicated logic exists across multiple files that should be centralized
- A block of code has a clear single responsibility that deserves its own unit
- Test coverage is difficult because the function does too many things

## Prerequisites
- Target code block identified with clear boundaries
- Existing tests pass before starting the refactoring
- Git working directory is clean (commit or stash pending changes)

## Playbook

### 1. Identify Extraction Target
- Read the source file and identify the code block to extract
- Determine the extraction type: method/function, React component, or utility
- Mark the exact line range of the code to extract
- Document what the extracted unit will do (single responsibility)

### 2. Analyze Dependencies
- List all variables the code block reads from its surrounding scope
- List all variables the code block writes/mutates
- Identify imports used only by the target block
- Determine return value(s) — what the calling code needs back
- Map these to: parameters (inputs), return values (outputs), side effects

### 3. Create Extracted Unit
- Create a new function/component in the appropriate location:
  - Utility functions: `utils/` or `lib/`
  - React components: `components/{category}/`
  - Service methods: same service file or new service
- Define clear TypeScript signature: typed parameters and return type
- Move the code block into the new unit
- Move related imports that only the extracted code uses

### 4. Update Call Sites
- Replace the original code block with a call to the new function/component
- Pass identified dependencies as arguments
- Handle the return value at the call site
- Search the codebase for any other locations with similar duplicated logic
- Update those call sites to use the new shared unit

### 5. Verify Correctness
- Run the existing test suite — all tests must pass unchanged
- If any test fails, the extraction changed behavior — investigate and fix
- Check TypeScript compilation with `npx tsc --noEmit`
- Run linter to catch any import or unused variable issues

### 6. Add Tests for Extracted Unit
- Write focused unit tests for the new function/component
- Test with the same inputs the original call sites were using
- Add edge case tests that are now easier to write in isolation
- Verify coverage of the extracted unit is >80%

## Output
- New function/component file (or addition to existing file)
- Updated original file with extraction call
- Updated additional call sites if deduplication was done
- New or updated test file for the extracted unit
- All existing tests still passing

## Review Checklist
- [ ] Extracted unit has a single, clear responsibility
- [ ] All dependencies passed explicitly as parameters (no hidden coupling)
- [ ] Return type is well-defined and minimal
- [ ] All call sites updated and working
- [ ] Existing tests pass without modification
- [ ] New tests cover the extracted unit in isolation
- [ ] No TypeScript errors or linting warnings
