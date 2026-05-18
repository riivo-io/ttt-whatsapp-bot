# Onboarding Flow — Lead to Client, Inside WhatsApp

_Working doc. Drafted 2026-04-28. Goal: a person who has never spoken to TTT can sign up, satisfy the per-service requirements, and become a client without leaving WhatsApp._

Status legend: ✅ live · 🟡 partial · ❌ not implemented yet · ❓ open question for TTT

---

## 1. Where we are today

### 1.1 What happens when an unknown number messages the bot

Traced from [webhook.controller.ts:567-609](../src/controllers/webhook.controller.ts#L567-L609) → `resolveSender` at [webhook.controller.ts:92-132](../src/controllers/webhook.controller.ts#L92-L132).

| Step | Status | Notes |
|---|---|---|
| Inbound message hits the Meta webhook | ✅ | |
| Phone is checked against Supabase staff, then the session cache, then Dynamics (contacts → leads → systemusers in parallel) | ✅ | [dynamics.service.ts:322](../src/services/dynamics.service.ts#L322) |
| If no match, the bot sends either a **WhatsApp signup flow** (when `WHATSAPP_SIGNUP_FLOW_ID` is set) or a static **"please sign up"** text with a link to `https://www.ttt-tax.co.za/client-onboarding` | ✅ | [webhook.controller.ts:307-327](../src/controllers/webhook.controller.ts#L307-L327) |
| Lead row is **not** auto-created on first inbound — the user must complete the signup flow / external page first | ❌ | Flagged in [leads-and-contacts.md](leads-and-contacts.md) row 26 |
| Signup flow submission → `dynamicsService.createLead` with first/last name, email, phone, `service_needed` | ✅ | [webhook.controller.ts:221-270](../src/controllers/webhook.controller.ts#L221-L270) |
| Next inbound message from that phone now resolves to a `lead` session and routes to the lead path | ✅ | |

### 1.2 What the lead can do in WhatsApp today

- Upload a signed LoE PDF → Mistral OCR → Claude extraction → fields PATCHed onto the lead, signed PDF attached as annotation. ✅ [loe-extractor.service.ts](../src/services/loe-extractor.service.ts), [dynamics.service.ts:884](../src/services/dynamics.service.ts#L884), [dynamics.service.ts:981](../src/services/dynamics.service.ts#L981)
- Generic chat with the assistant (BASE_SYSTEM_PROMPT). The system prompt does **not currently branch by service**. 🟡 [claude.service.ts:47](../src/services/claude.service.ts#L47)

### 1.3 What's missing end-to-end

- ❌ **In-WhatsApp signup** — onboarding still hops out to a web form.
- ❌ **Service-specific onboarding paths** — the bot captures `service_needed` on the signup form but the post-signup conversation is identical regardless of Tax vs Accounting vs Insurance vs Financial Planning.
- ❌ **LoE generation/delivery** — only signed LoEs flowing *in* are handled; no flow generates a personalised LoE and sends it *out* for the lead to sign.
- ❌ **OTP / SARS eFiling shared-access capture** for tax clients.
- ❌ **Lead → Contact conversion** (TTTFG-3191) — once the checklist is complete, nothing flips the lead into a client contact.
- ❌ **Per-service required-document checklist** surfaced to the lead (we have [requiredDocuments.service.ts](../src/services/requiredDocuments.service.ts) but it's not wired into the lead flow).

---

## 2. Target flow — shared spine

Regardless of service, every new person should hit the same opening steps in WhatsApp:

1. **Greet** the unknown number warmly. Brand: TTT Financial Group.
2. **Capture intent** with a single interactive list: _Tax_, _Accounting_, _Insurance_, _Financial Planning_, _I'm not sure_.
   - Today this lives only on the external signup page. Move it into chat.
3. **Capture identity** in WhatsApp (first name, last name, email, ID number, consent).
   - WhatsApp Flows can collect this in one screen — see [whatsapp-flow-signup.md](whatsapp-flow-signup.md).
4. **Create the lead in Dynamics** with `lead_type` set from step 2. ✅ method exists; just needs to be triggered from chat instead of the web form.
5. **Branch into the service-specific track** (sections 3 and 4 below).
6. **On track completion → convert lead to contact** and welcome them as a client.

❓ **Open**: Should "I'm not sure" route to a human staff handoff, or should the bot ask a few qualifying questions and recommend a service?

---

## 3. Tax — onboarding track

**End state**: Lead has signed an LoE and TTT has shared-access to their SARS eFiling profile. Lead is converted to a contact.

### Steps

| # | Step | Status | Notes |
|---|---|---|---|
| T1 | Lead picks "Tax" in the intent menu | ❌ | new |
| T2 | Bot collects identity + ID number + tax number (if known) | 🟡 | identity capture exists via signup flow; tax/ID number not collected here yet |
| T3 | Bot explains the two prerequisites (LoE + eFiling shared access) up-front so expectations are set | ❌ | new |
| T4 | **LoE delivery** — bot generates a personalised LoE PDF (pre-filled with name, ID, contact info, fee schedule) and sends it to the lead in WhatsApp | ❌ | currently only inbound signed LoEs are handled |
| T5 | Lead signs the LoE and uploads the signed PDF in WhatsApp | ✅ | inbound LoE flow exists |
| T6 | Bot extracts banking + signature + acknowledgement from the PDF, attaches to the lead | ✅ | [loe-extractor.service.ts](../src/services/loe-extractor.service.ts) |
| T7 | **eFiling shared access** — bot walks the lead through requesting tax-practitioner access on SARS eFiling, capturing the OTP that SARS sends to the client and forwarding it to TTT (or guiding the client to enter it on eFiling themselves) | ❌ | no code exists |
| T8 | TTT staff confirms shared access is live (manual? automated?) | ❓ | depends on how SARS access is verified |
| T9 | Bot converts the lead into a contact, links them to the Tax department/owner, sends a welcome | ❌ | TTTFG-3191 |

### Open questions for the Tax track

- ❓ **OTP mechanics**: When TTT requests practitioner access on eFiling, SARS sends an OTP to the taxpayer. Today, how does the OTP reach TTT? (Client reads it back over the phone? Email? Something else?) The bot version should probably have the lead message the OTP into WhatsApp — but is that compliant with how SARS expects this to work?
- ❓ **LoE personalisation**: Is the LoE a single template with merge fields (name, ID, fee), or are there variants per tax service (individual returns vs provisional vs business tax)? If variants, what determines which template?
- ❓ **Fee/quote step**: Does the lead see a quote and accept it before the LoE is sent, or is the fee already inside the LoE they sign?
- ❓ **FICA/KYC docs**: ID copy, proof of address, etc. — required for tax engagements in SA? If yes, where in this flow do they get collected?
- ❓ **Existing eFiling access**: Some leads will already have eFiling logins; others won't. Does the bot need to handle "I don't have eFiling yet — please register me" as a separate sub-track?
- ❓ **Trigger for conversion**: Is "lead → contact" triggered the moment shared access is confirmed, or does a staff member sign off first?

---

## 4. Accounting — onboarding track

**End state**: Lead has signed an LoE for accounting services. Lead is converted to a contact.

### Steps

| # | Step | Status | Notes |
|---|---|---|---|
| A1 | Lead picks "Accounting" in the intent menu | ❌ | new |
| A2 | Bot collects identity + business details (entity name, registration number, VAT number if applicable) | ❌ | new — the signup flow today is identity only |
| A3 | Bot explains the prerequisite (LoE) and what TTT will need afterwards (bookkeeping access, bank statements, etc.) | ❌ | new |
| A4 | **LoE delivery** — bot generates a personalised LoE PDF for accounting and sends it in WhatsApp | ❌ | same gap as Tax T4 |
| A5 | Lead signs and uploads the LoE | ✅ | same path as Tax T5 |
| A6 | Bot extracts and attaches the signed LoE | ✅ | |
| A7 | Bot converts the lead into a contact, links them to the Accounting department/owner, sends a welcome | ❌ | TTTFG-3191 |

### Open questions for the Accounting track

- ❓ **Who is the "lead"** — the individual signing, or a business entity? Dynamics has `entityType` on contacts ([dynamics.service.ts:670](../src/services/dynamics.service.ts#L670)). Do we create a contact, an account, or both?
- ❓ **Required onboarding info beyond LoE** — bookkeeping platform (Xero, Sage, QuickBooks?), accounting period, prior accountant handover? Does any of this need to be captured *during* onboarding, or after the lead becomes a client?
- ❓ **LoE template** — one accounting template, or variants (sole-prop bookkeeping vs company annual financials vs payroll)?
- ❓ **Quote/scope step** — same question as Tax. Does the LoE include the fee, or is there a quote acceptance step before the LoE?
- ❓ **Trigger for conversion** — same question as Tax. LoE upload alone, or a staff sign-off?

---

## 5. Other services (out of scope for this doc but flagged)

The signup flow already lists **Insurance** and **Financial Planning** ([claude.service.ts:302](../src/services/claude.service.ts#L302)) and the lead-creation tool also exposes **Long Term Insurance** and **Short Term Insurance** ([claude.service.ts:284](../src/services/claude.service.ts#L284)).

❓ Are these in scope for the WhatsApp-native onboarding work, or do they stay on the web form for now? If in scope, what are their per-service prerequisites (no LoE? FNA? FAIS disclosures?)?

---

## 6. Cross-cutting open questions

- ❓ **Definition of "client"** in Dynamics terms — is it simply a contact with `crm_type = 'client'` and a signed LoE on file, or does conversion also write to an Account, set an industry, assign a primary rep, or kick off billing setup?
- ❓ **Bot voice during onboarding** — same TTT assistant persona ([bot-personality.md](bot-personality.md)) or a distinct "onboarding concierge" tone?
- ❓ **Drop-off / nurture** — if a lead signs up but never uploads the LoE, what's the cadence? (Daily nudge for 3 days? Staff escalation after 7? Nothing?)
- ❓ **Magic-link pattern** — per the saved preference to give clients shareable artifacts they forward themselves, does the LoE delivery use a signed URL the client can open in a browser, sign, and re-send? Or does signing happen entirely in WhatsApp (e.g., type-to-sign confirmation)?
- ❓ **Staff handoff** — at what points does the bot hand the conversation to a human? (Before LoE? After LoE? Only on user request?)
- ❓ **Multiple services** — can a lead sign up for both Tax and Accounting at once, or is that two leads / two LoEs?

---

## 7. Next steps

1. Answer the open questions above (especially section 6 cross-cutting items).
2. Lock the per-service step list — which steps stay in WhatsApp, which fall back to web/staff.
3. Spec the LoE generation service (template store + merge-field source).
4. Spec the OTP capture flow for Tax.
5. Implement `convertLeadToContact` (TTTFG-3191) with the agreed conversion trigger.
