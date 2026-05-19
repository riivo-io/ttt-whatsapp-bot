# Referral Code — Feature Spec

_Status: **implemented.** Tier-aware shape live as of [Issues 11/12/13/14/15]. Last updated: 2026-05-19._

Source PRD: [PRD-referral-tier-update.md](./PRD-referral-tier-update.md). Marketing brainstorm: [referral-marketing.md](./referral-marketing.md).

When a client asks Tina for their referral code, she needs to (1) read it from Dynamics and (2) explain how the programme works for the **current campaign window**. Referrals are reportedly one of the most confusing things for clients, and the addition of tiers means the explanation matters more than ever.

---

## 1. Confirmed programme details

| Question | Answer |
|---|---|
| Dynamics field | `riivo_referralcode` on `contacts`. Formula field (read-only — the bot must never write to it). |
| Who gets the reward | Referrer only. The friend (referee) gets nothing — no discount, no credit. |
| Trigger event | The referee pays their first TTT tax invoice **in full**. Part-payment does not trigger. |
| Reward form | Cash, paid directly into the referrer's bank account on file. Not an invoice credit. |
| Tier rules (ex VAT) | <R1,500: no reward. R1,500 to R4,999.99: R500. R5,000 or more: R1,000. |
| Tier classification | Based on the referee's first paid invoice ex-VAT total. One reward per friend (first invoice only). |
| Campaign start | 1 June 2026. Before this date the code exists but no reward is payable. |
| Signup cutoff | 20 October 2026. Friend must have signed up via the magic link on or before this date. |
| Payout deadline | 28 February 2027. Friend's first invoice must be paid in full on or before this date. |
| Qualifying friend | Net-new TTT contact. Existing TTT clients (any service line) signing up via the link earn no reward. |
| Scope | Tax service line only. Accounting and advisory don't qualify. |
| Cap | None on total earnings. Every qualifying friend earns a separate reward. |
| Bot behaviour | Reactive only. Tina mentions referrals when asked; never proactively. |

---

## 2. How the programme works

1. Every TTT client has a unique referral code on their Dynamics `contact` record (`riivo_referralcode`).
2. Tina gives the client a unique magic link that embeds their code and routes straight to the tax onboarding form: `https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax`.
3. The client forwards the link themselves (WhatsApp, email, wherever). Tina does not send it on their behalf.
4. The friend clicks the link. Tax service is auto-selected; the onboarding form pre-fills the referral code; friend completes sign-up.
5. Onboarding form creates the lead in Dynamics with the referrer attributed (see §2.1 below).
6. When the friend pays their first TTT tax invoice in full, the Dynamics workflow classifies the tier from the invoice ex-VAT total and flags the payout amount for finance:
    - <R1,500 ex VAT: no reward (exit).
    - R1,500 to R4,999.99 ex VAT: R500 cash to the referrer.
    - R5,000 or more ex VAT: R1,000 cash to the referrer.
7. Finance is alerted via existing Power Automate flow with referrer banking details, payout amount, and friend name. Reward is paid into the referrer's bank account.

The reward is a cash payment, not an invoice credit. Clients should not expect to see a line item on their next invoice.

### 2.1. Onboarding-form side: attribution flow

When the tax onboarding form submits with a `ref` query-param present:

