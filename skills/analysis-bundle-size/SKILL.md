---
name: analysis-bundle-size
description: "Analyze Next.js or webpack bundle output. Identify largest modules, tree-shaking opportunities, dynamic import candidates, and lazy loading targets. Triggers: bundle size, bundle analysis, webpack, chunk size, large bundle, page weight"
---

# Bundle Size Analysis Playbook

## When to Use

- Page load times are slow or Lighthouse performance score is low
- Bundle size has grown significantly between releases
- Adding a new dependency and need to assess size impact
- Optimizing for mobile or low-bandwidth users

## Prerequisites

- Next.js or webpack-based project
- Build output accessible (`.next/` directory or webpack stats)
- Docker container running for build commands

## Playbook

### 1. Generate Build Analysis

Run the production build and capture bundle stats:

```bash
docker exec <container> npx next build
```

Review the build output table showing page sizes, first load JS, and shared chunks. Note any pages exceeding 100KB first-load JS.

### 2. Identify Largest Chunks

Examine `.next/analyze/` or use `@next/bundle-analyzer`:
- List all chunks sorted by size (descending)
- Identify the top 10 largest modules
- Check shared chunks vs page-specific chunks
- Note total bundle size and per-route sizes

### 3. Trace Large Dependencies

For each oversized module, determine:
- **Package name and version**
- **Compressed vs uncompressed size**
- **How many pages import it** (shared vs single-page)
- **Whether a lighter alternative exists** (e.g., date-fns vs moment, lodash-es vs lodash)

### 4. Check Tree-Shaking Effectiveness

Look for signs of poor tree-shaking:
- Barrel file imports (`import { x } from './components'` pulling entire directory)
- CommonJS modules that cannot be tree-shaken
- Side-effect imports that prevent dead code elimination
- Namespace imports (`import * as utils from './utils'`)

### 5. Identify Lazy Loading Candidates

Flag components and modules that should use dynamic imports:
- Below-the-fold components (modals, drawers, tabs)
- Heavy visualization libraries (charts, maps, editors)
- Admin-only features loaded on public pages
- Conditional features behind feature flags

Recommend `next/dynamic` with `{ ssr: false }` where appropriate.

### 6. Check Image and Asset Optimization

- Verify `next/image` is used instead of raw `<img>`
- Check for inline SVGs that could be components
- Look for large static assets in the public folder
- Verify font loading strategy (preload, swap)

### 7. Produce Optimization Report

| Module/Page | Current Size | Target Size | Optimization | Priority |
|-------------|-------------|-------------|--------------|----------|

Include total savings estimate and implementation effort per optimization.

## Output

- Bundle analysis report with per-page and per-module sizes
- Top 10 largest dependencies with alternatives
- Lazy loading candidates with implementation guidance
- Tree-shaking issues with specific fix instructions
- Estimated total size reduction

## Review Checklist

- [ ] Production build analyzed (not development)
- [ ] All pages checked for first-load JS size
- [ ] Largest dependencies identified with alternatives
- [ ] Tree-shaking issues flagged with barrel file locations
- [ ] Dynamic import candidates listed with priority
- [ ] Image optimization verified
- [ ] Estimated savings calculated per optimization
