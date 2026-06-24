/**
 * Unit matrix for the pure IRP5-reply composer in src/domain/irp5Reply.ts
 * (Issue 26 — list-once, not drip; always confirm receipt; graceful OCR fail).
 *
 * The composer is pure (no I/O), so we drive it with fixtures and assert the
 * two acceptance rules directly: the receipt is ALWAYS confirmed and the FULL
 * tailored list lands in ONE message (reasons + forms), never a one-doc drip
 * and never a mention of any read/OCR failure.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildIrp5ReceivedAck, renderOutstandingDocsList } from '../../src/domain/irp5Reply';
import type { DocRecommendationItem } from '../../src/domain/docRecommendation';

const OUTSTANDING: DocRecommendationItem[] = [
    { kind: 'form', label: 'Vehicle Detail Sheet', reason: "you've got a travel allowance", formKey: 'vehicle_detail' },
    { kind: 'doc', label: '12 payslips', reason: 'to verify your monthly earnings' },
    { kind: 'doc', label: 'Medical aid tax certificate', reason: 'to claim your medical aid contributions' },
];

// ── List-once: the whole list in one message ─────────────────────────────

test('list-once: the ack carries every outstanding item with its reason in one message', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2026,
        outstanding: OUTSTANDING,
    });
    for (const item of OUTSTANDING) {
        assert.ok(ack.includes(item.label), `"${item.label}" must appear`);
        assert.ok(ack.includes(item.reason), `reason for "${item.label}" must appear`);
    }
    // "send whatever you have, in any order" framing, not a single-next-doc drip.
    assert.match(ack, /any order/i);
});

test('forms are flagged distinctly from raw docs in the rendered list', () => {
    const lines = renderOutstandingDocsList(OUTSTANDING);
    const formLine = lines.find(l => l.includes('Vehicle Detail Sheet'));
    assert.match(formLine!, /form/i, 'form item reads as a form to fill in');
    const docLine = lines.find(l => l.includes('12 payslips'));
    assert.doesNotMatch(docLine!, /a form we'll send/i, 'raw doc not labelled as a form');
});

// ── Always confirm receipt ───────────────────────────────────────────────

test('receipt is always confirmed, with employer + year, even when the list is non-empty', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2026,
        outstanding: OUTSTANDING,
    });
    assert.match(ack, /Got your IRP5 from Acme Ltd for the 2026 tax year/);
    assert.match(ack, /✅/);
    assert.match(ack, /on file/i);
});

test('receipt is confirmed even with no employer name (graceful OCR fail → empty list)', () => {
    // Extraction degraded: no employer parsed, no source codes → empty list.
    const ack = buildIrp5ReceivedAck({
        employerName: null,
        assessmentYear: 2026,
        outstanding: [],
    });
    assert.match(ack, /Got your IRP5 for the 2026 tax year/);
    assert.match(ack, /on file/i);
    // Never surfaces a read/OCR failure to the client.
    assert.doesNotMatch(ack, /couldn't read|could not read|OCR|unreadable|failed to/i);
});

// ── Empty list → "that's everything" close ───────────────────────────────

test('empty outstanding list closes warmly without asking for anything', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2026,
        outstanding: [],
    });
    assert.match(ack, /everything we need/i);
    assert.doesNotMatch(ack, /send whatever you have/i);
});

// ── Wrong-year caveat surfaced gently ────────────────────────────────────

test('wrong-year warning is surfaced as a gentle note alongside the receipt', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2025,
        outstanding: OUTSTANDING,
        wrongYearWarning: 'the cert reads as the 2025 assessment year',
    });
    assert.match(ack, /One thing/);
    assert.ok(ack.includes('the cert reads as the 2025 assessment year'));
});
