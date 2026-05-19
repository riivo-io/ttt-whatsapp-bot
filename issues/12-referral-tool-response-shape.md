# Issue 12: [Backend] Refactor `get_my_referral_code` tool response to new tier-aware JSON shape

See `docs/ISSUE-BREAKDOWN-referral-tier-update.md` Issue 2 and `docs/PRD-referral-tier-update.md` §5.2.

- `src/services/claude.service.ts` around lines 2019-2028
- New `status: "ok"` payload fields: `campaign_start`, `signup_cutoff`, `payout_deadline`, `current_date`, `current_window`, `tier_rules`, `response_instructions`
- Error case payloads unchanged (`error`, `missing_code`)
- Magic link URL unchanged — Issue 5 verifies this
- `tier_rules`:
    - `below_floor`: { min_ex_vat: null, max_ex_vat: 1499.99, reward_zar: 0 }
    - `tier_1`: { min_ex_vat: 1500, max_ex_vat: 4999.99, reward_zar: 500 }
    - `tier_2`: { min_ex_vat: 5000, max_ex_vat: null, reward_zar: 1000 }
- Depends on Issue 13 (window helper) and Issue 14 (instructions strings)
