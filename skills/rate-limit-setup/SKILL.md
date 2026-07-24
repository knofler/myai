---
name: rate-limit-setup
description: "Set up rate limiting — choose a strategy, implement middleware for auth and API endpoints, configure per-endpoint limits, and test. Triggers: rate limit, rate limiting, throttle, request limit, abuse prevention"
---

# Rate Limit Setup

Configure rate limiting to protect endpoints from abuse and overload.

## Tech Stack

express-rate-limit | @fastify/rate-limit | Redis store for distributed

## Playbook

### 1. Identify endpoints needing rate limits

- **Auth** (login, register, forgot-password): strict limits.
- **Public API**: moderate limits per IP or API key.
- **Authenticated API**: higher limits per user.

### 2. Choose strategy

| Strategy | Best for |
|----------|----------|
| Fixed window | Simple, low-overhead |
| Sliding window | Auth endpoints (prevents burst attacks) |
| Token bucket | General APIs (allows short bursts) |

### 3. Implement with express-rate-limit

```typescript
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many attempts, try again later' },
  standardHeaders: true, legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
});
```

### 4. Configure per-endpoint limits

| Endpoint | Window | Max |
|----------|--------|-----|
| POST /auth/login | 15 min | 5 |
| POST /auth/register | 1 hour | 3 |
| GET /api/* | 1 min | 100 |
| POST /api/* | 1 min | 30 |

### 5. Apply middleware

```typescript
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api', apiLimiter);
```

### 6. Use Redis for distributed deployments

```typescript
import RedisStore from 'rate-limit-redis';
const limiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) }),
  windowMs: 60 * 1000, max: 100,
});
```

### 7. Test the limits

- Send requests exceeding the limit; verify 429 and `Retry-After` header.
- Confirm legitimate traffic is not affected.
