/**
 * Unit matrix for the pure document-recommendation kernel in
 * src/domain/docRecommendation.ts (Issue 25 — doc-journey).
 *
 * Covers the acceptance criteria: baseline correction (no Bank Statements,
 * IRP5 present, never ID Document), reason-present-on-every-item across all
 * tables, source-code-driven / industry-driven / baseline-only lists,
 * form-supersedes-doc dedupe, received-doc diff, and the no-IRP5 fallback.
 * Driven directly with fixtures — no mocks, no DB, no real clock.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDocRecommendation,
    BASELINE_DOCS,
    SOURCE_CODE_DOCS,
    INDUSTRY_DOCS,
    SOURCE_CODE_FORMS,
    type DocRecommendationItem,
} from '../../src/domain/docRecommendation';

const TODAY = new Date('2026-06-24T00:00:00Z'); // 2026 tax year

const labels = (items: DocRecommendationItem[]) => items.map(i => i.label);
const hasLabel = (items: DocRecommendationItem[], needle: string) =>
    items.some(i => i.label.toLowerCase().includes(needle.toLowerCase()));

// ── Baseline correction ──────────────────────────────────────────────────

test('baseline correction: BASELINE_DOCS has IRP5, no Bank Statements, no ID Document', () => {
    const baseLabels = BASELINE_DOCS.map(d => d.label.toLowerCase());
    assert.ok(baseLabels.some(l => l.includes('irp5')), 'IRP5 stays in baseline');
    assert.ok(!baseLabels.some(l => /bank statement/.test(l)), 'Bank Statements out of baseline');
    assert.ok(!baseLabels.some(l => /id document|id doc\b/.test(l)), 'ID Document never in baseline');
});

// ── Reasons present on every spec ────────────────────────────────────────

test('every spec across baseline / source-code / industry / forms carries a non-empty reason', () => {
    const nonEmpty = (s: string | undefined) => typeof s === 'string' && s.trim().length > 0;
    for (const d of BASELINE_DOCS) assert.ok(nonEmpty(d.reason), `baseline "${d.label}" needs a reason`);
    for (const [code, docs] of Object.entries(SOURCE_CODE_DOCS)) {
        for (const d of docs) assert.ok(nonEmpty(d.reason), `source-code ${code} "${d.label}" needs a reason`);
    }
    for (const entry of INDUSTRY_DOCS) {
        for (const d of entry.docs) assert.ok(nonEmpty(d.reason), `industry "${d.label}" needs a reason`);
    }
    for (const f of SOURCE_CODE_FORMS) assert.ok(nonEmpty(f.reason), `form "${f.label}" needs a reason`);
});

test('builder output: every outstanding and received item carries a non-empty reason', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3601', '3701', '4005'],
        industryName: 'Self-employed consultant',
        receivedLabels: ['IRP5'],
        today: TODAY,
    });
    for (const item of [...rec.outstanding, ...rec.received]) {
        assert.ok(item.reason.trim().length > 0, `"${item.label}" must carry a reason`);
    }
});

// ── Baseline-only (no codes, no industry) ────────────────────────────────

test('baseline-only: no codes + no industry → baseline docs, no personalisation', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    assert.equal(rec.hasPersonalisation, false);
    assert.equal(rec.matchedSourceCodes.length, 0);
    assert.equal(rec.matchedIndustry, null);
    assert.ok(hasLabel(rec.outstanding, 'IRP5'));
    assert.ok(!hasLabel(rec.outstanding, 'Bank statement'), 'no bank statements in the baseline-only list');
    assert.ok(rec.outstanding.every(i => i.kind === 'doc'), 'no forms without a triggering source code');
});

// ── Source-code-driven ───────────────────────────────────────────────────

test('source-code-driven: 4005 pulls in the medical aid certificate', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['4005'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    assert.deepEqual(rec.matchedSourceCodes, ['4005']);
    assert.ok(rec.hasPersonalisation);
    assert.ok(hasLabel(rec.outstanding, 'Medical aid'));
});

test('source-code order preserved + de-duped across buckets (IRP5 listed once)', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3601', '3615'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    const irp5Count = rec.outstanding.filter(i => /irp5/i.test(i.label)).length;
    assert.equal(irp5Count, 1, 'IRP5 de-duped to a single entry');
});

// ── Industry-driven ──────────────────────────────────────────────────────

test('industry-driven: rental industry pulls in lease + rental docs', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: 'Residential property landlord',
        receivedLabels: [],
        today: TODAY,
    });
    assert.equal(rec.matchedIndustry, 'Residential property landlord');
    assert.ok(rec.hasPersonalisation);
    assert.ok(hasLabel(rec.outstanding, 'Lease agreement'));
    assert.ok(hasLabel(rec.outstanding, 'Bond statement'));
});

// ── Form supersedes doc ──────────────────────────────────────────────────

test('form-supersedes-doc: travel allowance (3701) emits vehicle form and suppresses the logbook', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3701'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    const form = rec.outstanding.find(i => i.kind === 'form');
    assert.ok(form, 'a fillable form is emitted');
    assert.equal(form?.formKey, 'vehicle_detail');
    // the raw docs the form covers are suppressed
    assert.ok(!hasLabel(rec.outstanding, 'Logbook'), 'logbook suppressed by the vehicle form');
    assert.ok(!hasLabel(rec.outstanding, 'Fuel'), 'fuel slips suppressed by the vehicle form');
    assert.ok(!hasLabel(rec.outstanding, 'Vehicle purchase'), 'vehicle agreement suppressed by the form');
    // form leads the list
    assert.equal(rec.outstanding[0].kind, 'form', 'form leads the recommendation');
});

test('includeForms:false keeps the legacy docs-only list (logbook present, no form)', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3701'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
        includeForms: false,
    });
    assert.ok(!rec.outstanding.some(i => i.kind === 'form'), 'no forms when includeForms is false');
    assert.ok(hasLabel(rec.outstanding, 'Logbook'), 'raw logbook ask survives without form supersession');
});

test('commission (3606) emits the commission form and suppresses the till-slip ask', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3606'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    const form = rec.outstanding.find(i => i.formKey === 'commission_expenses');
    assert.ok(form, 'commission expenses form emitted');
    assert.ok(!hasLabel(rec.outstanding, 'Till slips'), 'till slips superseded by commission form');
});

// ── Received-doc diff ────────────────────────────────────────────────────

test('received-doc diff: an on-file IRP5 moves to received, loose-matched', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3601'],
        industryName: null,
        receivedLabels: ['IRP5 - 2026'],
        today: TODAY,
    });
    assert.ok(hasLabel(rec.received, 'IRP5'), 'IRP5 recognised as received via loose match');
    assert.ok(!hasLabel(rec.outstanding, 'IRP5'), 'received IRP5 not re-asked');
});

// ── Client-stated escape hatch (Issue 27) ────────────────────────────────

test('client-stated marker suppresses the ask but is NOT counted as verified received', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3601'],
        industryName: null,
        receivedLabels: [],
        clientStatedLabels: ['IRP5'],
        today: TODAY,
    });
    // suppressed from the re-ask
    assert.ok(!hasLabel(rec.outstanding, 'IRP5'), 'client-stated IRP5 is not re-asked');
    // never surfaced as a verified receipt
    assert.ok(!hasLabel(rec.received, 'IRP5'), 'client-stated IRP5 is NOT a verified receipt');
    // surfaced distinctly in its own bucket
    assert.ok(hasLabel(rec.clientStated, 'IRP5'), 'client-stated IRP5 lands in the clientStated bucket');
});

test('a verified receipt wins over a client-stated marker for the same doc', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3601'],
        industryName: null,
        receivedLabels: ['IRP5 - 2026'],
        clientStatedLabels: ['IRP5'],
        today: TODAY,
    });
    assert.ok(hasLabel(rec.received, 'IRP5'), 'verified IRP5 stays in received');
    assert.ok(!hasLabel(rec.clientStated, 'IRP5'), 'not double-counted as client-stated');
    assert.ok(!hasLabel(rec.outstanding, 'IRP5'), 'not re-asked');
});

test('client-stated labels default to empty — no clientStated items when omitted', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3601'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    assert.equal(rec.clientStated.length, 0, 'no client-stated bucket without markers');
    assert.ok(hasLabel(rec.outstanding, 'IRP5'), 'IRP5 still asked when nothing is on file');
});

// ── No-IRP5 fallback ─────────────────────────────────────────────────────

test('no-IRP5 fallback: empty source codes still yields the generic reason-annotated list', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: 'Sole proprietor / freelancer',
        receivedLabels: [],
        today: TODAY,
    });
    assert.equal(rec.matchedSourceCodes.length, 0);
    assert.ok(rec.outstanding.length > 0, 'never a dead end');
    assert.ok(hasLabel(rec.outstanding, 'Business bank statement'), 'industry list drives the fallback');
    assert.ok(rec.outstanding.every(i => i.reason.trim().length > 0), 'fallback items still reason-annotated');
});

test('tax year is derived from the injected clock (2026)', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    assert.equal(rec.taxYear.label, 2026);
});
