/**
 * Service routing: which side of TTT Financial Group a client's WhatsApp message is for, tax (Tina's tax path, as
 * before) or insurance (src/domain/insuranceHost.ts), decided before Tina answers it.
 *
 * The rule (decided 13 Nov 2026, docs/PLAN-service-routing.md): no message goes to the wrong side on a guess.
 *  - Insurance only: every message is insurance.
 *  - Tax only: tax, unless the message is about insurance. Then Tina offers to have the insurance team contact them,
 *    with a "No, it's about tax" button that puts the message back on the tax path.
 *  - Both (or not known): tax, unless the message has insurance words. Then the model says insurance, tax or unsure,
 *    and unsure gets two buttons, Insurance and Tax. The answer sticks for the session (the 30-minute conversation).
 *  - A claim or roadside walkthrough in progress keeps its messages, as before.
 *
 * Pure: the processor reads the inputs, calls the model when the verdict says `needs-model`, and applies the verdict.
 */
import { mightBeClaim } from '../departments/insurance/intent';
import type { ServiceLines } from './serviceLines';

export type Side = 'tax' | 'insurance';
export type SideAnswer = 'insurance' | 'tax' | 'unsure';

/** A message waiting on the client's tap: an Insurance/Tax question (`ask`) or the insurance offer (`offer`). */
export interface PendingRoute { kind: 'ask' | 'offer'; text: string; at: string }

/** Interactive ids. Namespaced like the client menu's `menu:client:*`. */
export const ROUTE_IDS = {
    /** The ask's buttons. */
    INSURANCE: 'route:insurance',
    TAX: 'route:tax',
    /** The tax-only client's insurance offer. */
    OFFER_YES: 'route:offer:yes',
    OFFER_NO: 'route:offer:no',
    /** The row the client welcome menu gets for a client with both sides. */
    MENU_INSURANCE: 'menu:client:insurance',
    /** The insurance menu. */
    INSURANCE_CLAIM: 'menu:insurance:claim',
    INSURANCE_OTHER: 'menu:insurance:other',
} as const;

/** What a "Report a claim" tap reads as, for the claim check and the CRM. */
export const REPORT_CLAIM_TEXT = 'I want to report an insurance claim.';

export interface RouteInput {
    lines: ServiceLines;
    /** The side this session settled on, if any. */
    side: Side | null;
    pending: PendingRoute | null;
    tapId?: string;
    document: boolean;
    text: string;
    /** A bare greeting as the first message of the session (the welcome menu's trigger). */
    freshGreeting: boolean;
    /** A claim walkthrough or roadside conversation is in progress for this number. */
    walkthrough: boolean;
}

export type RouteVerdict = { why: string } & (
    | { kind: 'walkthrough' }
    /** Tina's tax path. `text`: the message to answer instead of this one (a message replayed after a tap). */
    | { kind: 'tax'; text?: string; setSide?: Side }
    /** src/domain/insuranceHost.ts. `menu`: the insurance menu. `claim`: the client asked to report a claim. */
    | { kind: 'insurance'; text?: string; menu?: true; claim?: true; setSide?: Side }
    /** The Insurance/Tax buttons, for `text`. */
    | { kind: 'ask'; text: string }
    /** The tax-only client's insurance offer, for `text`. */
    | { kind: 'offer'; text: string }
    /** The tax-only client said yes to the offer: the Insurance and Advice team contacts them about `text`. */
    | { kind: 'offer-accepted'; text: string; setSide: Side }
    /** A tap with no message waiting: the side is set, and Tina asks what they need. */
    | { kind: 'ack'; setSide: Side }
    /** The verdict needs the model's insurance/tax/unsure answer: call decideServiceRoute again with it. */
    | { kind: 'needs-model' }
);

/** Insurance words beyond the claim words: cover, policies, the people and things insurance is about. */
const MORE_INSURANCE_WORDS = new RegExp([
    'insur', 'polic', 'cover', 'premium', 'excess', 'broker', 'underwrit', 'assessor', 'panel.?beat', 'quote',
    'vehicle', 'car\\b', 'cars\\b', 'bakkie', 'household', 'contents', 'buildings', 'funeral', 'life cover', 'disability',
    'gap cover', 'roadside', 'break.?down', 'broken down', 'tyre', 'tire', 'battery',
].map((w) => `\\b${w}`).join('|'), 'i');

