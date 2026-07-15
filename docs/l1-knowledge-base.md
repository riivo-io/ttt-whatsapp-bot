# L1 Knowledge Base — what Tina resolves and where she hands off

The seven Level-1 categories measured for the Q2 auto-resolution metric. For each: what the task is, how Tina closes it without a human, the explicit handoff trigger, and where the source-of-truth content lives.

Tina handles each category directly — no proactive consultant callbacks. Handoffs fire only when the client explicitly asks for a human, or when the case crosses a defined risk threshold listed below.

> **Q2 target:** 50% of L1 cases auto-resolved (client confirms or no follow-up within feedback window). Denominator = case count across all seven categories. June 2026 is the only month where "Update Client Details on CRM" counts toward the metric.

---

## How to read each entry

- **Definition** — what the client is actually asking, with typical phrasings.
- **Client self-service path** — the content/tool/answer Tina uses to close the loop herself.
- **Handoff trigger** — the specific signal where Tina stops and waits for the client to ask for a consultant, or routes to escalation if the rule is automatic.
- **Source of truth** — where the underlying content lives (prompt block, tool, this doc, or another doc).

---

## 1. Tax season dates

**Definition.** Generic timing questions — when does tax season open, when does it close, when is the provisional deadline, can I still submit my [year] return.

**Client self-service.** The 2026 SARS filing dates are confirmed. Tina states them plainly — she does NOT hedge with "usually", "typically", or "SARS will confirm the exact dates soon". The answer depends on taxpayer category:

| Window | Audience | 2026 dates |
|---|---|---|
| Basic / non-provisional returns | Salaried, simple affairs | 1 July → 12 July 2026 |
| Complex returns | Non-provisional, complex affairs | 13 July → 23 October 2026 |
| Provisional filing | Provisional taxpayers | 13 July 2026 → 22 January 2027 |
| 1st provisional return (IRP6/01) | Provisional | by 31 August 2026 |
| 2nd provisional return (IRP6/02) | Provisional | by 28 February 2027 |
| Trust filing | Trusts | follows the provisional deadline; confirm exact date if asked |

**Handoff trigger.** Client asks about *their own* status against the deadline → Tina pivots to case status (§2). Client mentions an extension request, dispute, or already-missed deadline with a penalty notice → consultant.

**Source of truth.** The dedicated "When does tax season start" doc in the SharePoint KB is authoritative for the dates above — mirror it here, don't contradict it. Refresh annually after SARS publishes the new season dates.

---

## 2. Case status

**Definition.** "Where is my tax return?", "Have you submitted me?", "What's my refund?", "Am I on audit?", "How long does the audit take?", "Have you received my docs?"

**Client self-service.** Tina uses `get_client_cases` and the FAQ wiring in [tax-season-faq-crm-spec.md](./tax-season-faq-crm-spec.md):

| Client question | Tina reads | Reply pattern |
|---|---|---|
| What's my refund? | `riivo_potentialrefund` on active case for current year | "Your potential refund for {year} is R{x} — case is at {stage}." |
| Have you submitted me? | `icon_casestage` | Map stage → plain-English sentence. |
| Am I on audit? | `icon_casestage = "On Audit"` + `riivo_dateplacedonaudit` | "Yes, on audit since {date} — that's {n} working days in. Standard window is 21 working days, up to 60 in special cases." |
| Have you received my docs? | `riivo_preseasondocumentation.statuscode` (1 = awaiting, 100000001 = ready) + child `riivo_taxsubmissionsdocuments` rows | List outstanding doc types from per-type triplets. |
| What docs do I still need? | → falls under §4 (document guidance) | Call `get_required_documents`. |

Never output the Dynamics case GUID to the client (existing prompt rule).

**Handoff trigger (automatic, not client-initiated).**
- Audit > 60 working days → "your consultant will follow up" (already wired in the audit-duration logic).
- `riivo_potentialrefund` null/zero on an active refund question → Tina says "we're not sure yet" AND sends the nudge email to the case owner via the tina-bot mailbox (already wired).
- Client wants to dispute a SARS assessment, lodge an objection, or query a penalty → consultant.

**Source of truth.** [tax-season-faq-crm-spec.md](./tax-season-faq-crm-spec.md) for field mappings; `get_client_cases` tool in `claude.service.ts`.

