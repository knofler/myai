---
name: github-actions-pipeline
description: "Create GitHub Actions CI/CD pipelines for test, build, and deploy. Triggers: 'CI/CD', 'GitHub Actions', 'pipeline', 'workflow', 'continuous integration', 'automated deploy'"
---

# GitHub Actions CI/CD Pipeline

Create a complete CI/CD pipeline using GitHub Actions with test, build, and deploy stages.

## Prerequisites

- GitHub repository initialized
- Deployment targets configured (Vercel for frontend, Render for API)
- Repository secrets set in GitHub Settings > Secrets

## Steps

### 1. Create workflow directory and file

```
mkdir -p .github/workflows
```

Create `.github/workflows/ci.yml` for the main pipeline.

### 2. Define triggers

```yaml
name: CI/CD Pipeline
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
```

### 3. Add lint job

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
```

### 4. Add test job

```yaml
  test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
```

### 5. Add build job

```yaml
  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build
```

### 6. Configure secrets

Required secrets in GitHub repo settings:
- `VERCEL_TOKEN` — Vercel deployment token
- `VERCEL_ORG_ID` — Vercel organization ID
- `VERCEL_PROJECT_ID` — Vercel project ID
- `RENDER_API_KEY` — Render deploy hook or API key
- `MONGODB_URI` — Database connection string (for test job if needed)

Reference in workflow: `${{ secrets.VERCEL_TOKEN }}`

### 7. Add deploy step (Vercel frontend)

```yaml
  deploy-frontend:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
```

### 8. Add deploy step (Render API)

```yaml
  deploy-api:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    steps:
      - run: curl -X POST "${{ secrets.RENDER_DEPLOY_HOOK }}"
```

### 9. Add status badge to README

```markdown
![CI/CD](https://github.com/ORG/REPO/actions/workflows/ci.yml/badge.svg)
```

## Validation

```bash
gh workflow list                    # List workflows
gh workflow run ci.yml              # Trigger manually
gh run list --workflow=ci.yml       # Check run history
gh run view <run-id> --log          # View logs
```
