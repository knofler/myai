---
name: analysis-lighthouse
description: "Interpret Lighthouse audit results. Prioritize findings by performance impact. Map each recommendation to specific code changes with estimated effort. Triggers: lighthouse, performance audit, web vitals, LCP, CLS, FID, page speed"
---

# Lighthouse Analysis Playbook

## When to Use

- Lighthouse performance score is below 90
- Core Web Vitals are failing in Google Search Console
- After a major feature release to check for performance regressions
- Before launch to ensure production readiness

## Prerequisites

- Lighthouse report available (JSON or HTML)
- Access to the deployed preview URL or local dev server
- Understanding of the page architecture (SSR, SSG, CSR)

## Playbook

### 1. Review Overall Scores

Extract the five audit categories:
- **Performance** (target: 90+)
- **Accessibility** (target: 95+)
- **Best Practices** (target: 95+)
- **SEO** (target: 95+)
- **PWA** (if applicable)

Flag any category below target.

### 2. Analyze Core Web Vitals

Focus on the three metrics that affect ranking:
- **LCP** (Largest Contentful Paint): target <2.5s
- **FID/INP** (Interaction to Next Paint): target <200ms
- **CLS** (Cumulative Layout Shift): target <0.1

For each failing metric, identify the element causing it (LCP element, layout shift source, long task).

### 3. Map Performance Opportunities

Review the "Opportunities" section and rank by estimated savings:

| Opportunity | Savings (ms) | Effort | Priority |
|-------------|-------------|--------|----------|

Common opportunities:
- Eliminate render-blocking resources
- Reduce unused JavaScript/CSS
- Serve images in next-gen formats
- Defer offscreen images
- Minimize main-thread work

### 4. Map Diagnostics to Code Changes

For each diagnostic finding, identify the specific file and code change:

- **Render-blocking CSS** → Move to component-level imports, use `media` attributes
- **Unused JS** → Dynamic import the module, check tree-shaking
- **Large images** → Switch to `next/image`, add width/height, use WebP
- **Layout shifts** → Add explicit dimensions to images/embeds, use `font-display: swap`
- **Long tasks** → Break up computation, use `requestIdleCallback`, move to web worker
- **DOM size** → Virtualize long lists, lazy render off-screen content

### 5. Prioritize by Impact-to-Effort Ratio

Score each fix:
- **Impact**: High (>500ms saving), Medium (100-500ms), Low (<100ms)
- **Effort**: Low (<1hr), Medium (1-4hr), High (>4hr)

Prioritize: High impact + Low effort first.

### 6. Create Implementation Plan

Order fixes into phases:
1. **Quick wins**: Image optimization, font loading, meta tags
2. **Medium effort**: Code splitting, lazy loading, caching headers
3. **Major refactors**: SSR/SSG changes, architecture changes

### 7. Set Regression Prevention

- Add Lighthouse CI to GitHub Actions pipeline
- Set score thresholds that block PRs
- Monitor Core Web Vitals in production via analytics

## Output

- Lighthouse score summary with pass/fail per category
- Core Web Vitals analysis with specific elements identified
- Prioritized fix list mapped to code changes
- Implementation plan in phases
- CI integration recommendation for regression prevention

## Review Checklist

- [ ] All five Lighthouse categories reviewed
- [ ] Core Web Vitals analyzed with specific elements identified
- [ ] Each opportunity mapped to a concrete code change
- [ ] Fixes prioritized by impact-to-effort ratio
- [ ] Quick wins separated from major refactors
- [ ] Lighthouse CI recommended for regression prevention
