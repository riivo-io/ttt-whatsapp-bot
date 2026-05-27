/**
 * Pre-merge smoke test for the first-contact template routing helpers
 * (PRD-first-contact-templates.md §5 + §6 behaviour matrix).
 *
 * Pure unit. Covers the four helpers in `src/utils/firstContactRouting.ts`:
 *   - REFERRAL_CODE_PATTERN  (canonical share-link inbound)
 *   - REFERRAL_KEYWORD_PATTERN (paraphrased fallback)
 *   - serviceLabelFromLeadType (OptionSet → email-API enum)
 *   - buildReferralFallback (text fallback when the Meta template send fails)
 *
 * Run: tsx test/test-first-contact-routing.ts
 */

import {
    REFERRAL_CODE_PATTERN,
    REFERRAL_KEYWORD_PATTERN,
    serviceLabelFromLeadType,
    buildReferralFallback,
} from '../src/utils/firstContactRouting';

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

function assertEqual<T>(actual: T, expected: T, label: string): void {
    const ok = actual === expected;
    if (ok) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
    }
}

// ---------------------------------------------------------------------------
// REFERRAL_CODE_PATTERN — canonical share-link inbound + variants
// ---------------------------------------------------------------------------
console.log('\nREFERRAL_CODE_PATTERN (PRD §7.1)');

const canonical = "I'd like to know more about the referral (code: REF-ABC123)";
const m1 = canonical.match(REFERRAL_CODE_PATTERN);
assert(!!m1 && m1[1] === 'REF-ABC123', 'extracts canonical "(code: REF-ABC123)"');

const withUnderscore = '(code: my_code_42)';
const m2 = withUnderscore.match(REFERRAL_CODE_PATTERN);
assert(!!m2 && m2[1] === 'my_code_42', 'allows underscores in code');

const caseInsensitive = '(CODE: AbCdEf)';
const m3 = caseInsensitive.match(REFERRAL_CODE_PATTERN);
assert(!!m3 && m3[1] === 'AbCdEf', 'matches CODE: (case-insensitive prefix)');

const trailingExtra = 'lorem (code: XYZ-9) ipsum';
const m4 = trailingExtra.match(REFERRAL_CODE_PATTERN);
assert(!!m4 && m4[1] === 'XYZ-9', 'matches mid-sentence');

const freeText = 'Just a chat about referrals in general';
assert(freeText.match(REFERRAL_CODE_PATTERN) === null, 'does not match free-text without (code: ...)');

const bracketWithoutKeyword = '(abc: 123)';
assert(bracketWithoutKeyword.match(REFERRAL_CODE_PATTERN) === null, 'requires literal "code:" prefix');

const emptyParens = '(code: )';
assert(emptyParens.match(REFERRAL_CODE_PATTERN) === null, 'rejects empty code');

const spaceyPrefix = '(code:   ABC)';  // multiple spaces tolerated
const m5 = spaceyPrefix.match(REFERRAL_CODE_PATTERN);
assert(!!m5 && m5[1] === 'ABC', 'tolerates extra whitespace after "code:"');

// ---------------------------------------------------------------------------
// REFERRAL_KEYWORD_PATTERN — paraphrased inbound fallback
// ---------------------------------------------------------------------------
console.log('\nREFERRAL_KEYWORD_PATTERN (PRD §7.1)');

assert(REFERRAL_KEYWORD_PATTERN.test('Tell me about your referral programme'), 'matches "referral"');
assert(REFERRAL_KEYWORD_PATTERN.test('REFERRAL!'), 'case-insensitive');
assert(REFERRAL_KEYWORD_PATTERN.test('Is there a referral code for me?'), 'matches "referral code"');
// PRD §7.1 specifies `\breferral\b` (both word boundaries). That means
// plurals/inflections like "referrals", "referred", "referrer" are NOT
// matched. If real-world inbounds show up paraphrased this way, loosen
// the right-hand boundary in a follow-up — but for now we test what's spec'd.
assert(!REFERRAL_KEYWORD_PATTERN.test('Got referrals?'), 'does NOT match "referrals" (PRD §7.1: word-boundary on both sides)');
assert(!REFERRAL_KEYWORD_PATTERN.test('Was I referred here?'), 'does NOT match "referred" (PRD §7.1: word-boundary on both sides)');
assert(!REFERRAL_KEYWORD_PATTERN.test('preferential treatment'), 'does NOT match "preferential" (word boundary)');
assert(!REFERRAL_KEYWORD_PATTERN.test('Hi, I need help with my tax return'), 'does not match generic tax inbound');

// ---------------------------------------------------------------------------
// serviceLabelFromLeadType — Dynamics OptionSet → API enum (PRD §5.3)
// ---------------------------------------------------------------------------
console.log('\nserviceLabelFromLeadType (PRD §5.3)');

assertEqual(serviceLabelFromLeadType(100000000), 'tax', '100000000 (Tax) → tax');
assertEqual(serviceLabelFromLeadType(100000001), 'accounting', '100000001 (Accounting) → accounting');
assertEqual(serviceLabelFromLeadType(463630001), 'insurance', '463630001 (Long Term Insurance) → insurance');
assertEqual(serviceLabelFromLeadType(463630002), 'insurance', '463630002 (Short Term Insurance) → insurance');
assertEqual(serviceLabelFromLeadType(undefined), 'tax', 'undefined → tax (default per PRD)');
assertEqual(serviceLabelFromLeadType(999999), 'tax', 'unknown OptionSet value → tax (default)');

// ---------------------------------------------------------------------------
// buildReferralFallback — text fallback when template send fails (PRD §5.1b)
// ---------------------------------------------------------------------------
console.log('\nbuildReferralFallback (PRD §5.1b)');

const withName = buildReferralFallback('Luc', 'REF-ABC123');
assert(withName.startsWith('Hey 👋 Luc thought you should give TTT a go.'), 'leads with named greeting');
assert(withName.includes('`REF-ABC123`'), 'embeds code in backticks');
assert(withName.includes('https://www.ttt-tax.co.za/client-onboarding/?ref=REF-ABC123'), 'appends ?ref= query suffix');

const noName = buildReferralFallback(null, 'REF-ABC123');
assert(noName.startsWith('Hey 👋 A friend thought you should give TTT a go.'), 'falls back to "A friend" when name null');

const noCode = buildReferralFallback('Luc', null);
assert(noCode.startsWith('Hey 👋 Luc thought you should give TTT a go.'), 'still personalises without code');
assert(!noCode.includes('`'), 'omits code-in-backticks line when no code');
assert(!noCode.includes('?ref='), 'omits ?ref= query string when no code');
assert(noCode.includes('https://www.ttt-tax.co.za/client-onboarding'), 'still includes signup URL when no code');

const bothNull = buildReferralFallback(null, null);
assert(bothNull.startsWith('Hey 👋 A friend thought you should give TTT a go.'), 'fully anonymous degraded mode');

// URL-encoding for codes with reserved characters (defensive — codes are
// alphanumeric + _ - in practice, but the encode is a belt-and-braces guarantee).
const reservedCode = buildReferralFallback('Luc', 'A B/C');
assert(reservedCode.includes('?ref=A%20B%2FC'), 'encodes reserved chars in ?ref= suffix');

// Empty-string name should fall through to "A friend" (caller does the trim,
// but defensive check inside the helper still kicks in for empty input).
const emptyName = buildReferralFallback('', 'REF-ABC123');
assert(emptyName.startsWith('Hey 👋 A friend thought you should give TTT a go.'), 'empty name string → "A friend"');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
