-- =============================================================================
-- TTTFG-5340: one reply, and one Tax lead, per unknown WhatsApp number
-- =============================================================================
-- A number that is on no contact and no lead gets one fixed reply with the tax
-- sign-up link, and Tina makes one lead for the Tax team (SPEC-05 "Unknown
-- numbers", decided 12 October 2026). A second message from the same number
-- within 24 hours gets no second reply, and no second lead is ever made.
--
-- replied_at: when Tina last sent the reply. A message inside the 24 hours
--             after it is not answered. The row is claimed before the reply is
--             sent, so two messages handled at once give one reply.
-- lead_id:    the new_leads row Tina made for this number. Kept for good: it
--             is how Tina knows a lead on this number is the placeholder she
--             made (no email yet), not a person who signed up, and why she
--             never makes a second one.
-- action_id:  the riivo_agentaction (Kind Created, owned by the Tax team) that
--             tells the team about the lead.
--
-- The service role reads and writes it; nobody else needs to. Safe to run again.
-- =============================================================================

create table if not exists unknown_number_replies (
    phone_number  text primary key,
    replied_at    timestamptz not null default now(),
    lead_id       text,
    action_id     text,
    created_at    timestamptz not null default now()
);

alter table unknown_number_replies enable row level security;
