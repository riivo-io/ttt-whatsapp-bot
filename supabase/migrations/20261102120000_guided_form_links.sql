-- =============================================================================
-- TTTFG-5562: the guided claim form's links (src/claimform/)
-- =============================================================================
-- One row per link Tina sent. The client's answers are on the claim (riivo_answers),
-- not here; this only says which claim a link is for and whether it still works.
--   token_hash       SHA-256 of the link's token (the token is never stored)
--   claim_id         the riivo_claim the form belongs to
--   phone            the WhatsApp number the link went to; Tina carries on there
--   contact_id       that number's contact
--   phone_number_id  the number the client wrote to, so Tina's replies come from it
--   status           open, done (the client submitted the form), expired (7 days),
--                    superseded (a newer link for the same claim)
-- Service role only (RLS on, no policies). Safe to run again.
-- =============================================================================

create table if not exists guided_form_links (
    id               uuid primary key,
    token_hash       text not null unique,
    claim_id         text not null,
    phone            text not null,
    contact_id       text not null,
    phone_number_id  text,
    status           text not null default 'open' check (status in ('open', 'done', 'expired', 'superseded')),
    expires_at       timestamptz not null,
    created_at       timestamptz not null default now(),
    opened_at        timestamptz,
    finished_at      timestamptz
);

create index if not exists guided_form_links_open_by_claim
    on guided_form_links (claim_id) where status = 'open';

alter table guided_form_links enable row level security;
