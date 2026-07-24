---
name: render-deploy-api
description: "Deploy an API to Render.com — render.yaml, environment variables, health checks, auto-deploy. Triggers: 'deploy to Render', 'Render deployment', 'render.yaml', 'deploy API', 'production deploy', 'staging deploy'."
---

# Deploy API to Render.com

Configure and deploy the API service to Render.com with proper health checks, environment variables, and auto-deploy from GitHub.

## When to Use

- Setting up initial deployment for a new API
- Updating deployment configuration (scaling, env vars, build commands)
- Adding staging or preview environments
- Troubleshooting a failed deploy

## Prerequisites

- Render.com account connected to the GitHub repository
- MongoDB Atlas connection string ready
- JWT secret and any third-party API keys available
- Dockerfile present (recommended) or a supported runtime detected by Render

## Playbook

### 1. Create or Update `render.yaml`

Place `render.yaml` at the repository root. This is the Infrastructure as Code manifest Render uses.

```yaml
services:
  - type: web
    name: project-api
    runtime: node           # or docker, python
    region: oregon
    plan: starter
    buildCommand: npm ci --production=false && npm run build
    startCommand: npm start
    healthCheckPath: /api/v1/health
    autoDeploy: true
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "10000"
      - key: MONGODB_URI
        sync: false         # set manually in Render dashboard
      - key: JWT_SECRET
        sync: false
      - key: ALLOWED_ORIGINS
        sync: false
```

For Docker-based deploys, set `runtime: docker` and ensure a `Dockerfile` exists.

### 2. Configure Environment Variables

**In the Render Dashboard (for secrets):**
- `MONGODB_URI` — Atlas connection string (use SRV format)
- `JWT_SECRET` — strong random string, minimum 32 characters
- `ALLOWED_ORIGINS` — comma-separated frontend URLs for CORS

**In `render.yaml` (for non-secrets):**
- `NODE_ENV`, `PORT`, `LOG_LEVEL`, `API_VERSION`

Never commit secrets to `render.yaml`. Use `sync: false` for any value that must be set in the dashboard.

### 3. Set Up the Health Check Endpoint

Create a dedicated health check route that Render polls to verify the service is alive.

**Express:**
```js
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});
```

**FastAPI:**
```python
@router.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}
```

Set `healthCheckPath` in `render.yaml` to match this route.

### 4. Configure Auto-Deploy from GitHub

- In Render Dashboard: connect the repo and select the branch (`main` for production)
- `autoDeploy: true` in `render.yaml` triggers a deploy on every push to the branch
- For staging: create a second service entry pointing to a `develop` or `staging` branch

### 5. Verify the Deployment

After deploy completes:
1. Hit the health check URL: `https://<service>.onrender.com/api/v1/health`
2. Confirm a `200 OK` with the expected JSON payload
3. Test a protected endpoint to verify JWT auth works with production secrets
4. Check Render logs for any startup errors or warnings
5. Verify MongoDB connectivity by hitting an endpoint that reads from the database

### 6. Post-Deploy Checklist

- [ ] `render.yaml` committed and valid
- [ ] All secrets set in Render Dashboard (never in code)
- [ ] Health check endpoint returns 200
- [ ] Auto-deploy triggers on push to the target branch
- [ ] CORS allows the production frontend origin
- [ ] Logs show clean startup with no errors
- [ ] MongoDB connection established successfully
- [ ] SSL/TLS active (Render provides this automatically)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Build fails | Check `buildCommand`, ensure `package.json` or `requirements.txt` is at repo root |
| Health check fails | Verify `healthCheckPath` matches the actual route and the server binds to `0.0.0.0` |
| 503 after deploy | Check Render logs — likely a missing env var or failed DB connection |
| CORS errors | Confirm `ALLOWED_ORIGINS` includes the frontend URL with protocol |
