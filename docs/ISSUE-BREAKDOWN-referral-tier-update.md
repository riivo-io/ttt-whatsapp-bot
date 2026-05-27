# Issue Breakdown: Referral Tier Update

_Source PRD: [PRD-referral-tier-update.md](./PRD-referral-tier-update.md). Generated: 2026-05-19._

---

## Backend

### Issue 1 — [Backend] Rewrite referral programme facts block in Tina system prompt

**Context**: The PRD locks new tier rules (R500 / R1,000), new dates (signup 20 Oct 2026, payout 28 Feb 2027), the net-new-contact requirement, and the full-payment requirement. The system prompt is Tina's source of truth on every conversation; the old flat-R500 block must be replaced verbatim with the spec in §5.1.

**Acceptance Criteria**:
- [ ] Given the bot loads its system prompt, when the "Referral Programme — FACTS ONLY" block is read, then it matches the §5.1 contract verbatim (modulo formatting).
- [ ] Given a client asks about the reward form, when Tina answers, then she never describes it as "discount" or "credit" or "off invoice" and always uses "cash into bank account on file."
- [ ] Given a client asks "do we both get a reward," when Tina answers, then she states the friend (referee) receives nothing.
- [ ] Given a friend is an existing TTT client signing up via the link, when the bot describes qualification, then it states this scenario earns no reward.

**Technical Notes**: Edit [src/services/claude.service.ts](../src/services/claude.service.ts) lines 107-115. Paste the §5.1 block from the PRD. No code logic changes, prompt text only.

---

### Issue 2 — [Backend] Refactor `get_my_referral_code` tool response to new tier-aware JSON shape

**Context**: The tool currently returns a flat payload aligned with the R500 / 2-month model. PRD §5.2 mandates new fields: `campaign_start`, `signup_cutoff`, `payout_deadline`, `current_date`, `current_window`, `tier_rules`, and a window-specific `response_instructions` string. The model consumes these to compose the user-facing reply.

**Acceptance Criteria**:
- [ ] Given an existing client requests their referral code, when `get_my_referral_code` returns `status: "ok"`, then the payload contains `campaign_start`, `signup_cutoff`, `payout_deadline`, `current_date`, `current_window`, `tier_rules`, and `response_instructions` as defined in PRD §5.2.
- [ ] Given a contact has no referral code on file, when the tool runs, then it returns `status: "missing_code"` payload unchanged from current behaviour.
- [ ] Given no contact context, when the tool runs, then it returns `status: "error"` payload unchanged from current behaviour.
- [ ] Given `tier_rules` is returned, then the three bands (below_floor / tier_1 / tier_2) match §5.2 numbers exactly.

**Technical Notes**: [src/services/claude.service.ts](../src/services/claude.service.ts) around lines 2019-2028. Error case shapes preserved. Magic-link URL is handled in Issue 5 — do not modify it here.

---

### Issue 3 — [Backend] Add `current_window` calculation helper

**Context**: The four campaign-state windows (`pre_launch` / `active` / `signup_closed_rewards_pending` / `fully_closed`) drive which `response_instructions` string the bot uses. Classification logic must run server-side against `current_date` per §5.3.

**Acceptance Criteria**:
- [ ] Given today is before 2026-06-01, when the helper runs, then it returns `"pre_launch"`.
- [ ] Given today is between 2026-06-01 and 2026-10-20 inclusive, when the helper runs, then it returns `"active"`.
- [ ] Given today is between 2026-10-21 and 2027-02-28 inclusive, when the helper runs, then it returns `"signup_closed_rewards_pending"`.
- [ ] Given today is 2027-03-01 or later, when the helper runs, then it returns `"fully_closed"`.
- [ ] Window boundaries flip at midnight SAST on the day after each cutoff (active upper inclusive on 2026-10-20; signup_closed upper inclusive on 2027-02-28).

**Technical Notes**: Implementation per §5.3 pseudocode. Logic lives in [src/services/claude.service.ts](../src/services/claude.service.ts) near the tool handler. Use `new Date(YYYY-MM-DD)` semantics matching the PRD example.

