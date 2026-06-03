/**
 * Detect inbound messages that look like automatic out-of-office replies
 * from another business's email/messaging system. Live transcripts show
 * these arriving when a client's email auto-forward bounces back through
 * the WhatsApp number — the bot otherwise treats the OOO body as a real
 * intent and either escalates or produces a confused reply.
 *
 * High-precision phrase list — each pattern is rarely seen in genuine
 * client speech. A short "thanks" or "out for the day" alone won't match.
 *
 * The caller is expected to send a single clarification ("looks like an
 * auto-reply, ignore if not intended") and silently drop further
 * matching inbounds from the same phone within a cooldown window.
 */
const AUTO_REPLY_PATTERNS: RegExp[] = [
    /\bout of (the )?office\b/i,
    /\bauto(matic)?[\s-]?(reply|response)\b/i,
    /\bautomated (reply|response|message|email)\b/i,
    /\bcurrently (away|on leave|on vacation|on holiday|unavailable)\b/i,
    /\bthis is an automated\b/i,
    /\bdo not reply to this (email|message)\b/i,
    /\bi (will|'ll) (respond|reply|be back|return) (to|on|when|upon|by)\b/i,
    /\bfor urgent (matters|enquiries|inquiries|queries|issues)\b/i,
    /\byour (email|message) has been received\b/i,
    /\bi am (currently )?(away|out|on leave|on annual leave)\b/i,
    /\baway from my desk\b/i,
    /\bback in the office on\b/i,
];

export function looksLikeAutoReply(text: string): boolean {
    if (!text) return false;
    // Auto-replies are typically long-form; short messages that happen to
    // include "out of office" colloquially shouldn't false-positive.
    if (text.length < 60) return false;
    return AUTO_REPLY_PATTERNS.some(re => re.test(text));
}

const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const recentClarifications: Map<string, number> = new Map();

/**
 * Returns true the first time it's called for a given phone within the
 * 24-hour window — caller should send the clarification. Subsequent calls
 * within the window return false (silent drop). Best-effort, in-memory.
 */
export function shouldSendAutoReplyClarification(phone: string): boolean {
    const now = Date.now();
    const expiry = recentClarifications.get(phone);
    if (expiry && expiry > now) return false;
    recentClarifications.set(phone, now + CLARIFICATION_TTL_MS);
    if (recentClarifications.size > 1024) {
        for (const [k, v] of recentClarifications) {
            if (v <= now) recentClarifications.delete(k);
        }
    }
    return true;
}

export const AUTO_REPLY_CLARIFICATION =
    "Looks like that came through as an auto-reply from another business. Ignore this if it wasn't meant for me — otherwise let me know what you need and I'll help.";
