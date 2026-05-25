# Meta WhatsApp Template Inventory

Every outbound message the bot might send **outside the 24-hour customer-service window** must go through a Meta-approved template. Within the 24h window (i.e. replying to a user's recent inbound) free-form text is fine.

This file is the inventory + submission tracker. Template approval typically takes 1–5 business days per template — start submitting ASAP.

**Submission destination:** Meta Business Manager → WhatsApp Manager → Message Templates.
**All templates:** Language `en`, Category `UTILITY` unless flagged otherwise. No media header unless explicitly stated.

---

## Status legend

| Symbol | Meaning |
|---|---|
| 🔴 | Not submitted |
| 🟡 | Submitted, pending Meta review |
| 🟢 | Approved |
| ⚫ | Rejected — see notes |

---

## 1. `ttt_signup_required` 🔴

Sent when an unknown phone number messages the bot (no Dynamics/Supabase match).

**Current code:** [webhook.controller.ts:13-14, 159-160](../src/controllers/webhook.controller.ts#L159-L160) — `SIGN_UP_GREETING` + `SIGN_UP_LINK` as two plain messages.

**Category:** UTILITY

**Body:**
```
👋 Hi there! It looks like you're not registered with TTT yet.

To get started, please sign up at {{1}}. Once registered, message us again and we'll be able to assist you with all your tax needs.
```

**Variables:**
- `{{1}}` — signup URL (e.g. `https://www.taxtechnicianstoday.co.za/sign-up`)

---

## 2. `ttt_staff_no_access` 🔴

Sent to a staff user when their Dynamics role has no permitted tools.

**Current code:** [webhook.controller.ts:181](../src/controllers/webhook.controller.ts#L181)

**Category:** UTILITY

**Body:**
```
Hi {{1}} — you don't currently have access to any bot features. Please contact your administrator to request access.
```

**Variables:**
- `{{1}}` — staff full name

---

## 3. `ttt_case_feedback_prompt` 🔴

Interactive button template sent after the bot answers an L1 case, asking the client to confirm resolution.

**Current code:** [webhook.controller.ts:286-294](../src/controllers/webhook.controller.ts#L286-L294) via `metaWhatsAppService.sendReplyButtons`.

**Template type:** Interactive — Quick Reply Buttons
**Category:** UTILITY

**Body:**
```
Did that answer your question?
```

**Buttons:**
1. `Yes, thanks`
2. `No, I still need help`

**Notes:** Meta templates with quick-reply buttons support up to 3 buttons, 20 chars per button. Current wording is within limit.

---

## 4. `ttt_case_feedback_ack_confirmed` 🔴

Sent after a client clicks "Yes, thanks".

**Current code:** [webhook.controller.ts:221-223](../src/controllers/webhook.controller.ts#L221-L223)

**Category:** UTILITY

**Body:**
```
Great — glad that helped. 🙌 Message me again any time.
```

**Variables:** none

---

## 5. `ttt_case_feedback_ack_escalated` 🔴

Sent after a client clicks "No, I still need help".

**Current code:** [webhook.controller.ts:221-223](../src/controllers/webhook.controller.ts#L221-L223)

**Category:** UTILITY

**Body:**
```
Thanks for letting me know. I've flagged this for a consultant to follow up.
```

**Variables:** none

---

## 6. `ttt_invoice_delivery` 🔴

Document template for sending invoice PDFs via `send_invoice_pdf`.

**Current code:** [claude.service.ts:1072-1073](../src/services/claude.service.ts#L1072-L1073)

**Template type:** Document header + text body
**Category:** UTILITY

**Header:** Document (PDF attachment, supplied at send time)

**Body:**
```
{{1}}, {{2}} from TTT has sent you an invoice. Please find it attached. Thank you.
```

**Variables:**
- `{{1}}` — greeting (`Good morning` / `Good afternoon` / `Good evening`)
- `{{2}}` — staff sender full name

---

## 7. `ttt_callback_confirmation` 🔴

Sent after a client's callback request is written to Dynamics via `request_consultant_callback`.

**Current code:** currently the callback confirmation is part of Claude's free-text reply. Once templated, `createCallbackRequest` success should send this explicit confirmation.

**Category:** UTILITY

**Body:**
```
Thanks {{1}} — we've logged your callback request. A consultant will be in touch within {{2}} hours.
```

**Variables:**
- `{{1}}` — client first name
- `{{2}}` — SLA window in hours (currently 2h per `riivo_slawindow`)

---

## 8. `ttt_opt_out_confirmation` 🔴

Sent after a client opts out via either the `opt_out_whatsapp` tool or (once implemented) the `STOP` keyword intercept.

**Current code:** part of Claude's free-text reply today; see [claude.service.ts:1552-1553](../src/services/claude.service.ts#L1552-L1553).

**Category:** UTILITY

**Body:**
```
You've been opted out of TTT WhatsApp messages. Reply START at any time to opt back in.
```

**Variables:** none

---

## 9. `ttt_webhook_error` 🔴

Generic error reply when bot processing fails.

**Current code:** [webhook.controller.ts:144, 350](../src/controllers/webhook.controller.ts#L144)

**Category:** UTILITY

**Body:**
```
Sorry, something went wrong on our side. Please try again in a moment.
```

**Variables:** none

**Notes:** This is always sent as a reply within 24h — arguably doesn't need a template. Include for completeness in case we ever retry outside the window.

---

## 10. `ttt_otp_instructions` 🔴

Interactive button template manually initiated by a consultant from Dynamics once they've added the lead on SARS eFiling. Sends the step-by-step OTP instructions plus two quick-reply buttons so the lead can confirm completion (auto-converts the lead to a client) or request help (escalates a `riivo_request` and emails taxcrew@ttt-tax.co.za from the tina-bot mailbox).

**Inbound handler:** [whatsappProcessor.ts](../src/workers/whatsappProcessor.ts) — `handleOtpTemplateResponse` (search for `OTP_BUTTON_PAYLOAD`).

**Template type:** Interactive — Quick Reply Buttons
**Category:** UTILITY

**Body:**
```
Hi {{1}}, here's the last step to get you set up — the SARS eFiling OTP. It takes about a minute:

1. Go to https://secure.sarsefiling.co.za/app/profileTaxType/taxTypeActivation
2. Fill in your ID Number and Income Tax Number, then click Submit.
3. Choose Cellphone (easier than email). SARS will SMS you an OTP — fill in the last 6 digits.
4. Click Accept.

Tap a button below once you're done, or if you'd like a hand.
```

**Variables:**
- `{{1}}` — Lead first name

**Buttons (must use these exact payload ids):**
1. Title: `Done ✅` — payload: `otp:done`
2. Title: `Need help` — payload: `otp:help`

**Notes:**
- Button payloads must match `OTP_BUTTON_PAYLOAD` constants in [whatsappProcessor.ts](../src/workers/whatsappProcessor.ts). Mismatched ids will silently fall through to the AI path.
- The "Done ✅" tap sets both `riivo_efilingotpcompleted=true` and `icon_converttoclient=true` on the lead row; a Power Automate flow on the CRM side converts the lead to a contact when `icon_converttoclient` flips.
- The "Need help" tap creates an escalated `riivo_request` for the lead and emails taxcrew so a consultant picks it up.

---

## Deferred until guardrails land (Phase E)

These templates only become relevant once [src/services/guardrails.service.ts](../src/services/guardrails.service.ts) ships.

### 10. `ttt_session_limit_reached` 🔴 (future)

**Body:**
```
You've reached the message limit for this session. Please start a new conversation by messaging again later. For urgent matters, call our office on {{1}}.
```

- `{{1}}` — office number

### 11. `ttt_daily_limit_reached` 🔴 (future)

**Body:**
```
You've reached today's message limit. You'll be able to continue tomorrow. For urgent matters, call our office on {{1}}.
```

- `{{1}}` — office number

### 12. `ttt_rapid_fire_throttle` 🔴 (future)

**Body:**
```
Please give me a moment to reply — I'll get back to you shortly.
```

---

## Not needed

- **Case feedback timeout**: when `handleTimeout` flips a case to `resolved_by_bot_timeout` after 12h, no outbound is sent. This is intentional — silent close, no user-visible message. No template needed.
- **Claude free-form replies**: the bulk of the bot's outbound is live AI-generated responses inside the 24h reply window. These never need templates.

---

## Submission checklist

Before submitting each template in Meta Business Manager:

- [ ] Category set correctly (UTILITY for all above — no MARKETING)
- [ ] Language = `en`
- [ ] Sample variables provided for approval
- [ ] Button labels ≤ 20 characters
- [ ] Body text ≤ 1024 characters
- [ ] No URLs in body other than pre-approved domains (for `ttt_signup_required`, URL goes in a variable or is hardcoded in a button)

## Code-side work (after approval)

Once a template is approved:
1. Add `metaWhatsAppService.sendTemplate(to, templateName, variables[])` to [src/services/meta.service.ts](../src/services/meta.service.ts) (TTTFG-3224).
2. Track `sessions.last_inbound_at`; when `now() - last_inbound_at > 24h`, route through `sendTemplate` instead of `sendMessage`.
3. Replace the hardcoded strings in the files referenced above with template sends, keyed off the 24h window check.
