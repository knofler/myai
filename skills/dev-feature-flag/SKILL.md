---
name: dev-feature-flag
description: "Implement a feature flag system with percentage rollout, user targeting, and cleanup process. Triggers: 'feature flag', 'feature toggle', 'flag system', 'gradual rollout', 'canary release', 'dark launch'."
---

# Feature Flag System Playbook

## When to Use
- Rolling out a new feature gradually to reduce risk
- A/B testing different implementations
- Enabling features per environment (staging vs production)
- Giving specific users early access to unreleased features
- Need to quickly disable a feature without redeployment

## Prerequisites
- Storage backend decided: environment variables (simple), config file, database, or external service
- Feature flag naming convention agreed (e.g., `ENABLE_NEW_DASHBOARD`)
- Application has middleware or initialization where flags can be loaded

## Playbook

### 1. Define Flag Storage
- Create `src/lib/featureFlags.ts` as the central flag module
- **Simple (env-based)**: Read flags from env vars prefixed with `FF_` (e.g., `FF_NEW_DASHBOARD=true`)
- **Config-based**: JSON file at `config/feature-flags.json` with flag definitions
- **DB-based**: MongoDB collection `featureFlags` with flag documents
- Flag schema: `{ name, enabled, rolloutPercentage, targetUsers, targetRoles, description, createdAt, expiresAt }`

### 2. Implement Evaluation Logic
- `isEnabled(flagName, context?)` — the core function:
  - Check if flag exists; return `false` for unknown flags (fail closed)
  - If `enabled` is false, return false immediately
  - If `targetUsers` array is set and user ID matches, return true
  - If `targetRoles` array is set and user role matches, return true
  - If `rolloutPercentage` is set: hash `userId + flagName`, mod 100, compare to percentage
  - Default: return the `enabled` boolean value
- Hashing ensures consistent evaluation — same user always gets the same result

### 3. Create Middleware/Hook
- **Backend**: Express middleware that loads flags and attaches to `req.flags`
  - Cache flag values for the duration of the request
  - Refresh flag cache every 60 seconds (not on every request)
- **Frontend**: React hook `useFeatureFlag(flagName)` that:
  - Fetches flags from API endpoint `GET /api/v1/feature-flags`
  - Caches in React context, refreshes on window focus
  - Returns `{ enabled: boolean, loading: boolean }`

### 4. Add Management Endpoint
- `GET /api/v1/feature-flags` — list all flags (admin only)
- `PUT /api/v1/feature-flags/:name` — update flag settings (admin only)
- `POST /api/v1/feature-flags` — create new flag (admin only)
- Log all flag changes with who changed what and when

### 5. Implement Flag Usage Pattern
- Guard new feature code with flag checks:
  ```
  if (isEnabled('NEW_DASHBOARD', { userId, role })) { /* new code */ } else { /* old code */ }
  ```
- Keep both code paths clean and testable
- Add flag name to the component/route as a comment for traceability

### 6. Define Cleanup Process
- Set `expiresAt` on every flag (recommended: 90 days max)
- Weekly review: flags past expiry should be removed
- Cleanup steps: remove flag check, remove old code path, delete flag from storage
- Track active flags in a table in `state/STATE.md`

## Output
- `src/lib/featureFlags.ts` — flag evaluation module
- Flag storage setup (env/config/DB)
- Backend middleware and/or frontend React hook
- Admin management endpoints
- Flag cleanup documentation

## Review Checklist
- [ ] Unknown flags return false (fail closed)
- [ ] Percentage rollout is consistent per user (hash-based)
- [ ] Flag changes are logged with actor and timestamp
- [ ] Both code paths (flag on/off) are tested
- [ ] Expiry dates set on all flags
- [ ] Cleanup process documented and scheduled
