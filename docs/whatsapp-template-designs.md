# WhatsApp Template Designs — Wording & Buttons

Design-first companion to [meta-templates.md](meta-templates.md). That file tracks submission state and code references; this one focuses on **what the user reads and taps**.

Scope: every outbound message that can leave the 24-hour customer-service window needs a Meta-approved template. Inside the window, free-form text from Tina is fine — but the wording here still applies so the voice stays consistent.

**Voice:** Tina — light, warm, brand-aligned. See [bot-personality.md](bot-personality.md) for the full rules.

**Constraints to remember while drafting:**
- Body ≤ 1024 chars (aim for ≤ 200 for mobile readability).
- Quick-reply buttons: max **3**, each ≤ **20 characters** (emoji counts as multiple bytes — keep button text ASCII where possible).
- Call-to-action buttons: max **2** (1 phone + 1 URL).
- Variables must have realistic sample values at submission time.
- No emoji in header text; body emoji is fine but sparingly (≤ 3).
- No marketing wording in UTILITY templates — keep it transactional.

---

## Template catalogue

| # | Name | Category | Interactive? | Trigger |
|---|---|---|---|---|
| 1 | `ttt_signup_required` | UTILITY | CTA URL button | Unknown phone messages bot |
| 2 | `ttt_lead_welcome` | UTILITY | Quick reply | Known lead's first message |
| 3 | `ttt_optin_request` | UTILITY | Quick reply | Bot wants to message outside 24h window for the first time |
| 4 | `ttt_optin_confirmation` | UTILITY | — | Client tapped "Yes, opt me in" |
| 5 | `ttt_optout_confirmation` | UTILITY | — | Client used `opt_out_whatsapp` tool or typed STOP |
| 6 | `ttt_case_feedback_prompt` | UTILITY | Quick reply | Bot just answered an L1 case |
| 7 | `ttt_case_feedback_ack_confirmed` | UTILITY | — | User tapped "Yes, thanks" |
| 8 | `ttt_case_feedback_ack_escalated` | UTILITY | — | User tapped "No, still need help" |
| 9 | `ttt_callback_confirmation` | UTILITY | — | `request_consultant_callback` succeeded |
| 10 | `ttt_invoice_delivery` | UTILITY | Document header | Staff used `send_invoice_pdf` |
| 11 | `ttt_document_received` | UTILITY | Quick reply | Client uploaded a file, bot asks doc type |
| 12 | `ttt_loe_request` | UTILITY | CTA URL button | Lead onboarding — prompt to sign LOE |
| 13 | `ttt_loe_received` | UTILITY | — | Signed LOE uploaded + processed |
| 14 | `ttt_staff_no_access` | UTILITY | — | Staff role has no permitted tools |
| 15 | `ttt_session_limit_reached` | UTILITY | CTA phone button | Guardrails: per-session cap hit |
| 16 | `ttt_daily_limit_reached` | UTILITY | CTA phone button | Guardrails: per-day cap hit |
| 17 | `ttt_rapid_fire_throttle` | UTILITY | — | Guardrails: user flooding |
| 18 | `ttt_reengagement_check_in` | UTILITY | Quick reply | 30 days inactive, tax season approaching |
| 19 | `ttt_nps_prompt` | UTILITY | Quick reply (List) | Monthly satisfaction survey trigger |
| 20 | `ttt_webhook_error` | UTILITY | — | Processing failure fallback |

---

## 1. `ttt_signup_required`

**Trigger:** An unknown phone number messages the bot. No contact, lead, or staff match.

**Body:**
```
👋 Hi there! I'm Tina from TTT Financial Group.

It looks like you're not registered with us yet. Tap below to get started — once you're onboarded, message me again and I'll get you sorted.
```

**Buttons (Call-to-action):**
- `Get started` → URL: `https://ttt-tax.co.za/client-onboarding`

**Variables:** none (URL is hardcoded in button, not a variable).

---

## 2. `ttt_lead_welcome`

**Trigger:** A lead's very first inbound message. Differentiated from clients because leads can't self-serve — we want to push them toward onboarding, not list features.

**Body:**
```
Hey {{1}} 👋 I'm Tina, TTT's WhatsApp tax assistant.

Great to have you with us! The fastest way to get going is your onboarding paperwork — shall we start there?
```

