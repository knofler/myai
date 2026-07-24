---
name: dev-caching-setup
description: "Set up a caching layer with strategy selection, middleware, TTLs, and invalidation. Triggers: 'caching', 'cache setup', 'add caching', 'Redis cache', 'cache layer', 'cache middleware'."
---

# Caching Setup Playbook

## When to Use
- API responses are slow due to repeated expensive queries
- Same data is fetched multiple times within short time windows
- Database load needs to be reduced for read-heavy endpoints
- Static or semi-static content needs faster delivery

## Prerequisites
- API endpoints identified that would benefit from caching
- Infrastructure choice: in-memory (node-cache), Redis, or CDN
- Understanding of data freshness requirements per resource

## Playbook

### 1. Choose Caching Strategy
- **In-memory** (node-cache/lru-cache): single instance, simple, no infra. Best for: small datasets, single-server deployments
- **Redis**: shared across instances, persistent, pub/sub for invalidation. Best for: multi-server, session storage, large datasets
- **CDN** (Vercel Edge, CloudFront): edge caching for static/semi-static responses. Best for: public content, API responses that rarely change
- Choose based on: deployment topology, data size, freshness requirements

### 2. Set Up Cache Infrastructure
- **In-memory**: Install `node-cache` or `lru-cache`. Create `src/lib/cache.ts` singleton
- **Redis**: Add Redis service to `docker-compose.yml`. Install `ioredis`. Create `src/lib/redis.ts` connection with retry logic and error handling
- **CDN**: Configure `Cache-Control` and `s-maxage` headers per route
- All: create `src/config/cache.ts` with TTL constants per resource type

### 3. Define TTLs Per Resource
- Map each cacheable resource to a TTL:
  - User profiles: 5 minutes (changes occasionally)
  - Configuration/settings: 30 minutes (rarely changes)
  - Public listings: 2 minutes (moderate change frequency)
  - Search results: 1 minute (frequent changes)
  - Static reference data: 24 hours (countries, categories)
- Store TTLs in config, not hardcoded in route handlers

### 4. Implement Cache Middleware
- Create `src/middleware/cache.ts` with:
  - `cacheResponse(ttlKey)` — middleware that checks cache before hitting handler
  - Cache key generation: `{method}:{path}:{queryHash}:{userId?}`
  - Cache hit: return cached response with `X-Cache: HIT` header
  - Cache miss: call next(), intercept response, store in cache, add `X-Cache: MISS` header
- Support cache bypass via `Cache-Control: no-cache` request header

### 5. Implement Cache Invalidation
- **Time-based**: TTL expiry handles most cases
- **Event-based**: invalidate on write operations (POST/PUT/PATCH/DELETE)
  - After a resource is modified, delete related cache keys
  - Use key pattern matching: delete all keys matching `GET:/api/v1/users:*`
- **Manual**: admin endpoint `DELETE /api/v1/cache/{pattern}` for emergency flush
- Log all invalidation events for debugging

### 6. Add Monitoring
- Track cache hit/miss ratio per endpoint
- Log cache operations at `debug` level
- Alert if hit ratio drops below 50% (indicates TTLs may be too short)
- Monitor Redis memory usage and eviction count if using Redis

## Output
- `src/lib/cache.ts` or `src/lib/redis.ts` — cache client
- `src/config/cache.ts` — TTL configuration per resource
- `src/middleware/cache.ts` — cache middleware
- Cache invalidation logic in write-path handlers
- Updated `docker-compose.yml` with Redis service (if applicable)

## Review Checklist
- [ ] Cache strategy matches deployment topology
- [ ] TTLs defined per resource based on change frequency
- [ ] Cache key includes all relevant dimensions (path, query, user)
- [ ] Invalidation triggers on all write operations for cached resources
- [ ] X-Cache header added for debugging
- [ ] Cache bypass supported via request header
- [ ] Monitoring tracks hit/miss ratio
