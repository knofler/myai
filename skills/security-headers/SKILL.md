---
name: security-headers
description: "Configure security headers — set up helmet.js, configure CSP, HSTS, CORS, X-Frame-Options, X-Content-Type-Options, and verify with a scanner. Triggers: security headers, helmet, CORS, CSP, HSTS, content security policy"
---

# Security Headers

Configure HTTP security headers to protect against common web attacks.

## Tech Stack

helmet.js (Express) | @fastify/helmet | next.config.js headers

## Playbook

### 1. Install and configure helmet.js

```typescript
import helmet from 'helmet';
app.use(helmet());
```

Helmet enables secure defaults for 11+ headers. Customize below.

### 2. Configure Content Security Policy (CSP)

```typescript
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", process.env.API_URL],
    frameSrc: ["'none'"],
    objectSrc: ["'none'"],
  },
}));
```

- Start strict, loosen only as needed. Avoid `'unsafe-eval'`.

### 3. Configure HSTS

```typescript
app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));
```

### 4. X-Frame-Options and X-Content-Type-Options

- Helmet sets `SAMEORIGIN` and `nosniff` by default.
- Use `DENY` if the app should never be framed.

### 5. Configure CORS whitelist

```typescript
import cors from 'cors';
const allowedOrigins = ['https://myapp.com', 'https://staging.myapp.com'];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));
```

- Never use `origin: '*'` with `credentials: true`.

### 6. Verify with a security scanner

- Test with securityheaders.com or Mozilla Observatory. Target: A+.

### 7. Document the policy

- Record all headers, values, and CSP exceptions with justification.