/** Tax words: what makes a message on the insurance side worth checking again. */
const TAX_WORDS = new RegExp([
    'tax', 'sars', 'e.?filing', 'irp5', 'it3', 'itr12', 'it12', 'return', 'refund', 'assessment', 'provisional', 'vat',
    'paye', 'uif', 'emp201', 'emp501', 'payslip', 'invoice', 'statement of account', 'consultant', 'letter of engagement',
    'loe', 'logbook', 'log book', 'travel allowance', 'deduct', 'accountant', 'accounting', 'financial statements', 'cipc',
    'annual return', 'medical aid', 'retirement annuity',
].map((w) => `\\b${w}`).join('|'), 'i');

export const hasInsuranceWords = (text: string) => mightBeClaim(text) || MORE_INSURANCE_WORDS.test(text);
export const hasTaxWords = (text: string) => TAX_WORDS.test(text);

/** The message as one lower-case word or phrase: "Insurance!" and " insurance 🛡️" are "insurance". */
const bare = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const INSURANCE_ANSWERS = new Set(['insurance', 'insure', 'my insurance', 'insurance please', 'its insurance', "it's insurance", 'about insurance']);
const TAX_ANSWERS = new Set(['tax', 'my tax', 'tax please', 'its tax', "it's tax", 'about tax', "it's about tax", 'its about tax']);
const YES_ANSWERS = new Set(['yes', 'yes please', 'yes contact me', 'yebo', 'ja', 'sure', 'ok', 'okay', 'please', 'y']);
const NO_ANSWERS = new Set(['no', 'no thanks', 'no thank you', 'nope', 'nee', 'n', 'no its about tax', "no it's about tax", 'tax']);

/**
 * The verdict for one message. `model`: the insurance/tax/unsure answer, given only on the second call after a
 * `needs-model` verdict. A model that failed or refused is passed as 'unsure'.
 */
