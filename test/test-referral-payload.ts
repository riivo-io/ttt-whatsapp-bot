/**
 * Pre-merge smoke test for the `get_my_referral_code` tool payload
 * (Issues 12, 14, 18 / PRD §5.2 + §5.4 + §7).
 *
 * Pure unit. Drives the payload builder with mocked `currentDate` values
 * for each of the four campaign-state windows and the five boundary
 * dates listed in the issue 18 acceptance criteria. Asserts:
 * - current_window classification
 * - response_instructions string equality + content invariants
 * - tier_rules shape (PRD §5.2)
 * - magic_link unchanged (`?ref={CODE}&service=tax`) — Issue 15
 * - top-level dates echoed back
 *
 * Run: tsx test/test-referral-payload.ts
 */

import {
    buildReferralCodePayload,
    RESPONSE_INSTRUCTIONS,
    TIER_RULES,
    CAMPAIGN_START_DATE,
    SIGNUP_CUTOFF_DATE,
    PAYOUT_DEADLINE_DATE,
} from '../src/services/referral-window';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.error(`  ✗ ${label}`);
    }
}

const CODE = 'REF-ABC123';

// ---------------------------------------------------------------------------
// Issue 18 acceptance: four windows
// ---------------------------------------------------------------------------
console.log('\nbuildReferralCodePayload — four windows (Issue 18 acceptance)');

const preLaunch = buildReferralCodePayload({ code: CODE, currentDate: '2026-05-19' });
assert(preLaunch.status === 'ok', '2026-05-19 status = ok');
assert(preLaunch.current_window === 'pre_launch', '2026-05-19 current_window = pre_launch');
assert(preLaunch.response_instructions === RESPONSE_INSTRUCTIONS.pre_launch, '2026-05-19 response_instructions = §5.4 pre_launch');

const active = buildReferralCodePayload({ code: CODE, currentDate: '2026-07-15' });
assert(active.current_window === 'active', '2026-07-15 current_window = active');
assert(active.response_instructions === RESPONSE_INSTRUCTIONS.active, '2026-07-15 response_instructions = §5.4 active');

const signupClosed = buildReferralCodePayload({ code: CODE, currentDate: '2026-12-01' });
assert(signupClosed.current_window === 'signup_closed_rewards_pending', '2026-12-01 current_window = signup_closed_rewards_pending');
assert(signupClosed.response_instructions === RESPONSE_INSTRUCTIONS.signup_closed_rewards_pending, '2026-12-01 response_instructions = §5.4 signup_closed');

const fullyClosed = buildReferralCodePayload({ code: CODE, currentDate: '2027-03-15' });
assert(fullyClosed.current_window === 'fully_closed', '2027-03-15 current_window = fully_closed');
assert(fullyClosed.response_instructions === RESPONSE_INSTRUCTIONS.fully_closed, '2027-03-15 response_instructions = §5.4 fully_closed');

// ---------------------------------------------------------------------------
// Issue 18 acceptance: boundary dates (5)
// ---------------------------------------------------------------------------
console.log('\nbuildReferralCodePayload — boundary dates');
assert(buildReferralCodePayload({ code: CODE, currentDate: '2026-06-01' }).current_window === 'active', '2026-06-01 (campaign start) → active');
assert(buildReferralCodePayload({ code: CODE, currentDate: '2026-09-30' }).current_window === 'active', '2026-09-30 (signup cutoff) → active');
assert(buildReferralCodePayload({ code: CODE, currentDate: '2026-10-01' }).current_window === 'signup_closed_rewards_pending', '2026-10-01 → signup_closed_rewards_pending');
assert(buildReferralCodePayload({ code: CODE, currentDate: '2026-12-31' }).current_window === 'signup_closed_rewards_pending', '2026-12-31 (payout deadline) → signup_closed_rewards_pending');
assert(buildReferralCodePayload({ code: CODE, currentDate: '2027-01-01' }).current_window === 'fully_closed', '2027-01-01 → fully_closed');

