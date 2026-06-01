-- =============================================================================
-- Post-LoE activation in-flight mutex
-- =============================================================================
-- Backs the race-free claim in idempotencyService.claimLoeActivation().
--
-- activateLeadPostLoe() does check-then-act across multiple side effects
-- (WhatsApp send, taxcrew email, Dynamics sentinel write). Two concurrent
-- invocations — e.g. the LoE Next.js app retrying its POST to /webhook/
-- loe-signed, or the hourly sweep racing the webhook — both pass the
-- Dynamics sentinel check (Dynamics is eventually consistent and has no
-- atomic check-and-create) and both fire the side effects, double-sending
-- the "Got your LoE" WhatsApp.
--
-- A Postgres unique-constraint insert is the atomic primitive that fixes
-- this. The activation function claims the row, runs the flow, and clears
-- the row in a finally block. The Dynamics sentinel remains the long-term
-- record of completion; this table is just the short-lived mutex during
-- execution.
-- =============================================================================

create table if not exists loe_activation_inflight (
    lead_id text primary key,
    claimed_at timestamptz not null default now()
);

-- claimed_at index supports any future stale-claim sweep (rows left behind
-- by a process crash between claim and release).
create index if not exists loe_activation_inflight_claimed_at_idx
    on loe_activation_inflight (claimed_at);
