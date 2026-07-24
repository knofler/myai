---
name: auth-flow-review
description: "Review and implement authentication flow — audit JWT setup, cookie security, password hashing, token refresh, and protected route middleware. Triggers: auth, authentication, login flow, JWT, auth review, sign in, token"
---

# Auth Flow Review

Review and secure the authentication flow end-to-end.

## Tech Stack

JWT (jsonwebtoken/jose) | bcrypt (12+ rounds) | httpOnly cookies

## Playbook

### 1. Audit current auth implementation

- Map the full flow: register, login, refresh, logout.
- Check if auth logic is centralized or scattered across routes.

### 2. Verify JWT configuration

- Access token: 15 min expiry. Refresh token: 7 days.
- Payload: `sub` (user ID), `iat`, `exp` only. No sensitive data.
- Use 256-bit+ secrets from environment variables.

```typescript
jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '15m' });
```

### 3. Check httpOnly cookie usage

- Send tokens as httpOnly cookies (never localStorage).
- Set `Secure: true`, `SameSite: 'Strict'` in production.

```typescript
res.cookie('accessToken', token, {
  httpOnly: true, secure: true, sameSite: 'strict', maxAge: 15 * 60 * 1000,
});
```

### 4. Verify password hashing

- bcrypt with cost factor >= 12. Never plaintext or reversible encryption.

### 5. Review token refresh flow

- POST `/api/auth/refresh` validates and rotates refresh token.
- Store refresh tokens in DB for revocation capability.
- On logout, delete all refresh tokens for the user.

### 6. Check protected route middleware

- Extract token from cookie/header, verify signature + expiry.
- Attach user to `req.user`. Return 401/403 appropriately.

```typescript
function authenticate(req, res, next) {
  const token = req.cookies.accessToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}
```

### 7. Document findings

- Log issues with severity. Create remediation tasks.
- Update `state/STATE.md` with auth audit status.