// ---------------------------------------------------------------------------
// Issue 12 acceptance: tier_rules shape (PRD §5.2)
// ---------------------------------------------------------------------------
console.log('\ntier_rules shape (Issue 12 / PRD §5.2)');
assert(active.tier_rules.below_floor.min_incl_vat === null, 'below_floor.min_incl_vat = null');
assert(active.tier_rules.below_floor.max_incl_vat === 1724.99, 'below_floor.max_incl_vat = 1724.99');
assert(active.tier_rules.below_floor.reward_zar === 0, 'below_floor.reward_zar = 0');
assert(active.tier_rules.tier_1.min_incl_vat === 1725, 'tier_1.min_incl_vat = 1725');
assert(active.tier_rules.tier_1.max_incl_vat === 4999.99, 'tier_1.max_incl_vat = 4999.99');
assert(active.tier_rules.tier_1.reward_zar === 500, 'tier_1.reward_zar = 500');
assert(active.tier_rules.tier_2.min_incl_vat === 5000, 'tier_2.min_incl_vat = 5000');
assert(active.tier_rules.tier_2.max_incl_vat === null, 'tier_2.max_incl_vat = null');
assert(active.tier_rules.tier_2.reward_zar === 1000, 'tier_2.reward_zar = 1000');
assert(active.tier_rules === TIER_RULES, 'tier_rules is the shared constant (no per-call allocation)');

// ---------------------------------------------------------------------------
// Issue 15: magic_link unchanged (`?ref={CODE}&service=tax`)
// ---------------------------------------------------------------------------
console.log('\nmagic_link unchanged (Issue 15 / PRD §3.3)');
assert(
    active.magic_link === `https://ttt-tax.co.za/client-onboarding?ref=${CODE}&service=tax`,
    'magic_link uses ?ref={CODE}&service=tax format',
);
// URL-encoded variant when the code has reserved chars
const oddCode = buildReferralCodePayload({ code: 'A B/C', currentDate: '2026-07-15' });
assert(
    oddCode.magic_link === 'https://ttt-tax.co.za/client-onboarding?ref=A%20B%2FC&service=tax',
    'magic_link encodes reserved chars in code',
);

// ---------------------------------------------------------------------------
// Top-level campaign dates echoed back
// ---------------------------------------------------------------------------
console.log('\ntop-level dates (PRD §5.2)');
assert(active.campaign_start === CAMPAIGN_START_DATE, 'campaign_start = 2026-06-01');
assert(active.signup_cutoff === SIGNUP_CUTOFF_DATE, 'signup_cutoff = 2026-09-30');
assert(active.payout_deadline === PAYOUT_DEADLINE_DATE, 'payout_deadline = 2026-12-31');
assert(active.current_date === '2026-07-15', 'current_date echoed back as YYYY-MM-DD');
assert(active.code === CODE, 'code echoed back');

// ---------------------------------------------------------------------------
// Content invariants on response_instructions (§5.4 specifics)
// ---------------------------------------------------------------------------
console.log('\nresponse_instructions content invariants (§5.4)');
assert(RESPONSE_INSTRUCTIONS.active.includes('CRITICAL'), 'active instructions contain CRITICAL clause');
assert(/NEVER offer to send the link/i.test(RESPONSE_INSTRUCTIONS.active), 'active instructions forbid sending on client\'s behalf');
assert(RESPONSE_INSTRUCTIONS.active.includes('cash payment'), 'active instructions say cash payment');
assert(RESPONSE_INSTRUCTIONS.active.includes('31 December 2026'), 'active instructions cite payout deadline');
assert(RESPONSE_INSTRUCTIONS.active.includes('30 September 2026'), 'active instructions cite signup deadline');
assert(RESPONSE_INSTRUCTIONS.pre_launch.includes('1 June 2026'), 'pre_launch instructions cite start date');
assert(RESPONSE_INSTRUCTIONS.signup_closed_rewards_pending.includes('30 September 2026'), 'signup_closed instructions cite cutoff');
assert(RESPONSE_INSTRUCTIONS.fully_closed.includes('we\'ll let you know if we run it again'), 'fully_closed instructions include sign-off line');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
