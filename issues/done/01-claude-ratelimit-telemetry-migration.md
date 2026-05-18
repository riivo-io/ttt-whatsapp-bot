# Issue 1: [DB] Add Claude rate-limit telemetry columns to `claude_usage`

See `docs/ISSUE-BREAKDOWN-scaling-idempotency-and-claude.md` §1 for full spec.

- Add nullable columns: `ratelimit_tokens_remaining`, `ratelimit_tokens_limit`, `ratelimit_requests_remaining`, `ratelimit_requests_limit`, `retry_after_ms`
- Add `was_429 boolean NOT NULL default false`
- Idempotent (`add column if not exists`)
- New migration file under `supabase/migrations/`