---

### Issue 4 — [Backend] Add four `response_instructions` strings keyed by window

**Context**: §5.4 specifies exact model-facing instruction text for each of the four windows. Each string controls Tina's tone, copy, and what she's allowed/forbidden to say in that window.

**Acceptance Criteria**:
- [ ] Given `current_window` is `"pre_launch"`, when the tool response is assembled, then `response_instructions` equals the §5.4 pre_launch string verbatim.
- [ ] Given `current_window` is `"active"`, when the tool response is assembled, then `response_instructions` equals the §5.4 active string verbatim, including the CRITICAL clause about cash-not-discount and the NEVER-offer-to-send-on-client's-behalf clause.
- [ ] Given `current_window` is `"signup_closed_rewards_pending"`, when the tool response is assembled, then `response_instructions` equals the §5.4 signup_closed_rewards_pending string verbatim.
- [ ] Given `current_window` is `"fully_closed"`, when the tool response is assembled, then `response_instructions` equals the §5.4 fully_closed string verbatim.

**Technical Notes**: [src/services/claude.service.ts](../src/services/claude.service.ts) around lines 2025-2028 — replace the 2-string during/outside switch with a 4-string switch keyed on `current_window`. Strings copied verbatim from PRD §5.4.

---

### Issue 5 — [Backend] Verify magic link URL unchanged

**Context**: Scope is locked to the tax service line only. PRD §3.3 explicitly confirms no change to `?ref={CODE}&service=tax`. Logged as an explicit verification step so the work doesn't accidentally drift.

**Acceptance Criteria**:
- [ ] Given the tool composes a magic link, then the format is `https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax`.
- [ ] PR diff shows zero changes to the magic-link template at [claude.service.ts](../src/services/claude.service.ts) line 2019.

**Technical Notes**: Verification only.

---

## Documentation

### Issue 6 — [Docs] Rewrite docs/referral-code.md end-to-end

**Context**: The companion spec doc is currently aligned with the flat-R500 / 2-month structure. PRD §3.3 calls for full rewrite covering §1 confirmed details, §2 how-it-works, §4 client-education script (four window variants), §5 edge cases — incorporating tier rules, new dates, net-new-contact rule, full-payment rule.

**Acceptance Criteria**:
- [ ] Given a reader opens referral-code.md §1, then it states the tier amounts (R500 / R1,000), the sub-floor, and the new date boundaries.
- [ ] Given a reader needs the client-education script for the active window, when they look at §4, then they find the PRD §3.4 copy.
- [ ] Given a reader needs the script for pre_launch / signup_closed_rewards_pending / fully_closed windows, then those template variants exist.
- [ ] §5 covers edge cases consistent with §5.5 Dynamics contract (existing-client misclassification, refund/clawback out-of-scope, banking-details-missing).

**Technical Notes**: [docs/referral-code.md](./referral-code.md) — full rewrite. Match the spec doc style of existing docs in the folder.

---

### Issue 7 — [Docs] Update referral lines in docs/bot-overview.md

**Context**: bot-overview.md summarises the referral programme on lines 225 and 279. Both reference the old flat-R500 / 2-month structure and must be updated to mention tiers and new dates so the reference doc stays consistent with the code.

**Acceptance Criteria**:
- [ ] Given a reader scans bot-overview.md line 225, then the referral summary mentions tier amounts and the 1 Jun 2026 → 20 Oct 2026 signup window with 28 Feb 2027 payout deadline.
- [ ] Given a reader scans line 279, then the same update is applied consistently.

**Technical Notes**: [docs/bot-overview.md](./bot-overview.md) lines 225 and 279.

---

## Testing

### Issue 8 — [Testing] Smoke test `get_my_referral_code` in all four campaign windows

**Context**: PRD §7 implementation checklist requires confirming the tool response matches spec for each window. Smoke test with a mocked `current_date` covers the four cases without waiting on real time to pass.

