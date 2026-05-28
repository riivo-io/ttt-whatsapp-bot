# PRD: Post-LoE Activation & Middle-Stage Q&A

**Author:** Luc Duval
**Date:** 2026-05-28
**Status:** Approved, ready for implementation
**Related:** [docs/onboarding-loe-and-otp.md](./onboarding-loe-and-otp.md), [docs/onboarding-flow.md](./onboarding-flow.md), [docs/PRD-first-contact-templates.md](./PRD-first-contact-templates.md), [docs/irp5-ocr-field-mapping.md](./irp5-ocr-field-mapping.md)

---

## 1. Problem Statement

New Tax leads experience a friction-filled middle of onboarding. Today the flow is:

1. Client messages the bot, completes the WhatsApp signup Flow. **(Works well, no change.)**
2. Bot sends the LoE magic link with a one-line "next step" message ([src/workers/whatsappProcessor.ts:368](../src/workers/whatsappProcessor.ts#L368)). The client has no idea why TTT requires an LoE or what they're signing.
3. Client signs the LoE on [ttt-financial-forms.vercel.app](https://ttt-financial-forms.vercel.app). The form auto-flips `riivo_loereceived = true` in Dynamics. **Nothing happens on the WhatsApp side.** The bot only finds out on the next inbound from the client, and even then can only tell the client to wait for an OTP call.
4. Taxcrew may not know the client is waiting until the client chases. There is no automatic notification at LoE-signed time.
5. While the client waits for the OTP call, the bot refuses every tax or TTT-process question (CRITICAL RULE at [src/services/claude.service.ts:807](../src/services/claude.service.ts#L807) hard-blocks tax content for all leads regardless of state). The client feels stonewalled immediately after signing a contract.

The cumulative effect: leads sign their LoE, get a flat "consultant will call" line on their next inbound, and sit in dead air with no way to ask questions or move things along. Drop-offs at this stage are higher than they should be.

---

## 2. Goals

1. Make the LoE step **explicit and reassuring** before signing — the client must understand they're signing a legally binding contract and why.
2. Push a **proactive thank-you and "what's next" message** the moment the LoE lands in Dynamics, so the client experiences immediate confirmation rather than dead air.
3. **Notify taxcrew immediately** when a lead reaches the OTP-call stage, so callbacks don't depend on the client chasing.
4. **Open up Q&A** in the post-LoE state so the client can ask TTT process and general tax questions while they wait.
5. Offer a **fast-track lever** (IRP5 upload) so engaged clients can accelerate their tax return rather than waiting on the call.

## 3. Non-Goals

- Non-Tax leads are out of scope. The Tax LoE is the only LoE handled here; non-Tax onboarding will be formalised separately.
- No changes to the WhatsApp signup Flow itself.
- No changes to the existing CRM-triggered OTP template (the Done/Help buttons taxcrew sends from Dynamics).
- No new Dynamics entity schema. We reuse `riivo_request`, `riivo_irp5s`, `riivo_taxsubmissionsdocuments`, and annotations.
- No Lead → Contact conversion change. Conversion still happens at OTP completion via the existing `icon_converttoclient = true` trigger.

---

## 4. Success Metrics

| Metric | Baseline | Target |
|---|---|---|
| Time from `riivo_loereceived = true` to client receiving thank-you WhatsApp | Indefinite (lazy on next inbound) | < 10 seconds (instant webhook) / < 1 hour (cron fallback) |
| Time from LoE-signed to taxcrew receiving notification email | Indefinite (only on client chase) | < 10 seconds |
| State B leads asking tax/TTT questions and receiving useful answers | 0% (CRITICAL RULE blocks) | ≥ 80% answered without escalation |
| State B leads sending an IRP5 within 24h of LoE-signed | 0% (upload_irp5 rejects leads) | Track only; rollout target TBD |
| Cases auto-resolved (not escalated) at LoE-signed | 0% | 100% |

---

## 5. Solution Overview

```
Client signs LoE on ttt-financial-forms.vercel.app
│
├─ LoE form writes signed PDF + flips riivo_loereceived = true in Dynamics
│
├─ LoE form POSTs to bot: POST /webhook/loe-signed { leadId }   ←── instant path
│
└─ (fallback) Hourly cron sweeps Dynamics for activated-but-unprocessed leads

Bot activation handler (shared by webhook + cron):
│
├─ Idempotency check: riivo_request "post_loe_activation" sentinel exists? → skip
├─ Lead-type guard: non-Tax? → skip + log
├─ Fetch lead (phone, name, type) from Dynamics
├─ Send WhatsApp thank-you to client (with IRP5 fast-track invite + Q&A invite)
├─ Send taxcrew notification email to taxcrew@ttt-tax.co.za
├─ Create riivo_request sentinel ("post_loe_activation")
└─ Resolve any open WhatsApp case as resolved_by_bot (skipFeedback: true)

State B bot behavior (post-LoE, pre-OTP):
│
├─ CRITICAL RULE no longer applies — Q&A is open
├─ Bot answers TTT process + general tax education questions freely
├─ Bot uses general principles only for personal tax advice
├─ Bot surfaces info@ttt-tax.co.za / +27 10 442 9222 when client needs human help
├─ State B leads gain access to upload_irp5 tool
└─ IRP5 uploads stage in Supabase (pending_irp5s) + Lead annotation in Dynamics

On Lead → Contact conversion (driven by OTP completion + existing Power Automate):
│
└─ Lazy deferred-write: on next inbound, if entity now resolves to Contact,
   drain pending_irp5s for that phone and apply rows to Contact-linked tables
```

---

## 6. Detailed Specifications

### 6.1 Webhook: `POST /webhook/loe-signed`

**Request**:
```http
POST /webhook/loe-signed
Content-Type: application/json
X-LoE-Signature: <HMAC-SHA256 of raw body using LOE_ACTIVATION_WEBHOOK_SECRET, hex-encoded>

{ "leadId": "<dynamics-lead-guid>" }
```

**Auth**: HMAC-SHA256 over raw request body, compared against `X-LoE-Signature` header using `LOE_ACTIVATION_WEBHOOK_SECRET`. Constant-time comparison.

**Responses**:
- `200 { "ok": true, "activated": true }` — activation fired this call
- `200 { "ok": true, "activated": false, "reason": "already_activated" | "non_tax_lead" }` — idempotent / out-of-scope skip
- `401 { "error": "bad_signature" }` — HMAC mismatch
- `404 { "error": "lead_not_found" }` — `leadId` doesn't exist in Dynamics
- `503 { "error": "dynamics_unavailable" }` — transient Dynamics failure; LoE app should retry

**File**: new `src/routes/loeSigned.route.ts`, registered in `src/server.ts`.

### 6.2 Safety-net cron: `GET /api/cron/loe-activation-sweep`

**Auth**: `Authorization: Bearer ${CRON_SECRET}` (matches existing cron pattern at [src/routes/cron.route.ts:19](../src/routes/cron.route.ts#L19)).

**Schedule** (in `vercel.json`):
```json
{ "path": "/api/cron/loe-activation-sweep", "schedule": "0 * * * *" }
```

**Logic**: Query Dynamics for Tax leads where `riivo_loereceived eq true` and no `riivo_request` with `riivo_classificationtopic eq 'post_loe_activation'` exists. For each, invoke the same activation handler as the webhook.

**File**: extend `src/routes/cron.route.ts`.

### 6.3 Activation handler (shared by webhook + cron)

**File**: new `src/services/loeActivation.service.ts` exporting `activateLeadPostLoe(leadId: string): Promise<ActivationResult>`.

**Algorithm**:

1. Fetch lead via `dynamicsService.getLeadById(leadId)`. Return `lead_not_found` if missing.
2. **Idempotency**: check for existing `riivo_request` with `_riivo_lead_value = leadId` and `riivo_classificationtopic = 'post_loe_activation'`. If found, return `already_activated`.
3. **Lead-type guard**: if `lead.riivo_leadtype !== 100000000` (Tax), log `[Activation] Skipping non-Tax lead ${leadId}` and return `non_tax_lead`.
4. **Phone guard**: if `lead.mobilephone` is empty/null, log error, skip the WhatsApp send, but continue with steps 5–7 (taxcrew still gets the email so they can recover the phone manually).
5. **Send WhatsApp thank-you** (copy in §7.2) via `metaService.sendText(phone, body)`.
6. **Send taxcrew email** (copy in §7.3) via `graphMailService.sendEmail({ to: ['taxcrew@ttt-tax.co.za'], subject, body, from: 'tina-bot@ttt-group.co.za' })`.
7. **Create sentinel**: `riivo_request` row with `riivo_classificationtopic = 'post_loe_activation'`, `_riivo_lead_value = leadId`, `statecode = 1` (resolved — sentinel only).
8. **Resolve open case**: call `caseService.resolveByLeadId(leadId, { skipFeedback: true, reason: 'post_loe_activation' })`. If no case is open, no-op.

Each step logs success/failure. If steps 5 or 6 fail, the sentinel (step 7) is NOT written so the next sweep retries.

### 6.4 LoE pre-signing message change

**File**: [src/workers/whatsappProcessor.ts:368](../src/workers/whatsappProcessor.ts#L368).

**Today's copy**:
```
Thanks, ${firstName}! You're signed up with TTT Financial Group. 🎉

Next step: sign your Letter of Engagement using your unique link (valid for 72 hours):

${loeLink}

Once that's signed, let us know below.
```

**Replacement** (verbatim):
```
Thanks ${firstName}, you're signed up with TTT Financial Group. 🎉

Next up is your Letter of Engagement (LoE). It's the legally binding contract between you and TTT that lets us act for you at SARS. It sets out the scope of work and the responsibilities on both sides. SARS won't let us file or correspond on your behalf without it, so this one is non-negotiable.

Sign yours here (link valid 72 hours):
${loeLink}

It takes about 2 minutes. As soon as it's signed I'll message you with the next step.
```

**Drop the two quick-reply buttons** from this send path. The legacy `loe:signed` / `loe:later` button handlers in [src/workers/whatsappProcessor.ts:557](../src/workers/whatsappProcessor.ts#L557) stay in place as no-ops for ~3 months to absorb taps from clients who still have the old buttons in their chat history.

### 6.5 State B and State D role-context blocks

**File**: [src/services/claude.service.ts:774–806](../src/services/claude.service.ts#L774-L806).

**Gate the CRITICAL RULE** at line 807 so it only injects when `state === 'A' || state === 'C'` (LoE outstanding).

**New State B role context** (verbatim):
```
**Onboarding state — LoE DONE, OTP OUTSTANDING.**

The post-LoE thank-you and the taxcrew notification email have already been sent automatically when the LoE landed in Dynamics. Don't restate "thanks for signing your LoE" or repeat the "taxcrew will call you" promise unless the client asks about it directly.

What you CAN do in this state:
- Answer TTT process questions (services, timelines, what happens after OTP, what's included in the engagement).
- Answer general tax education questions (e.g. "what's an IRP5", "what's a provisional taxpayer", "when is the filing deadline").
- For personal tax advice (e.g. "is X deductible for me", "do I owe SARS", "should I be on provisional"), answer with general principles only. Do not give person-specific advice based on the client's numbers or situation.
- If the client sends an IRP5, hand off to the upload_irp5 tool.
- If the client sends a non-IRP5 document, defer politely: "Hold onto this for now and send it once your consultant has set up your eFiling. The only doc we can fast-track right now is your IRP5."

If the client needs human help:
- If their question goes beyond what you can answer with general principles, or they're stuck, or they explicitly ask for a human, share these contact options:
  - Email: info@ttt-tax.co.za
  - Phone: +27 10 442 9222

What NOT to do:
- Don't restate the LoE thank-you or the taxcrew-will-call message unless asked.
- Don't give person-specific tax advice based on the client's numbers.
- Don't send SARS OTP instructions yourself; the consultant handles that on the call.
```

**New State D role context** (verbatim):
```
**Onboarding state — LoE DONE, OTP DONE, awaiting client conversion.**

The same Q&A scope applies as in the LoE-done state: TTT process questions, general tax education, and general-principles-only personal advice. The client is fully signed up from their side; a TTT consultant will reach out shortly to confirm.

Don't invite the IRP5 fast-track in this state — they've already passed the window where it speeds things up; the consultant will pick up any remaining docs.

If the client needs human help: share email info@ttt-tax.co.za or phone +27 10 442 9222.
```

### 6.6 Tool permissions

**File**: [src/services/claude.service.ts:905](../src/services/claude.service.ts#L905).

State A / C / D leads remain at `['save_document']`. State B leads get `['save_document', 'upload_irp5']`.

### 6.7 IRP5 fast-track for State B leads

**File**: [src/services/claude.service.ts:1519](../src/services/claude.service.ts#L1519) (`handleUploadIrp5`).

**Today**: rejects all non-client entities with `wrong_role` error.

**Change**: accept a Lead when `lead.riivo_loereceived === true && lead.riivo_leadtype === 100000000` (Tax). Route through a new `processLeadIrp5Upload()` path:

1. SharePoint upload (same `sharePointService.uploadDocumentFile` as today, but under a `leads/${leadId}/${year}/` folder prefix instead of `clients/${contactId}/`).
2. Mistral OCR (`mistralService.ocrDocument`) — unchanged.
3. Claude IRP5 extraction (`irp5ExtractorService.extractIrp5Fields`) — unchanged.
4. Stage row in Supabase `pending_irp5s` (schema in §6.9).
5. Write Dynamics annotation on the Lead — see §6.8.
6. Return success payload to Claude with extraction preview (employer, year, cert number) so the bot can confirm receipt to the client.

### 6.8 Lead annotation for IRP5 uploads

**File**: new method `dynamicsService.createIrp5AnnotationOnLead(leadId, payload)`.

**Annotation body** (verbatim template):
```
IRP5 received from client via WhatsApp.

Employer: ${employerName}
Tax year: ${assessmentYear}
Certificate number: ${certificateNumber}
Source codes detected: ${sourceCodes.join(', ')}

PDF: ${sharepointUrl}

This IRP5 is staged in Supabase (pending_irp5s) and will apply automatically to the client's Contact record once they convert.
```

**Annotation subject**: `IRP5 received via WhatsApp (${assessmentYear})`.

### 6.9 Supabase migration: `pending_irp5s`

**File**: new `supabase/migrations/20260528100000_pending_irp5s.sql`.

```sql
CREATE TABLE pending_irp5s (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    sharepoint_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    certificate_number TEXT,
    assessment_year INTEGER,
    employer_name TEXT,
    source_codes TEXT[] DEFAULT ARRAY[]::TEXT[],
    extracted_fields JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_to_contact_id TEXT,
    applied_at TIMESTAMPTZ,
    apply_error TEXT
);

CREATE INDEX pending_irp5s_phone_pending_idx
    ON pending_irp5s (phone_number)
    WHERE applied_to_contact_id IS NULL;

CREATE INDEX pending_irp5s_lead_idx ON pending_irp5s (lead_id);
```

### 6.10 Lazy deferred-write hook

**File**: [src/workers/whatsappProcessor.ts](../src/workers/whatsappProcessor.ts) — add a hook after identity resolution.

**Logic**: after `resolveSender(phoneNumber)` returns, if the resolved entity is a Contact, call `pendingIrp5Service.drainForPhone(phoneNumber, contactId)`. The drain:

1. Query `pending_irp5s` rows for the phone where `applied_to_contact_id IS NULL`.
2. For each row, in order: create `riivo_irp5s` and `riivo_taxsubmissionsdocuments` records against the Contact ID (reuse the existing `processIrp5Upload` paths). Mark `applied_to_contact_id` + `applied_at` on success, or write `apply_error` on failure.
3. Log each application.

The drain is non-blocking for the inbound — it fires asynchronously, doesn't gate the bot's response.

**Safety net**: the hourly LoE-activation-sweep cron should ALSO drain any `pending_irp5s` rows whose `lead_id` now resolves to a Contact in Dynamics. Single endpoint, two responsibilities — keeps cron count low.

### 6.11 Remove proactive OTP escalation

**File**: [src/workers/whatsappProcessor.ts:404](../src/workers/whatsappProcessor.ts#L404) (`triggerProactiveOtpEscalation`) and its call site around [src/workers/whatsappProcessor.ts:965](../src/workers/whatsappProcessor.ts#L965).

**Action**: delete the function and the calling block. The new State B role-context handles OTP-related chat naturally; the CRM-triggered OTP template flow (taxcrew → template → Done/Help buttons → `markLeadOtpCompleteAndReadyToConvert`) stays exactly as today.

### 6.12 Case resolution with `skipFeedback`

**File**: [src/services/case.service.ts:295](../src/services/case.service.ts#L295) (the resolve path).

**Change**: extend the case-resolution method to accept an optional `{ skipFeedback: boolean }` option. When `true`, skip enqueuing the feedback prompt. The LoE activation handler passes `skipFeedback: true`. Existing Q&A resolution paths default to `false` — feedback behavior unchanged for normal cases.

Also add `caseService.resolveByLeadId(leadId, opts)` — looks up any open case for the lead and resolves it. Returns silently if no case is open.

### 6.13 Env vars

| Variable | Required where | Description |
|---|---|---|
| `LOE_ACTIVATION_WEBHOOK_SECRET` | Bot (this repo) + LoE Next.js app | HMAC-SHA256 shared secret for the webhook. Generate with `openssl rand -hex 32`. Rotate together. |

---

## 7. Locked Copy

### 7.1 Pre-LoE message (sent after WhatsApp signup Flow submission)

```
Thanks ${firstName}, you're signed up with TTT Financial Group. 🎉

Next up is your Letter of Engagement (LoE). It's the legally binding contract between you and TTT that lets us act for you at SARS. It sets out the scope of work and the responsibilities on both sides. SARS won't let us file or correspond on your behalf without it, so this one is non-negotiable.

Sign yours here (link valid 72 hours):
${loeLink}

It takes about 2 minutes. As soon as it's signed I'll message you with the next step.
```

### 7.2 Post-LoE thank-you (sent by activation handler)

```
Got your LoE 🎉 Thanks ${firstName}, that's the heavy lifting done on your side.

Last setup step is the SARS eFiling OTP. A member of our taxcrew will call you to walk you through it. They've already been notified and will reach out during working hours (Mon to Fri, 8am to 4pm SAST).

While you wait, you can fast-track your tax return by sending your latest IRP5 right here. That's the tax certificate your employer issues each year. Just send the PDF.

Got questions about TTT or your tax? Ask away, I'm here.
```

### 7.3 Taxcrew notification email

**Subject**:
```
New lead ready for eFiling OTP call — ${leadName}
```

**Body** (plain text):
```
${leadName} (${phone}) has signed their Letter of Engagement and is waiting on the SARS eFiling OTP step.

Please give them a call during working hours to walk them through the OTP at https://secure.sarsefiling.co.za/app/profileTaxType/taxTypeActivation.

Lead in Dynamics: ${leadDynamicsUrl}

Tina has already told them to expect a call from the taxcrew, so you can dial in cold — they're warmed up and waiting.

— Tina
```

**Recipient**: `taxcrew@ttt-tax.co.za` (no CCs).
**From**: `tina-bot@ttt-group.co.za`.

---

## 8. Tasks & Deliverables

Each task lists the file(s) touched, the deliverable, and the acceptance check.

### Task 1 — Webhook endpoint + HMAC auth

**Files**: new `src/routes/loeSigned.route.ts`, `src/server.ts` (registration), `.env.example` (new var).

**Deliverable**:
- `POST /webhook/loe-signed` route handler.
- HMAC verification middleware using `LOE_ACTIVATION_WEBHOOK_SECRET`. Constant-time compare.
- Calls `loeActivationService.activateLeadPostLoe(leadId)`, maps result to response per §6.1.

**Acceptance**:
- `curl -X POST /webhook/loe-signed` with a valid HMAC → 200 with correct `activated` flag.
- Same call with a wrong HMAC → 401.
- Same call with a non-existent leadId → 404.

### Task 2 — Activation service (shared logic)

**Files**: new `src/services/loeActivation.service.ts`.

**Deliverable**: `activateLeadPostLoe(leadId)` implementing §6.3. Returns a `ActivationResult` union covering all the §6.1 response cases.

**Acceptance**:
- Unit tests for: already-activated short-circuit, non-Tax skip, phone-missing partial success, full success path. Mocks for Dynamics + Meta + Graph email.

### Task 3 — Safety-net cron sweep

**Files**: [src/routes/cron.route.ts](../src/routes/cron.route.ts), `vercel.json`.

**Deliverable**:
- New `GET /api/cron/loe-activation-sweep` route per §6.2.
- Cron schedule added to `vercel.json` (`0 * * * *`).
- Sweep also drains `pending_irp5s` for any leads now resolving to a Contact (per §6.10).

**Acceptance**:
- Manual `curl` with `Bearer ${CRON_SECRET}` → 200 with sweep summary.
- Without auth → 401.
- Sweep is idempotent — re-running consecutively does not double-activate.

### Task 4 — Pre-LoE message copy update

**Files**: [src/workers/whatsappProcessor.ts:368](../src/workers/whatsappProcessor.ts#L368).

**Deliverable**:
- Replace the message body with the §7.1 copy.
- Remove the two quick-reply buttons from this send call.
- Leave the `loe:signed` / `loe:later` button handlers ([src/workers/whatsappProcessor.ts:557](../src/workers/whatsappProcessor.ts#L557)) intact with a `// LEGACY:` comment noting the 3-month sunset.

**Acceptance**:
- End-to-end signup test: complete signup Flow → receive the new message → no buttons render → link is valid.

### Task 5 — State B and State D role-context blocks

**Files**: [src/services/claude.service.ts:774–807](../src/services/claude.service.ts#L774-L807).

**Deliverable**:
- Gate the CRITICAL RULE so it only injects when state is `A` or `C`.
- Inject the §6.5 State B block when state is `B`.
- Inject the §6.5 State D block when state is `D`.

**Acceptance**:
- Manual chat tests in each state confirm the bot answers/declines per scope.
- A State B test asking "what's an IRP5?" → bot answers educationally.
- A State B test asking "is my freelance income taxable?" → bot answers with general principles, no person-specific advice.
- A State B test asking "can someone call me?" → bot surfaces info@/phone.

### Task 6 — Tool permissions for State B

**Files**: [src/services/claude.service.ts:905](../src/services/claude.service.ts#L905).

**Deliverable**: State B leads receive `['save_document', 'upload_irp5']`. All other lead states stay at `['save_document']`.

**Acceptance**: Unit test of the tool-selection branch for each state.

### Task 7 — Supabase migration `pending_irp5s`

**Files**: new `supabase/migrations/20260528100000_pending_irp5s.sql`.

**Deliverable**: §6.9 SQL applied locally and pushed to prod via the standard migration flow.

**Acceptance**:
- Local `supabase db reset` succeeds with the new table.
- `SELECT * FROM pending_irp5s` returns empty set on a fresh DB.

### Task 8 — IRP5 upload path for State B leads

**Files**: [src/services/claude.service.ts:1502–1649](../src/services/claude.service.ts#L1502-L1649) (`handleUploadIrp5`), new `src/services/pendingIrp5.service.ts`.

**Deliverable**:
- New `pendingIrp5Service` with `stageForLead`, `drainForPhone`, `markApplied`, `markFailed`.
- `handleUploadIrp5` accepts State B leads, routes through staging path. Existing client path unchanged.
- Staging path uploads to SharePoint under `leads/${leadId}/${year}/`, runs OCR + extraction, writes Supabase row, writes Dynamics Lead annotation (§6.8).

**Acceptance**:
- State B lead uploads an IRP5 PDF → file appears in SharePoint at `leads/...`, row in `pending_irp5s`, annotation visible on the Lead in Dynamics.
- Client gets a confirmation message naming the employer + year.

### Task 9 — Lazy deferred-write hook

**Files**: [src/workers/whatsappProcessor.ts](../src/workers/whatsappProcessor.ts) (post-identity-resolution hook), `pendingIrp5Service.drainForPhone`.

**Deliverable**:
- After `resolveSender` returns a Contact, fire-and-forget `pendingIrp5Service.drainForPhone(phone, contactId)`.
- The drain applies each pending row to Contact-side tables, marks `applied_to_contact_id` + `applied_at`, or `apply_error` on failure.

**Acceptance**:
- Manually stage a `pending_irp5s` row, then convert the lead to a Contact in Dynamics, then send any WhatsApp message from that phone → row gets applied within seconds and is visible in `riivo_irp5s` against the Contact.

### Task 10 — Taxcrew notification email

**Files**: `src/services/loeActivation.service.ts` (uses existing `graphMailService.sendEmail`).

**Deliverable**: Email send with §7.3 subject + body via the existing tina-bot mailbox.

**Acceptance**: Test activation against a staging lead → email arrives at `taxcrew@ttt-tax.co.za` (or test inbox in staging) with the correct subject, body, and Dynamics link.

### Task 11 — Case auto-resolution with feedback bypass

**Files**: [src/services/case.service.ts:295](../src/services/case.service.ts#L295) and feedback-prompt queue enqueue site.

**Deliverable**:
- New `resolveByLeadId(leadId, { skipFeedback })` method.
- Existing resolve path accepts `skipFeedback` (default `false`).
- When `skipFeedback: true`, feedback-prompt queue is NOT enqueued.

**Acceptance**:
- Open a case, call `resolveByLeadId` with `skipFeedback: true` → case status becomes `resolved_by_bot`, no feedback prompt scheduled.

### Task 12 — Remove proactive OTP escalation

**Files**: [src/workers/whatsappProcessor.ts](../src/workers/whatsappProcessor.ts) — `triggerProactiveOtpEscalation` definition and call site.

**Deliverable**: Delete the function and the conditional that invokes it. Remove any imports/constants used only by that path. Keep the OTP template button handlers (`handleOtpTemplateResponse`).

**Acceptance**:
- State B lead asking "any update on the OTP call?" gets a natural-language response per the new State B context, no email fires, case is not escalated.
- Client tapping a Done/Help button from a CRM-sent template still works end-to-end.

### Task 13 — LoE Next.js app: outbound webhook call

**Repo**: `ttt-financial-forms` (separate repo, owner = Luc).

**Deliverable**:
- After the form writes the signed PDF and flips `riivo_loereceived = true`, POST to the bot's `/webhook/loe-signed` with `{ leadId }` and `X-LoE-Signature` HMAC header.
- New env var `LOE_ACTIVATION_WEBHOOK_SECRET` on the Next.js app (must match the bot's value).
- Failure handling: log + don't block the user's success page if the bot is unreachable (the safety-net cron will pick it up).

**Acceptance**:
- End-to-end test: sign a real LoE in staging → within 10s, taxcrew gets email + client gets WhatsApp.

### Task 14 — Edge-case rulings

These are implementation details inside the activation service (§6.3) — no separate files, but call out explicitly in code review:

- Non-Tax lead → skip silently with log line `[Activation] Skipping non-Tax lead ${leadId}`.
- Phone missing → log error, skip WhatsApp send, still email taxcrew (taxcrew body still includes lead name + Dynamics link; consultant recovers phone manually).
- Feedback prompt suppression — `skipFeedback: true` on resolve.

**Acceptance**: Unit tests covering each branch in the activation service.

---

## 9. Rollout Plan

1. **Bot side first**:
   - Land Tasks 1–12 in this repo behind no flag (the new endpoint exists but receives no traffic until task 13 lands).
   - Deploy.
   - Verify the safety-net cron picks up any leads that signed during the window where the LoE app wasn't calling the webhook yet.
2. **LoE Next.js app second**:
   - Land Task 13.
   - Set `LOE_ACTIVATION_WEBHOOK_SECRET` in the Next.js app's env (same value as in the bot).
   - Deploy.
3. **Smoke test with a controlled lead** (Luc on a fresh test number):
   - Complete signup → receive new LoE pre-signing message.
   - Sign LoE on staging → receive thank-you within 10s; taxcrew test inbox gets email.
   - Ask "what's an IRP5?" → bot answers.
   - Send an IRP5 PDF → confirmation with employer + year; row in `pending_irp5s`; annotation on Lead.
   - Convert the lead manually in Dynamics → send another message → `pending_irp5s` row drains to Contact tables.
4. **Monitor for 1 week**:
   - Activation success rate (target: 100% within 5 minutes of LoE-signed).
   - Number of feedback-prompts not sent due to `skipFeedback` flag (sanity check for unintended downstream effects).
   - State B Q&A volume — measure how many clients actually engage in the open Q&A window.

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Webhook signature mismatch from env-rotation drift | Rotate `LOE_ACTIVATION_WEBHOOK_SECRET` in both repos in the same deploy window; safety-net cron catches any missed activations |
| Bot answers a tax question incorrectly in State B | Scope is bucketed: TTT process + general education are safe; personal advice is general principles only with info@/phone fallback. Monitor first 50 State B Q&A exchanges manually. |
| `pending_irp5s` rows orphan if a lead never converts | Acceptable — staged data sits in Supabase, no client-visible failure. Cron safety net + manual sweep available if a stale-row alarm ever matters. |
| Lead-to-Contact conversion drops the phone link | The drain queries by phone, not by leadId, so it tolerates conversion without an explicit handoff. |
| Removing proactive OTP escalation leaves clients without a Done/Help affordance | The CRM-sent OTP template still surfaces those buttons exactly as today; the proactive path was a secondary surface. |

## 11. Open Questions

None at time of approval. Author to update if any surface during implementation.
