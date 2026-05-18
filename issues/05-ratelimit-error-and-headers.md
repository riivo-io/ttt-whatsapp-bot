# Issue 5: Define `RateLimitError` and parse Anthropic rate-limit headers

Breakdown §5. Export `RateLimitError` from `src/services/claude.service.ts`. Wrap all 3 SDK call sites. Read rate-limit response headers, make available for persistence.
