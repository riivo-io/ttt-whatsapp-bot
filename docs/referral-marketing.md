# Referral Programme — Marketing Opportunities

_Status: brainstorm doc for TTT marketing. Last updated: 2026-05-18._

Companion to [referral-code.md](./referral-code.md), which covers the mechanics. This doc is about how to actually drive referral volume now that the programme has tiers and a longer window.

---

## 1. The campaign at a glance

For anyone reading cold:

- **Window:** 1 June 2026 to 20 October 2026 (cutoff semantics TBD, see [referral-code.md](./referral-code.md))
- **Tiers (referee's first invoice, ex VAT):**
  - R1,500 to R4,999.99 → R500 cash to referrer
  - R5,000 or more → R1,000 cash to referrer
  - Below R1,500 → no payout
- **Scope:** tax services only (accounting and advisory not yet wired up)
- **Mechanism:** existing TTT clients share a magic link from Tina. Friend signs up via the link, pays first tax invoice, referrer gets paid into the bank account TTT has on file.
- **No cap** on how many friends a single client can refer.

The thing to remember: the referrer does the work of sharing. The reward is for them, not the friend. The friend gets no discount.

---

## 2. Make Tina earn her keep

Tina is already the delivery mechanism for the magic link. She's also the most underused marketing channel TTT has. Concrete moves:

### 2a. Proactive moments (with care)
After a clearly positive interaction, Tina can mention the programme once. Good moments:

- **Refund just landed.** Client is happy. "Glad that came through. If you've got friends still wrestling with their returns, you've got a referral link that earns you R500 to R1,000 per friend until October. Want me to send it?"
- **Case resolved.** Same pattern.
- **End of a complex consultation.** "While I've got you, here's something worth knowing..."

The rule from the writing-style memory still applies: never broker the outbound. Tina hands over the link; the client forwards it themselves.

Anti-patterns:
- Mentioning referrals in the same message as bad news (rejected return, outstanding balance).
- Mentioning it more than once per conversation.
- Mentioning it to leads who aren't clients yet (they don't have a code).

### 2b. Suggested-question chips
The interactive first-message menus (see [interactive-first-message-menus.md](./interactive-first-message-menus.md)) could carry a "Get my referral link" option during the campaign window. Removes the discoverability problem.

### 2c. Campaign-end urgency push
Two to three weeks before 20 October, Tina could proactively message clients with the tier breakdown and a "campaign ends soon" framing. This is the highest-conversion moment for most referral programmes. Needs an opt-out path.

---

## 3. Channels beyond Tina

The bot only reaches clients who message in. Most clients won't. So:

### 3a. Invoice footer
Every TTT tax invoice should carry one line: "Refer a friend, earn R500 to R1,000 until 20 October 2026. Ask your consultant or message Tina." Invoices are read. Newsletters aren't.

### 3b. Consultant email signatures
TTT consultants email clients constantly. A signature line for the campaign window only:

> "Until 20 October: refer a friend, earn R500 to R1,000 per referral. Message Tina on WhatsApp for your link."

Costs nothing. Hits every client touchpoint.

### 3c. Outbound template message
Meta-approved WhatsApp template message (see [meta-templates.md](./meta-templates.md)) sent once at campaign launch and once again ~2 weeks before close. Two touches over 4.5 months is restrained enough to not feel spammy.

### 3d. Social proof
A monthly "we paid out R[X] this month to clients who referred friends" post on LinkedIn. Doesn't require naming names. Makes the programme feel real and active rather than theoretical.

---

## 4. Lean into the tier structure

The tiers aren't just a cost-control mechanism. They're a marketing message. "Refer a friend, get R500" is fine. "Refer a friend, get up to R1,000" is better, because the upside is what gets shared.

### 4a. Lead with the ceiling
In all outbound copy, the headline should be "R500 to R1,000" or "up to R1,000." Not "R500." The R1,000 ceiling does the work even if most payouts will be R500.

