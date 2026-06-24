/**
 * Characterization tests for the pure feedback-reply decision in
 * src/domain/feedbackReply.ts.
 *
 * These lock the EXACT verdict for each cell of the state × session-window
 * matrix (Issue 23) plus the unchanged free-text gate. Tests drive the pure
 * function directly with fixtures — no mocks, no DB, no clock.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    decideFeedbackReply,
    CASE_FEEDBACK_PROMPT_TEXT,
    type FeedbackTurn,
    type TappedCase,
} from '../../src/domain/feedbackReply';
import {
    CASE_FEEDBACK_BUTTON_YES,
    CASE_FEEDBACK_BUTTON_NO,
    CASE_FEEDBACK_BUTTON_YES_PREFIX,
    CASE_FEEDBACK_BUTTON_NO_PREFIX,
} from '../../src/domain/caseRouting';

const PENDING = 'case-1';

// Per-case button ids (what feedbackPromptWorker now emits).
const yesBtn = `${CASE_FEEDBACK_BUTTON_YES_PREFIX}:${PENDING}`;
const noBtn = `${CASE_FEEDBACK_BUTTON_NO_PREFIX}:${PENDING}`;

// History whose last assistant turn IS the resolution prompt (free-text gate open).
const afterPrompt: FeedbackTurn[] = [
    { role: 'user', content: 'How do I file my tax return?' },
    { role: 'assistant', content: `${CASE_FEEDBACK_PROMPT_TEXT}` },
];

// History whose last assistant turn is NOT the resolution prompt (gate shut).
const afterNonPrompt: FeedbackTurn[] = [
    { role: 'user', content: 'How do I file my tax return?' },
    { role: 'assistant', content: 'Want me to list the typical documents?' },
];

function tapped(status: string): TappedCase {
    return { id: PENDING, status };
}

// ---------------------------------------------------------------------------
// Nothing to do
// ---------------------------------------------------------------------------

test('no button + no pending -> none (even for a yes after the prompt)', () => {
    const v = decideFeedbackReply(afterPrompt, { text: 'yes' }, null, null, false);
    assert.deepEqual(v, { kind: 'none' });
});

// ---------------------------------------------------------------------------
// State matrix — same active session (button taps bypass the free-text gate,
// so afterNonPrompt is used to prove the bypass)
// ---------------------------------------------------------------------------

test('bot_responded + Yes -> confirm-close (no escalation clear)', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: yesBtn }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'confirm-close', caseId: PENDING, clearEscalation: false });
});

test('bot_responded + Still need help -> reengage (no escalation clear)', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: noBtn }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'reengage', caseId: PENDING, clearEscalation: false });
});

test('auto-closed (timeout) + Yes -> confirm-upgrade', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: yesBtn }, PENDING, tapped('resolved_by_bot_timeout'), true);
    assert.deepEqual(v, { kind: 'confirm-upgrade', caseId: PENDING });
});

test('auto-closed (timeout) + Still need help -> reengage (no escalation clear)', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: noBtn }, PENDING, tapped('resolved_by_bot_timeout'), true);
    assert.deepEqual(v, { kind: 'reengage', caseId: PENDING, clearEscalation: false });
});

test('already confirmed (resolved_by_bot) + Yes -> ack-only', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: yesBtn }, PENDING, tapped('resolved_by_bot'), true);
    assert.deepEqual(v, { kind: 'ack-only' });
});

test('already confirmed (resolved_by_bot) + Still need help -> reengage (no escalation clear)', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: noBtn }, PENDING, tapped('resolved_by_bot'), true);
    assert.deepEqual(v, { kind: 'reengage', caseId: PENDING, clearEscalation: false });
});

test('escalated + Yes -> confirm-close + clearEscalation', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: yesBtn }, PENDING, tapped('escalated'), true);
    assert.deepEqual(v, { kind: 'confirm-close', caseId: PENDING, clearEscalation: true });
});

test('escalated + Still need help -> reengage + clearEscalation', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: noBtn }, PENDING, tapped('escalated'), true);
    assert.deepEqual(v, { kind: 'reengage', caseId: PENDING, clearEscalation: true });
});

// ---------------------------------------------------------------------------
// State matrix — session expired (belongsToActiveSession = false)
// ---------------------------------------------------------------------------

test('session expired + Yes -> ack-only (no resurrection)', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: yesBtn }, null, tapped('bot_responded'), false);
    assert.deepEqual(v, { kind: 'ack-only' });
});

test('session expired + Still need help -> reengage-stale', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: noBtn }, null, tapped('bot_responded'), false);
    assert.deepEqual(v, { kind: 'reengage-stale' });
});

test('tapped case gone (null) + Yes -> ack-only', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: yesBtn }, null, null, false);
    assert.deepEqual(v, { kind: 'ack-only' });
});

test('tapped case gone (null) + Still need help -> reengage-stale', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: noBtn }, null, null, false);
    assert.deepEqual(v, { kind: 'reengage-stale' });
});

// ---------------------------------------------------------------------------
// Legacy bare button id — caseId null, processor resolves via pending pointer,
// so the pure function still gets a tappedCase and decides normally
// ---------------------------------------------------------------------------

test('legacy bare Yes id + same-session bot_responded -> confirm-close', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Yes, thanks', interactiveId: CASE_FEEDBACK_BUTTON_YES }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'confirm-close', caseId: PENDING, clearEscalation: false });
});

test('legacy bare No id + same-session bot_responded -> reengage', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'Still need help', interactiveId: CASE_FEEDBACK_BUTTON_NO }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'reengage', caseId: PENDING, clearEscalation: false });
});

// ---------------------------------------------------------------------------
// Free-text gate (unchanged) — only counts when the previous bot turn was the
// prompt; free-text is by construction same-session
// ---------------------------------------------------------------------------

test('free-text yes after the prompt -> confirm-close', () => {
    const v = decideFeedbackReply(afterPrompt, { text: 'yes' }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'confirm-close', caseId: PENDING, clearEscalation: false });
});

test('free-text no after the prompt -> reengage', () => {
    const v = decideFeedbackReply(afterPrompt, { text: 'no' }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'reengage', caseId: PENDING, clearEscalation: false });
});

test('free-text yes when previous turn was NOT the prompt -> clear-pending', () => {
    const v = decideFeedbackReply(afterNonPrompt, { text: 'yes' }, PENDING, tapped('bot_responded'), true);
    assert.deepEqual(v, { kind: 'clear-pending' });
});

test('non-feedback free-text after the prompt with pending case -> clear-pending', () => {
    const v = decideFeedbackReply(
        afterPrompt,
        { text: 'Actually, what about my 2023 return?' },
        PENDING,
        tapped('bot_responded'),
        true,
    );
    assert.deepEqual(v, { kind: 'clear-pending' });
});
