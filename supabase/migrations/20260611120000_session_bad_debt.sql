-- =============================================================================
-- Bad-debt session markers (PRD-bad-debt-collection.md §6.2, §7.1, §11.3)
-- =============================================================================
-- When a registered client with an overdue invoice (open >= 30 days) messages
-- Tina, she reminds them of the debt, sends the invoice PDF(s), and holds new
-- tax-return work until it's paid. Detection is deterministic and runs once per
-- session on the first client inbound; the result is cached on the session for
-- the rest of that session (re-evaluated fresh next session).
--
-- bad_debt_evaluated        — true once first-inbound detection has run this
--                             session (so we don't re-query Dynamics every turn).
-- bad_debt                  — detection result: client is in bad debt this
--                             session. Also makes the session "noteworthy" for
--                             the consultant close-summary (§9).
-- bad_debt_detail           — cached summary used by the prompt guidance and the
--                             close-summary BAD DEBT line: total outstanding,
--                             open-invoice count, oldest age, per-invoice rows.
-- bad_debt_invoices_sent_at — claimed atomically by the first bad-debt inbound
--                             so the invoice PDFs (and the payment ask) are sent
--                             exactly once per session, not on every inbound.
-- =============================================================================

alter table sessions
    add column if not exists bad_debt_evaluated boolean not null default false,
    add column if not exists bad_debt boolean not null default false,
    add column if not exists bad_debt_detail jsonb,
    add column if not exists bad_debt_invoices_sent_at timestamptz;
