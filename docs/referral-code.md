# Referral Code — Feature Spec

_Status: **not yet implemented.** Design doc. Last updated: 2026-04-24._

When a client asks Tina for their referral code, she needs to (1) read it from Dynamics and (2) explain — **very clearly** — how the programme works. Referrals are reportedly one of the most confusing things for clients, so the explanation matters as much as the code itself.

---

## 1. Confirmed programme details

| Question | Answer |
|---|---|
| Dynamics field | `riivo_referralcode` on `contacts` — **formula field** (read-only; Dynamics derives it, the bot must never write to it) |
| Who gets the R500 | **Referrer only.** The new friend (referee) gets no discount. |
| Trigger event | The referee **pays their first invoice**. |
| Payout mechanism | **Direct bank transfer** into the referrer's account — **not** an invoice credit. Uses the banking details on the referrer's contact record. |
| Campaign window | **1 June 2026 – 31 July 2026** (2 months). Outside this window the code still exists but no reward is payable. |
| Referral cap | **None.** A client can refer unlimited friends during the campaign window. |

---

## 2. How the programme works

1. Every TTT client has a unique referral code on their Dynamics `contact` record (`riivo_referralcode`).
2. Tina gives the client a **unique magic link** that embeds their code and routes straight to the tax onboarding form: `https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax`.
3. The client **forwards the link** themselves (WhatsApp, SMS, email — their choice). Tina does not send it on their behalf.
4. The friend clicks the link → the tax service is auto-selected, the onboarding form pre-fills the referral code → friend completes sign-up.
5. Onboarding form creates the lead in Dynamics with the referrer attributed (see §2.1 below).
6. When the friend **pays their first TTT invoice** during the campaign window, **R500 is paid into the referrer's bank account** (using the banking details already on file).
7. There's no cap — every friend who pays a first invoice during June–July 2026 earns the referrer another R500.

The reward is a cash payment, not an invoice credit. Clients should **not** expect to see a line item on their next invoice.

### 2.1. Onboarding-form side: attribution flow

When the tax onboarding form submits with a `ref` query-param present:

