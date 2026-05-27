# PRD: Referral Campaign Tier Update — Real Estate Agent Acquisition Push

_Status: ready for implementation. Last updated: 2026-05-18._

Companion doc: [referral-code.md](./referral-code.md) (mechanics spec, will be rewritten as part of this work), [referral-marketing.md](./referral-marketing.md) (marketing brainstorm).

---

## 1. Problem Statement

TTT has a strategic goal of acquiring **real estate agents** as tax clients. Real estate agent engagements typically invoice at around R5,000 ex VAT (provisional tax plus more complex returns). The existing referral programme pays a flat **R500** regardless of the friend's eventual invoice size, which means a referrer is rewarded the same for sending in a R1,500 individual return as they are for sending in a R5,000 real estate agent engagement.

There are three concrete problems with the current structure:

1. **No incentive alignment.** The flat payout doesn't tell referrers what kinds of friends TTT actually wants. A client with five real estate agent contacts in their network and a client with five individual-taxpayer friends earn the same R500-per-conversion. TTT's economics say one of those is dramatically more valuable.
2. **Window too short.** The original 2-month window (1 Jun to 31 Jul 2026) gives word-of-mouth almost no time to compound. Many referrals start with a casual conversation in month one and only convert to a signup in month two or three. A 2-month window guarantees most of the natural runway is cut off.
3. **Real estate agent push has no programme support yet.** TTT marketing is preparing online ads targeted at real estate agents. The referral programme should be the WhatsApp-side complement that existing clients are incentivised to actually share when those ads run.

**Who experiences this:**
- **TTT operations:** spending payout budget on referrals that don't move the strategic goal.
- **Existing TTT clients with high-value networks:** under-rewarded relative to the value they bring.
- **TTT marketing:** running ads without an aligned referral push.

---

## 2. Success Metrics

**Primary metric:**
- **Number of new real estate agent contacts acquired via valid referral** between 1 Jun 2026 and 28 Feb 2027.

"Real estate agent" is identified via the friend's onboarding form (occupation / business type field) or post-onboarding classification in Dynamics. Real estate agents are the campaign's whole reason for existing; if this number is low, the campaign hasn't delivered regardless of other numbers.

**Secondary metrics:**
- **Count of R1,000-tier payouts processed.** Direct proxy for "did the tier system attract the bigger-ticket clients we designed it for." Most R1,000 payouts should map back to real estate agent engagements; if they don't, the tier is paying out for the wrong reasons.
- **Total new tax clients acquired via valid referral** (R500-tier and R1,000-tier combined). The volume number. Tells us whether the programme is generating any acquisition at all.
- **Net revenue from referred-client first invoices, minus total payouts.** Campaign ROI. The payout amounts are a real cost (R500 to R1,000 cash per conversion); the campaign should clear that cost in first-invoice revenue alone, before counting lifetime value.
- **Conversion: magic link issued to first invoice paid.** Tells us where the funnel leaks. Existing tooling counts `get_my_referral_code` calls; Dynamics tracks signups and invoice payments. Compute as `paid first invoices / get_my_referral_code calls` over the campaign window.

**Target ranges:**
TTT to commit to specific targets before campaign launch. For the PRD, the bar is "we can measure all five numbers." Anyone reading this in October must be able to answer "did this work?" with data, not vibes.

**Measurement cadence:**
- Magic links issued: live, from bot logs.
- Signups, invoice payments, real estate agent classification: weekly pull from Dynamics during campaign.
- Final readout: 15 March 2027 (two weeks after the 28 Feb 2027 payout deadline).

---

## 3. Solution & File Plan

### 3.1 Campaign rules (locked through Socratic grilling)

| Rule | Value |
|---|---|
| Start | 1 June 2026 |
| Signup cutoff | 20 October 2026 _(PROVISIONAL — see §6 Open Items)_ |
| First-invoice-paid cutoff | 28 February 2027 |
| Sub-floor | < R1,500 ex VAT → no reward |
| Tier 1 | R1,500 to R4,999.99 ex VAT → R500 cash |
| Tier 2 | R5,000 or more ex VAT → R1,000 cash |
| Trigger event | Friend's first TTT tax invoice is paid in full. Tier is determined by that invoice's ex-VAT total. |
| Reward target | Existing TTT client (the referrer). Friend gets no discount. |
| Reward form | Cash, bank transfer, into the banking details on the referrer's contact record. Not invoice credit. |
| Cap | None on total earnings. One reward per friend (first invoice only). |
| Scope | Tax service line only. Accounting and advisory not included. |
| Qualifying friend | Net-new TTT contact. Existing TTT clients (any service line) don't trigger a reward. |
| Bot behavior | Reactive only. Tina mentions the programme when asked; never proactively. Proactive promotion lives in TTT online ads. |

