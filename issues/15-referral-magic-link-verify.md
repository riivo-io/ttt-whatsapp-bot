# Issue 15: [Backend] Verify magic link URL unchanged

See `docs/ISSUE-BREAKDOWN-referral-tier-update.md` Issue 5 and `docs/PRD-referral-tier-update.md` §3.3.

Verification only — no code change.

- Magic link must remain `https://ttt-tax.co.za/client-onboarding?ref={CODE}&service=tax`
- PR diff must show zero changes to the magic-link template at `src/services/claude.service.ts` line 2019