1. Look up the referring contact in Dynamics: `contacts` where `riivo_referralcode eq '{CODE}'`. (`riivo_referralcode` is a formula field, but it's queryable.)
2. If exactly one contact matches → on the new `new_lead` record set:
   - `riivo_referrer` = lookup to the matched contact (`riivo_Referrer@odata.bind` → `/contacts({id})`)
   - `riivo_validreferral` = `true`
3. If no contact matches or the param is missing → create the lead normally; `riivo_validreferral` defaults to false/null.

Scope locked: **tax onboarding form only** for the initial rollout. Insurance/advisory and the accounting form (`ClientOnboardingForm.tsx`) don't accept referral codes yet.

### Why a magic link, not just a code

- Removes a step for the friend (no typing the code, no "where do I enter this?").
- Makes attribution reliable — the code is carried through the URL rather than depending on the friend remembering to mention it.
- Lets the client share in the format that suits them (forward the WhatsApp message, copy-paste into email, etc.) instead of Tina sending an outbound message on their behalf.
- Routing directly to the tax form (`&service=tax`) skips the service-picker step entirely.

---

## 3. New tool: `get_my_referral_code`

Client-facing. Staff don't need it (they can look it up in Dynamics directly).

| Property | Value |
|---|---|
| Name | `get_my_referral_code` |
| Scope | `client` only (add to `clientTools` in [claude.service.ts:783](../src/services/claude.service.ts#L783)) |
| Input | None — uses `crmEntity.id` from session |
| Reads | `contacts.riivo_referralcode` via a new `dynamicsService.getContactReferralCode(contactId)` method |
| Returns | `{ code: string }` or `{ code: null, reason: 'not_set' }` |
| Side effects | None. Pure read. `riivo_referralcode` is a formula field — never PATCH it. |

### Handler behaviour
- If code present → return it. Tina then delivers it **together with the explanation in §4**.
- If code missing → Tina apologises, offers to flag it with the consultant (use `request_consultant_callback`). Do **not** invent a code. (A formula field should always populate — an empty value means the Dynamics formula hasn't resolved, which is a data issue worth escalating.)

### Related existing tool
`refer_friend` ([claude.service.ts:424](../src/services/claude.service.ts#L424)) creates a lead on behalf of the client — separate path. Keep both. `refer_friend` is when the client wants Tina to do the work; `get_my_referral_code` is when the client wants to share the code themselves (e.g. forward it in a chat).

---

## 4. Client-education script (the important part)

Whenever Tina returns the code, she **must** include an explanation. Without it, clients think the code is the reward, or that they type it somewhere mysterious, or that the R500 comes off instantly.

### Template reply (during the campaign window: 1 Jun – 31 Jul 2026)

> Here's your personal TTT referral link 🎉
>
> **https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax**
>
> Here's how it works, step by step:
>
> 1. **Forward this link** to a friend or family member — WhatsApp, email, wherever suits you.
> 2. **They click the link and sign up.** Your code is already attached, so they don't need to type anything extra.
> 3. **When they pay their first TTT invoice**, we pay **R500 straight into your bank account** — the same account we have on file for you.
>
> A few things worth knowing:
> - The R500 is for **you** (the referrer), not them.
> - It's a **cash payment into your bank account** — not a discount on your next invoice, so don't go looking for it on your bill.
> - The campaign runs **until 31 July 2026**. Your friend's first invoice needs to be paid before then for the R500 to apply.
> - **No cap** — every friend who signs up and pays their first invoice earns you another R500.
>
> (If you just want the code on its own: **`{CODE}`** — they can type it in during onboarding instead.)

### Template reply (before or after the campaign window)

> Here's your personal TTT referral link:
>
> **https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax**
>
> Quick heads-up: our R500 referral campaign runs from **1 June to 31 July 2026**. {_Before: "Forward this link to friends during that window and you'll get R500 paid into your bank account for every friend who pays their first invoice."_} {_After: "The campaign has now closed — but keep the link; we'll let you know if we run it again."_}

### Copy rules (bake into the tool-response instructions)

1. **Always** lead with the **magic link**, not the raw code. The code is a fallback for when the friend can't or won't click a link.
2. **Never** offer to send the link or code on the client's behalf. The client forwards it themselves. Tina gives them the artifact; she doesn't broker the message.
3. **Always** include the 3 numbered steps during the campaign window. Never return the link on its own, even if the client seems to know the programme.
4. **Always** state explicitly *who* gets the R500 (referrer) — this is the single most common point of confusion.
5. **Always** describe the reward as a **cash payment into the referrer's bank account** — never "discount", "credit", or "off your invoice". Clients will otherwise check their next invoice and think TTT has forgotten.
6. **Always** mention the campaign end date (31 July 2026) so clients don't sit on the link.
7. **Never** promise a specific payout date — it depends on when the friend pays their first invoice.
8. **Never** say the friend also gets R500. They don't.
9. If the client follows up with *"when will I get paid?"* or *"has my friend signed up?"* → Tina cannot answer this directly today. Offer `request_consultant_callback`. (Future: a `get_my_referral_status` tool — out of scope here.)
10. The model must read the **current date** against the campaign window (1 Jun 2026 – 31 Jul 2026) to pick the right template. Pass the current date explicitly into the tool-response instructions so the model doesn't guess.

### Tone
Follow [bot-personality.md](./bot-personality.md). Warm, light, specific. The 🎉 on the first line is the only emoji — the explanation body is deliberately plain so the steps read as instructions, not decoration.

---

## 5. Edge cases

| Situation | Expected behaviour |
|---|---|
| Client asks "what's my referral code?" | Call `get_my_referral_code`, reply using the §4 template appropriate for the current date. |
| Client asks "how does the referral thing work?" without asking for the code | Reply with the §4 explanation, but **still include the code** — they almost always want it next. |
| Code field is empty in Dynamics | Unusual for a formula field. "I can't see a code on your profile yet — want me to ask your consultant to look into it?" Offer `request_consultant_callback`. Flag the data issue in logs. |
| Lead (not a contact) asks about referrals | Leads don't have codes. Reply: "Referral codes are for TTT clients once you're fully onboarded. Let's get you signed up first." |
| Staff asks for a client's referral code | Not supported by this tool. Staff can look it up in Dynamics directly. (Add a staff-side lookup only if product asks.) |
| Client asks whether their friend used the code | Out of scope for v1 — direct them to their consultant. |
| Client asks Tina to send the link to their friend | Politely decline — "The link's yours to share, so forward it from your own WhatsApp or email. That way your friend knows it came from you." Never initiate an outbound message on the client's behalf. |
| Client asks "when will I get the R500?" | "As soon as your friend pays their first TTT invoice — it goes straight into your bank account on file. I can't give you a specific date; your consultant can check progress if you'd like." |
| Client asks if the R500 will appear on their invoice | **No.** Explicitly correct the misunderstanding: "It's a cash payment into your bank account, not a discount on your invoice — so don't go looking for it on your bill." |
| Client refers a friend outside the 1 Jun – 31 Jul 2026 window | The friend can still sign up, but no R500 is payable. Be honest: "The R500 campaign only runs through July — your friend's welcome to join, but the reward won't apply." |
| Client's banking details aren't on file | Flag to consultant — R500 can't be paid without them. `request_consultant_callback`. |

---

## 6. Implementation checklist

- [ ] Coordinate with the onboarding-page owner on the three decisions locked in §2 / §2.1: `?ref=` query-param, `&service=tax` auto-select, and the `riivo_referrer` + `riivo_validreferral` lead-write flow. Bot rollout can land before the form side is live (worst case: Tina hands out working codes that simply aren't attributed yet).
- [ ] Add `getContactReferralCode(contactId)` to [dynamics.service.ts](../src/services/dynamics.service.ts) — single-field select on `riivo_referralcode`.
- [ ] Add `get_my_referral_code` tool definition in [claude.service.ts](../src/services/claude.service.ts) (near the `refer_friend` block, ~line 424).
- [ ] Add the tool to the `clientTools` array ([claude.service.ts:783](../src/services/claude.service.ts#L783)).
- [ ] Add the handler branch in the tool dispatcher (pattern: see the `refer_friend` handler at [claude.service.ts:1817](../src/services/claude.service.ts#L1817)).
- [ ] Embed the §4 copy rules in the tool-call response instructions so the model doesn't paraphrase them away. Include the campaign window dates (1 Jun 2026 – 31 Jul 2026) and the current date so the model picks the right template.
- [ ] Decide whether to remove or keep the tool after 31 Jul 2026 — post-campaign the code is still valid to share, but the reward path isn't active.
- [ ] Test with a real client contact that has a code, one without a code (data issue), and a lead. Test the reply before 1 Jun, during the campaign, and after 31 Jul.
