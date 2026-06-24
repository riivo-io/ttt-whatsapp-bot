/**
 * Pure domain module owning the per-turn feedback-reply decision.
 *
 * When a session is waiting on feedback for a bot answer, the processor must
 * decide — before invoking Claude — whether the inbound turn is answering the
 * resolution prompt, and if so what to do with the case it refers to. The full
 * gate lives here:
 *
 *  - A feedback button tap is self-identifying: `parseFeedbackButton` pulls the
 *    verdict (confirmed/rejected) and the exact caseId out of the button id, so
 *    the decision no longer depends on `pending_case_id` surviving.
 *  - A free-text yes/no only counts when the PREVIOUS assistant turn was the
 *    resolution prompt itself (the unchanged free-text gate); such replies are
 *    by construction same-session and refer to the pending case.
 *
 * The outcome depends on the resolved case's state and whether it still belongs
 * to the active session, so the processor resolves the tapped case first and
 * passes its `status` plus a `belongsToActiveSession` flag in. The function
 * stays pure (no DB, no clock, no logging) and returns a discriminated
 * `FeedbackReply` verdict; the processor performs all the I/O by switching on
 * it. The `type === 'client'` guard stays in the processor.
 */

import {
    detectFeedback,
    parseFeedbackButton,
} from './caseRouting';

// Exact wording of the resolution prompt sent by feedbackPromptWorker. Shared
// with the processor's gate so the "previous bot turn was the prompt" check can
// match the last assistant message without drift. case.service re-exports this
// so the feedback prompt worker and any other importer compile unchanged.
export const CASE_FEEDBACK_PROMPT_TEXT = 'Did that answer your question?';

/**
 * The fields of a conversation-history turn the feedback gate reads. Narrowed
 * so the domain module does not depend on the Supabase row type; the existing
 * history rows are structurally assignable to it.
 */
export interface FeedbackTurn {
    role: string;
    content: string;
}

/**
 * The resolved tapped case the decision reads — narrowed to the two fields it
 * needs. The processor resolves it (by parsed caseId, falling back to the
 * pending pointer for legacy bare ids) before calling. `status` is kept as a
 * string so the domain module does not import the Supabase `CaseStatus` type.
 */
export interface TappedCase {
    id: string;
    status: string;
}

/**
 * The feedback verdict — a discriminated union so every state × session-window
 * outcome is explicit. See the state matrix in
 * `.scratch/feedback-reengage/PRD.md`.
 *
 * - `confirm-close`   — "yes" on a live (`bot_responded` / `escalated`) case;
 *   close it confirmed. `clearEscalation` pulls the human off too.
 * - `confirm-upgrade` — "yes" on an auto-closed (`resolved_by_bot_timeout`)
 *   case; stamp it genuinely confirmed, no reopen.
 * - `reengage`        — "still need help" on a same-session case, any state;
 *   reopen to bot-owned and ask what's still unclear (never escalate).
 *   `clearEscalation` reconciles a case a consultant already owns.
 * - `ack-only`        — cross-session "yes", or "yes" on an already-confirmed
 *   case; friendly ack, no case surgery.
 * - `reengage-stale`  — cross-session "still need help"; send the re-engage
 *   message only, the follow-up opens a fresh case.
 * - `clear-pending`   — a pending pointer exists but this turn is not feedback;
 *   clear it and fall through to the normal answer path.
 * - `none`            — nothing pending and no tapped case; nothing to do here.
 */
export type FeedbackReply =
    | { kind: 'confirm-close'; caseId: string; clearEscalation: boolean }
    | { kind: 'confirm-upgrade'; caseId: string }
    | { kind: 'reengage'; caseId: string; clearEscalation: boolean }
    | { kind: 'ack-only' }
    | { kind: 'reengage-stale' }
    | { kind: 'clear-pending' }
    | { kind: 'none' };

/**
 * Decide what an inbound turn means for the case it refers to. Pure: history,
 * message, the pending pointer, the resolved tapped case and its session
 * membership are all passed in; no DB, no clock, no logging.
 *
 * Only called for client senders — the `type === 'client'` guard stays in the
 * processor.
 */
export function decideFeedbackReply(
    history: FeedbackTurn[],
    msg: { text: string; interactiveId?: string },
    pendingCaseId: string | null,
    tappedCase: TappedCase | null,
    belongsToActiveSession: boolean,
): FeedbackReply {
    // 1. Determine this turn's feedback verdict (confirmed / rejected / null).
    //    A button tap is self-identifying and bypasses the free-text gate; a
    //    free-text reply only counts when the previous bot turn was the prompt.
    const parsed = parseFeedbackButton(msg.interactiveId);
    let verdict: 'confirmed' | 'rejected' | null;
    if (parsed) {
        verdict = parsed.verdict;
    } else if (!pendingCaseId) {
        // No button tap and nothing pending — this turn can't be feedback.
        return { kind: 'none' };
    } else {
        let previousWasPrompt = false;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'assistant') {
                previousWasPrompt = history[i].content.startsWith(CASE_FEEDBACK_PROMPT_TEXT);
                break;
            }
        }
        verdict = previousWasPrompt ? detectFeedback(msg.text) : null;
    }

    // 2. Not a feedback reply. Clear a dangling pending pointer (so the turn
    //    routes as a fresh query), else nothing to do.
    if (verdict === null) {
        return pendingCaseId ? { kind: 'clear-pending' } : { kind: 'none' };
    }

    // 3. Feedback, but the case is gone or its session has expired — the 30-min
    //    session boundary is the staleness cutoff. Acknowledge a "yes"; for
    //    "still need help" send the re-engage prompt and let the follow-up open
    //    a fresh case (no cross-session resurrection).
    if (!tappedCase || !belongsToActiveSession) {
        return verdict === 'confirmed' ? { kind: 'ack-only' } : { kind: 'reengage-stale' };
    }

    // 4. Same-session feedback — resolve against the case's current state.
    const caseId = tappedCase.id;
    if (verdict === 'rejected') {
        // "Still need help" re-engages, never escalates. An escalated case is
        // reconciled (consultant pulled off) as Tina re-owns it.
        return { kind: 'reengage', caseId, clearEscalation: tappedCase.status === 'escalated' };
    }

    // verdict === 'confirmed'
    switch (tappedCase.status) {
        case 'resolved_by_bot':
            // Already recorded as confirmed — nothing to change.
            return { kind: 'ack-only' };
        case 'resolved_by_bot_timeout':
            // Auto-closed on the assumed-resolved timeout — upgrade to a genuine
            // confirmation without reopening.
            return { kind: 'confirm-upgrade', caseId };
        case 'escalated':
            return { kind: 'confirm-close', caseId, clearEscalation: true };
        default:
            // bot_responded (and the transient created/classified states).
            return { kind: 'confirm-close', caseId, clearEscalation: false };
    }
}
