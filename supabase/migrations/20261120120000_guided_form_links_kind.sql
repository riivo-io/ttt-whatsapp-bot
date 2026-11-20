-- =============================================================================
-- The user (20 Nov 2026): the claim's broker gets a link to the client's form
-- =============================================================================
-- When the client's form link goes out, the claim's broker gets a link of their own
-- to the same form, so they can fill it in for a client who is stuck. It is saved
-- on the claim in Dataverse (riivo_brokerformlink), shown on the claim in My Day and
-- emailed to the broker by the email agent.
--   kind   'client' (every link until now) or 'broker'
-- A client's link and a broker's link never stop each other: a new link stops only
-- the earlier open link of its own kind. A broker's link never signs, submits,
-- accepts the terms or stops the reminders.
-- Run this before CLAIMS_BROKER_FORM=on. Safe to run again.
-- =============================================================================

alter table guided_form_links add column if not exists kind text not null default 'client';

do $$ begin
    alter table guided_form_links add constraint guided_form_links_kind_check check (kind in ('client', 'broker'));
exception when duplicate_object then null; end $$;

create index if not exists guided_form_links_open_by_claim_kind
    on guided_form_links (claim_id, kind) where status = 'open';
