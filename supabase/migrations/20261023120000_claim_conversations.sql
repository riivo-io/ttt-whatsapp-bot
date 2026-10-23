-- =============================================================================
-- TTTFG-4830 (claims demo): a claims conversation on a demo number, one per phone
-- =============================================================================
-- Numbers listed in CLAIMS_DEMO_NUMBERS talk only to the claims flow
-- (src/domain/claimsDemoHost.ts). Between messages Tina keeps where the
-- conversation is, never what the claim holds (the claim record is the source
-- of truth, TTTFG-5262):
--   walkthrough  the 5168 walkthrough in progress (null when none);
--   resume       resume.ts's ResumeState: the follow-on's place and any
--                unanswered "which claim?" / "is this a new claim?";
--   held         files the client sent before their claim existed, kept for
--                the follow-on's start;
--   request_id   the riivo_request the latest claim conversation runs under;
--   last_sent    Tina's last message, so the next reply is read against it.
-- "#reset" from the phone deletes the row.
-- =============================================================================

create table if not exists claim_conversations (
    phone_number    text primary key,
    contact_id      text not null,
    request_id      text not null default '',
    walkthrough     jsonb,
    resume          jsonb not null default '{"followOn": null, "pending": null}'::jsonb,
    held            jsonb not null default '[]'::jsonb,
    last_sent       text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table claim_conversations enable row level security;
