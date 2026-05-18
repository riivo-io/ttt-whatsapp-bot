-- =============================================================================
-- Email-to-WhatsApp relay pending-consent table
-- =============================================================================
-- TTT staff forward client emails to tina-bot@ttt-group.co.za. Microsoft Graph
-- pushes a notification, the bot looks the sender up in Dynamics, and asks the
-- client over WhatsApp (via a pre-approved Meta template with Yes/No buttons)
-- whether they want the relay. The Yes/No tap can arrive minutes or hours
-- later, possibly across cold-starts on Vercel — so we persist the pending
-- state here rather than in process memory.
--
-- The graph_message_id unique constraint gives us idempotency: Microsoft Graph
-- occasionally redelivers notifications for the same message, and the unique
-- key makes the second insert a no-op.
--
-- Only one row per phone may sit in 'awaiting_consent' at a time (partial
-- unique index below). If a new forward arrives while a prior one is still
-- pending, the orchestrator marks the old row 'superseded' before inserting.
-- =============================================================================

create table if not exists email_relay_pending (
    id uuid primary key default gen_random_uuid(),
    graph_message_id text not null unique,
    client_phone text not null,
    client_crm_id text,
    client_crm_type text check (client_crm_type in ('client', 'lead', 'user')),
    forwarder_email text not null,
    forwarder_name text,
    original_sender_email text not null,
    subject text,
    relay_body text not null,
    status text not null default 'awaiting_consent'
        check (status in ('awaiting_consent', 'accepted', 'declined', 'expired', 'no_match', 'superseded')),
    template_sent_at timestamptz,
    responded_at timestamptz,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index if not exists email_relay_pending_phone_status_idx on email_relay_pending (client_phone, status);
create index if not exists email_relay_pending_status_expires_idx on email_relay_pending (status, expires_at);
create index if not exists email_relay_pending_forwarder_idx on email_relay_pending (forwarder_email);

-- Enforce at-most-one pending relay per client phone at a time. New forwards
-- supersede prior pending rows; the orchestrator flips them to 'superseded'
-- before insert, but this index is the safety net.
create unique index if not exists email_relay_pending_one_active_per_phone_idx
    on email_relay_pending (client_phone)
    where status = 'awaiting_consent';
