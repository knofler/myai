---
name: data-api-integration
description: "Design external API integration spec with auth, rate limiting, retry, and caching. Triggers: API integration, external API, third-party API, API mapping, integration spec"
---
# Data API Integration Playbook

## When to Use
- Integrating with a third-party or external API
- Designing a data sync between your system and an external service
- Building a wrapper/adapter around an external API
- Documenting an existing integration for maintainability

## Prerequisites
- External API documentation available
- API credentials or sandbox access provisioned
- Understanding of data mapping between external and internal schemas
- Rate limit and quota information from the provider

## Playbook

### 1. API Discovery and Mapping
- Document the external API: base URL, version, available endpoints
- Map external endpoints to internal use cases
- Identify required fields vs optional fields in requests/responses
- Create a field mapping table: external field -> internal field + transformation

### 2. Authentication Setup
- Identify auth method: API key, OAuth2, JWT, basic auth
- Store credentials securely (environment variables, secrets manager)
- Implement token refresh logic for OAuth2 flows
- Test auth in sandbox environment before production

### 3. Rate Limiting Strategy
- Document provider rate limits (requests/minute, daily quota)
- Implement client-side rate limiter (token bucket or sliding window)
- Add request queuing for burst scenarios
- Track usage against quota with alerts at 80% threshold

### 4. Retry and Error Handling
- Classify errors: retryable (429, 500, 503) vs permanent (400, 401, 404)
- Implement exponential backoff with jitter for retryable errors
- Set max retry count (default: 3) and total timeout
- Log all failures with request context for debugging
- Implement circuit breaker for sustained failures

### 5. Data Transformation Layer
- Build request transformers (internal format -> API format)
- Build response transformers (API format -> internal format)
- Handle pagination (cursor, offset, or link-based)
- Validate transformed data against internal schema

### 6. Caching Strategy
- Identify cacheable responses (reference data, slow-changing data)
- Set TTL per endpoint based on data freshness requirements
- Implement cache invalidation on relevant writes
- Use ETag or Last-Modified headers where supported

### 7. Monitoring and Observability
- Log request/response times, status codes, payload sizes
- Track error rates by endpoint and error type
- Alert on latency spikes or elevated error rates
- Dashboard showing integration health and throughput

## Output
- API integration specification document
- Field mapping table (external to internal)
- Integration adapter/service code
- Rate limiter and retry configuration
- Monitoring dashboard configuration

## Review Checklist
- [ ] All required endpoints mapped and documented
- [ ] Auth credentials stored securely, not hardcoded
- [ ] Rate limits respected with client-side throttling
- [ ] Retry logic handles transient errors gracefully
- [ ] Circuit breaker prevents cascade failures
- [ ] Caching reduces unnecessary API calls
- [ ] Monitoring covers latency, errors, and quota usage
