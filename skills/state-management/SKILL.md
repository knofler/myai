---
name: state-management
description: "Set up frontend state management with the right tool for the scope. Triggers: state management, global state, React Context, Zustand, store, state"
---

# Skill: Set Up State Management

Choose and implement the right state management approach based on state scope and complexity.

## Playbook

### 1. Identify State Scope

Classify the state being managed:

- **Local** — single component (use `useState` / `useReducer`).
- **Shared** — a few related components (use React Context or prop lifting).
- **Global** — app-wide state across many components (use Zustand).
- **Server** — remote data with caching needs (use React Query / SWR).

If the scope is local, no further setup is needed. Advise `useState` and stop.

### 2. Choose the Approach

| Scope | Tool | When |
|-------|------|------|
| Shared UI state | React Context | Theme, sidebar open/close, modals |
| Global client state | Zustand | Auth user, feature flags, app preferences |
| Server/async state | React Query | API data, pagination, cache invalidation |

Do not over-engineer: prefer the simplest option that fits.

### 3a. React Context Setup

- Create `src/contexts/{Name}Context.tsx`.
- Define a context type interface.
- Create provider component with `useState` or `useReducer` internally.
- Export a custom hook: `use{Name}()` that throws if used outside provider.
- Wrap the relevant layout or page with the provider.

### 3b. Zustand Store Setup

- Create `src/stores/{name}Store.ts`.
- Define the store interface (state + actions).
- Create the store with `create<StoreType>()`.
- Use slices if the store grows beyond 5-6 state fields.
- Export typed selectors for performance (avoid selecting entire store).

### 3c. React Query Setup

- Install `@tanstack/react-query` if not present.
- Add `QueryClientProvider` to root layout if not already there.
- Create query hooks in `src/hooks/` using `useQuery` and `useMutation`.
- Define query keys as constants for consistency.
- Configure stale time and cache time per query as needed.

### 4. Wire into Components

- Import the hook or store selector into consuming components.
- Ensure re-renders are scoped (select only needed state slices).
- Add TypeScript types for all state and actions.

### 5. Verify

- Confirm state updates propagate correctly.
- Check no unnecessary re-renders via React DevTools.
- Log action to `logs/claude_log.md`.
