---
name: make-prod
description: "Productionise a project — create Vercel project, provision MongoDB Atlas database, optionally create Render service for API. Triggers: make prod, productionise, go live, deploy setup, production setup"
---

# Skill: Make Prod

Provision production infrastructure for any project. Detects project type and sets up the appropriate services. **Always checks for existing production config first** — if already set up, verifies health and skips provisioning.

## When to Use

- New project needs production deployment
- Triggered by `make prod` keyword
- Setting up Vercel + Atlas + Render for the first time
- Verifying an existing production setup is healthy

## Playbook

### 0. Check Existing Production Config (ALWAYS DO THIS FIRST)

Before provisioning anything, check if production is already configured:

| Check | How | If Found |
|-------|-----|----------|
| **Vercel** | Look for `.vercel/project.json`, run `vercel ls` | Already linked — skip to health check |
| **Render** | Look for `render.yaml` | Already configured — skip to health check |
| **MongoDB Atlas** | Check `.env` or `.env.example` for `mongodb+srv://` connection string | Already provisioned — skip to health check |
| **Git auto-deploy** | Check `vercel.json` or Vercel dashboard for git integration | Deploys on push — just commit and push |
| **Environment vars** | Run `vercel env ls production` or check Render dashboard | Already set — verify values |

**If all services are already configured:**
1. Run health checks (Step 7)
2. Report status to user
3. If healthy → done, no provisioning needed
4. If unhealthy → diagnose and fix (don't re-provision from scratch)

**If partially configured:**
1. Report what exists vs what's missing
2. Only provision the missing pieces

**If nothing is configured:**
1. Proceed with full provisioning (Steps 1-8)

### 1. Detect Project Type

Scan the project directory to determine what needs provisioning:

| Signal | Detection | Service |
|--------|-----------|---------|
| `next.config.js` or `next.config.ts` | Next.js frontend | **Vercel** |
| `package.json` with `express`/`fastify`/`hono` | Standalone API | **Render** |
| Mongoose models or `MONGODB_URI` in `.env.example` | Database layer | **MongoDB Atlas** |
| All-in-one Next.js API routes | Next.js fullstack | **Vercel + Atlas** (no Render) |

Report findings to user before proceeding. Ask:
- Project name for services (lowercase, URL-safe)
- Which services to provision (confirm detected defaults)

### 2. MongoDB Atlas — Provision Database

**Prerequisites:** Atlas account, existing cluster (or create one).

**Using Atlas Admin API (if `MONGODB_ATLAS_PUBLIC_KEY` and `MONGODB_ATLAS_PRIVATE_KEY` env vars exist):**

```bash
# Create database user
curl -s -u "$MONGODB_ATLAS_PUBLIC_KEY:$MONGODB_ATLAS_PRIVATE_KEY" \
  --digest \
  -X POST "https://cloud.mongodb.com/api/atlas/v2/groups/$ATLAS_PROJECT_ID/databaseUsers" \
  -H "Content-Type: application/json" \
  -d '{
    "databaseName": "admin",
    "username": "<project>_user",
    "password": "<generated>",
    "roles": [{"databaseName": "<project>", "roleName": "readWrite"}]
  }'
```

**Manual fallback (no API keys):**
1. Log into Atlas dashboard → Database Access → Add New Database User
2. Username: `<project>_user`, password: generate strong random
3. Role: Read and write to `<project>` database
4. Network Access: ensure `0.0.0.0/0` is allowed (or add Vercel/Render IPs)
5. Build connection string: `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/<project>?retryWrites=true&w=majority`

**Output:** Connection string saved to `.env` (local) and set as env var on Vercel/Render.

### 3. Vercel — Create and Deploy Frontend

**Prerequisites:** `vercel` CLI installed and logged in.

```bash
# Step 1: Link or create project
cd <project-root>
vercel link -p <project-name>

# Step 2: Set environment variables (use printf to avoid trailing newline)
printf "<value>" | vercel env add MONGODB_URI production
printf "<value>" | vercel env add JWT_SECRET production
printf "<value>" | vercel env add NODE_ENV production

# Step 3: Create .vercelignore
cat > .vercelignore << 'EOF'
.env
.env.local
tests/
scripts/
artifacts/
docker-compose.yml
Dockerfile
Dockerfile.dev
.dockerignore
EOF

# Step 4: Deploy
vercel --prod
```

**Post-deploy checks:**
- Hit `/api/health` — expect `{"status":"ok","db":"connected"}`
- Verify env vars are loaded (no undefined, no trailing whitespace)

### 4. Render — Create and Deploy API (if separate API repo)

**Prerequisites:** Render account, GitHub repo connected.

**Using Render API (if `RENDER_API_KEY` env var exists):**

```bash
# Create web service
curl -s -X POST "https://api.render.com/v1/services" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "web_service",
    "name": "<project>-api",
    "repo": "https://github.com/<owner>/<repo>",
    "branch": "main",
    "rootDir": "",
    "runtime": "node",
    "region": "oregon",
    "plan": "starter",
    "buildCommand": "npm ci && npm run build",
    "startCommand": "npm start",
    "healthCheckPath": "/api/health",
    "envVars": [
      {"key": "NODE_ENV", "value": "production"},
      {"key": "PORT", "value": "10000"}
    ]
  }'

# Set secret env vars separately
curl -s -X POST "https://api.render.com/v1/services/<service-id>/env-vars" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {"key": "MONGODB_URI", "value": "<atlas-connection-string>"},
    {"key": "JWT_SECRET", "value": "<generated>"}
  ]'
```

**Manual fallback (no API key):**
1. Go to render.com → New → Web Service
2. Connect GitHub repo, select branch `main`
3. Name: `<project>-api`, Runtime: Node, Plan: Starter
4. Build: `npm ci && npm run build`, Start: `npm start`
5. Add env vars: `MONGODB_URI`, `JWT_SECRET`, `NODE_ENV=production`
6. Health check path: `/api/health`

**Also create `render.yaml`** at project root for Infrastructure as Code.

### 5. Generate Production .env.example

Update `.env.example` with all production variables documented:

```bash
# ── Database ──
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority

# ── Auth ──
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_EXPIRES_IN=7d

# ── App ──
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://<project>.vercel.app
```

### 6. Seed Production Database

Run the seed script against the production database to create initial data:

```bash
# Option A: Direct (if mongosh available)
mongosh "<atlas-uri>" --eval "db.users.find()" # verify connection first

# Option B: Via application
MONGODB_URI="<atlas-uri>" npx tsx scripts/seed.ts

# Option C: Via Docker
docker exec <container> sh -c 'MONGODB_URI="<atlas-uri>" npx tsx scripts/seed.ts'
```

### 7. Verify Everything

| Check | Command | Expected |
|-------|---------|----------|
| Health | `curl <url>/api/health` | `{"status":"ok","db":"connected"}` |
| Auth | `curl -X POST <url>/api/auth/login -d '...'` | `{"message":"Login successful"}` |
| HTTPS | Browser | Lock icon, valid cert |
| Env vars | Health endpoint | All required vars set |

### 8. Update State

- Add deployment URLs to `AI/state/STATE.md`
- Add credentials reference to `AI/state/AI_AGENT_HANDOFF.md`
- Log to `AI/logs/claude_log.md`
- Update `.env.example` with all production variables

## Outputs

- Vercel project created and deployed (if frontend)
- Atlas database user and connection string (if DB)
- Render service created (if separate API)
- `.vercelignore` created
- `render.yaml` created (if Render)
- `.env.example` updated
- Production URLs documented in state files
