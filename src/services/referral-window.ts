export type ReferralWindow =
    | 'pre_launch'
    | 'active'
    | 'signup_closed_rewards_pending'
    | 'fully_closed';

export const CAMPAIGN_START_DATE = '2026-06-01';
export const SIGNUP_CUTOFF_DATE = '2026-09-30';
export const PAYOUT_DEADLINE_DATE = '2026-12-31';

const CAMPAIGN_START = new Date(CAMPAIGN_START_DATE);
const SIGNUP_CUTOFF = new Date(SIGNUP_CUTOFF_DATE);
const PAYOUT_DEADLINE = new Date(PAYOUT_DEADLINE_DATE);

export function getReferralWindow(currentDate: Date | string): ReferralWindow {
    const today = typeof currentDate === 'string' ? new Date(currentDate) : currentDate;
    if (today < CAMPAIGN_START) return 'pre_launch';
    if (today <= SIGNUP_CUTOFF) return 'active';
    if (today <= PAYOUT_DEADLINE) return 'signup_closed_rewards_pending';
    return 'fully_closed';
}

export type TierRules = {
    below_floor: { min_incl_vat: null; max_incl_vat: number; reward_zar: number };
    tier_1: { min_incl_vat: number; max_incl_vat: number; reward_zar: number };
    tier_2: { min_incl_vat: number; max_incl_vat: null; reward_zar: number };
};

export const TIER_RULES: TierRules = {
    below_floor: { min_incl_vat: null, max_incl_vat: 1724.99, reward_zar: 0 },
    tier_1: { min_incl_vat: 1725, max_incl_vat: 4999.99, reward_zar: 500 },
    tier_2: { min_incl_vat: 5000, max_incl_vat: null, reward_zar: 1000 },
};

export const RESPONSE_INSTRUCTIONS: Record<ReferralWindow, string> = {
    pre_launch:
        "Campaign starts 1 June 2026. Hand the client their magic_link, explain how it'll work in the 3-step format, mention the tier rules and the 30 September signup deadline. Be upfront that no reward is payable yet.",
    active:
        "Hand the client their magic_link as the PRIMARY artifact (full URL in the message). Explain in 3 numbered steps: (1) forward the link, the friend has to be new to TTT, (2) the friend clicks and signs up with the code already attached, (3) when the friend pays their FIRST TTT tax invoice IN FULL, the reward is paid into the referrer's bank account. State the tier rules in plain English (all amounts incl VAT): R500 if the invoice is R1,725 to under R5,000, R1,000 if it's R5,000 or more, nothing below R1,725. CRITICAL: describe the reward as a cash payment into the referrer's bank account, NEVER as a discount, credit, or amount off an invoice. State: signup deadline 30 September 2026; first invoice must be paid in full by 31 December 2026; no cap on total rewards; include the raw `code` as a typed fallback at the end. NEVER offer to send the link on the client's behalf.",
    signup_closed_rewards_pending:
        "Signup window has closed. Be honest: new referrals after 30 September 2026 do NOT earn a reward, even if the friend pays their first invoice in time. If the client's friend already signed up before 30 September, the reward still applies if that friend's first invoice is paid in full by 31 December 2026. Provide the magic_link only as a record of what they shared previously, NOT as something to share now.",
    fully_closed:
        "Campaign has fully closed. No rewards are payable for any new or existing referrals. Provide the magic_link for future reference and say 'we'll let you know if we run it again.' Be friendly but final.",
};

export type ReferralCodePayload = {
    status: 'ok';
    code: string;
    magic_link: string;
    campaign_start: string;
    signup_cutoff: string;
    payout_deadline: string;
    current_date: string;
    current_window: ReferralWindow;
    tier_rules: TierRules;
    response_instructions: string;
};

function toISODate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

export function buildReferralCodePayload(args: {
    code: string;
    currentDate: Date | string;
}): ReferralCodePayload {
    const dateStr = typeof args.currentDate === 'string'
        ? args.currentDate
        : toISODate(args.currentDate);
    const window = getReferralWindow(args.currentDate);
    return {
        status: 'ok',
        code: args.code,
        magic_link: `https://ttt-tax.co.za/client-onboarding?ref=${encodeURIComponent(args.code)}&service=tax`,
        campaign_start: CAMPAIGN_START_DATE,
        signup_cutoff: SIGNUP_CUTOFF_DATE,
        payout_deadline: PAYOUT_DEADLINE_DATE,
        current_date: dateStr,
        current_window: window,
        tier_rules: TIER_RULES,
        response_instructions: RESPONSE_INSTRUCTIONS[window],
    };
}
