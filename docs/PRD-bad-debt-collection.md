# PRD: Bad-Debt Reminders & New-Work Hold

**Status:** Approved spec, ready for implementation
**Owner:** Luc
**Date:** 2026-06-11
**Surface:** Tina (WhatsApp bot), Dynamics, Supabase, invoice-gen API

---

## 1. Summary

When a client with an overdue invoice messages Tina, she warmly reminds them of the
outstanding amount, sends them their actual invoice PDF(s), asks for payment, and tells
them that no new tax-return work can be processed until the debt is settled. She still
helps with their existing account (status checks, invoices, callbacks) and still accepts
documents, but makes clear nothing on a new return gets processed while the invoice is
unpaid. The owning consultant is flagged in the session close-summary email.

The feature is fully reactive. Tina never initiates an outbound message. Everything below
fires only when the client messages first.

## 2. Goals

- Get overdue invoices in front of clients and nudge payment, nicely.
- Stop TTT committing new-return effort to clients who are in arrears.
- Keep the relationship warm so debtors stay engaged enough to pay.
- Give the consultant visibility that their client is a bad-debt case.

## 3. Non-goals

- No proactive / business-initiated WhatsApp messages (no templates, no scheduled sweep).
- No hard lockout. Account self-service and existing-work status stay available.
- No tool removal. Documents are still accepted; only *processing* of new work is held.
- No change to how invoices are created in Dynamics.

## 4. Definitions

| Term | Definition |
|------|------------|
| Open invoice | Invoice with `ttt_outstanding > 0`. |
| Bad debt | The client has at least one open invoice unpaid for **≥ 30 calendar days** from `createdon` (≥ 30 inclusive). |
| Overdue invoice | An open invoice that is itself ≥ 30 days old. |
| Bad-debt session | A WhatsApp session where the resolved client is in bad-debt state. |
| New-return work | Starting / progressing / processing the client's current-year tax return, including collecting and processing documents toward it. |

## 5. Scope

