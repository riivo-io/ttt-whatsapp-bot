-- =============================================================================
-- TTTFG-5168: a client's claim walkthrough in progress, one per phone
-- =============================================================================
-- Tina asks the claim questions in a fixed order (src/departments/insurance/
-- walkthrough.ts). Between messages the state lives here, not on the 30-minute
-- session: a client may answer "where did it happen?" an hour later. The row
-- goes when the claim opens or the walkthrough hands over to a person. A row
-- older than 72 hours is treated as abandoned and replaced.
--
-- request_id: the riivo_request (Insurance, topic Claim) the walkthrough runs
-- under; follow-ups and WhatsApp communication rows hang off it.
-- last_sent: Tina's last message, so the next reply is read against the
-- question it answers.
-- =============================================================================

create table if not exists claim_walkthroughs (
    phone_number    text primary key,
    contact_id      text not null,
    request_id      text not null,
    state           jsonb not null,
    last_sent       text,
    started_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