### 3.2 Campaign-state windows

The bot must behave correctly in four distinct date windows. Each window changes what Tina says when asked about referrals.

| Window | Date range | What Tina says |
|---|---|---|
| **Pre-launch** | now to 31 May 2026 | "Campaign starts 1 June 2026. Here's how it'll work." Still hand out the magic link so clients can prepare. |
| **Active** | 1 June 2026 to 20 October 2026 | Full pitch. Magic link, 3-step explanation, tier breakdown, deadlines. |
| **Signup-closed, rewards pending** | 21 October 2026 to 28 February 2027 | "Signup window's closed for new referrals. If your friend signed up before 20 October and pays their first invoice by 28 February 2027, you still earn the reward." |
| **Fully closed** | 1 March 2027 onwards | "Campaign's over. Keep the link, we'll let you know if we run it again." |

### 3.3 Files to change

| File | Change | Why |
|---|---|---|
| [src/services/claude.service.ts](../src/services/claude.service.ts) lines 107-115 | Rewrite the "Referral Programme — FACTS ONLY" block in the system prompt. Replace flat R500 + 2-month window with tier rules + new dates + net-new-contact requirement + first-invoice-paid-in-full requirement. | This is the source of truth Tina reads on every conversation. |
| [src/services/claude.service.ts](../src/services/claude.service.ts) lines 2025-2028 | Replace the 2-string (during/outside) response_instructions with a 4-string switch keyed off `currentDate` against the four window boundaries. | Each window has different correct copy; bot must select the right one. |
| [src/services/claude.service.ts](../src/services/claude.service.ts) line 2019 | No change to magic link URL. Confirm `?ref={CODE}&service=tax` is unchanged. | Scope locked: tax only. |
| [docs/referral-code.md](./referral-code.md) | Full rewrite. Replace §1 confirmed details, §2 how-it-works, §4 client-education script, §5 edge cases. Add tier rules, new dates, new-to-TTT requirement, full-payment requirement, four-window template structure. | This is the human-readable spec consultants and ops reference. |
| [docs/bot-overview.md](./bot-overview.md) lines 225 and 279 | Update referral programme summary lines: tier amounts, dates, scope notes. | Reference doc; must stay consistent with code. |
| Dynamics workflow (TTT-side, not in this repo) | Owner: TTT operations. On invoice payment-status flip to "Paid" for a contact whose `riivo_referrer` is populated AND the friend is a net-new contact: read the invoice's ex-VAT total, classify into R500 / R1,000 / R0 tier, write the payout amount and "payout pending" flag against the lead or contact record, alert finance team via existing Power Automate flow. | The bot doesn't calculate tiers; Dynamics does. TTT confirmed this ownership during grilling. |

### 3.4 Bot copy: the new client-education script (active window)