---

## 3. Home office requirements

**Definition.** "Can I claim home office?", "What do I need to claim?", "What can I deduct?", "I work from home — does that count?"

**Client self-service.** Tina explains the SARS criteria, lists the docs needed, and flags the CGT consideration. Does *not* compute a rand amount.

**Eligibility (must satisfy all that apply):**
- Used **regularly AND exclusively** for work (no shared dining-table setup).
- Employer requires WFH **in writing**, OR > 50% of working time is at home over the tax year.
- For salaried employees, the office must be specifically equipped for the trade (s23(b)).
- Commission earners (income mostly from commission) have broader deductibility under s11(a).

**Apportionment.** Allowable expenses × (home office floor area ÷ total home floor area).

**Allowable expenses.** Rent OR bond interest (not capital), rates and taxes, electricity and water, repairs to the office, cleaning, insurance (proportional), security.

**Not allowable.** Bond capital, building improvements, general household items, internet costs unless dedicated to the office.

**Documents needed.**
- Lease agreement OR bond statements showing interest portion
- Utility bills (electricity, water, rates)
- Photos of dedicated workspace
- Employer letter (for required-WFH or > 50% claim)
- Floor plan with measurements (office area + total home area)

**CGT warning.** Claiming home office means a portion of the home is used for trade, which **may reduce the R2m primary-residence CGT exclusion when the home is sold**. Tina mentions this as a consideration — does not compute the impact.

**Handoff trigger.** Client asks for a specific rand calculation on their own numbers; asks about CGT impact on sale; is a commission earner with multiple income streams; asks about a SARS query/audit on a previously-claimed home office deduction.

**Source of truth.** This doc. Cross-check against SARS Interpretation Note 28 (home office expenses) annually.

---

## 4. Document guidance

**Definition.** "What docs do you need from me?", "Can I send my IRP5?", "How do I upload?", "Did you get my docs?"

**Client self-service.**
- Tina calls `get_required_documents` for a per-client tailored list (computed from SARS source codes + industry). Relays the tool output verbatim. Never lists docs from her own head, never mentions SARS source codes to the client (existing prompt rule).
- Client uploads via WhatsApp directly. Tina accepts the file and calls `save_document` once she has the doc type. Supported types: IRP5, IT3(a), IT3(b), payslips, medical certificates, till slips/receipts, logbooks, ID documents, bank statements, tax certificates.
- "Did you get my docs?" → `get_client_cases` reads `riivo_taxsubmissionsdocuments` rows under the preseason record. Tina lists received types and what's still outstanding.

**Handoff trigger.** Client asks for a doc Tina doesn't recognise (e.g. retrieve their Notice of Registration from SARS eFiling — that needs consultant access to the firm's eFiling profile). Client asks Tina to forward a doc to a third party.

**Source of truth.** `get_required_documents` tool (`requiredDocuments.service.ts`); `save_document` tool; preseason wiring in [tax-season-faq-crm-spec.md](./tax-season-faq-crm-spec.md).

---

## 5. Basic tax structuring

**Scope rule.** Concepts + generic worked examples only. Never use the client's actual income/deductions. Any "should I" or amount-specific question → handoff.

**Definition.** "What's a TFSA?", "How does an RA work for tax?", "How do medical credits work?", "Are donations tax-deductible?"

**Client self-service — four instruments Tina explains:**

**Tax-Free Savings Account (TFSA).**
- Annual contribution limit: R36,000.
- Lifetime cap: R500,000.
- Growth, dividends, and withdrawals all tax-free.
- Over-contribution penalty: 40% of the excess.
- Generic example: "If you contribute the full R36k/year for 10 years and average 8% growth, you have ~R520k that's entirely tax-free to withdraw."

**Retirement Annuity (RA).**
- Contributions deductible up to 27.5% of the higher of remuneration or taxable income.
- Annual cap: R350,000 deductible.
- Excess contributions roll forward to future years.
- Generic example: "If your taxable income is R600k, you can contribute up to R165k (27.5%) and reduce that year's taxable income to R435k."

**Medical aid tax credits.**
- Monthly tax credit per member and per dependent (TTT to confirm current-year rand values when SARS updates).
- Additional medical tax credit (AMTC) for out-of-pocket medical expenses above a threshold tied to taxable income.
- Tina explains the structure; she does not compute the client's exact credit.

