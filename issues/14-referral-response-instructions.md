# Issue 14: [Backend] Add four `response_instructions` strings keyed by window

See `docs/ISSUE-BREAKDOWN-referral-tier-update.md` Issue 4 and `docs/PRD-referral-tier-update.md` §5.4.

Replace the current 2-string (during/outside) switch with a 4-string switch keyed on `current_window`:

- `pre_launch`
- `active` — includes CRITICAL clause on cash-not-discount and NEVER-offer-to-send-on-client's-behalf clause
- `signup_closed_rewards_pending`
- `fully_closed`

Strings copied verbatim from PRD §5.4. Lives in `src/services/claude.service.ts` around lines 2025-2028. Depends on Issue 13 (window helper).
