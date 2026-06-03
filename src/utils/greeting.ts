/**
 * Pure check: does this inbound look like a bare greeting with no specific
 * ask? Used by the client first-message path to decide whether to show the
 * welcome menu (greetings only) or fall through to the AI path (substantive
 * questions). Without this gate, every fresh-session inbound — including
 * specific questions like "I'd like to know more about the referral" — hit
 * the menu instead of being answered.
 *
 * Conservative on purpose: anything not in the small whitelist falls through.
 * False negatives (a real greeting routes to AI) are harmless; false
 * positives (a real question hits the menu) are the failure we're fixing.
 */
const GREETING_TOKENS = new Set([
    // English / SA-English
    'hi', 'hello', 'hey', 'heya', 'hiya', 'hola', 'howzit', 'yo', 'ya',
    'morning', 'afternoon', 'evening', 'good',
    // isiZulu / isiXhosa / Sesotho / Afrikaans
    'sawubona', 'molo', 'molweni', 'dumela', 'goeie', 'goeiemore', 'goeienaand',
    // common addressees / fillers that show up in greetings
    'tina', 'there', 'team', 'ttt', 'everyone', 'all', 'friends', 'friend',
]);

export function looksLikeGreetingOnly(text: string): boolean {
    if (!text) return false;
    const cleaned = text
        .normalize('NFKC')
        // Strip emoji + symbols + punctuation, keep letters/digits/whitespace
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');

    // Pure emoji / punctuation reduces to empty — treat as a greeting
    if (!cleaned) return true;
    if (cleaned.length > 40) return false;

    const tokens = cleaned.split(' ');
    if (tokens.length > 5) return false;

    return tokens.every(t => GREETING_TOKENS.has(t));
}
