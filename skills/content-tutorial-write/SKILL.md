---
name: content-tutorial-write
description: "Write step-by-step tutorials with prerequisites, setup, code examples, and troubleshooting. Triggers: tutorial, how-to guide, step-by-step, walkthrough, getting started guide"
---
# Tutorial Writing Playbook

## When to Use
- Onboarding developers to a new project or feature
- Documenting a complex setup or integration process
- Creating guides for API consumers or end users
- Teaching a specific workflow or best practice

## Prerequisites
- Working knowledge of the subject being documented
- Access to a clean environment to verify all steps
- Understanding of the target audience's skill level
- List of tools and dependencies required

## Playbook

### 1. Define Scope and Audience
- State what the reader will achieve by the end
- Identify skill level: beginner, intermediate, advanced
- List what is NOT covered (link to other resources)
- Estimate time to complete the tutorial

### 2. Write Prerequisites Section
- List required software with specific versions
- Include installation commands or links
- Note any accounts, API keys, or access needed
- Provide a way to verify prerequisites are met

### 3. Write Setup Steps
- Start from a clean state (clone repo, create directory)
- Number each step sequentially
- Include exact commands to run (copy-pasteable)
- Show expected output after key commands
- Add checkpoints: "At this point you should see..."

### 4. Write Core Tutorial Steps
- One concept per step (do not combine unrelated actions)
- Lead with what the step accomplishes, then how
- Include full code snippets (not fragments) with file paths
- Highlight important values or configuration with bold or comments
- Show the result after each meaningful step

### 5. Add Expected Output
- Include terminal output, screenshots descriptions, or UI state
- Show both success and common error outputs
- Use code blocks for terminal output
- Clearly distinguish between what the user types and what they see

### 6. Write Troubleshooting Section
- List the 3-5 most common errors encountered
- For each: error message, cause, and fix
- Include "If X doesn't work, try Y" patterns
- Link to relevant documentation or issue trackers

### 7. Add Summary and Next Steps
- Recap what was accomplished
- List what the reader can explore next
- Link to related tutorials or documentation
- Invite feedback or contributions

## Output
- Tutorial document in Markdown
- Any supporting files (config templates, sample data)
- Verified: all steps tested in a clean environment

## Review Checklist
- [ ] All steps tested end-to-end in a clean environment
- [ ] Prerequisites are complete and verifiable
- [ ] Code snippets are copy-pasteable and correct
- [ ] Expected output shown after key steps
- [ ] Troubleshooting covers common failure modes
- [ ] No assumed knowledge beyond stated prerequisites
