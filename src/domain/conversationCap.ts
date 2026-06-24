/**
 * Pure domain module owning the per-turn conversation-cap decision.
 *
 * On every inbound turn from a non-staff sender the processor must decide,
 * before invoking Claude, whether the sender has blown through their caps: the
 * session is already cap-blocked, the session/daily counts have just crossed a
 * threshold, or everything is within limits. `decideConversationCap` returns
 * that decision as a discriminated `ConversationCap` verdict; the processor
 * performs all the I/O (canned reply, marking the session blocked, escalating
 * the open Case) by switching on it.
 *
 * This module has NO side-effecting imports (no DB, no clock, no logging, no
 * env), so the decision is unit-testable in isolation. The already-blocked
 * state is a truthy check on `capBlockedAt`, not a time comparison — the
 * decision needs no clock.
 *
 * The staff-exemption guard (`type !== 'user'`) stays in the processor, exactly
 * as the entity-type guard stays outside `decideCaseRouting`.
 */

// Conversation cap thresholds. Apply to clients, leads, and unknown users —
// staff (entityType === 'user') are exempt because their tool-driven workflows
// legitimately rack up turns; that guard stays in the processor. Tune these
// once we have a few weeks of usage data in claude_usage_daily.
export const CAP_MESSAGES_PER_SESSION = 50;
export const CAP_TOKENS_PER_SESSION = 200_000;
export const CAP_MESSAGES_PER_DAY = 100;

/**
 * The cap verdict — a discriminated union so the three outcomes are explicit
 * and exhaustively handled.
 *
 * - `blocked` — the session was already marked cap-blocked on a prior turn.
 * - `hit` — a threshold has just been crossed this turn; `reason` selects the
 *   escalation text. Daily wins ties (over both daily and session → `daily`).
 * - `ok` — within all limits; the turn proceeds normally.
 */
export type ConversationCap =
    | { kind: 'blocked' }
    | { kind: 'hit'; reason: 'daily' | 'session' }
    | { kind: 'ok' };

/**
 * Decide whether an inbound turn is within the conversation caps. Pure: the
 * session counts and the daily count are pre-fetched and passed in; no DB, no
 * clock, no logging. Behaviour mirrors the (formerly inline) cap block in
 * whatsappProcessor exactly — daily wins ties.
 *
 * Only called for non-staff senders — the `type !== 'user'` exemption stays in
 * the processor.
 */
export function decideConversationCap(
    counts: { capBlockedAt: string | null; messageCount: number; tokenCount: number },
    dailyCount: number,
): ConversationCap {
    if (counts.capBlockedAt) {
        return { kind: 'blocked' };
    }

    const overDaily = dailyCount >= CAP_MESSAGES_PER_DAY;
    const overSession =
        counts.messageCount >= CAP_MESSAGES_PER_SESSION ||
        counts.tokenCount >= CAP_TOKENS_PER_SESSION;

    // Daily wins ties: when both are over, the processor escalated with the
    // daily reason text, so the verdict must report 'daily'.
    if (overDaily) {
        return { kind: 'hit', reason: 'daily' };
    }
    if (overSession) {
        return { kind: 'hit', reason: 'session' };
    }

    return { kind: 'ok' };
}
