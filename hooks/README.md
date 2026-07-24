# Claude Code Hooks

> 26 automated hooks that fire during Claude Code sessions. Configured in `.claude/settings.json`.

## Directory Structure

```
hooks/
  session/     ← SessionStart: runs when a session begins
  pre-tool/    ← PreToolUse: runs before tool execution (can BLOCK)
  post-tool/   ← PostToolUse: runs after tool succeeds
  stop/        ← Stop: runs when Claude finishes responding
```

## Hook Catalog

### Session Start (9 hooks)

| # | Script | Purpose | Timeout |
|---|--------|---------|---------|
| 1 | `01-machine-switch.sh` | Detect hostname change, warn about stale Docker | 5s |
| 2 | `02-dropbox-conflicts.sh` | Scan for Dropbox conflict files | 10s |
| 3 | `03-docker-health.sh` | Verify Docker daemon + containers healthy | 15s |
| 4 | `04-atlas-connectivity.sh` | Test MongoDB Atlas connection, show collection stats | 10s |
| 5 | `05-copilot-status.sh` | Check GitHub Copilot CLI extension | 5s |
| 6 | `06-aws-auth.sh` | Verify AWS CLI credentials (`sts get-caller-identity`) | 8s |
| 7 | `07-azure-auth.sh` | Verify Azure CLI login (`az account show`) | 8s |
| 8 | `11-yolo-status.sh` | Check YOLO mode state — show active/expired/inactive | 3s |
| 9 | `12-usage-guard-init.sh` | Initialize session usage metrics (time + action tracking) | 3s |

### Pre-Tool Use (10 hooks)

These run before Bash/Edit/Write tools. Exit code 2 = **BLOCK** the action.

| # | Script | Purpose | Blocks? | Timeout |
|---|--------|---------|---------|---------|
| 1 | `01-block-push-main.sh` | Prevent direct `git push` to main/master | Yes | 3s |
| 2 | `02-commit-msg-lint.sh` | Warn on non-conventional commit messages | Warn | 3s |
| 3 | `03-secret-scan.sh` | Block commits with API keys, passwords, PEM keys | Yes | 5s |
| 4 | `04-protected-files.sh` | Block deletion of STATE.md, CLAUDE.md, etc. | Yes | 3s |
| 5 | `05-no-local-npm.sh` | Block bare npm/npx/node — must use Docker | Yes | 3s |
| 6 | `06-terraform-plan-guard.sh` | Warn if `terraform apply` without prior plan | Warn | 3s |
| 7 | `07-terraform-state-lock.sh` | Warn if terraform state is locked | Warn | 3s |
| 8 | `08-iac-validate.sh` | Validate CFN/Bicep/CDK templates before deploy | Yes | 10s |
| 9 | `09-cloud-cost-guard.sh` | Warn about expensive AWS/Azure resource creation | Warn | 3s |
| 10 | `10-usage-guard.sh` | Track session capacity — warn 80/90%, block at 95% | Yes (95%) | 3s |

### Post-Tool Use (5 hooks)

| # | Script | Purpose | Trigger | Timeout |
|---|--------|---------|---------|---------|
| 1 | `01-tsc-on-commit.sh` | Run TypeScript check after git commit | `git commit` | 60s |
| 2 | `02-vercel-status.sh` | Check Vercel deployment after push | `git push` | 10s |
| 3 | `03-render-health.sh` | Check Render service health after push | `git push` | 10s |
| 4 | `04-gh-actions-status.sh` | Check GitHub Actions CI status after push | `git push` | 10s |
| 5 | `05-framework-sync-reminder.sh` | Remind to run update_all.sh after framework edits | Edit/Write | 3s |

### Stop (1 hook)

| # | Script | Purpose | Timeout |
|---|--------|---------|---------|
| 1 | `01-state-save-reminder.sh` | Remind to update STATE.md if stale (>30min) | 5s |

## How Hooks Work

- **SessionStart**: All 9 session hooks run on every new session
- **PreToolUse**: Hooks receive JSON on stdin with `tool_name` and `tool_input`
  - Exit 0 = allow, Exit 2 = block the action
- **PostToolUse**: Same stdin format, runs after tool succeeds
- **Stop**: Fires when Claude finishes a response

## Adding New Hooks

1. Create script in the appropriate `hooks/` subdirectory
2. Make executable: `chmod +x hooks/category/script.sh`
3. Add to `.claude/settings.json` under the right event
4. Test: run a command that should trigger it

## Cloud/IaC Coverage

| Platform | Hooks |
|----------|-------|
| **AWS** | Auth check, CloudFormation validate, CDK synth guard, cost warning |
| **Azure** | Auth check, Bicep validate, cost warning |
| **Terraform** | Plan guard, state lock check, cost estimate |
| **Pulumi** | Preview check before `pulumi up --yes` |
| **Vercel** | Deployment status after push |
| **Render** | Service health after push |
| **MongoDB Atlas** | Connectivity + collection stats |
| **GitHub Actions** | CI workflow status after push |
| **GitHub Copilot** | Extension status check |
