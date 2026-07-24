---
name: content-technical-doc
description: "Write technical documentation with architecture overview, components, data flow, and deployment guide. Triggers: technical doc, architecture doc, system documentation, technical writing, deployment guide"
---
# Technical Documentation Playbook

## When to Use
- Documenting a new system or major feature for the team
- Onboarding new developers who need to understand the architecture
- Creating deployment or operations guides
- Updating docs after significant architectural changes

## Prerequisites
- Access to the codebase and running system
- Understanding of the system's purpose and users
- Knowledge of deployment infrastructure
- Stakeholder input on audience (developers, ops, product)

## Playbook

### 1. Define Scope and Audience
- Identify the document type: architecture overview, component guide, deployment guide, or runbook
- Define the primary audience: developers, DevOps, product, external
- Set the depth level: high-level overview vs detailed implementation
- List sections to include based on audience needs

### 2. Write Architecture Overview
- Describe the system purpose in 2-3 sentences
- List key design decisions and their rationale
- Identify system boundaries (what is in scope, what is external)
- Include a high-level architecture diagram (Mermaid flowchart)
- Document technology stack with version numbers

### 3. Document Components
- List each component/service with its responsibility
- Document interfaces between components (APIs, events, shared state)
- Describe the directory structure and code organization
- Include component-level diagrams where helpful
- Note configuration options and environment variables

### 4. Map Data Flow
- Create data flow diagrams for key operations (Mermaid sequence diagrams)
- Document request lifecycle from client to database and back
- Identify async flows (queues, webhooks, scheduled jobs)
- Note data transformation points and validation boundaries

### 5. Write Deployment Guide
- Document prerequisites (Docker, Node.js version, env vars)
- Provide step-by-step local development setup
- Document staging and production deployment procedures
- Include health check and verification steps
- List common troubleshooting scenarios and solutions

### 6. Add Diagrams
- Architecture diagram: components and their connections
- Sequence diagrams: key user flows
- ER diagram: data model relationships
- Deployment diagram: infrastructure layout
- Use Mermaid syntax for all diagrams (renders in GitHub)

### 7. Review and Maintain
- Have a team member follow the doc to verify accuracy
- Add a "Last updated" date and owner
- Link from README.md for discoverability
- Set a review cadence (quarterly or after major changes)

## Output
- Technical documentation file (Markdown)
- Mermaid diagrams embedded in the document
- Deployment/operations guide
- Troubleshooting FAQ section

## Review Checklist
- [ ] Document purpose and audience clearly stated
- [ ] Architecture diagram accurately reflects current system
- [ ] All components documented with responsibilities
- [ ] Data flows cover happy path and error scenarios
- [ ] Deployment steps verified by following them
- [ ] Diagrams render correctly in GitHub Markdown
- [ ] No stale information from previous architecture
