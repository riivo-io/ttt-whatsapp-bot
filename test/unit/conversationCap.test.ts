/**
 * Characterization tests for the pure conversation-cap decision in
 * src/domain/conversationCap.ts.
 *
 * These lock the EXACT verdict returned for each cap branch so the extraction
 * of decideConversationCap out of whatsappProcessor (Issue 22) is provably
 * behaviour-preserving. Tests drive the pure function directly with fixtures —
 * no mocks, no DB, no clock.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    decideConversationCap,
    CAP_MESSAGES_PER_SESSION,
    CAP_TOKENS_PER_SESSION,
    CAP_MESSAGES_PER_DAY,
} from '../../src/domain/conversationCap';

// ---------------------------------------------------------------------------
// Already blocked — wins over everything
// ---------------------------------------------------------------------------

test('cap_blocked_at set -> blocked (even with counts under all limits)', () => {
    const v = decideConversationCap(
        { capBlockedAt: '2026-06-23T10:00:00.000Z', messageCount: 0, tokenCount: 0 },
        0,
    );
    assert.deepEqual(v, { kind: 'blocked' });
});

// ---------------------------------------------------------------------------
// Hit by daily
// ---------------------------------------------------------------------------

test('over per-day -> hit/daily', () => {
    const v = decideConversationCap(
        { capBlockedAt: null, messageCount: 0, tokenCount: 0 },
        CAP_MESSAGES_PER_DAY,
    );
    assert.deepEqual(v, { kind: 'hit', reason: 'daily' });
});

// ---------------------------------------------------------------------------
// Hit by session (messages or tokens)
// ---------------------------------------------------------------------------

test('over per-session messages -> hit/session', () => {
    const v = decideConversationCap(
        { capBlockedAt: null, messageCount: CAP_MESSAGES_PER_SESSION, tokenCount: 0 },
        0,
    );
    assert.deepEqual(v, { kind: 'hit', reason: 'session' });
});

test('over per-session tokens -> hit/session', () => {
    const v = decideConversationCap(
        { capBlockedAt: null, messageCount: 0, tokenCount: CAP_TOKENS_PER_SESSION },
        0,
    );
    assert.deepEqual(v, { kind: 'hit', reason: 'session' });
});

// ---------------------------------------------------------------------------
// Daily wins ties — over both reports 'daily'
// ---------------------------------------------------------------------------

test('over both daily and session -> hit/daily (daily wins ties)', () => {
    const v = decideConversationCap(
        { capBlockedAt: null, messageCount: CAP_MESSAGES_PER_SESSION, tokenCount: CAP_TOKENS_PER_SESSION },
        CAP_MESSAGES_PER_DAY,
    );
    assert.deepEqual(v, { kind: 'hit', reason: 'daily' });
});

// ---------------------------------------------------------------------------
// Boundaries — thresholds are inclusive (>=); one under is ok
// ---------------------------------------------------------------------------

test('exactly one under every threshold -> ok', () => {
    const v = decideConversationCap(
        {
            capBlockedAt: null,
            messageCount: CAP_MESSAGES_PER_SESSION - 1,
            tokenCount: CAP_TOKENS_PER_SESSION - 1,
        },
        CAP_MESSAGES_PER_DAY - 1,
    );
    assert.deepEqual(v, { kind: 'ok' });
});

test('all counts zero -> ok', () => {
    const v = decideConversationCap(
        { capBlockedAt: null, messageCount: 0, tokenCount: 0 },
        0,
    );
    assert.deepEqual(v, { kind: 'ok' });
});