**Acceptance Criteria**:
- [ ] Given `current_date = "2026-05-19"`, when `get_my_referral_code` is invoked, then `current_window = "pre_launch"` and `response_instructions` matches the pre_launch §5.4 string.
- [ ] Given `current_date = "2026-07-15"`, then `current_window = "active"` and `response_instructions` matches the active §5.4 string.
- [ ] Given `current_date = "2026-12-01"`, then `current_window = "signup_closed_rewards_pending"` and matches §5.4.
- [ ] Given `current_date = "2027-03-15"`, then `current_window = "fully_closed"` and matches §5.4.
- [ ] All four cases include the correct `tier_rules` shape and unchanged `magic_link`.
- [ ] Boundary dates (`2026-06-01`, `2026-10-20`, `2026-10-21`, `2027-02-28`, `2027-03-01`) also covered to confirm inclusive/exclusive edges.

**Technical Notes**: Add a test (or smoke script) that injects mock `current_date` into the tool handler. Follow existing test patterns in the repo; standalone script is acceptable if none exists.

---

## Coordination (out-of-repo)

### Issue 9 — [Ops] Hand Dynamics workflow contract to TTT operations

**Context**: The bot does not calculate tiers or trigger payouts. PRD §5.5 defines the contract for the Dynamics-side workflow TTT operations must build (trigger on invoice paid → check 6 pre-conditions → classify tier → notify finance). This issue tracks the hand-off, not the implementation.

**Acceptance Criteria**:
- [ ] §5.5 of the PRD shared with TTT operations.
- [ ] Owner identified on the TTT side.
- [ ] Target delivery date committed (must be before 1 Jun 2026 launch, or interim manual tier classification arranged with finance).
- [ ] Idempotency flag (`riivo_referralpayoutprocessed` or equivalent) confirmed.

**Technical Notes**: No code change in this repo. Coordination only.

---

### Issue 10 — [Product] Agree numeric targets for success metrics before launch

**Context**: PRD §2 lists five success metrics but explicitly leaves target numbers blank: "TTT to commit to specific targets before campaign launch." Without targets, the 15 Mar 2027 readout can't answer "did this work?"

**Acceptance Criteria**:
- [ ] Target number recorded for primary metric: real estate agent acquisitions by 28 Feb 2027.
- [ ] Target numbers recorded for the four secondary metrics (R1,000-tier count, total acquisitions, net revenue after payouts, magic-link-to-paid-invoice conversion).
- [ ] Targets captured in the PRD or a linked document for the post-campaign readout.

**Technical Notes**: Coordination with TTT operations and marketing. No code.

---

### Issue 11 — [Product] Resolve PRD §6 open items with TTT

**Context**: Five open items in §6 require TTT decisions before or shortly after launch: cutoff semantics, service-line broadening, payout notification path, real-estate-agent classification source, numeric targets (covered by Issue 10).

**Acceptance Criteria**:
- [ ] Cutoff semantics confirmed (status quo or stricter; if stricter, file follow-up for 4 → 3 window collapse).
- [ ] Service-line broadening decision logged (in-scope for Phase 2 or no).
- [ ] Payout-notification architecture decision logged (deferred until first month of payout volume per PRD).
- [ ] Real-estate-agent classification source documented (onboarding field, consultant tag, or both).
- [ ] Each open item has a named owner on the TTT side.

**Technical Notes**: Coordination only.

---

## Post-launch

### Issue 12 — [Ops] Post-campaign success-metrics readout on 15 Mar 2027

**Context**: PRD §2 specifies a final readout two weeks after the 28 Feb 2027 payout deadline, against the five success metrics. PRD §7 lists this as the final checklist item.

**Acceptance Criteria**:
- [ ] All five §2 metrics computed against the campaign window.
- [ ] Each metric compared to the target recorded under Issue 10.
- [ ] Findings documented in a follow-up note or PRD addendum.

**Technical Notes**: Schedule a reminder for 15 Mar 2027. Data sources: bot logs (magic links), Dynamics (signups, invoice payments, RE agent classification).
