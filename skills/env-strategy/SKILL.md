---
name: env-strategy
description: "Set up environment variable strategy with per-environment configs. Triggers: 'environment variables', '.env', 'env strategy', 'config management', 'secrets setup'"
---

# Environment Variable Strategy

Establish a secure, documented environment variable strategy across dev, staging, and production.

## Prerequisites

- Project repository initialized
- Deployment targets identified (Vercel, Render, local Docker)

## Steps

### 1. Create .env.example at project root

Document every variable with descriptions and example values.

```env
# === Application ===
NODE_ENV=development                  # development | staging | production
PORT=3000                             # Application port
API_URL=http://localhost:4000         # Backend API base URL

# === Database (Required) ===
MONGODB_URI=mongodb://localhost:27017/myapp   # MongoDB connection string

# === Authentication (Required) ===
JWT_SECRET=change-me-to-random-string         # JWT signing secret
JWT_EXPIRY=7d                                 # Token expiration

# === External Services (Optional) ===
# SENDGRID_API_KEY=                   # Email service
# STRIPE_SECRET_KEY=                  # Payment processing
# S3_BUCKET=                          # File storage
```

### 2. Mark required vs optional variables

- Required: app cannot start without these (DB, auth secrets)
- Optional: feature-gated, app degrades gracefully without them
- Use comments in `.env.example` to indicate which are required

### 3. Configure .gitignore

Ensure secrets are never committed:

```
.env
.env.local
.env.*.local
```

Keep `.env.example` tracked in git.

### 4. Create per-environment config files

```
.env.example        # Template — committed to git
.env                # Local dev — gitignored
.env.test           # Test runner — gitignored
```

Production and staging variables live in platform dashboards (Vercel/Render), never in files.

### 5. Configure Docker Compose env mapping

```yaml
services:
  app:
    env_file: .env
    environment:
      - NODE_ENV=development
      - API_URL=http://api:4000
  db:
    environment:
      - MONGO_INITDB_ROOT_USERNAME=${MONGO_USER}
      - MONGO_INITDB_ROOT_PASSWORD=${MONGO_PASS}
```

### 6. Set up platform environment variables

**Vercel (frontend):**
- Dashboard > Project > Settings > Environment Variables
- Set `NEXT_PUBLIC_*` vars for client-side access
- Scope per environment: Production, Preview, Development

**Render (API):**
- Dashboard > Service > Environment
- Add all server-side secrets
- Use Environment Groups for shared variables

### 7. Add startup validation

Create a config validation module that runs at app boot:

```javascript
const required = ['MONGODB_URI', 'JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
```

### 8. Document in project README

Add a setup section pointing to `.env.example` with copy instructions:

```bash
cp .env.example .env
# Edit .env with your local values
```

## Validation

- Confirm `.env` is in `.gitignore`
- Run `git status` to verify no secrets are staged
- Start app and confirm no missing-variable errors
- Check `.env.example` has every variable the app uses