This goes into the §4 of the rewritten referral-code.md and into the response_instructions for the active window. Plain English, no em dashes, casual and tight.

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
> - The reward is for **you** (the referrer), not them. They don't get a discount.
> - It's **cash into your bank account**, not a discount on your next invoice.
> - The campaign runs until **20 October 2026**. Your friend just has to sign up by then. Their first invoice has to be settled by 28 February 2027 for the reward to land.
> - No cap. Every new friend who signs up and pays their first invoice earns you another reward.
>
> (If you'd rather just give them the code: `{CODE}`. They can type it in during onboarding instead.)

Pre-launch, signup-closed-rewards-pending, and fully-closed variants are mechanical adaptations of this template. Spec doc captures them in full.

---

## 4. Out of Scope

Explicitly NOT building in this update:

- **Proactive Tina mentions.** Tina does not bring up the referral programme unless the client asks. Online ads run by TTT marketing handle the proactive layer.
- **`get_my_referral_status` tool.** The bot cannot tell a referrer "your friend signed up" or "you'll be paid on date X." Referrers asking this get directed to their consultant.
- **WhatsApp notifications to the referrer on payout.** When the friend pays their first invoice and the reward triggers, the referrer is not notified by Tina. Finance team alerts go via existing Power Automate flow. Re-evaluate after the first month of the campaign once we know payout volume.
- **Accounting and advisory service lines.** Tax-only. Existing clients who would refer accounting prospects don't earn under this programme. Broadening to other service lines is a separate piece of work flagged with TTT.
- **Magic link URL changes.** Stays `?ref={CODE}&service=tax`.
- **Referrer dashboard or portal.** No web-facing surface for clients to see their referral activity.
- **Multi-tier expansion beyond two tiers.** Two tiers plus a sub-floor only. No "premium" R2k tier for >R10k invoices, no progressive scale.
- **Self-referral / family-referral gaming policy.** No bot-side enforcement. Finance team to spot-check during payout review using existing Dynamics tools. Bot copy says "your friend has to be new to TTT" and that's the extent.
- **Migrating notifications from Power Automate to Graph.** Discussed, deferred. Existing Power Automate flows for invoice payment alerts continue unchanged.

---

## 5. AI / Engineering Contracts

### 5.1 System prompt facts block

Located in [claude.service.ts](../src/services/claude.service.ts) around lines 107-115. Must read exactly as follows (modulo formatting):

```
**Referral Programme — FACTS ONLY (never embellish, never guess)**:
- Only the REFERRER (existing TTT client) earns a reward. The friend (referee) receives nothing. Never say "both of you get a reward" or anything similar.
- Reward depends on the friend's first TTT tax invoice (ex VAT, paid in full):
    * Below R1,500 ex VAT: no reward.
    * R1,500 to R4,999.99 ex VAT: R500 cash to the referrer.
    * R5,000 or more ex VAT: R1,000 cash to the referrer.
- Reward form: CASH paid directly into the referrer's bank account on file. NOT an invoice discount, NOT a credit, NOT a line item on the next bill. If the client asks whether it'll show on their invoice, correct the misunderstanding explicitly.
- Trigger: reward is paid when the REFEREE PAYS THEIR FIRST TTT INVOICE IN FULL. Not when they sign up, not when they part-pay, not when the invoice is issued.
- The friend must be NEW to TTT. An existing TTT client (any service line) signing up for tax via the link does NOT earn the referrer a reward.
- Scope: tax services only. The link routes to the tax onboarding form.
- Campaign window: signup by 20 October 2026; first invoice paid in full by 28 February 2027.
- Campaign start: 1 June 2026. Before that date the code exists but no reward is payable.
- No cap on total rewards. Every qualifying friend earns a separate reward.
- If the client wants their personal code or sharing link, call get_my_referral_code. NEVER invent a code and NEVER quote one from memory.
- Never offer to send the link to the friend on the client's behalf. The client forwards it themselves.
```

### 5.2 `get_my_referral_code` tool response payload

The tool returns a JSON object that the model uses to compose its reply. New fields added for tier support:

```json
{
  "status": "ok",
  "code": "REF-ABC123",
  "magic_link": "https://ttt-tax.co.za/client-onboarding?ref=REF-ABC123&service=tax",
  "campaign_start": "2026-06-01",
  "signup_cutoff": "2026-10-20",
  "payout_deadline": "2027-02-28",
  "current_date": "2026-05-18",
  "current_window": "pre_launch",
  "tier_rules": {
    "below_floor": { "min_ex_vat": null, "max_ex_vat": 1499.99, "reward_zar": 0 },
    "tier_1":      { "min_ex_vat": 1500, "max_ex_vat": 4999.99, "reward_zar": 500 },
    "tier_2":      { "min_ex_vat": 5000, "max_ex_vat": null,    "reward_zar": 1000 }
  },
  "response_instructions": "<window-specific instruction string>"
}
```

Error cases unchanged from current implementation:

```json
{ "status": "error", "message": "No contact context — cannot look up referral code." }
{ "status": "missing_code", "code": null, "message": "No referral code is set on this contact record. Apologise briefly, offer to have the consultant look into it (request_consultant_callback). Do NOT invent a code." }
```

### 5.3 `current_window` calculation

```
window = (() => {
  const today = new Date(current_date);              // YYYY-MM-DD
  if (today < new Date("2026-06-01")) return "pre_launch";
  if (today <= new Date("2026-10-20")) return "active";
  if (today <= new Date("2027-02-28")) return "signup_closed_rewards_pending";
  return "fully_closed";
})();
```

Boundaries are inclusive on the upper bound for `active` and `signup_closed_rewards_pending` so the window flips at midnight SAST on the day after the cutoff.

### 5.4 `response_instructions` strings (one per window)

These are the model-facing instructions. Each is a single string injected into the tool response. Templates live in the rewritten [referral-code.md](./referral-code.md) §4.

- **`pre_launch`** — "Campaign starts 1 June 2026. Hand the client their magic_link, explain how it'll work in the 3-step format, mention the tier rules and the 20 October signup deadline. Be upfront that no reward is payable yet."
- **`active`** — "Hand the client their magic_link as the PRIMARY artifact (full URL in the message). Explain in 3 numbered steps: (1) forward the link, the friend has to be new to TTT, (2) the friend clicks and signs up with the code already attached, (3) when the friend pays their FIRST TTT tax invoice IN FULL, the reward is paid into the referrer's bank account. State the tier rules in plain English: R500 if the invoice is R1,500 to under R5,000 (ex VAT), R1,000 if it's R5,000 or more (ex VAT), nothing below R1,500. CRITICAL: describe the reward as a cash payment into the referrer's bank account, NEVER as a discount, credit, or amount off an invoice. State: signup deadline 20 October 2026; first invoice must be paid in full by 28 February 2027; no cap on total rewards; include the raw `code` as a typed fallback at the end. NEVER offer to send the link on the client's behalf."
- **`signup_closed_rewards_pending`** — "Signup window has closed. Be honest: new referrals after 20 October 2026 do NOT earn a reward, even if the friend pays their first invoice in time. If the client's friend already signed up before 20 October, the reward still applies if that friend's first invoice is paid in full by 28 February 2027. Provide the magic_link only as a record of what they shared previously, NOT as something to share now."
- **`fully_closed`** — "Campaign has fully closed. No rewards are payable for any new or existing referrals. Provide the magic_link for future reference and say 'we'll let you know if we run it again.' Be friendly but final."

### 5.5 Dynamics workflow contract (TTT-side)

The bot does not calculate tiers or trigger payouts. This work lives in a Dynamics workflow owned by TTT operations. Defining the contract here so the workflow author knows what to build:

**Trigger:** Invoice status field updates to "Paid" on an invoice associated with a contact.

**Pre-conditions to evaluate:**
1. Is this the contact's **first paid invoice** in the tax service line? If no, exit.
2. Does the contact have a populated `riivo_referrer` field linking back to a TTT client contact? If no, exit.
3. Was the contact created as **net-new** (no prior contact record at the time of signup)? If no, exit.
4. Is the contact's `riivo_validreferral` flag true? If no, exit.
5. Was the contact created on or after **1 June 2026** and on or before **20 October 2026**? If no, exit.
6. Is the invoice payment date on or before **28 February 2027**? If no, exit.

**Action when all pre-conditions pass:**
1. Read the invoice's ex-VAT total.
2. Classify the tier:
   - `< R1,500` → exit (no reward).
   - `R1,500` to `R4,999.99` → `payout_amount = R500`.
   - `>= R5,000` → `payout_amount = R1,000`.
3. Write the payout amount to a new field on the lead or referrer record (TTT to design field naming).
4. Set a "payout pending" flag.
5. Notify finance team via existing Power Automate flow (banking details, payout amount, referrer name, friend name).

**Idempotency:** the workflow must not double-process. Keep a flag on the friend's contact record (e.g. `riivo_referralpayoutprocessed`) and short-circuit if already set.

**Edge cases the workflow handles:**
- Banking details missing on referrer: flag the record for finance follow-up; do not auto-payout.
- Friend later refunded or credited: out of scope for v1; finance handles clawback manually if needed.
- Friend was an existing TTT client misclassified as new: workflow exits at pre-condition 3.

### 5.6 No changes required on the onboarding form side

The existing `?ref={CODE}&service=tax` query-param handling, `riivo_referrer` write-back, and `riivo_validreferral` flag are unchanged. The form continues to behave exactly as documented in the current [referral-code.md](./referral-code.md) §2.1. The new tier logic is downstream of the form.

---

## 6. Open Items

To resolve with TTT before, or shortly after, 1 June 2026 launch:

1. **Cutoff semantics.** Provisional rule shipped: friend signs up by 20 October 2026, first invoice paid in full by 28 February 2027. TTT may correct to "first invoice must be paid by 20 October" instead. If so: collapse the 4-window model to 3 (no signup-closed-rewards-pending window) and update bot copy. Patch cost is small if caught early.
2. **Service-line broadening.** Tax-only for this campaign. If TTT wants accounting / advisory referrals to also count, that's a separate piece of work touching the other onboarding forms. Flagged for Phase 2 conversation.
3. **Payout notification path.** Decide whether referrers get a WhatsApp notification from Tina when their reward triggers. Two architecture options: Power Automate → Tina webhook, or Graph subscriptions → Tina event handler. Defer the decision until we've seen one month of payout volume.
4. **Real-estate-agent classification source.** Confirm how Dynamics will tag a new contact as a real estate agent so the primary success metric can be measured. Onboarding form occupation field? Post-onboarding consultant tag? Both? TTT operations to confirm.
5. **Numeric targets for success metrics.** TTT to commit to specific numbers (e.g. "30 real estate agent acquisitions by Feb 2027") before campaign launch so the post-campaign readout has a yardstick.

---

## 7. Implementation checklist

- [ ] Rewrite [src/services/claude.service.ts](../src/services/claude.service.ts) system-prompt referral block (§5.1 contract).
- [ ] Refactor `get_my_referral_code` tool response into the JSON shape in §5.2.
- [ ] Add `current_window` calculation per §5.3.
- [ ] Add four `response_instructions` strings per §5.4.
- [ ] Rewrite [docs/referral-code.md](./referral-code.md) end-to-end. Replace flat R500 / 2-month structure with tier rules, four windows, new-to-TTT rule, full-payment rule.
- [ ] Update referral lines in [docs/bot-overview.md](./bot-overview.md) (lines 225, 279).
- [ ] Hand the Dynamics workflow contract (§5.5) to TTT operations. Confirm ownership and target completion date.
- [ ] Smoke test: query Tina with `get_my_referral_code` in each of the four windows (mock `current_date`). Confirm output matches the spec.
- [ ] Confirm magic link URL unchanged (§3.3).
- [ ] Pre-launch: agree numeric targets for success metrics with TTT (§6 item 5).
- [ ] 15 March 2027: post-campaign readout against the five success metrics.

---

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| TTT corrects cutoff semantics to stricter rule after launch | Medium | Medium (re-messaging cost) | Provisional copy is the more generous interpretation. If corrected to stricter, grandfather already-signed-up friends as a goodwill gesture; cost is small. |
| Dynamics workflow not ready by 1 June | Medium | High (payouts can't be calculated) | Workflow contract handed over now (§5.5). Track delivery; if slipping, manual tier classification by finance is acceptable interim. |
| R1,000 tier rarely triggers (real estate agents don't refer) | Medium | High (campaign fails its primary goal) | Marketing-side ads should specifically prompt referrers to think about real estate agent friends. Mid-campaign review in early August. |
| Referrers confused by tier system, expect R1,000 for everything | Low | Medium (trust damage) | Bot copy explicitly lists all three bands. Online ads should be equally explicit. |
| Existing clients who saw old R500-flat copy feel rug-pulled by tier introduction | Low | Low | Anyone who already qualifies under the old R500 still qualifies (R1,500 to R4,999 invoices). Tier 2 is purely additive. |
| Self-referral / family-referral gaming over 4.5 months with no cap | Medium | Low (finance review catches) | No bot-side enforcement. Finance spot-checks payouts. Acceptable cost. |

---

## 9. Definition of done

- All four files in §3.3 updated and merged.
- All four campaign windows produce correct bot copy when smoke-tested with mocked dates.
- TTT operations has the Dynamics workflow contract and a target delivery date.
- TTT has been briefed on the five §6 open items and has owners for each.
- Numeric targets for the five success metrics are recorded against this PRD.
- Campaign launch on 1 June 2026 has Tina responding correctly to a real client asking for their referral link.