**Section 18A donations.**
- Deductible up to 10% of taxable income.
- Donee must be a SARS-registered PBO with s18A approval.
- s18A certificate required as proof.

**Handoff trigger.** Any question that uses the client's actual numbers ("if I earn R800k, how much should I put in my RA?"), any "should I" question, any structuring beyond these four instruments (trusts, share schemes, offshore structures, retirement withdrawals, estate planning).

**Source of truth.** This doc. TTT updates the medical credit rand values when SARS publishes the new tax year's amounts (typically February budget speech / Taxation Laws Amendment Act).

---

## 6. Referral enquiries

**Definition.** "How does the referral programme work?", "How much do I earn?", "When do I get paid?", "What's my referral code/link?"

**Client self-service.** Facts already live in the system prompt at [claude.service.ts:274-288](../src/services/claude.service.ts#L274). Summary:

- Only the **referrer** earns. The friend gets nothing.
- Tiered cash reward (paid to referrer's bank account on file, not as invoice credit):
  - Below R1,725 incl VAT first invoice → no reward.
  - R1,725 to R4,999.99 incl VAT → R500.
  - R5,000+ incl VAT → R1,000.
- Trigger: referee pays their first TTT tax invoice **in full**. Not at signup, not at part-pay.
- Friend must be **net-new** to TTT. Existing TTT clients converting to tax don't qualify.
- Campaign window: signup by 30 September 2026; first invoice paid by 31 December 2026.
- Campaign starts 1 June 2026 — code exists before that, no reward payable.
- For the personal code/link: Tina calls `get_my_referral_code` every time. Never invents a code, never quotes from memory.
- Tina does not send the link on the client's behalf — the client forwards it themselves.

**Handoff trigger.** Client claims a payout that hasn't arrived; client asks about a specific friend's status (consultant verifies, not bot); client wants the programme rules waived.

**Source of truth.** Prompt block at [claude.service.ts:274-288](../src/services/claude.service.ts#L274); [referral-code.md](./referral-code.md); [PRD-referral-tier-update.md](./PRD-referral-tier-update.md).

---

## 7. Update Client Details on CRM *(June 2026 pilot)*

**Definition.** Client wants to update their contact information on TTT's records — moved address, new mobile number, new email.

**Scope of this pilot.** Phone (mobile), email, physical/postal address only.

**Out of scope (always escalate).**
- Banking details (route SARS refunds — needs verification).
- Name, surname, ID number (high-risk identity fields).
- Spouse/dependent details.
- Employer details (affects tax classification).

**Client self-service.**
- New tool: `update_my_details` writes the whitelisted fields to the Dynamics contact record. Field whitelist enforced at the database/tool layer, not just in the prompt (same pattern as `update_loe_field`).
- Tina **echoes the new value back and waits for explicit confirmation** before writing: "Just to confirm — update your mobile to 082 xxx xxxx?"
- The change writes an audit record on the contact so staff can see what was changed and when.

**Handoff trigger.** Client wants to update any out-of-scope field above; client provides a value that looks malformed (e.g. phone with wrong digit count, email with no `@`); client wants to change details on someone else's record.

**Source of truth.** New tool to be built — `update_my_details` in `claude.service.ts`, backed by a write method on `dynamics.service.ts`. Audit log table in Supabase, mirrored to Dynamics.

---

## What this knowledge base is NOT

- **Tax practitioner-grade advice.** Tina explains concepts; specific recommendations on a client's facts go through a consultant.
- **A SARS-process guide.** Tasks that need consultant access to the firm's eFiling profile (Notice of Registration download, Tax Compliance Letter download, security details changes, 24-hour authorisation refreshes) are explicitly out of L1 auto-resolution scope.
- **A pricing sheet.** Specific quotes go through consultants.
- **A workflow doc for new features.** Those live in PRD-*.md files.

---

## Open items for TTT to confirm

- **Trust filing deadline** — TTT-specific guidance on the standard line.
- **Home office CGT line** — confirm Tina should surface the primary-residence-exclusion warning at L1, or hand off whenever CGT comes up.
- **Medical aid credit values** — confirm current tax year rand values for §5.
- **`update_my_details` tool** — to be built before June 2026 measurement window.
