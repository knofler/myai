---
name: vercel-deploy-frontend
description: "Deploy a Next.js frontend to Vercel with environment config and preview deployments. Triggers: Vercel deploy, deploy frontend, Vercel config, preview deployment"
---

# Skill: Deploy Frontend to Vercel

Configure and deploy the Next.js frontend to Vercel with proper environment handling.

## Playbook

### 1. Check Prerequisites

- Verify `package.json` has a valid `build` script.
- Run `npm run build` (or equivalent) locally to confirm it succeeds.
- Ensure `.gitignore` includes `.vercel/`, `.env.local`, and `node_modules/`.

### 2. Create or Update vercel.json

- Create `vercel.json` at project root if it does not exist.
- Configure:
  ```json
  {
    "framework": "nextjs",
    "buildCommand": "npm run build",
    "outputDirectory": ".next",
    "regions": ["iad1"],
    "headers": [
      {
        "source": "/(.*)",
        "headers": [
          { "key": "X-Content-Type-Options", "value": "nosniff" },
          { "key": "X-Frame-Options", "value": "DENY" }
        ]
      }
    ]
  }
  ```
- Adjust regions, redirects, and rewrites as needed.

### 3. Configure Environment Variables

- List all required env vars from `.env.example` or `.env.local`.
- Categorize by environment: Production, Preview, Development.
- Instruct the user to set them via Vercel dashboard or CLI:
  ```bash
  vercel env add NEXT_PUBLIC_API_URL production
  ```
- Never commit secret values to the repo.

### 4. Set Up Preview Deployments

- Verify Vercel GitHub integration is connected.
- Confirm every PR gets an automatic preview deployment.
- Add preview-specific env vars if the preview API differs from production.

### 5. Configure Custom Domain

- If a custom domain is required:
  - Add domain in Vercel dashboard under project settings.
  - Update DNS records (CNAME or A record) as instructed by Vercel.
  - Wait for SSL certificate provisioning (automatic).
- If no custom domain, use the default `.vercel.app` URL.

### 6. Add Deployment Badge to README

- Add a Vercel deployment status badge to `README.md`:
  ```markdown
  [![Deploy](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=REPO_URL)
  ```
- Or use project-specific deployment status badge if available.

### 7. Verify Deployment

- Confirm the production URL loads correctly.
- Check environment variables are resolved at runtime.
- Test preview deployment on a feature branch.
- Log action to `logs/claude_log.md`.
