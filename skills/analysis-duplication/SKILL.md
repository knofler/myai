---
name: analysis-duplication
description: "Scan codebase for repeated code blocks longer than 5 lines. Group by similarity, calculate duplication percentage, and suggest extraction into shared utilities. Triggers: duplication, duplicate code, copy paste, DRY, code clones"
---

# Code Duplication Analysis Playbook

## When to Use

- Codebase has grown organically and DRY violations are suspected
- Before extracting shared libraries or utilities
- During tech debt assessment
- When multiple developers have implemented similar logic independently

## Prerequisites

- Source code accessible (TypeScript/JavaScript project)
- Knowledge of project module structure for extraction targets

## Playbook

### 1. Define Detection Parameters

Set thresholds before scanning:
- **Minimum block size**: 5 lines (ignore smaller matches)
- **Similarity threshold**: 80% (catch near-duplicates, not just exact copies)
- **Ignore patterns**: imports, type declarations, boilerplate comments

### 2. Scan for Exact Duplicates

Search for identical code blocks across all source files. Compare normalized code (whitespace and variable names ignored). Record each duplicate pair with:
- File A path + line range
- File B path + line range
- Duplicate block content
- Line count

### 3. Scan for Near-Duplicates

Look for structurally similar blocks where only variable names, string literals, or minor logic differ. These are often copy-paste-modify patterns. Flag blocks with >80% token similarity.

### 4. Group by Similarity Cluster

Cluster duplicate blocks into groups where each group represents one logical pattern that was copied. For each cluster:
- Count of occurrences
- List of all locations
- Representative code sample
- Variation notes (what differs between copies)

### 5. Calculate Duplication Metrics

- **Duplication percentage**: duplicated lines / total lines
- **Cluster count**: number of distinct duplicated patterns
- **Worst offenders**: files with highest duplication ratio

### 6. Suggest Extraction Targets

For each cluster, recommend an extraction strategy:
- **Utility function**: pure logic duplicated across files
- **Shared component**: UI pattern repeated in multiple pages
- **Base class / mixin**: similar class methods across models
- **Configuration**: repeated config objects or constants
- **Middleware**: duplicated request handling logic

Specify the target module path (e.g., `src/utils/`, `src/components/shared/`).

### 7. Produce Report

| Cluster | Occurrences | Lines Each | Total Waste | Suggested Extraction |
|---------|-------------|-----------|-------------|---------------------|

Include overall duplication percentage and top 5 extraction priorities.

## Output

- Duplication report with cluster details
- Extraction recommendations with target locations
- Duplication percentage metric
- Priority-ranked list of refactoring tasks

## Review Checklist

- [ ] All source directories scanned
- [ ] Minimum block size threshold applied (5+ lines)
- [ ] Both exact and near-duplicates detected
- [ ] Duplicates grouped into meaningful clusters
- [ ] Each cluster has a specific extraction recommendation
- [ ] Import statements and type declarations excluded from matches