- **Applies to:** registered clients / contacts (`crm_type` = `client` / `contact`).
- **Excluded:** leads (no invoices) and staff (exempt; staff querying a debtor's record see no block).

## 6. Trigger & detection

### 6.1 Reactive only
The treatment is evaluated only when a client sends an inbound message. There is no
outbound initiation.

### 6.2 Deterministic detection on first inbound of a session
On the **first client inbound of a session**, the worker performs a single Dynamics read of
the client's open invoices (`ttt_outstanding > 0`) plus each invoice's `createdon`.

- If any open invoice is ≥ 30 calendar days old → the client is in **bad debt**.
- The result is stamped on the Supabase session (new `bad_debt` marker) and cached for the
  rest of that session. It is re-evaluated fresh at the start of the next session.
- Calendar days, not working days. A client exactly at day 30 counts as bad debt.

### 6.3 Under 30 days
If the client has an open invoice that is younger than 30 days (within terms), Tina behaves
100% normally: no payment nag, no invoice push, no block, no consultant flag.

## 7. Behaviour when bad debt is active

### 7.1 First bad-debt inbound of the session (fires once per session)

Deterministically, around the model reply:

1. **Send invoice PDF(s)** via the external invoice-gen API
   (`https://ttt-invoice-gen.azurewebsites.net/api/invoice-generator`), delivered as
   WhatsApp document messages through the existing `metaWhatsAppService.sendDocument` path.
   - Send the **overdue** (≥ 30-day) invoices.
   - **Cap at ~5 PDFs.** If there are more, summarise the remainder as a text list with the
     total still owed.
   - Guarded once-per-session by a `claimCloseSummary`-style claim so messages don't re-send
     the PDFs on every inbound.
2. **Inject bad-debt state guidance** into the system prompt for every reply that session so
   the payment-ask and block stance hold across the whole conversation. The model owns the
   wording; the send is a deterministic side-effect, not left to model discretion.

Tina's first reply leads with the debt, warmly:
- States the **total outstanding**.
- Asks nicely for payment.
- Includes, in **bold**: **"Please use your invoice number as a reference when paying"**, and
  surfaces each invoice's number from `ttt_invoiceid`.
- Explains new-return work is paused: e.g. "Unfortunately your profile has an unpaid invoice
  and we can't move forward with your new return until it's been paid."
- If the client also asked an allowed question (refund / audit / submission status), Tina
  answers that in the same combined reply.

### 7.2 Partial payments
The invoice-gen PDF shows the full invoice total (its payload has no "amount paid" / "balance
due" field). Tina's **WhatsApp text** states the real position per invoice, e.g. "You've paid
R400 of R747.50, *R347.50 still outstanding* on INV29267011." The PDF goes out as-is.

### 7.3 Subsequent messages in the same session
- No re-sending of PDFs, no re-leading with the debt (avoids nagging).
- Allowed queries answered normally.
- The block is only re-surfaced when the client pushes on new-return work
  ("can you do my 2026 return?" -> "once the outstanding invoice is settled we'll get
  straight onto it").

## 8. The block (conversational, not enforced by tool removal)

- **All tools stay enabled.** Documents are still accepted and saved.
- Tina communicates that nothing on a new return will be **processed** until the bad debt is
  paid. Decline is warm, not cold.
- **Still available regardless of debt:** account/admin tools (`get_my_details`,
  `get_outstanding_balance`, `get_invoice_pdf`, `get_my_consultant`,
  `request_consultant_callback`, `get_tax_number`, `get_my_referral_code`, `opt_out_whatsapp`,
  `escalate_to_taxcrew`) and existing-work status (`get_refund_status`, `get_submission_status`,
  `get_audit_status`, `get_received_documents`).
- **Held (messaging only):** the new-return pipeline (`get_required_documents`, `list_tax_forms`,
  `send_tax_form`, `save_document`, `upload_irp5`) still runs, but Tina tells the client the
  output won't be processed until payment.

## 9. Consultant notification (reuse close-summary plumbing)

- A bad-debt session is marked **noteworthy** (alongside the existing doc-upload / escalation
  triggers) so `sendConsultantCloseSummary` always sends for it.
- Deduped once per session via the existing `claimCloseSummary`.
- The email body gains a prepended **⚠️ BAD DEBT** line: outstanding total, number of open
  invoices, and the oldest invoice's age in days.
- The record link points at the conversation's **`riivo_request`** record
  (`buildDynamicsRecordUrl('riivo_request', requestId)`), falling back to the contact record
  when no request id is available for the session.
- Routes to the owning consultant, falling back to `taxcrew@ttt-tax.co.za` as today.

## 10. Fallback & robustness

- **Invoice-gen API failure / missing line items:** Tina does not go silent on the debt. She
  sends the payment ask in text including the banking details already on the invoice record
  (`icon_accountholdername`, `icon_bank`, `icon_accountnumber`, `icon_accounttype`,
  `icon_branchnumber`) plus the outstanding amount and invoice number. The block stance still
  applies. The API failure is logged for ops.
- **Volume:** ~5-PDF cap (see 7.1), remainder summarised in text.
- **Mid-session payment:** status is cached for the session; the next session re-evaluates.

## 11. Data dependencies

### 11.1 Dynamics fields to read
- `ttt_outstanding` (open-invoice signal)
- `ttt_invoiceid` (invoice number used as payment reference)
- `createdon` (30-day age)
- `riivo_totalinclvat`, `ttt_paymentreceived` (partial-payment text)
- Banking fallback: `icon_accountholdername`, `icon_bank`, `icon_accountnumber`,
  `icon_accounttype`, `icon_branchnumber`
- These must be added to the invoice query (`getClientInvoices` currently selects only
  `new_invoicesid`, `new_name`, `riivo_totalinclvat`, `statecode`, `statuscode`).

### 11.2 Build-time discovery (no product decision outstanding)
- Locate the invoice **line-item entity** logical name and the **`terms`** (30/60/90)
  source required by the invoice-gen API payload.
- Confirm `ttt_invoiceid` holds the clean "INV…" number, not a GUID.
- Store the invoice-gen API URL + code as env config.

### 11.3 Supabase
- Add a `bad_debt` marker to the session schema for the per-session cache + once-per-session
  send claim.

## 12. Affected code (reference)

- `src/services/dynamics.service.ts` — extend invoice query; helper for open/overdue invoices
  + ages; `buildDynamicsRecordUrl('riivo_request', …)` already exists.
- `src/workers/whatsappProcessor.ts` — first-inbound detection, session stamp, deterministic
  PDF send, mark session noteworthy.
- `src/services/claude.service.ts` — inject bad-debt state guidance into the client system
  prompt (mirrors the lead onboarding state guidance pattern).
- `src/services/case.service.ts` — `sendConsultantCloseSummary` gains the ⚠️ BAD DEBT line +
  `riivo_request` link; bad-debt counts as noteworthy.
- New invoice-gen API client (calls the Azure function, returns the PDF buffer).
- `src/services/supabase.service.ts` — `bad_debt` session field + claim helper.

## 13. Acceptance criteria

1. A client with an open invoice **29 days** old gets normal service, no debt messaging,
   no consultant flag.
2. A client with an open invoice **30+ days** old, on their first inbound of a session,
   receives their invoice PDF(s) and a warm reply stating the total outstanding, the bold
   payment-reference line with `ttt_invoiceid`, and the new-work hold.
3. PDFs are sent **once** per session, not on every inbound. The cap is ~5 PDFs with the
   remainder summarised in text.
4. A partially-paid invoice shows the full total on the PDF but the correct remainder in
   Tina's text.
5. The bad-debt client can still check refund / audit / submission status and download
   invoices; uploads are still accepted but Tina says they won't be processed until payment.
6. Pushing on the new return is met with a warm decline referencing the unpaid invoice.
7. On session close, the consultant receives a summary email with the ⚠️ BAD DEBT line and a
   working link to the `riivo_request` (or contact fallback).
8. When the invoice-gen API fails, the client still receives a text payment ask with banking
   details, and the failure is logged.
9. Leads and staff never trigger any of this.
