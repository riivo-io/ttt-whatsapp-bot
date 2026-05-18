-- =============================================================================
-- Claude API rate-limit telemetry columns
-- =============================================================================
-- Additive, nullable columns on claude_usage so we can persist Anthropic
-- rate-limit response headers (anthropic-ratelimit-tokens-remaining etc.) and
-- track 429 occurrences for the success metric in the scaling PRD §2.2.
--
-- No backfill. Existing rows read NULL for the new nullable columns and
-- was_429 = false (NOT NULL with default). Idempotent — safe to run twice.
-- =============================================================================

alter table claude_usage
    add column if not exists ratelimit_tokens_remaining   bigint,
    add column if not exists ratelimit_tokens_limit       bigint,
    add column if not exists ratelimit_requests_remaining bigint,
    add column if not exists ratelimit_requests_limit     bigint,
    add column if not exists retry_after_ms               integer,
    add column if not exists was_429                      boolean not null default false;
