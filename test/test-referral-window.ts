/**
 * Pre-merge smoke test for the referral campaign `current_window` helper
 * (Issue 13 / PRD §5.3).
 *
 * Pure unit. No SDK, Redis, Supabase, or Dynamics interaction.
 *
 * Run: tsx test/test-referral-window.ts
 */

import { getReferralWindow, type ReferralWindow } from '../src/services/referral-window';

let passed = 0;
let failed = 0;

function assertEqual(actual: ReferralWindow, expected: ReferralWindow, label: string): void {
    if (actual === expected) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.error(`  ✗ ${label} — expected ${expected}, got ${actual}`);
    }
}

console.log('\ngetReferralWindow — Issue 8 / PRD §7 acceptance dates');
assertEqual(getReferralWindow('2026-05-19'), 'pre_launch', '2026-05-19 → pre_launch');
assertEqual(getReferralWindow('2026-07-15'), 'active', '2026-07-15 → active');
assertEqual(getReferralWindow('2026-12-01'), 'signup_closed_rewards_pending', '2026-12-01 → signup_closed_rewards_pending');
assertEqual(getReferralWindow('2027-03-15'), 'fully_closed', '2027-03-15 → fully_closed');

console.log('\ngetReferralWindow — boundary dates');
assertEqual(getReferralWindow('2026-05-31'), 'pre_launch', '2026-05-31 (last pre_launch day) → pre_launch');
assertEqual(getReferralWindow('2026-06-01'), 'active', '2026-06-01 (campaign start, inclusive) → active');
assertEqual(getReferralWindow('2026-10-20'), 'active', '2026-10-20 (signup cutoff, inclusive) → active');
assertEqual(getReferralWindow('2026-10-21'), 'signup_closed_rewards_pending', '2026-10-21 (day after cutoff) → signup_closed_rewards_pending');
assertEqual(getReferralWindow('2027-02-28'), 'signup_closed_rewards_pending', '2027-02-28 (payout deadline, inclusive) → signup_closed_rewards_pending');
assertEqual(getReferralWindow('2027-03-01'), 'fully_closed', '2027-03-01 (day after deadline) → fully_closed');

console.log('\ngetReferralWindow — Date objects accepted');
assertEqual(getReferralWindow(new Date('2026-07-15')), 'active', 'Date(2026-07-15) → active');
assertEqual(getReferralWindow(new Date('2025-01-01')), 'pre_launch', 'Date(2025-01-01) far past → pre_launch');
assertEqual(getReferralWindow(new Date('2030-01-01')), 'fully_closed', 'Date(2030-01-01) far future → fully_closed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