**Buttons (Quick reply):**
1. `Yes, let's start`
2. `I have a question`
3. `Not right now`

**Variables:**
- `{{1}}` — lead first name (sample: `Luc`)

**Follow-on routing:**
- `Yes, let's start` → `ttt_loe_request`
- `I have a question` → free-form Tina response (inside 24h window, no template)
- `Not right now` → free-form acknowledgement, no follow-up

---

## 3. `ttt_optin_request`

**Trigger:** Bot needs to re-engage a contact outside the 24h window AND `riivo_whatsappoptinout` is null/unset. Must get explicit opt-in before any further marketing-adjacent contact.

**Category note:** UTILITY is defensible because we're confirming transactional preferences, not marketing. If Meta pushes back, resubmit as MARKETING.

**Body:**
```
Hi {{1}}, it's Tina from TTT.

Is it OK if I send you updates and reminders on WhatsApp? Things like case progress, invoice notices, and the occasional tax-season heads-up. You can opt out any time by replying STOP.
```

**Buttons (Quick reply):**
1. `Yes, opt me in`
2. `No thanks`

**Variables:**
- `{{1}}` — client first name (sample: `Luc`)

---

## 4. `ttt_optin_confirmation`

**Trigger:** Client tapped `Yes, opt me in` from template 3.

**Body:**
```
You're all set ✅ I'll keep you posted on anything important. Reply STOP any time to stop these messages.
```

**Buttons:** none.
**Variables:** none.

---

## 5. `ttt_optout_confirmation`

**Trigger:** Client invoked `opt_out_whatsapp` tool, tapped `No thanks` on opt-in, or sent the STOP keyword.

**Body:**
```
Got it — you've been opted out of TTT WhatsApp messages. Reply START at any time to opt back in, or give our office a call if you need urgent help.
```

