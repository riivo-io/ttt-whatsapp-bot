export type ReferralWindow =
    | 'pre_launch'
    | 'active'
    | 'signup_closed_rewards_pending'
    | 'fully_closed';

const CAMPAIGN_START = new Date('2026-06-01');
const SIGNUP_CUTOFF = new Date('2026-10-20');
const PAYOUT_DEADLINE = new Date('2027-02-28');

export function getReferralWindow(currentDate: Date | string): ReferralWindow {
    const today = typeof currentDate === 'string' ? new Date(currentDate) : currentDate;
    if (today < CAMPAIGN_START) return 'pre_launch';
    if (today <= SIGNUP_CUTOFF) return 'active';
    if (today <= PAYOUT_DEADLINE) return 'signup_closed_rewards_pending';
    return 'fully_closed';
}