### 4b. Target the R1,000 tier explicitly
Some clients have professional networks where R5,000+ engagements are normal. Provisional taxpayers, directors, high-net-worth individuals. A consultant-led nudge to *those clients specifically* will convert better than mass outreach. The consultant knows who can plausibly refer a R5,000+ friend.

### 4c. Be honest about the tiers
Don't bury the R1,500 floor in fine print. Clients who refer a friend who gets a R900 invoice and earn nothing will feel cheated, even though the rules are clear. Put the floor in every piece of copy. Tina already does this.

---

## 5. Timing windows worth exploiting

The campaign runs through two distinct seasons:

- **June to August:** post-tax-season cleanup. Clients who just had a stressful return are primed to recommend a calm, competent firm.
- **September to October:** provisional tax season. Existing clients are talking to their friends about tax anyway. Topical.

A coordinated launch push in early June and a closing push in early October will outperform anything in the quiet middle.

### 5a. Tie to news moments
Whenever SARS announces something (filing season opens, e-filing changes, audit shifts), TTT can piggyback with "if your friends are confused, refer them and earn R500 to R1,000." News moments are when people share tax-related content anyway.

---

## 6. Content marketing that pulls double duty

Content that helps clients ALSO seeds referrals:

- **"5 signs your friend needs a real tax person":** light, shareable. Ends with the referral CTA.
- **Referrer testimonial post:** "Sarah referred 4 friends in 2025 and earned R2,000. Here's why she did it." (With permission, obviously.)
- **Tier-explainer video:** 60 seconds, plain English. Tina can link it when clients ask how the tiers work.

---

## 7. Things to measure

If we're going to invest in marketing the programme, we should know what's working:

- Magic links shared (count of `get_my_referral_code` tool calls)
- Leads created with a valid `riivo_referrer` populated
- Conversion: leads → first invoice paid
- Payouts processed, by tier
- Cost per acquired client (payout amount divided by acquired-client count, by channel if attributable)

The bot side can count tool calls and link generations cleanly. Lead conversion and tier breakdown live in Dynamics. The hard part is attributing conversions back to the marketing channel that drove them. Worth a separate conversation.

---

## 8. Risks and anti-patterns

- **Tina spam.** If referrals get mentioned in every conversation, clients tune them out. Cap at one mention per conversation and only after positive context.
- **Mis-set expectations.** The single biggest known failure mode (see [referral-code.md](./referral-code.md) §4) is clients thinking the reward is a discount on their next invoice. Every piece of marketing copy must say "cash into your bank account," never "credit" or "discount."
- **Looking like MLM.** "No cap on referrals" is a good message but the framing matters. "Earn R500 to R1,000 per friend you refer to TTT" reads professionally. "Build your downline" reads like a pyramid scheme. Pick wording carefully.
- **POPIA.** The referrer is sharing TTT's link, not TTT's contact data. That's fine. But if TTT later cold-calls leads who didn't complete signup, it crosses a line. Stay reactive on the friend side.
- **Tier-2 frustration.** Most tax invoices fall in the R500 tier. If outbound copy leads with "R1,000" too hard, clients who get R500 may feel under-rewarded. Always say "R500 to R1,000."

---

## 9. Open questions for TTT

These shape what marketing copy can promise:

1. Is the 20 October cutoff a **signup** date or a **first-invoice-paid** date? (Affects every piece of outbound copy.)
2. Is there a payment-side deadline if signup is the gate? (Currently proposed: 28 February 2027.)
3. Will the programme broaden to **accounting and advisory** during this campaign window? The R1,000 tier is much more meaningful for those services.
4. Is there a marketing budget for paid amplification (invoice footers, email signature rollout, outbound template), or is this all organic?
5. Who owns the campaign post-launch — consultants for one-on-one nudges, marketing for broadcast?

---

## 10. Minimum viable marketing plan

If TTT only does three things:

1. **Add a line to every tax invoice** for the campaign window. Cheapest, highest reach.
2. **Consultant email signature update** for the campaign window. Free, hits every client touchpoint.
3. **One Tina-led WhatsApp template push** at launch (early June) and one at close (early October). Two messages over 4.5 months.

Everything else is upside.
