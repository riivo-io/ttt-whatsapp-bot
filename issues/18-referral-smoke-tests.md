# Issue 18: [Testing] Smoke test `get_my_referral_code` in all four campaign windows

See `docs/ISSUE-BREAKDOWN-referral-tier-update.md` Issue 8 and `docs/PRD-referral-tier-update.md` §7.

Inject mock `current_date` into the tool handler and verify each window's contract:

- `2026-05-19` → `pre_launch`
- `2026-07-15` → `active`
- `2026-12-01` → `signup_closed_rewards_pending`
- `2027-03-15` → `fully_closed`
- Boundary dates: `2026-06-01`, `2026-10-20`, `2026-10-21`, `2027-02-28`, `2027-03-01`

All cases must include correct `tier_rules` and unchanged `magic_link`.

Follow existing test patterns under `test/`. Standalone script acceptable if no test framework available.
