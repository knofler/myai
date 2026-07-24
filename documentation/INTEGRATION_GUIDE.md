# Integration & Migration Guide: Existing Repositories

This guide explains how to transition an existing repository with its own documentation and AI logs into this standardized framework.

## 1. Conflict Resolution Principles
- **Global vs. Local:** The rules in `AI/documentation/AI_RULES.md` from the master template are **Global Mandates**. If the existing repo has conflicting tech stack rules, they must be updated to align with the global standard (Docker, Next.js, MongoDB, etc.) unless an explicit architectural exception is documented.
- **Append, Don't Overwrite:** For logs (`logs/claude_log.md`, `logs/gemini.md`, `logs/copilot.md`) and `state/STATE.md`, always append existing history to the new standardized format.
- **Project Context Preservation:** Any project-specific architectural decisions or design specs found in existing folders must be moved to the respective subdirectories in the new `AI/` folder.

## 2. Step-by-Step Integration Process

### Step A: Deep Traversal & Folder Merging
1.  **Deep Search for Docs and Logs:** Use `glob` or recursive search across the **entire workspace** (including deep subdirectories, one or more levels deep) to locate scattered documentation, plans, and AI logs (e.g., `claude.md`, `gemini.md`, `copilot.md`, `instructions.md`).
2.  **Consolidate to AI Root:** Move and organize these found files into the new centralized `AI/` structure at the workspace root:
    - `docs/` or scattered documentation -> `AI/documentation/`
    - Architecture docs -> `AI/architecture/`
    - Plans/roadmaps -> `AI/plan/`
3.  **Clean Up:** Remove the old folders after verifying all files have been safely consolidated into the `AI/` framework.

### Step B: Log and State Synchronization
1.  **Combine Logs:** If `claude.md`, `gemini.md`, or `copilot.md` were found anywhere in the workspace, copy their historical entries and paste them under the appropriate headers in the corresponding log files inside the `AI/logs/` directory.
2.  **Initialize STATE.md:** If there are existing "status", "progress", or "session" files, summarize them and move the content into `AI/state/STATE.md` at the workspace root to build rich context for the next agent.

### Step C: Rule Harmonization
1.  **Merge AI_RULES.md:** 
    - Keep the **Global Instructions** (Section 1-4) from the master template at the top.
    - Add a new section: **## 5. Project-Specific Overrides & Context**.
    - Move any existing project-specific rules or constraints found during your search into this new section.

### Step D: Infrastructure Alignment
1.  **Create Template Files:** If they don't exist, create `.gitignore`, `.dockerignore`, and `.env.example`.
2.  **Update Docker Compose:** Ensure any existing `docker-compose.yml` is updated to map environment variables as per the global mandate.

---

## 3. Sequential Integration Prompt (The "Trigger")
Copy and paste the following prompt to an AI agent to start the migration:

> "I am integrating this existing repository into the Global AI Management Framework. Please execute the following steps sequentially:
> 1. **Analyze:** Use `glob` to recursively scan the ENTIRE workspace (including nested project folders) for existing documentation, design files, or AI logs (`claude.md`, `gemini.md`, `copilot.md`, `instructions.md`).
> 2. **Structure:** Ensure the `AI/` folder structure exists at the workspace root as defined in the master framework.
> 3. **Consolidate & Migrate:** Move all found documentation and logs from their scattered locations into the centralized `AI/` subdirectories at the workspace root. Merge contents to build rich context.
> 4. **Standardize:** Apply the `AI/documentation/AI_RULES.md` global mandates. If project-specific rules were found, move them to a new 'Project-Specific Overrides' section in `AI/documentation/AI_RULES.md`.
> 5. **Verify:** Ensure `.gitignore`, `.dockerignore`, and `.env.example` are present at the workspace root and aligned with the Docker/Next.js/MongoDB stack. 
> 6. **Log:** Document the migration steps taken in your respective log (e.g., `AI/logs/gemini.md`)."
