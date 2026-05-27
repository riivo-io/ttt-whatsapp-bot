/**
 * Pure helpers for the first-contact WhatsApp template routing
 * (see docs/PRD-first-contact-templates.md).
 *
 * Lives in `utils/` rather than inline in the processor so it has no
 * side-effecting imports — keeps the unit test in
 * `test/test-first-contact-routing.ts` fast to run.
 */

// Canonical inbound from the LOE app's share-link builder:
//   `I'd like to know more about the referral (code: ${code})`
// CODE pattern is the primary trigger; KEYWORD is the fallback for paraphrased
// inbounds where the user edited the prefilled text.
export const REFERRAL_CODE_PATTERN = /\(code:\s*([a-zA-Z0-9_-]+)\)/i;
export const REFERRAL_KEYWORD_PATTERN = /\breferral\b/i;

/**
 * Text fallback used only when the Meta referral template send fails.
 * Inlines the referrer's first name and the referral code into a plain-text
 * onboarding link so the new lead still gets a usable path forward.
 */
export function buildReferralFallback(referrerFirstName: string | null, code: string | null): string {
    const name = referrerFirstName || 'A friend';
    const codeSuffix = code ? `/?ref=${encodeURIComponent(code)}` : '';
    return `Hey 👋 ${name} thought you should give TTT a go.\n\nWe handle tax, accounting and insurance for South Africans, all over WhatsApp.\n\nRegister here${code ? ` and add the code \`${code}\`` : ''}: https://www.ttt-tax.co.za/client-onboarding${codeSuffix}`;
}

/**
 * Map Dynamics `riivo_leadtype` OptionSet → the LOE app's `/api/whatsapp-signup`
 * `service` enum. There is no `advisory` value in the current OptionSet — it
 * stays in the union so the contract is forward-compatible. Default `tax`
 * (the dominant service).
 *
 * OptionSet values, per dynamics.service.ts:
 *   100000000 Tax
 *   100000001 Accounting
 *   463630001 Long Term Insurance
 *   463630002 Short Term Insurance
 */
export function serviceLabelFromLeadType(leadType: number | undefined): 'tax' | 'accounting' | 'insurance' | 'advisory' {
    switch (leadType) {
        case 100000001: return 'accounting';
        case 463630001:
        case 463630002: return 'insurance';
        case 100000000:
        default: return 'tax';
    }
}
