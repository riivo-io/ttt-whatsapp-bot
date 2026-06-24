/**
 * Pure domain module owning the per-turn case-routing decision.
 *
 * When a client or lead messages the bot, the system must decide — every turn,
 * before the bot answers — how the inbound message relates to the session's
 * open Case: fresh question, continuation of an open thread, a topic shift that
 * closes the old Case and opens a new one, a clarification that rescues an
 * escalated Case, or nothing to do. `decideCaseRouting` returns that decision
 * as a discriminated `CaseRouting` verdict; the processor performs all the I/O
 * by switching on it.
 *
 * This module has NO side-effecting imports (no DB, no clock, no logging, no
 * env), so the decision and its predicates are unit-testable in isolation. The
 * current time is injected as `now` (a millisecond epoch) so the
 * continuation-window branch is deterministic under test.
 *
 * The three routing predicates (`qualifyMessage`, `detectWrapUp`,
 * `detectFeedback`) and the feedback button ids live here too; case.service
 * re-exports them so existing callers are unaffected.
 */

// ---------------------------------------------------------------------------
// Predicate constants + helpers (moved from case.service — already pure)
// ---------------------------------------------------------------------------

// Legacy bare ids for the case-resolution feedback buttons. Still recognised
// for in-flight prompts sent before the per-case ids deployed; new prompts use
// the prefixed `case_fb_*:<caseId>` form below. Meta delivers a button tap as
// its title text, but the ids are matched directly where available.
export const CASE_FEEDBACK_BUTTON_YES = 'case_feedback_yes';
export const CASE_FEEDBACK_BUTTON_NO = 'case_feedback_no';

// Per-case feedback button id prefixes. The feedback prompt worker builds ids
// as `${prefix}:${caseId}` so a tap is self-identifying — it resolves to its
// exact case even after pending_case_id was cleared (auto-close) or the session
// rolled over (30-min timeout), instead of falling through to a fresh case.
export const CASE_FEEDBACK_BUTTON_YES_PREFIX = 'case_fb_yes';
export const CASE_FEEDBACK_BUTTON_NO_PREFIX = 'case_fb_no';

/**
 * Parse a feedback reply-button id into its verdict and the case it belongs to.
 * The single place that knows the id shape.
 *
 * - Per-case id (`case_fb_yes:<caseId>` / `case_fb_no:<caseId>`) → verdict +
 *   the embedded caseId.
 * - Bare legacy constant (`case_feedback_yes` / `case_feedback_no`) → verdict
 *   with `caseId: null`, so a tap on a prompt sent before this deployed still
 *   parses and the caller falls back to the surviving pending pointer.
 * - Anything else (including undefined / a non-feedback button) → null.
 */
export function parseFeedbackButton(
    interactiveId: string | null | undefined,
): { verdict: 'confirmed' | 'rejected'; caseId: string | null } | null {
    if (!interactiveId) return null;

    if (interactiveId === CASE_FEEDBACK_BUTTON_YES) return { verdict: 'confirmed', caseId: null };
    if (interactiveId === CASE_FEEDBACK_BUTTON_NO) return { verdict: 'rejected', caseId: null };

    const sep = interactiveId.indexOf(':');
    if (sep === -1) return null;
    const prefix = interactiveId.slice(0, sep);
    const caseId = interactiveId.slice(sep + 1);
    if (!caseId) return null;
    if (prefix === CASE_FEEDBACK_BUTTON_YES_PREFIX) return { verdict: 'confirmed', caseId };
    if (prefix === CASE_FEEDBACK_BUTTON_NO_PREFIX) return { verdict: 'rejected', caseId };
    return null;
}

const NOISE_WORDS = new Set([
    'thanks', 'thank', 'thx', 'ty', 'ok', 'okay', 'k', 'kk',
    'noted', 'cool', 'great', 'test', 'hi', 'hello', 'hey',
    'yes', 'no', 'yep', 'nope', 'sure', 'fine',
]);

const EMOJI_ONLY_RE = /^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

/**
 * Decide whether an inbound client message is a genuine query worth tracking as
 * a case. Rule-based — no model call — so it's free.
 */
export function qualifyMessage(text: string): boolean {
    const trimmed = (text || '').trim();
    if (trimmed.length < 3) return false;
    if (EMOJI_ONLY_RE.test(trimmed)) return false;

    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 1 && NOISE_WORDS.has(words[0].replace(/[^a-z]/g, ''))) return false;

    return true;
}

/**
 * Detect a natural wrap-up acknowledgement that should close the existing case,
 * not in the explicit pending-feedback window (the client kept chatting past
 * the feedback prompt or never received one). Conservative on purpose: skips
 * long messages, anything containing "?", or qualifiers like "but" that suggest
 * the client is actually asking for more.
 */
export function detectWrapUp(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    if (!t || t.length > 60) return false;
    if (t.includes('?')) return false;
    if (/\b(but|however|actually|also|wait|another|one more)\b/.test(t)) return false;
    // Bare gratitude ("thanks", "thank you", "thx", "ty") is intentionally
    // excluded — clients thank intermediate replies, and treating that as
    // a wrap-up close caused premature resolutions. Stronger closing
    // signals ("perfect", "sorted", "all good") remain.
    return /\b(perfect|sorted|got it|all good|all sorted|appreciate it|cheers|awesome|amazing|brilliant|lekker)\b/.test(t);
}

