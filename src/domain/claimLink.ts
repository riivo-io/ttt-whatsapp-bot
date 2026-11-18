/**
 * The claim link: a WhatsApp click-to-chat link the insurance team sends a client, `wa.me/<Tina>?text=<CLAIM_LINK_TEXT>`.
 * The client taps it, WhatsApp opens Tina's chat with the message already typed, and the client presses Send.
 *
 * That message is the same as tapping "Report a claim" in Tina's insurance menu: a claim, on the insurance side, whatever
 * else the client has with TTT (tax, accounting, both). It is decided by words, not by a model, so a client who has both
 * services is never asked "insurance or tax?" and a claim is never judged "not a claim" for having no details yet.
 *
 * Only the whole, short message counts. Anything added ("... for my stolen car") is an ordinary message and goes the
 * ordinary way (claim words, the model, the client's services), which still ends in a claim for an insurance client.
 *
 * Pure. Used by src/domain/serviceRoute.ts and src/domain/claimsHost.ts.
 */

/** What the link types into the client's message box. Change it here and the matcher below still has to accept it (tested). */
export const CLAIM_LINK_TEXT = "Hi Tina, I'd like to open an insurance claim.";

/** The message as lower-case words: curly apostrophes straightened, punctuation and emoji gone. */
const plain = (text: string) => text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const GREETING = '(?:(?:hi|hello|hey|good (?:morning|afternoon|evening)) ?(?:tina)? ?(?:from ttt)? )?';
const WANT = "(?:(?:i'd like|i would like|id like|i want|i need|i'd love|i would love) to |can i |could i |please |let's |lets )?";
const VERB = '(?:open|report|lodge|log|start|make|submit|file)';
const CLAIM = "(?:an?|my|a new|new|the) insurance claim";
const TAIL = '(?: please| now| with you| with tina| with ttt)?';
const CLAIM_LINK_MESSAGE = new RegExp(`^${GREETING}${WANT}${VERB} ${CLAIM}${TAIL}$`);

/** True for the link's message, or the same words lightly edited. False for anything with more in it. */
export function isClaimLinkMessage(text: string): boolean {
    const t = plain(text);
    return t.length > 0 && t.length <= 90 && CLAIM_LINK_MESSAGE.test(t);
}

/**
 * The link for Tina's WhatsApp number (digits only, with the country code: 27764446801). The apostrophe is encoded too
 * (%27), so the link survives an email button or an SMS app that wraps the address in single quotes.
 */
export function claimLinkUrl(number: string): string {
    return `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(CLAIM_LINK_TEXT).replace(/'/g, '%27')}`;
}
