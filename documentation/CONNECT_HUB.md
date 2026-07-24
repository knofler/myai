# Connect Hub — Installation & Integration Guide

> This document is the single source of truth for installing and operating the Connect Hub module in any project. It is copied to `AI/documentation/CONNECT_HUB.md` in each project by `init_connect.sh`.

---

## What is Connect Hub?

An AI-integrated help desk, bug tracker, and feature request system. Adds `/connect` routes to any Next.js app with:
- `/connect` — Dashboard with stats
- `/connect/bug` — Bug report form + list with status tracking
- `/connect/feature` — Feature request form + list with voting
- `/connect/help` — FAQ search + category filters

All data stored in MongoDB. AI agents can pull bugs/features from DB, implement fixes, and update status.

---

## Installation Process (Two Steps)

### Step A: Copy files (done from master AI repo — NOT the local agent)

The user or master AI agent runs this from the master AI repo:
```bash
./scripts/init_connect.sh /path/to/project
```

This copies:
- 3 Mongoose models → `src/models/`
- 8 API routes → `src/app/api/connect/`
- 4 pages → `src/app/connect/`
- This instruction doc → `AI/documentation/CONNECT_HUB.md`

**The local agent does NOT run this script. It has already been run if this file exists.**

---

### Step B: Integrate (done by local agent when user says `connect setup`)

**Trigger keyword: `connect setup`**

When the user says `connect setup`, you (the local AI agent) must follow these steps:

### Step 1: Verify files exist

Check these paths exist:
```
src/models/BugReport.ts
src/models/FeatureRequest.ts
src/models/HelpArticle.ts
src/app/api/connect/bugs/route.ts
src/app/api/connect/features/route.ts
src/app/api/connect/help/route.ts
src/app/connect/page.tsx
src/app/connect/bug/page.tsx
src/app/connect/feature/page.tsx
src/app/connect/help/page.tsx
```

If missing, tell user to run `init connect` from the master AI repo first.

### Step 2: Fix import paths

**IMPORTANT: Use the project's EXISTING database connection and auth helpers. Do NOT create new connection files, adapters, or separate databases. Connect Hub uses the same MongoDB database and auth system as the rest of the app.**

The template API route files may have placeholder imports. Find and replace them with this project's actual imports:

| Placeholder | How to find the correct import | Common values |
|------------|-------------------------------|---------------|
| `__DB_IMPORT__` | Search for existing `connectDB` or `dbConnect` usage in `src/app/api/` routes | `@/lib/db`, `@/lib/database`, `@/lib/mongoose`, `@/lib/mongodb` |
| `__AUTH_IMPORT__` | Search for existing auth middleware usage in `src/app/api/` routes (look for `getAuthUser`, `requireAuth`, `authenticate`) | `@/lib/api-auth`, `@/lib/auth`, `@/lib/auth-helpers` |
| `__MODELS_PATH__` | Check if `src/models/index.ts` exists | `@/models` |

**How to detect:** Read any existing API route in the project (e.g. `src/app/api/*/route.ts`) and copy the exact import pattern it uses for DB connection and auth.

**Then:** Search all files in `src/app/api/connect/` for `__DB_IMPORT__`, `__AUTH_IMPORT__`, `__MODELS_PATH__` and replace with the detected values. If the placeholders were already replaced by `init_connect.sh`, verify the imports match the project's actual file paths.

**Do NOT:**
- Create a new database connection file (e.g. `connect-db.ts`)
- Create a separate auth adapter (e.g. `connect-auth.ts`)
- Add a new `CONNECT_MONGODB_URI` environment variable
- Install mongoose or zod if they're already in the project's dependencies

**BEFORE integrating, detect the project architecture:**

Check how existing API routes work in this project. Look at `src/app/api/` or `src/pages/api/`:

| What you find | Architecture | How to integrate Connect Hub |
|--------------|-------------|------------------------------|
| API routes import mongoose/DB directly | **Next.js monolith** (e.g. a Next.js app) | Use template as-is. Replace placeholders with existing DB/auth imports. |
| API routes proxy to a separate backend (FastAPI, Express, Render) | **Split architecture** (e.g. Job Hunter) | Keep frontend pages (they use `fetch`). Add Connect Hub endpoints to the **backend** using its framework. Create proxy routes in Next.js matching existing patterns. |
| No API routes at all — pure frontend | **Static/SSG app** | Add mongoose to dependencies. Use template API routes directly. Or skip API and use a hosted backend. |
| Uses Prisma, Drizzle, or raw MongoDB driver (not Mongoose) | **Different ORM** | Keep frontend pages. Rewrite models using the project's ORM. Keep the same API contract (request/response shapes). |

