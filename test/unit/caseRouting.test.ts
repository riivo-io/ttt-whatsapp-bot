/**
 * Characterization tests for the pure case-routing decision in
 * src/domain/caseRouting.ts.
 *
 * These lock the EXACT verdict returned for each routing branch so the
 * extraction of decideCaseRouting out of whatsappProcessor (Issue 19) is
 * provably behaviour-preserving. Tests drive the pure function directly with
 * fixtures and an injected clock — no mocks, no DB.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    decideCaseRouting,
    qualifyMessage,
    detectWrapUp,
    detectFeedback,
    parseFeedbackButton,
    TOPIC_SHIFT_MIN_GAP_MS,
    CASE_FEEDBACK_BUTTON_YES,
    CASE_FEEDBACK_BUTTON_NO,
    CASE_FEEDBACK_BUTTON_YES_PREFIX,
    CASE_FEEDBACK_BUTTON_NO_PREFIX,
    type RoutingCase,
} from '../../src/domain/caseRouting';

// A fixed clock for every test. Cases are positioned relative to this.
const NOW = 1_700_000_000_000;

function caseRow(overrides: Partial<RoutingCase> = {}): RoutingCase {
    return {
        id: 'case-1',
        status: 'bot_responded',
        // default: just inside the continuation window unless overridden
        updated_at: new Date(NOW).toISOString(),
        crm_case_id: 'req-1',
        ...overrides,
    };
}

// updated_at strings positioned relative to NOW.
const justOutsideWindow = new Date(NOW - TOPIC_SHIFT_MIN_GAP_MS - 1).toISOString();
const wellInsideWindow = new Date(NOW - 60_000).toISOString();

// ---------------------------------------------------------------------------
// No open case
// ---------------------------------------------------------------------------

test('no open case + qualifying message -> fresh', () => {
    const v = decideCaseRouting(null, { text: 'How do I file my tax return?', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'fresh' });
});

test('no open case + emoji-only -> none with null request', () => {
    const v = decideCaseRouting(null, { text: '👍👍', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'none', crmRequestId: null });
});

test('no open case + single noise word -> none with null request', () => {
    const v = decideCaseRouting(null, { text: 'thanks', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'none', crmRequestId: null });
});

test('no open case + sub-3-char fragment -> none with null request', () => {
    const v = decideCaseRouting(null, { text: 'hi', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'none', crmRequestId: null });
});

// ---------------------------------------------------------------------------
// bot_responded — topic shift vs continuation
// ---------------------------------------------------------------------------

test('bot_responded + qualifying + outside window -> topic-shift', () => {
    const c = caseRow({ status: 'bot_responded', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'Different question about my invoice please', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'topic-shift', priorCaseId: 'case-1', priorCrmRequestId: 'req-1' });
});

test('bot_responded + qualifying + inside window -> continue', () => {
    const c = caseRow({ status: 'bot_responded', updated_at: wellInsideWindow });
    const v = decideCaseRouting(c, { text: 'Different question about my invoice please', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('bot_responded + feedback button tap -> continue (not topic-shift)', () => {
    const c = caseRow({ status: 'bot_responded', updated_at: justOutsideWindow });
    const v = decideCaseRouting(
        c,
        { text: 'Yes, thanks', interactiveId: CASE_FEEDBACK_BUTTON_YES, pendingCaseId: null },
        NOW,
    );
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('bot_responded + wrap-up phrase -> continue (not topic-shift)', () => {
    const c = caseRow({ status: 'bot_responded', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'perfect, all sorted', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('pending-case id + free-text feedback -> continue (not topic-shift)', () => {
    const c = caseRow({ status: 'bot_responded', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'yes', pendingCaseId: 'case-1' }, NOW);
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('bot_responded + per-case feedback button id -> continue (not topic-shift)', () => {
    // Self-identifying button id (case_fb_no:<caseId>) must still trip the
    // feedback guard so the tap is NOT read as a fresh topic. pendingCaseId is
    // null here on purpose — the id alone has to be enough.
    const c = caseRow({ status: 'bot_responded', updated_at: justOutsideWindow });
    const v = decideCaseRouting(
        c,
        { text: 'Still need help', interactiveId: `${CASE_FEEDBACK_BUTTON_NO_PREFIX}:case-1`, pendingCaseId: null },
        NOW,
    );
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

// ---------------------------------------------------------------------------
// Non-terminal "drafting" status — always continuation
// ---------------------------------------------------------------------------

test('still-drafting (created) status + ack -> continue', () => {
    const c = caseRow({ status: 'created', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'ok', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('classified status + qualifying -> continue (only bot_responded shifts)', () => {
    const c = caseRow({ status: 'classified', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'Another unrelated tax question here', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'continue', caseId: 'case-1', crmRequestId: 'req-1' });
});

// ---------------------------------------------------------------------------
// Escalated — reclassify vs hold (none)
// ---------------------------------------------------------------------------

test('escalated + qualifying -> reclassify', () => {
    const c = caseRow({ status: 'escalated', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'I want to do my 2024 tax return', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'reclassify', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('escalated + wrap-up -> reclassify', () => {
    const c = caseRow({ status: 'escalated', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'perfect', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'reclassify', caseId: 'case-1', crmRequestId: 'req-1' });
});

test('escalated + neither qualifying nor wrap-up -> none with request id set', () => {
    const c = caseRow({ status: 'escalated', updated_at: justOutsideWindow });
    const v = decideCaseRouting(c, { text: 'ok', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'none', crmRequestId: 'req-1' });
});

test('escalated + null crm request + non-qualifying -> none with null request', () => {
    const c = caseRow({ status: 'escalated', updated_at: justOutsideWindow, crm_case_id: null });
    const v = decideCaseRouting(c, { text: 'ok', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'none', crmRequestId: null });
});

// ---------------------------------------------------------------------------
// Continuation-window boundary
// ---------------------------------------------------------------------------

test('exactly at the window boundary -> topic-shift (window is strict <)', () => {
    const c = caseRow({ status: 'bot_responded', updated_at: new Date(NOW - TOPIC_SHIFT_MIN_GAP_MS).toISOString() });
    const v = decideCaseRouting(c, { text: 'A brand new question about something', pendingCaseId: null }, NOW);
    assert.deepEqual(v, { kind: 'topic-shift', priorCaseId: 'case-1', priorCrmRequestId: 'req-1' });
});

// ---------------------------------------------------------------------------
// Predicates (moved here from case.service)
// ---------------------------------------------------------------------------

test('qualifyMessage: rejects short / emoji / noise, accepts real questions', () => {
    assert.equal(qualifyMessage('hi'), false);
    assert.equal(qualifyMessage('👍'), false);
    assert.equal(qualifyMessage('thanks'), false);
    assert.equal(qualifyMessage('How do I file?'), true);
});

test('detectWrapUp: strong closers true, bare thanks and questions false', () => {
    assert.equal(detectWrapUp('perfect'), true);
    assert.equal(detectWrapUp('all sorted'), true);
    assert.equal(detectWrapUp('thanks'), false);
    assert.equal(detectWrapUp('perfect but one more thing?'), false);
});

test('detectFeedback: yes/no heuristics and button ids', () => {
    assert.equal(detectFeedback('yes'), 'confirmed');
    assert.equal(detectFeedback(CASE_FEEDBACK_BUTTON_YES), 'confirmed');
    assert.equal(detectFeedback('no'), 'rejected');
    assert.equal(detectFeedback(CASE_FEEDBACK_BUTTON_NO), 'rejected');
    assert.equal(detectFeedback('how do I file'), null);
});

// ---------------------------------------------------------------------------
// parseFeedbackButton — the single place that knows the button id shape
// ---------------------------------------------------------------------------

test('parseFeedbackButton: well-formed per-case ids -> verdict + caseId', () => {
    assert.deepEqual(
        parseFeedbackButton(`${CASE_FEEDBACK_BUTTON_YES_PREFIX}:abc-123`),
        { verdict: 'confirmed', caseId: 'abc-123' },
    );
    assert.deepEqual(
        parseFeedbackButton(`${CASE_FEEDBACK_BUTTON_NO_PREFIX}:abc-123`),
        { verdict: 'rejected', caseId: 'abc-123' },
    );
});

test('parseFeedbackButton: bare legacy constants -> verdict with null caseId', () => {
    assert.deepEqual(parseFeedbackButton(CASE_FEEDBACK_BUTTON_YES), { verdict: 'confirmed', caseId: null });
    assert.deepEqual(parseFeedbackButton(CASE_FEEDBACK_BUTTON_NO), { verdict: 'rejected', caseId: null });
});

test('parseFeedbackButton: malformed / unrelated / empty ids -> null', () => {
    assert.equal(parseFeedbackButton(undefined), null);
    assert.equal(parseFeedbackButton(''), null);
    assert.equal(parseFeedbackButton('some_other_button'), null);
    assert.equal(parseFeedbackButton('client_menu:foo'), null);
    assert.equal(parseFeedbackButton(`${CASE_FEEDBACK_BUTTON_YES_PREFIX}:`), null); // empty caseId
});
