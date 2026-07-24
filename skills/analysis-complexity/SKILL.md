---
name: analysis-complexity
description: "Calculate cyclomatic and cognitive complexity per function. Flag functions exceeding threshold of 10. Rank by severity and suggest refactoring strategies. Triggers: complexity, cyclomatic, cognitive complexity, complex functions, refactor complexity"
---

# Code Complexity Analysis Playbook

## When to Use

- Codebase feels hard to maintain or test
- Before a major refactoring effort to identify priorities
- During code review when a function feels too complex
- As part of a regular codebase health audit

## Prerequisites

- Source code accessible (TypeScript/JavaScript project)
- Understanding of cyclomatic complexity (independent paths) and cognitive complexity (human readability)

## Playbook

### 1. Scan All Functions

Walk through `src/` and identify every function, method, and arrow function. For each, count:
- **Cyclomatic complexity**: +1 for each `if`, `else if`, `&&`, `||`, `for`, `while`, `case`, `catch`, ternary
- **Cognitive complexity**: +1 for each break in linear flow, +increment for nesting depth

### 2. Flag High-Complexity Functions

Apply thresholds:
- **Warning**: complexity 6-10
- **Critical**: complexity >10
- **Severe**: complexity >15

Record file path, function name, line number, and both complexity scores.

### 3. Rank by Severity

Sort flagged functions by:
1. Cognitive complexity (descending) — hardest to understand first
2. Cyclomatic complexity (descending) — hardest to test
3. Function length (lines of code) as tiebreaker

### 4. Analyze Root Causes

For each critical function, identify the complexity driver:
- **Deep nesting**: nested if/else/for chains
- **Multiple responsibilities**: function does too many things
- **Complex conditionals**: boolean logic with many operands
- **State management**: multiple state transitions in one function

### 5. Suggest Refactoring Strategy

Map each root cause to a refactoring pattern:
- Deep nesting → Early returns / guard clauses
- Multiple responsibilities → Extract method / single responsibility
- Complex conditionals → Extract to named boolean functions
- State management → State machine pattern or strategy pattern

### 6. Produce Report

Generate a markdown table:

| File | Function | Line | Cyclomatic | Cognitive | Driver | Suggested Fix |
|------|----------|------|-----------|-----------|--------|--------------|

Include summary statistics: total functions scanned, percentage above threshold, top 5 hotspots.

## Output

- Complexity report as markdown table
- Top 10 refactoring candidates with specific strategies
- Summary statistics (mean, median, max complexity)

## Review Checklist

- [ ] All source files scanned
- [ ] Both cyclomatic and cognitive complexity calculated
- [ ] Threshold applied correctly (warning >6, critical >10)
- [ ] Root cause identified for each flagged function
- [ ] Refactoring strategy is specific, not generic
- [ ] Report sorted by severity