/**
 * Detect a feedback reply from an incoming message. The Meta interactive
 * button reply arrives as its title (e.g. "Yes, thanks") via extractIncoming,
 * so we match on both button ids (if the text matches one) and a tight
 * yes/no heuristic.
 *
 * "thanks" is deliberately NOT a confirmed trigger here — clients commonly
 * thank intermediate replies, and equating gratitude with case-resolution
 * caused premature closes (e.g. Francis Kabelo: "Yes" to "want me to list
 * docs?" was read as feedback-confirmed instead of "yes please list"). The
 * caller (whatsappProcessor) additionally gates this on the previous bot
 * turn being the explicit resolution prompt.
 */
export function detectFeedback(text: string): 'confirmed' | 'rejected' | null {
    const t = (text || '').trim().toLowerCase();
    if (!t) return null;

    if (t === CASE_FEEDBACK_BUTTON_YES || t.includes('yes, thanks') || /^(y|yes|yep|yeah|yup|sure|ok|okay|all good|sorted|resolved|solved)\b/.test(t)) {
        return 'confirmed';
    }
    if (t === CASE_FEEDBACK_BUTTON_NO || t.includes('still need help') || /^(n|no|nope|not really|still)\b/.test(t)) {
        return 'rejected';
    }
    return null;
}

// ---------------------------------------------------------------------------
// The routing decision
// ---------------------------------------------------------------------------

/**
 * Topic-shift relaxation (see docs/topic-shift-relaxation.md). A qualifying
 * follow-up only opens a NEW case when it lands at least this long after the
 * open case's last activity; within the window it's treated as the same client
 * continuing the same thread.
 */
export const TOPIC_SHIFT_MIN_GAP_MS = 30 * 60 * 1000;

/**
 * The fields of a session's open Case that the routing decision reads. Narrowed
 * so the domain module does not depend on the Supabase row type; the existing
 * `WhatsAppCaseRow` is structurally assignable to it.
 */
export interface RoutingCase {
    id: string;
    status: string;
    updated_at: string;
    crm_case_id: string | null;
}

/**
 * The routing verdict — a discriminated union so illegal combinations of
 * outcomes cannot be represented.
 *
 * - `topic-shift` / `fresh` carry no ids: the new Case id and request id are
 *   minted by createCase during application (I/O the pure function can't do).
 * - `none` carries a nullable `crmRequestId`: an escalated Case receiving a
 *   non-qualifying, non-wrap-up message is threaded under its existing request
 *   (`crmRequestId` set) but triggers no Case action.
 */
export type CaseRouting =
    | { kind: 'topic-shift'; priorCaseId: string; priorCrmRequestId: string | null }
    | { kind: 'fresh' }
    | { kind: 'continue';   caseId: string; crmRequestId: string | null }
    | { kind: 'reclassify'; caseId: string; crmRequestId: string | null }
    | { kind: 'none';       crmRequestId: string | null };

/**
 * Decide how an inbound message relates to the session's open Case. Pure: all
 * inputs are raw and `now` is injected. Behaviour mirrors the (formerly inline)
 * ~80-line routing block in whatsappProcessor exactly.
 *
 * Only called for client/lead senders — the entity-type guard (staff/unknown
 * senders are not routed) stays in the processor.
 */
export function decideCaseRouting(
    latestCase: RoutingCase | null,
    msg: { text: string; interactiveId?: string; pendingCaseId: string | null },
    now: number,
): CaseRouting {
    const qualifies = qualifyMessage(msg.text);

    // A feedback reply or closing ack belongs to the existing case — it is NOT
    // a new topic. Without this guard a "Yes, thanks" button tap (delivered as
    // its literal title text) reads as a fresh qualifying question, closing the
    // prior case and spawning a duplicate REQ that resolves the same turn.
    const looksLikeFeedbackOrAck =
        parseFeedbackButton(msg.interactiveId) !== null ||
        detectWrapUp(msg.text) ||
        (msg.pendingCaseId != null && detectFeedback(msg.text) !== null);

    const withinContinuationWindow =
        !!latestCase &&
        (now - new Date(latestCase.updated_at).getTime()) < TOPIC_SHIFT_MIN_GAP_MS;

    if (
        latestCase &&
        latestCase.status === 'bot_responded' &&
        qualifies &&
        !looksLikeFeedbackOrAck &&
        !withinContinuationWindow
    ) {
        // Topic shift — close the prior thread before opening a new one.
        return {
            kind: 'topic-shift',
            priorCaseId: latestCase.id,
            priorCrmRequestId: latestCase.crm_case_id,
        };
    }

    if (latestCase) {
        // Continuation — reuse the existing case + Dynamics request.
        const crmRequestId = latestCase.crm_case_id;
        if (latestCase.status === 'escalated' && (qualifies || detectWrapUp(msg.text))) {
            // Vague openers sometimes get flagged escalation on the first turn;
            // once the client clarifies (or sends a closing ack) the case is
            // clearly L1 — attempt recovery.
            return { kind: 'reclassify', caseId: latestCase.id, crmRequestId };
        }
        if (latestCase.status !== 'escalated') {
            return { kind: 'continue', caseId: latestCase.id, crmRequestId };
        }
        // Escalated + neither qualifying nor wrap-up — thread under the existing
        // request and take no further Case action.
        return { kind: 'none', crmRequestId };
    }

    if (qualifies) {
        // Fresh — first qualifying message in the session.
        return { kind: 'fresh' };
    }

    return { kind: 'none', crmRequestId: null };
}
