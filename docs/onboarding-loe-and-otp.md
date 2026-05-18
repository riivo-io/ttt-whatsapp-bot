# Onboarding Sign-On Fix — LoE + SARS OTP

_Drafted 2026-05-04. Owner: TBD. Companion to [onboarding-flow.md](onboarding-flow.md) — that doc surveys the whole pipeline; this one specs the immediate fix to the lead greeting so it reflects real onboarding state._

---

## 1. Problem

When a non-client (lead) messages the bot, the current greeting is:

> Hey Sheri! 👋 I'm Tina, TTT's tax assistant — welcome aboard! 🎉 Ready to get you set up. Want to kick off by sending through your onboarding docs?

This is wrong for two reasons:

1. **It treats every lead as a fresh signup.** It doesn't check whether the lead has already signed the Letter of Engagement (`riivo_loereceived` on the Lead in Dynamics). A lead mid-onboarding gets the same opening line as a lead who just landed.
2. **It only references "onboarding docs" / LoE.** Tax onboarding has **two** gates: signed LoE *and* SARS eFiling shared-access OTP. The OTP step is never mentioned in chat today.

Per business rules: a lead becomes a client only once **both** are satisfied.

---

## 2. The two gates

### Gate 1 — Signed Letter of Engagement

- **Source of truth:** `riivo_loereceived` (boolean) on the Lead in Dynamics.
- **Already wired:** the inbound LoE upload flow flips this to `true` after staff confirms extracted data ([dynamics.service.ts:1108](../src/services/dynamics.service.ts#L1108)).
- **Lead-facing artifact:** signup link `https://ttt-tax.co.za/client-onboarding` (per brand identity — not `app.ttt-tax.co.za/signup`, that string is stale and should be removed wherever it appears in [claude.service.ts](../src/services/claude.service.ts)).

### Gate 2 — SARS eFiling OTP (Tax track only)

- **Source of truth:** `riivo_efilingotpcompleted` (boolean) on the Lead in Dynamics. Created in dev, deploying to UAT 2026-05-05; lands in prod as part of the same release as this code change.
- **Lead action:** lead does the OTP themselves on the SARS site so TTT can attach as a tax practitioner. The OTP exchange happens **on the SARS site**, not over WhatsApp — we don't capture or relay the OTP digits.
- **Verification:** **manual flip by staff** for now. Staff close the loop by flipping `riivo_efilingotpcompleted = true` directly on the Lead in Dynamics once they've confirmed the access on eFiling. A staff-side bot tool to flip the flag from WhatsApp can come later if the manual workflow proves friction-heavy.

### Canonical OTP instructions to send the lead

These are the exact steps TTT staff send today. The bot should send the same wording (formatted for WhatsApp — no HTML, plain numbered list):

```
Please complete the SARS One-Time Pin so TTT can access your eFiling profile:

1. Go to https://www.sarsefiling.co.za/
2. Click on "Manage Access requests"
3. Click "Yes" to South African Citizen, then fill in your ID Number and Income Tax Number. Click Submit.
4. Click on "Cellphone/Email". The OTP will be sent to you via SMS/Email — fill in the last 6 digits of the number you receive.
5. Click Accept.

Reply here once you've done it and we'll take it from there.
```

---

## 3. Greeting state machine (lead path)

For every inbound from a lead, evaluate fresh — **do not cache** at session start. The user can complete the LoE / OTP between turns and the next reply must reflect that.

| State                              | `riivo_loereceived` | OTP done  | Greeting / next-step content                                                                                                                                                                                     |
| ---------------------------------- | --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Fresh lead**            | `false`             | `false` | "Welcome — to get you set up we need two things: (1) a signed Letter of Engagement, (2) SARS eFiling access via a one-time pin. Let's start with the LoE: [shareable LoE link / instructions]."                 |
| **B. LoE done, OTP pending** | `true`              | `false` | "Thanks — we have your signed LoE on file. ✅ One step left: please complete the SARS OTP so we can act as your tax practitioner. [paste canonical OTP instructions, section 2]"                                |
| **C. OTP done, LoE pending** | `false`             | `true`  | "Thanks for completing the SARS OTP. ✅ Last step: we still need your signed Letter of Engagement. [shareable LoE link / instructions]"                                                                          |
| **D. Both done**             | `true`              | `true`  | Lead should already have been converted to a contact (TTTFG-3191). Until conversion is wired, fall back to: "You're all set on our end — a TTT consultant will be in touch shortly to confirm." Flag for staff. |

Notes:

- States A/C only apply to the Tax track. For Accounting/Insurance/FP we don't need the OTP step — those tracks stop at LoE. Service track lives on `new_lead.riivo_leadtype` (confirmed; already captured by the signup flow at [webhook.controller.ts:255](../src/controllers/webhook.controller.ts#L255)). Treat OTP as **Tax-only** and skip Gate 2 entirely if the lead's service ≠ Tax.
- If the bot cannot determine the service (field empty), default to **Tax** and ask the OTP step — staff can correct.
- Tax = `riivo_leadtype === 100000000`. Use a named constant `LEAD_TYPE_TAX` to keep the magic number out of business logic.

---

## 4. Implementation

### 4.1 Read both flags on every lead inbound

Add to [src/services/dynamics.service.ts](../src/services/dynamics.service.ts) — extend `getContactByPhone` (and `getEntityById` for the cached path) so a `lead` result includes the onboarding state:

```ts
// inside the `lead` branch around dynamics.service.ts:423
return {
    id: lead.new_leadid,
    type: 'lead',
    fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim(),
    loeReceived: lead.riivo_loereceived === true,
    otpCompleted: lead.riivo_efilingotpcompleted === true,
    leadType: lead.riivo_leadtype ?? null,                  // optionset id; map to 'tax'/'accounting'/etc
};
```

The `$select` clauses at [dynamics.service.ts:385](../src/services/dynamics.service.ts#L385), [453](../src/services/dynamics.service.ts#L453), and [583](../src/services/dynamics.service.ts#L583) need to include these new columns.

### 4.2 Re-read on every inbound (no caching)

Today `resolveSender` short-circuits on the Supabase session cache ([webhook.controller.ts:121-131](../src/controllers/webhook.controller.ts#L121-L131)). For leads, that cache returns the entity from Dynamics via `getEntityById` — so as long as the new fields are added to that path's `$select`, every inbound already round-trips to Dynamics for leads. **Verify** the cache hit path also fetches the flags; if not, force a re-read for `crm_type === 'lead'` until conversion.

### 4.3 Branch the lead system prompt

In [src/services/claude.service.ts:552](../src/services/claude.service.ts#L552), the `entityType === 'lead'` branch currently has a single hard-coded greeting. Replace it with state-aware content driven by the new flags:

```ts
} else if (entityType === 'lead') {
    const isTax = (crmEntity?.leadType === LEAD_TYPE_TAX) || crmEntity?.leadType == null;
    const loeDone = !!crmEntity?.loeReceived;
    const otpDone = !isTax || !!crmEntity?.otpCompleted;  // non-tax tracks: OTP gate is N/A
    // build the state-A/B/C/D guidance string and inject into roleContext
    // include the canonical OTP instructions verbatim when OTP is the next step
}
```

The `crmEntity` is already passed through `claudeService.generateResponse` via the webhook ([webhook.controller.ts:534-545](../src/controllers/webhook.controller.ts#L534-L545)); thread the new fields through the function signature (today only `crmEntity.id`, `crmEntity.type`, `crmEntity.fullname` are passed — extend to pass the full object or the three new fields).

### 4.4 LoE-received nudge after upload

When a lead uploads a signed LoE in the same WhatsApp session and the staff-side `confirm_loe_upload` flips `riivo_loereceived = true`, **the lead's next inbound** must transition them from State A → State B (and surface the OTP instructions). No code change needed here as long as section 4.2 holds (re-read on every inbound).

### 4.5 Don't broker the OTP for the lead

Per the saved preference ("give clients shareable artifacts, don't broker outbound messages"): the bot must **not** offer to "send the OTP to TTT for you" or ask the lead to forward the OTP digits into WhatsApp. The OTP exchange is between the lead and SARS; we just instruct, the lead acts. This is also the safer compliance posture given the open question in [onboarding-flow.md:77](onboarding-flow.md#L77).

### 4.6 Remove the old greeting code path

[claude.service.ts:553](../src/services/claude.service.ts#L553) — replace the static "welcome aboard! 🎉 want to kick off by sending through your onboarding docs?" example with a state-driven one. Replace the stale `app.ttt-tax.co.za/signup` URL with `ttt-tax.co.za/client-onboarding` everywhere it appears in the lead and unknown-user prompts ([claude.service.ts:553](../src/services/claude.service.ts#L553), [claude.service.ts:583](../src/services/claude.service.ts#L583)).

---

## 5. Out of scope for this fix (tracked elsewhere)

- ❌ **Lead → Contact conversion** when both gates are satisfied — TTTFG-3191, see [onboarding-flow.md:73](onboarding-flow.md#L73).
- ❌ **In-WhatsApp signup flow** for unknown numbers — handled by the existing flow ID path in [webhook.controller.ts:319-334](../src/controllers/webhook.controller.ts#L319-L334).
- ❌ **Outbound LoE generation** (sending a personalised LoE PDF *to* the lead to sign) — [onboarding-flow.md:68](onboarding-flow.md#L68) gap T4.
- ❌ **Automatic OTP-completed detection** — until SARS-side verification exists, OTP completion is a manual staff flag flip.

---

## 6. Decisions locked + remaining unknowns

**Locked (2026-05-05):**

- ✅ **OTP field name** — `riivo_efilingotpcompleted`, boolean on Lead. UAT deploy 2026-05-05; ships with this code change.
- ✅ **OTP flip mechanism** — manual flip by staff in Dynamics for now. No bot tool yet.
- ✅ **Service-track field** — `riivo_leadtype` on the Lead is the authoritative service indicator.
- ✅ **No backfill needed** — only active leads are queried, and most leads from before the field existed will already be converted contacts. Treating any active lead with `null`/`false` as "OTP pending" is acceptable.

- ✅ **Tax lead-type optionset value** — `100000000` (`riivo_leadtype === 100000000` ⇒ Tax). Define this as a named constant (e.g. `LEAD_TYPE_TAX = 100000000`) at the top of `dynamics.service.ts` so the meaning is self-documenting at the call site. If `riivo_leadtype` is `null`/`undefined`, default to Tax — most common case, prevents the OTP gate from being silently skipped.

**Remaining unknown:** none — spec is implementation-ready.

---

## 7. Test cases

Once implemented, exercise these in [test/test-case-lifecycle.ts](../test/test-case-lifecycle.ts) or a new `test/test-lead-onboarding.ts`:

- T-A: New lead (Tax, no LoE, no OTP) sends "hi" → bot returns State A greeting with LoE link.
- T-B1: Lead (Tax, LoE=true, OTP=false) sends "hi" → bot returns State B greeting with full OTP instructions.
- T-B2: Lead (Tax, LoE=false, OTP=true) send4s "hi" → bot returns State C greeting nudging LoE.
- T-C: Lead (Accounting, LoE=false) sends "hi" → bot returns LoE-only greeting (no OTP step).
- T-D: Lead uploads signed LoE mid-session → next inbound transitions A→B (OTP instructions surface). Validates section 4.2 (no caching).
- T-E: Lead asks "can I just send you the OTP?" → bot declines, restates the SARS-side flow.
