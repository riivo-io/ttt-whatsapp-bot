-- =============================================================================
-- Session-level signals for the consultant close-summary
-- =============================================================================
-- When a case closes, Tina emails the client's owning consultant a short
-- summary of the conversation — but only for "noteworthy" sessions: ones where
-- the client uploaded documents or an escalation fired. These three columns let
-- the close path make that decision (and stay idempotent) without re-deriving
-- the signals from Dynamics.
--
-- had_doc_upload        — set true the moment a client document is filed in the
--                         session (WhatsApp upload, IRP5 ingest, doc tool).
-- had_escalation        — set true the moment an escalation fires in the session
--                         (classified escalation, rejected feedback, callback /
--                         taxcrew tool).
-- close_summary_sent_at — claimed atomically by the first close in the session
--                         so a fan-out close (one "Yes" closing several cases)
--                         or the timeout sweep can't double-send.
-- =============================================================================

alter table sessions
    add column if not exists had_doc_upload boolean not null default false,
    add column if not exists had_escalation boolean not null default false,
    add column if not exists close_summary_sent_at timestamptz;
