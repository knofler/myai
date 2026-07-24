---
name: secrets-audit
description: "Audit secrets and environment variables — scan for hardcoded secrets, verify .env safety, check Docker layers, and review CI/CD secret management. Triggers: secrets, secret audit, API keys, credentials, environment security, .env audit"
---

# Secrets Audit

Audit the codebase for exposed secrets and insecure environment variable handling.

## Playbook

### 1. Scan codebase for hardcoded secrets

- Search for common patterns: API keys, passwords, tokens, connection strings.
- Regex patterns to check:
  - `(password|secret|key|token|api_key)\s*[:=]\s*['"][^'"]+`
  - `mongodb(\+srv)?://[^/\s]+`
  - `sk-[a-zA-Z0-9]{20,}`
  - `ghp_[a-zA-Z0-9]{36}`
  - `AKIA[0-9A-Z]{16}`
- Use `git log --all -p` to check history for previously committed secrets.
- Consider running `gitleaks` or `trufflehog` for automated scanning.

### 2. Verify .env is in .gitignore

- Confirm `.env` and all variants are listed in `.gitignore`:
  ```
  .env
  .env.local
  .env.*.local
  .env.production
  ```
- Run `git ls-files .env*` to verify no .env files are tracked.
- If found in history, rotate the exposed secrets immediately.

### 3. Check .env.example has all keys without values

- Verify `.env.example` exists and lists every required variable.
- Confirm no actual values are present — only descriptive placeholders.
  ```
  DATABASE_URL=mongodb://localhost:27017/myapp
  JWT_SECRET=your-secret-here
  API_KEY=
  ```
- Keep `.env.example` in version control as documentation.

### 4. Verify no secrets in Docker build layers

- Check `Dockerfile` for `COPY .env` or `ENV SECRET=...` instructions.
- Use multi-stage builds to avoid leaking build-time secrets.
- Use Docker BuildKit secrets for build-time credentials:
  ```dockerfile
  RUN --mount=type=secret,id=npm_token ...
  ```
- Run `docker history <image>` to inspect layers for exposed values.

### 5. Review CI/CD secret management

- Verify secrets are stored in GitHub Actions secrets (or equivalent).
- Check workflow files do not echo or log secret values.
- Confirm secrets are scoped to the minimum required environments.
- Verify OIDC is used for cloud provider auth where possible (no long-lived keys).

### 6. Check for exposed API keys in frontend

- Search client-side code for API keys or tokens.
- Verify only public/publishable keys are in client bundles.
- Confirm `NEXT_PUBLIC_` prefixed variables contain no sensitive data.
- Use server-side API routes to proxy requests that need secret keys.

### 7. Document findings and remediate

- List all findings with severity and location.
- Rotate any compromised secrets immediately.
- Update `.env.example` if new variables were found.
- Add `gitleaks` to the CI pipeline as a pre-merge check.