**The template frontend pages work in ALL cases** — they use `fetch("/api/connect/...")` with relative URLs. Only the backend implementation varies.

### Step 3: Update middleware

Add `/connect` and `/api/connect` to protected route prefixes in `src/middleware.ts`:

```typescript
const PROTECTED_PREFIXES = [
  // ...existing paths...
  "/connect",
  "/api/connect",
];
```

### Step 4: Update model barrel exports

Add to `src/models/index.ts`:

```typescript
// Connect Hub models
export { default as BugReport } from "./BugReport";
export type { IBugReport, IBugReportDocument, IBugReportModel, BugSeverity, BugStatus } from "./BugReport";
export { BUG_SEVERITIES, BUG_STATUSES } from "./BugReport";

export { default as FeatureRequest } from "./FeatureRequest";
export type { IFeatureRequest, IFeatureRequestDocument, IFeatureRequestModel, FeaturePriority, FeatureStatus } from "./FeatureRequest";
export { FEATURE_PRIORITIES, FEATURE_STATUSES } from "./FeatureRequest";

export { default as HelpArticle } from "./HelpArticle";
export type { IHelpArticle, IHelpArticleDocument, IHelpArticleModel } from "./HelpArticle";
```

### Step 5: Add navigation item

Add a "Connect" link to the app's sidebar or header navigation, pointing to `/connect`. Use a chat/message icon. Example:

```tsx
{
  label: "Connect",
  href: "/connect",
  icon: <ChatBubbleIcon />,
}
```

### Step 6: Type check

```bash
docker compose exec app npx tsc --noEmit
```

Fix any import errors. Common issues:
- `connectDB` vs `connectToDatabase` — match your project's DB helper name
- `getAuthUser` vs `requireAuth` — match your project's auth helper
- `AuthError` may not exist — create it or use a generic error check

### Step 7: Test

Navigate to `/connect` and verify:
- Dashboard loads with 3 cards
- Bug form submits and appears in list
- Feature form submits and appears in list
- Help page loads (will be empty until FAQ articles are seeded)

### Step 8: Report

Output a summary table of what was done.

---

## Feature/Bug Lifecycle — Who Does What

| Step | Who | What happens |
|------|-----|-------------|
| User submits feature/bug on prod | User | Status: `reported` in MongoDB |
| You say `check features` or `check bugs` | AI | Queries DB, shows the list |
| You say `build feature [id]` or `fix bug [id]` | AI | Status → `working`, AI implements on `test` branch |
| You test on preview URL | User | Verify it works on Vercel preview |
| You say `merge it` | AI | Merge test → main, status → `deployed` |

**Key rules:**
- Features/bugs are submitted to the **same MongoDB** (Atlas) whether from prod or preview
- Code always goes through `test` first — the status only becomes `deployed` after merge to `main`
- The AI agent updates the DB status at each step — the `/connect` pages reflect current status automatically

---

## AI Agent Keywords (after Connect Hub is installed)

| Keyword | What to do |
|---------|-----------|
| `check bugs` | Query `BugReport` collection: `db.bugreports.find({status: {$ne: "deployed"}}).sort({severity: -1, createdAt: 1})`. List as table with ID, title, severity, status, date. Suggest which to fix first (critical > high > oldest). |
| `fix bug [id]` | 1. Query bug by ID from DB. 2. Update status to "working", set `workStartedAt`. 3. Read bug details (description, steps to reproduce, expected/actual). 4. Implement the fix on `test` branch. 5. Push, create PR. 6. Update bug: status → "solved", `solvedAt`, `resolution`, `prUrl`. 7. After merge: status → "deployed", `deployedAt`. |
| `check features` | Query `FeatureRequest` collection: `db.featurerequests.find({status: {$ne: "deployed"}}).sort({priority: 1, upvotes: -1})`. List as table with ID, title, priority, status, upvotes. Suggest which to build. |
| `build feature [id]` | 1. Query feature by ID from DB. 2. Update status to "working", set `workStartedAt`. 3. Read feature details. 4. Create implementation plan. 5. Implement on `test` branch. 6. Push, create PR. 7. Update feature: status → "solved", `solvedAt`, `prUrl`. 8. After merge: status → "deployed", `deployedAt`. |
| `triage` | Query all items with status "reported". For each: analyse severity/priority, detect duplicates, assign to specialist agent, update status to "triaged". Output summary table. |
| `connect setup` | Run the integration steps above (Steps 1-8). |

