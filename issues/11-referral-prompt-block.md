# Issue 11: [Backend] Rewrite referral programme facts block in Tina system prompt

See `docs/ISSUE-BREAKDOWN-referral-tier-update.md` Issue 1 and `docs/PRD-referral-tier-update.md` §5.1.

- Edit `src/services/claude.service.ts` lines 107-115
- Replace the flat-R500 "Referral Programme — FACTS ONLY" block with the §5.1 contract verbatim (modulo formatting)
- Tier 1 (R1,500–R4,999.99 ex VAT): R500; Tier 2 (≥R5,000 ex VAT): R1,000; below R1,500 ex VAT: nothing
- Dates: signup cutoff 20 Oct 2026, payout deadline 28 Feb 2027, campaign start 1 Jun 2026
- Friend must be NEW to TTT (any service line)
- Trigger: friend pays first TTT invoice IN FULL
- No code logic changes — prompt text only
