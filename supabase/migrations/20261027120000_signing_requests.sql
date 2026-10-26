-- =============================================================================
-- TTTFG-5196: TTT's signing page (src/signing/)
-- =============================================================================
-- One row per signing link. Generic: a document, the channel and the number or
-- address the link went to, where to stamp, and who to tell (callback_url).
-- Nothing here knows about claims; caller + caller_record_id say whose it is
-- (for example "claim" and the riivo_claim id).
--   token_hash     SHA-256 of the link's token (the token is never stored)
--   document_hash  SHA-256 of the unsigned PDF, checked again at signing
--   status         open, used (signed once), expired (7 days), superseded (a
--                  newer request for the same caller record)
--   audit          what was recorded with the signature: time, IP, browser,
--                  channel, sent to, both hashes
--   callback_*     the signed PDF's delivery to the caller; the signing-sweep
--                  cron retries 'pending' and 'failed' rows once
--                  callback_next_at is due (a delivery running holds it as
--                  a lease, so one callback never runs twice at once)
-- The PDFs are in the private storage bucket "signing": <id>/unsigned.pdf and
-- <id>/signed-<first 16 of its SHA-256>.pdf. Service role only (RLS on, no
-- policies). Safe to run again.
-- =============================================================================

create table if not exists signing_requests (
    id                  uuid primary key,
    token_hash          text not null unique,
    document_path       text not null,
    document_hash       text not null,
    file_name           text not null,
    title               text not null,
    channel             text not null check (channel in ('whatsapp', 'email')),
    sent_to             text not null,
    caller              text not null,
    caller_record_id    text not null,
    callback_url        text not null,
    stamps              jsonb not null,
    status              text not null default 'open' check (status in ('open', 'used', 'expired', 'superseded')),
    expires_at          timestamptz not null,
    created_at          timestamptz not null default now(),
    opened_at           timestamptz,
    signed_at           timestamptz,
    signed_path         text,
    audit               jsonb,
    callback_status     text check (callback_status in ('pending', 'done', 'failed')),
    callback_attempts   integer not null default 0,
    callback_error      text,
    callback_next_at    timestamptz
);
-- In case an earlier draft of this migration (without the lease) was run.
alter table signing_requests add column if not exists callback_next_at timestamptz;

create index if not exists signing_requests_open_by_caller
    on signing_requests (caller, caller_record_id) where status = 'open';
create index if not exists signing_requests_callbacks
    on signing_requests (callback_next_at) where callback_status in ('pending', 'failed');

alter table signing_requests enable row level security;

insert into storage.buckets (id, name, public)
values ('signing', 'signing', false)
on conflict (id) do nothing;
