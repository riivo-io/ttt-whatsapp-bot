/**
 * Unit matrix for the pure IRP5-reply composer in src/domain/irp5Reply.ts
 * (Issue 26 — list-once, not drip; always confirm receipt; graceful OCR fail;
 * ADR 0004 — advice only, no upload-status reporting).
 *
 * The composer is pure (no I/O), so we drive it with fixtures and assert the
 * acceptance rules directly: the receipt of the just-sent IRP5 is ALWAYS
 * confirmed, the FULL tailored list lands in ONE message (reasons + forms) as
 * ADVICE, never a one-doc drip, never a mention of any read/OCR failure, and
 * never a claim about what the client has or hasn't already sent.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildIrp5ReceivedAck, renderAssociatedDocsList } from '../../src/domain/irp5Reply';
import type { DocRecommendationItem } from '../../src/domain/docRecommendation';

const ASSOCIATED: DocRecommendationItem[] = [
    { kind: 'form', label: 'Vehicle Detail Sheet', reason: "you've got a travel allowance", formKey: 'vehicle_detail' },
    { kind: 'doc', label: '12 payslips', reason: 'to verify your monthly earnings' },
    { kind: 'doc', label: 'Medical aid tax certificate', reason: 'to claim your medical aid contributions' },
];

// ── List-once: the whole list in one message ─────────────────────────────

test('list-once: the ack carries every associated item with its reason in one message', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2026,
        associatedDocs: ASSOCIATED,
    });
    for (const item of ASSOCIATED) {
        assert.ok(ack.includes(item.label), `"${item.label}" must appear`);
        assert.ok(ack.includes(item.reason), `reason for "${item.label}" must appear`);
    }
    // "send whatever applies to you, in any order" framing, not a single-next-doc drip.
    assert.match(ack, /any order/i);
    // Advice framing (ADR 0004) — never a claim about what's outstanding / received.
    assert.doesNotMatch(ack, /outstanding|still (need|owe)|already sent|received from you/i);
});

test('forms are flagged distinctly from raw docs in the rendered list', () => {
    const lines = renderAssociatedDocsList(ASSOCIATED);
    const formLine = lines.find(l => l.includes('Vehicle Detail Sheet'));
    assert.match(formLine!, /form/i, 'form item reads as a form to fill in');
    const docLine = lines.find(l => l.includes('12 payslips'));
    assert.doesNotMatch(docLine!, /a form we'll send/i, 'raw doc not labelled as a form');
});

// ── Always confirm receipt of the just-sent cert ─────────────────────────

test('receipt is always confirmed, with employer + year, even when the list is non-empty', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2026,
        associatedDocs: ASSOCIATED,
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
        associatedDocs: [],
    });
    assert.match(ack, /Got your IRP5 for the 2026 tax year/);
    assert.match(ack, /on file/i);
    // Never surfaces a read/OCR failure to the client.
    assert.doesNotMatch(ack, /couldn't read|could not read|OCR|unreadable|failed to/i);
});

// ── Empty list → warm close ──────────────────────────────────────────────

test('empty associated list closes warmly without asking for anything or claiming completeness', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2026,
        associatedDocs: [],
    });
    assert.match(ack, /consultant will be in touch/i);
    assert.doesNotMatch(ack, /send whatever applies/i);
    // ADR 0004: never assert we have "everything" — we can't see their record.
    assert.doesNotMatch(ack, /everything we need|that's everything/i);
});

// ── Wrong-year caveat surfaced gently ────────────────────────────────────

test('wrong-year warning is surfaced as a gentle note alongside the receipt', () => {
    const ack = buildIrp5ReceivedAck({
        employerName: 'Acme Ltd',
        assessmentYear: 2025,
        associatedDocs: ASSOCIATED,
        wrongYearWarning: 'the cert reads as the 2025 assessment year',
    });
    assert.match(ack, /One thing/);
    assert.ok(ack.includes('the cert reads as the 2025 assessment year'));
});
