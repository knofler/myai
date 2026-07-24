---
name: ops-capacity-report
description: "Generate a capacity planning report covering current resource usage, growth projections, cost estimates, scaling recommendations, and bottleneck identification. Triggers: capacity report, capacity planning, resource usage, scaling plan, cost projection, infrastructure sizing"
---

# Capacity Report Playbook

## When to Use

- Before a product launch to ensure infrastructure can handle expected load
- Quarterly infrastructure review
- When monitoring shows resources approaching limits
- Before budgeting season to project infrastructure costs
- After a scaling incident to reassess capacity

## Prerequisites

- Access to hosting dashboards (Vercel, Render, Atlas)
- Current usage metrics (requests/sec, CPU, memory, storage)
- User growth data or projections
- Current infrastructure cost data

## Playbook

### 1. Inventory Current Infrastructure

Document every service and its resource allocation:

| Service | Provider | Tier | CPU | Memory | Storage | Monthly Cost |
|---------|----------|------|-----|--------|---------|-------------|
| Frontend | Vercel | Pro | - | - | - | $20 |
| API | Render | Starter | 0.5 CPU | 512MB | - | $7 |
| Database | Atlas | M10 | 2 vCPU | 2GB | 10GB | $57 |

### 2. Measure Current Usage

For each service, capture current utilization:
- **CPU**: average and peak utilization percentage
- **Memory**: average and peak usage vs allocated
- **Storage**: current usage vs quota, growth rate per month
- **Network**: bandwidth usage, request volume per second
- **Connections**: database connections used vs pool size
- **Response time**: p50, p95, p99 latencies

Flag any metric above 70% utilization as approaching capacity.

### 3. Analyze Growth Trends

Using the last 3-6 months of data:
- Calculate month-over-month growth rate for each metric
- Identify seasonal patterns (if any)
- Project when each resource will hit capacity at current growth

```
Time to capacity = (Limit - Current) / Monthly Growth Rate
```

### 4. Identify Bottlenecks

Determine which resource will hit its limit first:
- **Database connections**: often the first bottleneck
- **Memory**: especially for Node.js services
- **Storage**: for databases with growing datasets
- **API rate limits**: for third-party service dependencies
- **Cold starts**: for serverless functions at scale

Rank bottlenecks by time-to-capacity (shortest first).

### 5. Model Scaling Scenarios

Create projections for three scenarios:

| Scenario | Growth Rate | 3-Month Projection | 6-Month Projection | 12-Month Projection |
|----------|-------------|--------------------|--------------------|---------------------|
| Conservative | Current rate | ... | ... | ... |
| Expected | 1.5x current | ... | ... | ... |
| Aggressive | 3x current | ... | ... | ... |

### 6. Estimate Costs

For each scenario and time horizon, calculate infrastructure costs:
- Current monthly cost
- Projected cost at each milestone
- Cost per user/request at current and projected scale
- Cost optimization opportunities (reserved instances, caching, CDN)

### 7. Recommend Scaling Actions

Produce a prioritized action plan:

| Priority | Action | Trigger | Estimated Cost | Lead Time |
|----------|--------|---------|---------------|-----------|
| P0 | Upgrade Atlas to M20 | DB connections >80% | +$100/mo | 1 hour |
| P1 | Add Redis caching layer | API p95 >500ms | +$15/mo | 1 week |
| P2 | Enable Vercel Edge Functions | Cold starts >2s | +$0 | 2 days |

Include both reactive (fix when it breaks) and proactive (fix before it breaks) recommendations.

## Output

- Infrastructure inventory table
- Current utilization metrics with capacity percentages
- Growth projections for 3/6/12 months
- Bottleneck analysis ranked by time-to-capacity
- Cost projections for three growth scenarios
- Prioritized scaling action plan with triggers and costs

## Review Checklist

- [ ] All services inventoried with current allocation
- [ ] Usage metrics captured for CPU, memory, storage, network
- [ ] Growth trends calculated from historical data
- [ ] Bottlenecks identified and ranked by urgency
- [ ] Three scaling scenarios modeled (conservative, expected, aggressive)
- [ ] Cost projections include optimization opportunities
- [ ] Action plan has clear triggers and lead times