1. Look up the referring contact in Dynamics: `contacts` where `riivo_referralcode eq '{CODE}'`. (`riivo_referralcode` is a formula field, but it's queryable.)
2. If exactly one contact matches, on the new `new_lead` record set:
   - `riivo_referrer` = lookup to the matched contact (`riivo_Referrer@odata.bind` → `/contacts({id})`)
   - `riivo_validreferral` = `true`
3. If no contact matches or the param is missing, create the lead normally. `riivo_validreferral` defaults to false/null.

Scope locked: tax onboarding form only. Insurance/advisory and the accounting form (`ClientOnboardingForm.tsx`) don't accept referral codes.

### 2.2. Dynamics-side workflow (TTT operations)

This part of the contract is owned by TTT operations, not by this repo. Triggers when an invoice flips to "Paid" on a contact whose `riivo_referrer` is populated. The workflow:

1. Confirms 6 pre-conditions: first paid invoice in tax line, `riivo_referrer` populated, contact is net-new, `riivo_validreferral` true, contact created between 1 Jun 2026 and 20 Oct 2026, invoice paid on or before 28 Feb 2027.
2. Reads the invoice ex-VAT total and classifies the tier (R0 / R500 / R1,000).
3. Writes the payout amount to the contact (or lead) record and sets a "payout pending" flag.
4. Alerts finance via the existing Power Automate flow.
5. Idempotency flag (`riivo_referralpayoutprocessed` or equivalent) short-circuits re-processing.

Full contract: see [PRD-referral-tier-update.md](./PRD-referral-tier-update.md) §5.5.

### Why a magic link, not just a code

- Removes a step for the friend (no typing the code, no "where do I enter this?").
- Makes attribution reliable. The code is carried through the URL rather than depending on the friend remembering to mention it.
- Lets the client share in the format that suits them (forward the WhatsApp message, copy-paste into email) instead of Tina sending an outbound message on their behalf.
- Routing directly to the tax form (`&service=tax`) skips the service-picker step entirely.

---

## 3. Tool: `get_my_referral_code`

Client-facing. Staff don't need it (they can look it up in Dynamics directly). Lives in [src/services/claude.service.ts](../src/services/claude.service.ts) with the payload builder in [src/services/referral-window.ts](../src/services/referral-window.ts).

| Property | Value |
|---|---|
| Name | `get_my_referral_code` |
| Scope | `client` only |
| Input | None — uses `crmEntity.id` from session |
| Reads | `contacts.riivo_referralcode` via `dynamicsService.getContactReferralCode(contactId)` |
| Returns (ok) | PRD §5.2 shape including `current_window`, `tier_rules`, `response_instructions` |
| Returns (missing) | `{ status: "missing_code", code: null, message: "..." }` |
| Returns (no contact) | `{ status: "error", message: "No contact context — cannot look up referral code." }` |
| Side effects | None. Pure read. `riivo_referralcode` is a formula field — never PATCH it. |

The `response_instructions` field is window-specific (four variants, see §4) and tells the model exactly what to say in the current campaign state. The model composes the reply against `current_window`, `magic_link`, `code`, and `response_instructions` — no other interpretation needed.

### Related existing tool
`refer_friend` creates a lead on behalf of the client (separate path). Keep both. `refer_friend` is when the client wants Tina to do the work; `get_my_referral_code` is when the client wants to share the link themselves.

---

## 4. Client-education script — four window variants

`current_window` is classified server-side from today's date (PRD §5.3) and selects one of four templates. The reply pattern is roughly the same shape across windows; the differences are in what the client can act on.

### Active window (1 Jun 2026 to 20 Oct 2026)

> Here's your personal TTT referral link 🎉
>
> **https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax**
>
> How it works:
>
> 1. Forward this link to a friend or family member. WhatsApp, email, wherever suits you. They need to be new to TTT for the reward to apply.
> 2. They click the link and sign up. Your code is already attached, so they don't have to type anything.
> 3. When they pay their first TTT tax invoice in full, we pay you cash into the bank account we have on file. If their first invoice is R5,000 or more (before VAT), you get R1,000. If it's between R1,500 and R5,000 (before VAT), you get R500. Below R1,500, no reward.
>
> A few things worth knowing:
> - The reward is for *you* (the referrer), not them. They don't get a discount.
> - It's *cash into your bank account*, not a discount on your next invoice.
> - The campaign runs until *20 October 2026*. Your friend just has to sign up by then. Their first invoice has to be settled by 28 February 2027 for the reward to land.
> - No cap. Every new friend who signs up and pays their first invoice earns you another reward.
>
> (If you'd rather just give them the code: `{CODE}`. They can type it in during onboarding instead.)

### Pre-launch window (now to 31 May 2026)

> Here's your personal TTT referral link:
>
> **https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax**
>
> Heads-up: the referral campaign kicks off *1 June 2026*. Here's how it'll work:
>
> 1. Forward this link to a friend or family member who's new to TTT.
> 2. They click and sign up, code attached.
> 3. When they pay their first TTT tax invoice in full, you get cash into your bank account. R1,000 if it's R5,000 or more ex VAT, R500 if it's R1,500 to R5,000, nothing below R1,500.
>
> Sign-ups have to happen by 20 October 2026 and first invoices have to be paid by 28 February 2027. The link's yours to keep, but no reward is payable until 1 June.

### Signup-closed, rewards-pending window (21 Oct 2026 to 28 Feb 2027)

> The referral signup window closed on *20 October 2026*, so new referrals from this point on don't qualify for a reward.
>
> If your friend already signed up before 20 October, you're still in. The reward kicks in when they pay their first TTT tax invoice in full, and that needs to happen on or before *28 February 2027*.
>
> Here's your link for reference (don't share it expecting a reward now): **https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax**

### Fully-closed window (1 Mar 2027 onwards)

> The campaign's done — no rewards are payable for any new or existing referrals.
>
> Keep your link though, we'll let you know if we run it again: **https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax**

### Copy rules (baked into `response_instructions`)

These constraints live verbatim in [src/services/referral-window.ts](../src/services/referral-window.ts) as `RESPONSE_INSTRUCTIONS` and the system prompt's "Referral Programme — FACTS ONLY" block. They apply during the active window:

1. Lead with the magic link, not the raw code. The code is a typed-fallback at the end.
2. Never offer to send the link or code on the client's behalf.
3. Always include the 3 numbered steps in the active window.
4. Always state who gets the reward (referrer only). The friend gets nothing.
5. Always describe the reward as cash into the referrer's bank account. Never "discount", "credit", or "off your invoice".
6. Always state the tier rules in plain English so the client knows what to expect.
7. Always cite both deadlines: signup by 20 Oct 2026, first invoice paid in full by 28 Feb 2027.
8. Never promise a payout date. It depends on when the friend pays.
9. Never say the friend also gets a reward.
10. The friend must be net-new to TTT. Existing TTT clients signing up don't qualify.

### Tone

Follow [bot-personality.md](./bot-personality.md). Warm, light, specific. The 🎉 on the active template's first line is the only emoji.

---

## 5. Edge cases

| Situation | Expected behaviour |
|---|---|
| Client asks "what's my referral code?" | Call `get_my_referral_code`. Reply uses the §4 template selected by `current_window`. |
| Client asks "how does the referral thing work?" without asking for the code | Still call the tool. Include the code/link plus the explanation. They almost always want both. |
| Code field is empty in Dynamics | Unusual for a formula field. Tool returns `status: "missing_code"`. Tina apologises, offers `request_consultant_callback`. Flag the data issue in logs. |
| Lead (not a contact) asks about referrals | Leads don't have codes. "Referral codes are for TTT clients once you're fully onboarded. Let's get you signed up first." |
| Staff asks for a client's referral code | Not supported by this tool. Staff look it up in Dynamics directly. |
| Client asks whether their friend used the code | Out of scope. Direct them to their consultant. A `get_my_referral_status` tool is explicitly out of scope per PRD §4. |
| Client asks Tina to send the link to their friend | Politely decline. "The link's yours to share, so forward it from your own WhatsApp or email. That way your friend knows it came from you." |
| Client asks "when will I get paid?" | "As soon as your friend pays their first TTT invoice in full, it goes straight into your bank account on file. I can't give you a specific date; your consultant can check progress." |
| Client asks if the reward will appear on their invoice | Correct the misunderstanding explicitly. "It's a cash payment into your bank account, not a discount on your invoice." |
| Friend's first invoice is below R1,500 ex VAT | No reward. The bot's copy already states this in the tier rules; the Dynamics workflow exits at tier classification. |
| Friend is an existing TTT client signing up via the link | Out of scope per the net-new rule. Dynamics workflow exits at pre-condition 3 (not net-new). No bot-side check needed: copy says "your friend has to be new to TTT" and that's the extent. |
| Friend signs up after 20 Oct 2026 | No reward, even if first invoice is paid in time. `current_window` flips to `signup_closed_rewards_pending` and the copy explains this. Dynamics workflow exits at pre-condition 5. |
| Friend pays first invoice after 28 Feb 2027 | No reward. Dynamics workflow exits at pre-condition 6. |
| Friend later refunded or credited | Out of scope for v1. Finance team handles clawback manually if needed. Workflow does not roll back. |
| Client's banking details aren't on file | Workflow flags the record for finance follow-up. No auto-payout. Bot does not check this up front. |

---

## 6. Implementation status

- [x] Magic-link format `?ref={CODE}&service=tax` confirmed unchanged (Issue 15).
- [x] `getContactReferralCode(contactId)` in [dynamics.service.ts](../src/services/dynamics.service.ts).
- [x] `get_my_referral_code` tool definition + handler in [claude.service.ts](../src/services/claude.service.ts).
- [x] `getReferralWindow` helper + `buildReferralCodePayload` + `RESPONSE_INSTRUCTIONS` in [referral-window.ts](../src/services/referral-window.ts) (Issues 13, 14, 12).
- [x] System-prompt referral block rewritten to PRD §5.1 (Issue 11).
- [x] Smoke test in [test/test-referral-payload.ts](../test/test-referral-payload.ts) covers all 4 windows + 5 boundary dates + tier shape + magic-link format.
- [ ] Dynamics-side workflow (TTT operations). Contract in PRD §5.5. Owner: TTT ops. Target before 1 Jun 2026 launch.
- [ ] Numeric targets for success metrics (PRD §2). Owner: TTT.
- [ ] Real-estate-agent classification source documented in Dynamics. Owner: TTT ops.
- [ ] Post-campaign readout on 15 March 2027.
