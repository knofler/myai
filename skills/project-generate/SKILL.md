# Skill: Project Generate

> Agent: **solution-architect** (primary), **swarm-coordinator** (for multi-agent dispatch)
> Triggers: `generate`, `generate project`, `idea to deployment`, `create project from idea`, `autonomous build`

---

## Purpose

Generate a complete project from an idea through 8 stages. Claude Code generates each stage directly — no API key or external calls needed. Each stage builds on the previous, producing a full set of documents from concept to deployment plan.

---

## Pipeline Stages

| # | Stage | Output | Agent Equivalent |
|---|-------|--------|-----------------|
| 1 | **Idea Refinement** | Structured concept, personas, features | product-manager |
| 2 | **Project Plan** | Milestones, architecture, task breakdown | project-manager |
| 3 | **BRD** | Functional/non-functional requirements, user stories | tech-ba |
| 4 | **Gap Analysis** | Coverage matrix, risks, missing components | solution-architect |
| 5 | **TRD** | Schemas, API specs, auth flow, infrastructure | solution-architect |
| 6 | **Design Spec** | Design system, components, page layouts, a11y | ui-ux-specialist |
| 7 | **Build Spec** | File structure, build order, implementation guide | tech-lead |
| 8 | **Ship Plan** | Deployment steps, monitoring, rollback plan | devops-specialist |

---

## How It Works

Claude Code IS the generation engine. No separate API calls needed.

1. **Read stage definitions** from `config/generation-stages.json`
2. **Create project workspace** at `projects/<name>/` with `stages/`, `artifacts/`, `code/`
3. **For each stage**, Claude Code:
   - Reads the stage instructions from the config
   - Generates content using the previous stage's output as context (relay semantics)
   - Saves to `projects/<name>/stages/<stage>.md`
   - Updates `project.json` manifest
4. **Optional**: If scanning an existing project first, include `AI/scan-report.json` as context

---

## Steps to Execute

### Step 1: Create Project Workspace

```
mkdir -p projects/<name>/stages projects/<name>/artifacts projects/<name>/code
```

Write `project.json`:
```json
{
  "name": "<name>",
  "idea": "<the idea>",
  "status": "generating",
  "current_stage": "idea",
  "stages_completed": [],
  "created_at": "<timestamp>"
}
```

### Step 2: Read Stage Config

Read `config/generation-stages.json` — contains 8 stage definitions with `id`, `name`, `description`, and `instructions`.

### Step 3: Generate Each Stage (Relay)

For each stage in order:

1. **Context**: Original idea + previous stage output (if any) + scan report (if any)
2. **Instructions**: Follow the `instructions` field from the stage definition
3. **Output**: Write to `projects/<name>/stages/<stage-id>.md`
4. **Track**: Add stage to `stages_completed` in `project.json`

**Relay rule**: Each stage receives ONLY the previous stage's output, not all stages.

### Step 4: Scan First (Optional)

For existing projects:
```bash
./scripts/scan-project.sh /path/to/project
```
Then include the scan report as additional context when generating.

---

## Usage Examples

### Greenfield Project
```
User: generate "SaaS dashboard for tracking fitness metrics"
```
Claude Code creates workspace, generates all 8 stages.

### With Existing Project Scan
```
User: generate "add real-time notifications" --scan /path/to/your-repo
```
Claude Code scans first, then generates with existing stack context.

### Resume Partial Generation
If generation was interrupted, check `project.json` for `stages_completed` and continue from the next incomplete stage.

---

## Output Structure

```
projects/
  <project-name>/
    project.json          ← Manifest: status, stages completed
    stages/
      idea.md             ← Stage 1 output
      plan.md             ← Stage 2 output
      brd.md              ← Stage 3 output
      gap-analysis.md     ← Stage 4 output
      trd.md              ← Stage 5 output
      design.md           ← Stage 6 output
      build.md            ← Stage 7 output
      ship.md             ← Stage 8 output
    artifacts/            ← Generated artifacts (future)
    code/                 ← Scaffolded project code (future)
```

---

## MCP Tool Integration (Optional)

When the MCP server is running, these tools are available:
- `init-generation` — Create project workspace
- `mark-stage-complete` — Track stage completion
- `generation-status` — Show project status

These are optional — Claude Code can manage files directly without MCP.

---

## Post-Generation Workflow

After generation completes:

1. Review each stage document in `projects/<name>/stages/`
2. Use `agent mode` to dispatch specialists based on the Build Spec
3. Run `scan [path]` after implementation to verify coverage
4. Use `ship it` to deploy

---

## Notes

- No API key needed — Claude Code generates content directly
- No Docker needed for generation — only for the MCP server (optional)
- The scanner (`scan-project.sh`) runs as plain bash — no dependencies
- Stage definitions in `config/generation-stages.json` can be customized per project
- All outputs are markdown — human-readable and version-controllable