export function decideServiceRoute(input: RouteInput, model?: SideAnswer): RouteVerdict {
    const { lines, side, pending, tapId, document } = input;
    const text = input.text;

    // 1. A tap answers itself, whatever else is true.
    switch (tapId) {
        case ROUTE_IDS.INSURANCE:
            return pending
                ? { kind: 'insurance', text: pending.text, setSide: 'insurance', why: 'tapped Insurance' }
                : { kind: 'insurance', menu: true, setSide: 'insurance', why: 'tapped Insurance (nothing waiting)' };
        case ROUTE_IDS.TAX:
            return pending
                ? { kind: 'tax', text: pending.text, setSide: 'tax', why: 'tapped Tax' }
                : { kind: 'ack', setSide: 'tax', why: 'tapped Tax (nothing waiting)' };
        case ROUTE_IDS.OFFER_YES:
            return { kind: 'offer-accepted', text: pending?.text ?? '', setSide: 'insurance', why: 'accepted the insurance offer' };
        case ROUTE_IDS.OFFER_NO:
            return pending
                ? { kind: 'tax', text: pending.text, setSide: 'tax', why: 'declined the insurance offer' }
                : { kind: 'ack', setSide: 'tax', why: 'declined the insurance offer (nothing waiting)' };
        case ROUTE_IDS.MENU_INSURANCE:
            return { kind: 'insurance', menu: true, setSide: 'insurance', why: 'tapped Insurance in the menu' };
        case ROUTE_IDS.INSURANCE_CLAIM:
            return { kind: 'insurance', claim: true, text: REPORT_CLAIM_TEXT, setSide: 'insurance', why: 'tapped Report a claim' };
        case ROUTE_IDS.INSURANCE_OTHER:
            return { kind: 'ack', setSide: 'insurance', why: 'tapped Something else in the insurance menu' };
    }

    // 2. A typed answer to the question waiting on the client reads as the tap.
    if (pending && !document) {
        const b = bare(text);
        if (pending.kind === 'ask') {
            if (INSURANCE_ANSWERS.has(b)) return decideServiceRoute({ ...input, tapId: ROUTE_IDS.INSURANCE });
            if (TAX_ANSWERS.has(b)) return decideServiceRoute({ ...input, tapId: ROUTE_IDS.TAX });
        } else {
            if (YES_ANSWERS.has(b)) return decideServiceRoute({ ...input, tapId: ROUTE_IDS.OFFER_YES });
            if (NO_ANSWERS.has(b)) return decideServiceRoute({ ...input, tapId: ROUTE_IDS.OFFER_NO });
        }
    }

    // 3. A claim or roadside conversation in progress keeps its messages. A file sent during one is insurance's.
    if (input.walkthrough) {
        return document ? { kind: 'insurance', why: 'file during a claim conversation' } : { kind: 'walkthrough', why: 'claim conversation in progress' };
    }

    const insuranceOnly = lines.insurance && !lines.tax;
    const taxOnly = lines.tax && !lines.insurance;

    // 4. "insurance" on its own: the client is saying which side (Tina's tax prompt tells them to).
    if (!document && bare(text) === 'insurance') {
        return taxOnly
            ? { kind: 'offer', text, why: 'said "insurance" (tax client)' }
            : { kind: 'insurance', menu: true, setSide: 'insurance', why: 'said "insurance"' };
    }

    // 5. Insurance only: every message.
    if (insuranceOnly) {
        return input.freshGreeting
            ? { kind: 'insurance', menu: true, why: 'insurance client, greeting' }
            : { kind: 'insurance', why: 'insurance client' };
    }

    // 6. Tax only: tax, unless the message is about insurance.
    if (taxOnly) {
        if (document) {
            return side === 'insurance'
                ? { kind: 'insurance', why: 'tax client, file after accepting the offer' }
                : { kind: 'tax', why: 'tax client, file' };
        }
        if (side === 'insurance') {
            // They said yes to the offer this session: more messages go to the same hand-over, unless they turn to tax.
            if (!hasTaxWords(text)) return { kind: 'insurance', why: 'tax client, after accepting the offer' };
            if (model === undefined) return { kind: 'needs-model', why: 'tax client, tax words after accepting the offer' };
            return model === 'tax'
                ? { kind: 'tax', setSide: 'tax', why: 'tax client, model: tax' }
                : { kind: 'insurance', why: `tax client, model: ${model}, after accepting the offer` };
        }
        if (side === 'tax') return { kind: 'tax', why: 'tax client, offer declined this session' };
        if (!hasInsuranceWords(text)) return { kind: 'tax', why: 'tax client' };
        if (model === undefined) return { kind: 'needs-model', why: 'tax client, insurance words' };
        // Unsure stays tax: the client is a tax client, and Tina's tax prompt sends insurance questions back here.
        return model === 'insurance'
            ? { kind: 'offer', text, why: 'tax client, model: insurance' }
            : { kind: 'tax', why: `tax client, model: ${model}` };
    }

    // 7. Both, or not known.
    if (input.freshGreeting) return { kind: 'tax', why: 'both sides, greeting (menu with Insurance)' };
    if (document) {
        return side === 'insurance'
            ? { kind: 'insurance', why: 'both sides, file, session is insurance' }
            : { kind: 'tax', why: `both sides, file, session is ${side ?? 'not set'}` };
    }
    const check = side === 'insurance' ? hasTaxWords(text) : hasInsuranceWords(text);
    if (!check) {
        return side === 'insurance'
            ? { kind: 'insurance', why: 'both sides, session is insurance' }
            : { kind: 'tax', why: `both sides, no insurance words, session is ${side ?? 'not set'}` };
    }
    if (model === undefined) return { kind: 'needs-model', why: `both sides, ${side === 'insurance' ? 'tax' : 'insurance'} words` };
    if (model === 'insurance') return { kind: 'insurance', setSide: 'insurance', why: 'both sides, model: insurance' };
    if (model === 'tax') return { kind: 'tax', setSide: 'tax', why: 'both sides, model: tax' };
    return { kind: 'ask', text, why: 'both sides, model: unsure' };
}