### How to query the DB

**From Docker:**
```bash
docker compose exec mongo mongosh "mongodb://admin:password@localhost:27017/dbname?authSource=admin" --quiet --eval 'db.bugreports.find({status: {$ne: "deployed"}}).sort({createdAt: -1}).forEach(b => print(b._id, b.title, b.severity, b.status))'
```

**From the API:**
```bash
curl -s http://localhost:PORT/api/connect/bugs | jq '.data'
curl -s http://localhost:PORT/api/connect/features | jq '.data'
```

### Status lifecycle

```
reported → triaged → working → solved → deployed
                  ↘ rejected (with reason)
                  ↘ duplicate (linked to original)
```

### When AI finds a bug during code review

Create a bug report programmatically:
```bash
curl -X POST http://localhost:PORT/api/connect/bugs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"...","description":"...","severity":"high"}'
```
Set `reportedBy: "ai"` in the API route (modify if needed for AI-created reports).

---

## DB Collections

| Collection | Model | Key fields |
|-----------|-------|-----------|
| `bugreports` | BugReport | title, description, severity, status, reportedBy, userId, aiAnalysis, resolution, prUrl |
| `featurerequests` | FeatureRequest | title, description, priority, status, requestedBy, userId, upvotes, implementationPlan, prUrl |
| `helparticles` | HelpArticle | question, answer, category, helpful, notHelpful |

---

## Ticket → Task Bridge (S1)

A **triaged** Connect Hub item can flow straight into the gateway's task queue so
the fleet runner picks it up as work. The app's Connect Hub emits the item to the
gateway when an item's status flips to `triaged`; the gateway maps it to a task.

**Gateway endpoint:** `POST /api/webhooks/connect`
- Optional HMAC-SHA256 signature in `X-Connect-Signature-256` keyed on `CONNECT_WEBHOOK_SECRET` (same scheme as the GitHub webhook). Skipped with a warning if the secret is unset.
- Returns `201` with `{ taskCreated }` when a task is made, `200` otherwise (non-triaged, idempotent re-emit, or validation skip).

**Payload (the connect-side emit sends this):**
```jsonc
{
  "type": "bug" | "feature",   // required
  "id": "<item _id>",           // required — used to build a stable sourceId
  "title": "Login broken",      // required
  "repo": "my-app",             // required — becomes the task's repo
  "status": "triaged",          // only `triaged` creates a task
  "description": "…",           // optional — truncated to 500 chars
  "severity": "high",           // bugs: critical|high|medium|low
  "priority": "must-have",      // features: must-have|should-have|nice-to-have
  "url": "https://app/connect/bug/<id>"  // optional deep link → task notes
}
```

**Mapping:**
| Item field | Task field |
|-----------|-----------|
| bug severity | priority — critical→P0, high→P1, medium→P2, low→P3 |
| feature priority | priority — must-have→P1, should-have→P2, nice-to-have→P3 (default P2) |
| title | `[Bug]`/`[Feature]` prefixed title |
| type | assignedAgent — bug→`qa-specialist`, feature→`product-manager` |
| `type`+`id` | sourceId `bug-<id>` / `feature-<id>`; source `connect-hub` |

**Idempotent:** re-emitting a triaged item (same `sourceId` + `repo`) returns the
existing task — it never piles up duplicates — so the connect-side emit is safe to
fire on every triage save.

> Gateway-side bridge: `runtime/src/webhooks/connect-handler.ts`. The connect-side
> emit (the app POSTing here on triage) is a companion task in the app's repo.

---

## Installing Connect Hub via the CLI

Besides `./scripts/init_connect.sh /path/to/app`, the gateway CLI wraps it:

```bash
myai connect install /path/to/app   # embeds Connect Hub into a target Next.js app
```

This validates the target has a `src/` dir, locates the framework's
`init_connect.sh`, and runs it against the target.
