-- =============================================================================
-- Email-relay forwarder round-trip
-- =============================================================================
-- Extends email_relay_pending to support the case where a forwarded email
-- can't be resolved to a client we can WhatsApp — because the original sender
-- isn't in the CRM, has no mobile on file, or the forward parsed back to the
-- forwarder themselves (the bug that prompted this work).
--
-- Instead of dead-ending, Tina now emails the consultant asking for the
-- client's email or mobile, and parks an 'awaiting_forwarder' row. When the
-- consultant replies on the same email thread, we match their reply to that
-- row by conversation_id, resolve the identifier they gave to a CRM contact or
-- lead, and send the relay template.
-- =============================================================================

-- Microsoft Graph conversationId for the email thread. Lets a forwarder's
-- reply be matched back to the parked request. Nullable: pre-existing rows and
-- any message Graph returns without one stay null.
alter table email_relay_pending
    add column if not exists conversation_id text;

-- New lifecycle state: parked while we wait for the consultant to reply with
-- the client's contact details.
alter table email_relay_pending
    drop constraint if exists email_relay_pending_status_check;

alter table email_relay_pending
    add constraint email_relay_pending_status_check
    check (status in (
        'awaiting_consent',
        'awaiting_forwarder',
        'accepted',
        'declined',
        'expired',
        'no_match',
        'superseded'
    ));

-- Look up the open parked request for an inbound reply: by thread, scoped to
-- the still-waiting state.
create index if not exists email_relay_pending_conversation_idx
    on email_relay_pending (conversation_id, status);