**Buttons:** none (intentionally — we don't want to nudge them back after an opt-out).

**Variables:** none.

**Note:** Must always succeed even when Dynamics opt-out PATCH fails — send the confirmation first, then reconcile CRM state async.

---

## 6. `ttt_case_feedback_prompt`

**Trigger:** Bot answered an L1 classified question. Sent after the answer, usually as a separate message with interactive buttons.

**Body:**
```
Did that answer your question?
```

**Buttons (Quick reply):**
1. `Yes, thanks` *(matches [CASE_FEEDBACK_BUTTON_YES](../src/services/case.service.ts))*
2. `No, still need help` *(matches [CASE_FEEDBACK_BUTTON_NO](../src/services/case.service.ts))*

**Variables:** none.

**Design notes:**
- Keep body to one line — buttons do the work.
- Two buttons not three: a "not sure" middle option dilutes the metric and we can't do anything useful with it.
- Button wording must match the code constants exactly or the webhook handler won't route correctly.

---

## 7. `ttt_case_feedback_ack_confirmed`

**Trigger:** User tapped `Yes, thanks` from template 6.

**Body:**
```
Glad that helped 🙌 Ping me any time you need a hand.
```

**Buttons:** none.
**Variables:** none.

---

## 8. `ttt_case_feedback_ack_escalated`

**Trigger:** User tapped `No, still need help` from template 6.

**Body:**
```
Thanks for letting me know. I've flagged this for one of our consultants — they'll be in touch shortly.
```

**Buttons:** none.
**Variables:** none.

**Design notes:**
- Don't apologise ("sorry I couldn't help") — it foregrounds the failure. A calm handoff reads better.
- No SLA promise here (that's template 9's job if a callback was explicitly logged).

---

## 9. `ttt_callback_confirmation`

**Trigger:** `request_consultant_callback` tool ran and wrote a Dynamics task.

**Body:**
```
Thanks {{1}} — your callback is logged ✅ A TTT consultant will be in touch within {{2}} hours.

If it's urgent, you can also call our office on {{3}}.
```

**Buttons (Call-to-action):**
- `Call office` → Phone: `{{3}}`

**Variables:**
- `{{1}}` — client first name (sample: `Luc`)
- `{{2}}` — SLA window hours (sample: `2`)
- `{{3}}` — office number E.164 (sample: `+27 21 555 0123`)

---

## 10. `ttt_invoice_delivery`

**Trigger:** Staff used `send_invoice_pdf` to deliver a PDF to a client outside the 24h window.

**Header:** Document (PDF attached at send time; sample filename `INV-2026-0042.pdf`)

**Body:**
```
{{1}}, {{2}} from TTT has sent you an invoice. Please find it attached.

Any questions, just reply to this chat.
```

**Buttons:** none (attachment + reply affordance is enough).

**Variables:**
- `{{1}}` — time-of-day greeting (sample: `Good morning`)
- `{{2}}` — staff sender full name (sample: `Sarah Jacobs`)

---

## 11. `ttt_document_received`

**Trigger:** Client uploaded a file; bot needs to know the document type before calling `save_document`. Interactive list is better than quick replies here because there are usually 5+ categories.

**Template type:** Interactive — List

**Body:**
```
Got your file 📎 — what kind of document is it?
```

**Button label:** `Choose type`

**List sections:**

*Section: Identification*
- `ID Document`
- `Passport`

*Section: Financial*
- `Payslip`
- `Bank Statement`
- `Tax Certificate (IRP5/IT3)`

*Section: Other*
- `Medical Aid Certificate`
- `Something else`

**Variables:** none.

**Design notes:**
- List over quick-reply because we have > 3 options.
- `Something else` routes to free-form — don't try to enumerate every edge case.

---

## 12. `ttt_loe_request`

**Trigger:** Lead tapped "Yes, let's start" on the welcome template, OR staff manually nudged onboarding.

**Body:**
```
Let's get you set up, {{1}}.

Please download your Letter of Engagement, sign it, and send the signed copy back to me here on WhatsApp. I'll take it from there.
```

**Buttons (Call-to-action):**
- `Download LOE` → URL: `{{2}}`

**Variables:**
- `{{1}}` — lead first name (sample: `Luc`)
- `{{2}}` — per-lead LOE URL (sample: `https://ttt-tax.co.za/loe/{{leadId}}`)

**Design notes:**
- URL variable requires pre-approval of the base domain with Meta.
- If URL variability is rejected, host a single static LOE link and personalise via `{{1}}` in body only.

---

## 13. `ttt_loe_received`

**Trigger:** Signed LOE PDF was uploaded, OCR extracted successfully, lead record patched.

**Body:**
```
Got your signed LOE 📄✅ Thanks {{1}} — we've captured everything we need.

Your consultant {{2}} will be in touch to kick things off.
```

**Buttons:** none.

**Variables:**
- `{{1}}` — lead first name (sample: `Luc`)
- `{{2}}` — owning consultant full name (sample: `Sarah Jacobs`)

---

## 14. `ttt_staff_no_access`

**Trigger:** Staff sender has a Dynamics record but zero permitted tools.

**Body:**
```
Hi {{1}} — you don't currently have bot access. Please contact your TTT administrator to request it.
```

**Buttons:** none.

**Variables:**
- `{{1}}` — staff first name (sample: `Sarah`)

---

## 15. `ttt_session_limit_reached`

**Trigger:** Per-session message cap hit (Phase E guardrails).

**Body:**
```
We've covered a lot in this session 👍 Let's pick it back up later — message me again in a bit and we'll carry on.

For urgent matters, you can call our office.
```

**Buttons (Call-to-action):**
- `Call office` → Phone: `{{1}}`

**Variables:**
- `{{1}}` — office number E.164 (sample: `+27 21 555 0123`)

---

## 16. `ttt_daily_limit_reached`

**Trigger:** Per-day cap hit.

**Body:**
```
You've reached today's message limit with me. We can pick this up tomorrow — I'll be right here.

For anything urgent, give the office a ring.
```

**Buttons (Call-to-action):**
- `Call office` → Phone: `{{1}}`

**Variables:**
- `{{1}}` — office number (sample: `+27 21 555 0123`)

---

## 17. `ttt_rapid_fire_throttle`

**Trigger:** User sending faster than the bot can keep up — soft throttle.

**Body:**
```
One sec — still typing my last reply 💬 I'll be with you in a moment.
```

**Buttons:** none.
**Variables:** none.

**Design notes:**
- Keep it charming, not scolding.
- Don't reference "rate limit" — that's internal language.

---

## 18. `ttt_reengagement_check_in`

**Trigger:** Contact hasn't messaged for 30+ days AND is within 60 days of tax season opening. Category may need to be MARKETING — confirm with Meta.

**Body:**
```
Hi {{1}} — Tina here 👋

Tax season opens {{2}}. Just a friendly heads-up in case you want to get ahead of the paperwork. Want me to pull your outstanding items?
```

**Buttons (Quick reply):**
1. `Yes, show me`
2. `Not yet, thanks`
3. `Stop messages`

**Variables:**
- `{{1}}` — contact first name (sample: `Luc`)
- `{{2}}` — tax season open date, friendly format (sample: `1 July`)

**Design notes:**
- `Stop messages` doubles as an opt-out fast path — routes through template 5.
- Never send this if `riivo_whatsappoptinout` is false.

---

## 19. `ttt_nps_prompt`

**Trigger:** Monthly survey to a sampled set of clients with ≥ 1 resolved case in the window.

**Template type:** Interactive — List (ratings scale)

**Body:**
```
Quick one, {{1}} — how likely are you to recommend TTT to a friend or colleague?
```

**Button label:** `Rate us`

**List sections:**

*Section: Promoters*
- `10 — Definitely`
- `9 — Very likely`

*Section: Passives*
- `8 — Likely`
- `7 — Somewhat`

*Section: Detractors*
- `6 or below`

**Variables:**
- `{{1}}` — contact first name (sample: `Luc`)

**Follow-on routing:**
- Promoters → `ttt_nps_ack_promoter` (new template — "Thanks! If you'd like to refer someone…")
- Passives → `ttt_nps_ack_passive` (new template — "Thanks, any feedback?")
- Detractors → escalation: free-form consultant outreach within 24h

**Design notes:**
- 11-point NPS collapsed to 5 rows because WhatsApp lists support max 10 items per section and this is easier to scan.
- Keep the follow-on ack templates in a later submission batch — the prompt itself is the long-lead item.

---

## 20. `ttt_webhook_error`

**Trigger:** Unhandled exception in the webhook pipeline, always within 24h window. Keep it templated anyway for completeness.

**Body:**
```
Sorry, something went wrong on my side. Please try again in a moment — if it keeps happening, our office can help directly.
```

**Buttons (Call-to-action):**
- `Call office` → Phone: `{{1}}`

**Variables:**
- `{{1}}` — office number (sample: `+27 21 555 0123`)

---

## Cross-cutting design rules

**Voice consistency**
- Tina never signs off. No "— Tina" closers.
- First message of any template thread re-introduces Tina once; subsequent templates in the same thread do not.
- Time-of-day greetings only in `ttt_invoice_delivery` (where it's the staff sender's voice, not Tina's).

**Button wording**
- Start with a verb where possible (`Sign up`, `Call office`, `Download LOE`).
- For feedback/confirmation buttons, the exact string is load-bearing — the webhook matches on it. Keep these in sync with the constants in [case.service.ts](../src/services/case.service.ts).
- Emoji in button labels: avoid unless the template is client-facing and the emoji meaningfully disambiguates (✅, ❌). Emoji eats into the 20-char limit faster than you'd think.

**Emoji budget**
- ≤ 3 per body.
- Never in header text (Meta sometimes rejects).
- Never in the same message as bad news — matches [bot-personality.md](bot-personality.md) §1.

**Localisation**
- Submit all templates in `en` first.
- `af` (Afrikaans) is the most likely second language — build the submission queue to make re-submission cheap (keep variable structure identical, translate body only).

---

## Submission priority

Submit in this order based on user-facing impact and approval lead time:

**Batch 1 (submit immediately — core flows):**
1. `ttt_signup_required`
2. `ttt_case_feedback_prompt`
3. `ttt_case_feedback_ack_confirmed`
4. `ttt_case_feedback_ack_escalated`
5. `ttt_optout_confirmation`
6. `ttt_webhook_error`

**Batch 2 (submit within 1 week):**
7. `ttt_callback_confirmation`
8. `ttt_invoice_delivery`
9. `ttt_lead_welcome`
10. `ttt_loe_request`
11. `ttt_loe_received`
12. `ttt_document_received`
13. `ttt_staff_no_access`

**Batch 3 (Phase E guardrails):**
14. `ttt_optin_request`
15. `ttt_optin_confirmation`
16. `ttt_session_limit_reached`
17. `ttt_daily_limit_reached`
18. `ttt_rapid_fire_throttle`

**Batch 4 (growth / lifecycle — after core is stable):**
19. `ttt_reengagement_check_in`
20. `ttt_nps_prompt` (+ ack variants)
