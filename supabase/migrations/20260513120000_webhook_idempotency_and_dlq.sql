-- =============================================================================
-- Webhook idempotency + queue DLQ
-- =============================================================================
-- Two tables that back Phase 1 of the scaling work:
--
-- 1. whatsapp_webhook_events — persistent idempotency on Meta's `messages[].id`.
--    Replaces the in-memory Map in webhook.controller.ts that didn't survive
--    restarts and didn't span multiple ingester replicas. Insert-on-receive
--    with a unique constraint; ON CONFLICT DO NOTHING silently drops Meta's
--    duplicate retries (Meta is at-least-once with up to 7 days of retry).
--
-- 2. whatsapp_queue_dlq — dead-letter landing zone for jobs that failed all
--    BullMQ retry attempts. Lets us inspect poison payloads without leaving
--    them looping in the queue. Cron-cleanable; no FK to keep inserts cheap.
-- =============================================================================

create table if not exists whatsapp_webhook_events (
    -- Meta's `messages[].id` (e.g. "wamid.HBgL..."). Unique per inbound event.
    meta_message_id text primary key,
    phone_number text not null,
    received_at timestamptz not null default now()
);

-- received_at index supports the 7-day cleanup cron without scanning the PK.
create index if not exists whatsapp_webhook_events_received_at_idx
    on whatsapp_webhook_events (received_at);

create table if not exists whatsapp_queue_dlq (
    id uuid primary key default gen_random_uuid(),
    job_id text,                            -- BullMQ job id at time of failure
    queue_name text not null,
    meta_message_id text,                   -- echoed from the original payload
    phone_number text,
    payload jsonb not null,                 -- full job data for replay/inspection
    failed_reason text,                     -- last error message from the worker
    attempts_made int not null default 0,
    stack_trace text,
    failed_at timestamptz not null default now()
);

create index if not exists whatsapp_queue_dlq_failed_at_idx
    on whatsapp_queue_dlq (failed_at);
create index if not exists whatsapp_queue_dlq_phone_number_idx
    on whatsapp_queue_dlq (phone_number);
