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

test('form-supersedes-doc: travel allowance (3701) leads with the vehicle form, keeps the purchase agreement, folds in service records + leave dates', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3701'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    const form = rec.outstanding.find(i => i.kind === 'form');
    assert.ok(form, 'a fillable form is emitted');
    assert.equal(form?.formKey, 'vehicle_detail');
    // the raw docs the form covers are suppressed (guide §3701)
    assert.ok(!hasLabel(rec.outstanding, 'Logbook'), 'logbook suppressed by the vehicle form');
    assert.ok(!hasLabel(rec.outstanding, 'Service records'), 'service records folded into the form');
    assert.ok(!hasLabel(rec.outstanding, 'Leave dates'), 'leave dates folded into the form');
    // the purchase agreement is NOT captured by the form, so it survives as a loose doc
    assert.ok(hasLabel(rec.outstanding, 'Vehicle purchase agreement'), 'purchase agreement asked as a loose doc');
    // form leads the list
    assert.equal(rec.outstanding[0].kind, 'form', 'form leads the recommendation');
});

test('includeForms:false drops the form and resurfaces the docs it would have superseded (service records, leave dates)', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3701'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
        includeForms: false,
    });
    assert.ok(!rec.outstanding.some(i => i.kind === 'form'), 'no forms when includeForms is false');
    // with no form, nothing is superseded — the captured docs reappear as raw asks
    assert.ok(hasLabel(rec.outstanding, 'Service records'), 'service records resurface without form supersession');
    assert.ok(hasLabel(rec.outstanding, 'Leave dates'), 'leave dates resurface without form supersession');
    assert.ok(hasLabel(rec.outstanding, 'Vehicle purchase agreement'), 'purchase agreement still asked');
});

test('commission (3606) leads with BOTH forms then the conditional loose docs; superseded docs absent', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3606'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    // both forms present, vehicle form leads
    assert.ok(rec.outstanding.some(i => i.formKey === 'vehicle_detail'), 'vehicle detail sheet emitted');
    assert.ok(rec.outstanding.some(i => i.formKey === 'commission_expenses'), 'commission expenses form emitted');
    const forms = rec.outstanding.filter(i => i.kind === 'form');
    assert.equal(forms.length, 2, 'exactly the two forms');
    assert.equal(rec.outstanding[0].kind, 'form', 'forms lead the list');
    assert.equal(rec.outstanding[1].kind, 'form', 'both forms lead before any loose doc');
    // the conditional loose docs the forms don't capture
    assert.ok(hasLabel(rec.outstanding, 'Vehicle purchase agreement'), 'purchase agreement present');
    assert.ok(hasLabel(rec.outstanding, 'Vehicle finance statements'), 'finance statements present');
    assert.ok(hasLabel(rec.outstanding, 'Vehicle insurance policy schedule'), 'insurance schedule present');
    assert.ok(hasLabel(rec.outstanding, 'Bank statements'), 'bank statements present');
    // every commission/vehicle loose doc is conditionally framed
    const conditional = rec.outstanding.filter(i =>
        ['Vehicle purchase', 'Vehicle finance', 'Vehicle insurance', 'Bank statements'].some(n => i.label.includes(n)));
    assert.ok(conditional.length === 4, 'all four loose docs found');
    assert.ok(conditional.every(i => /only if you want to claim/i.test(i.reason)), 'each loose doc carries a conditional reason');
    // docs the forms supersede are absent
    assert.ok(!hasLabel(rec.outstanding, 'Logbook'), 'logbook folded into the vehicle form');
    assert.ok(!hasLabel(rec.outstanding, 'Till slips'), 'till slips folded into the commission form');
    assert.ok(!hasLabel(rec.outstanding, 'Service records'), 'service records folded into the vehicle form');
});

test('commission (3606) bank-statements reason interpolates the tax-year range, never a hardcoded one', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3606'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    const bank = rec.outstanding.find(i => i.label.includes('Bank statements'));
    assert.ok(bank, 'bank statements present');
    assert.ok(bank!.reason.includes(rec.taxYear.rangeText), 'reason carries the derived range text');
    assert.ok(!bank!.reason.includes('{taxYearRange}'), 'the token is interpolated, not left raw');
});

test('company car (3802): vehicle form present, fringe-benefit letter present, medical/RA not duplicated', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3802'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    assert.deepEqual(rec.matchedSourceCodes, ['3802']);
    assert.ok(rec.outstanding.some(i => i.formKey === 'vehicle_detail'), 'vehicle detail sheet form present');
    assert.equal(rec.outstanding[0].kind, 'form', 'form leads');
    assert.ok(hasLabel(rec.outstanding, 'Fringe-benefit letter'), 'fringe-benefit letter present');
    // baseline medical aid / RA appear exactly once (not duplicated by the 3802 spec)
    const medCount = rec.outstanding.filter(i => /medical aid/i.test(i.label)).length;
    const raCount = rec.outstanding.filter(i => /retirement annuity|\bra\b/i.test(i.label)).length;
    assert.equal(medCount, 1, 'medical aid certificate listed once (baseline only)');
    assert.equal(raCount, 1, 'RA certificate listed once (baseline only)');
});

test('combined [3606, 3701]: de-duplicated, single vehicle form, no doc twice, forms leading', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3606', '3701'],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    const vehicleForms = rec.outstanding.filter(i => i.formKey === 'vehicle_detail');
    assert.equal(vehicleForms.length, 1, 'vehicle detail sheet not duplicated across the two codes');
    assert.ok(rec.outstanding.some(i => i.formKey === 'commission_expenses'), 'commission form present');
    // no label appears twice
    const labels = rec.outstanding.map(i => i.label);
    assert.equal(new Set(labels).size, labels.length, 'no doc listed twice');
    // purchase agreement (in both 3606 and 3701) appears once
    const purchaseCount = rec.outstanding.filter(i => i.label.includes('Vehicle purchase')).length;
    assert.equal(purchaseCount, 1, 'purchase agreement de-duped across the two codes');
    // forms lead the list
    const firstDocIdx = rec.outstanding.findIndex(i => i.kind === 'doc');
    const lastFormIdx = rec.outstanding.map(i => i.kind).lastIndexOf('form');
    assert.ok(lastFormIdx < firstDocIdx, 'all forms come before the first loose doc');
});

test('3802 already-received fringe-benefit letter diverts out of outstanding', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3802'],
        industryName: null,
        receivedLabels: ['Fringe-benefit letter from your employer'],
        today: TODAY,
    });
    assert.ok(hasLabel(rec.received, 'Fringe-benefit letter'), 'received letter recognised');
    assert.ok(!hasLabel(rec.outstanding, 'Fringe-benefit letter'), 'received letter not re-asked');
});

test('3606 client-stated bank statements divert out of outstanding without counting as received', () => {
    const rec = buildDocRecommendation({
        sourceCodes: ['3606'],
        industryName: null,
        receivedLabels: [],
        clientStatedLabels: ['Bank statements'],
        today: TODAY,
    });
    assert.ok(hasLabel(rec.clientStated, 'Bank statements'), 'client-stated bank statements surfaced distinctly');
    assert.ok(!hasLabel(rec.outstanding, 'Bank statements'), 'client-stated bank statements not re-asked');
    assert.ok(!hasLabel(rec.received, 'Bank statements'), 'client-stated is NOT a verified receipt');
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

// ── Issue 03: baseline relabel + rental industry upgrade ─────────────────

test('Issue 03 baseline: no-code list is exactly IRP5, investment certs, medical aid, RA — no bank statements, no ID', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null,
        receivedLabels: [],
        today: TODAY,
    });
    assert.deepEqual(labels(rec.outstanding), [
        'IRP5',
        'Investment tax certificates (IT3(b)/IT3(c))',
        'Medical aid tax certificate',
        'Retirement Annuity (RA) tax certificate',
    ]);
    assert.ok(!hasLabel(rec.outstanding, 'bank statement'), 'no bank statements in baseline');
    assert.ok(!hasLabel(rec.outstanding, 'id document'), 'no ID document in baseline');
});

test('Issue 03 baseline: an uploaded "IT3(b)" loose-matches the relabelled item → received, not outstanding', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null,
        receivedLabels: ['IT3(b)'],
        today: TODAY,
    });
    assert.ok(hasLabel(rec.received, 'Investment tax certificates'), 'IT3(b) recognised against the relabelled item');
    assert.ok(!hasLabel(rec.outstanding, 'Investment tax certificates'), 'not re-asked once received');
});

test('Issue 03 rental: landlord industry yields the full upgraded rental set, each with a reason', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: 'Residential property landlord',
        receivedLabels: [],
        today: TODAY,
    });
    for (const needle of [
        'Lease agreement',
        'Bank statement showing rent received',
        'Bond statement',
        'Rates & levies',
        'Maintenance & repairs',
        'Insurance',
        'Agency commission paid',
    ]) {
        assert.ok(hasLabel(rec.outstanding, needle), `rental set includes "${needle}"`);
    }
    const rentalItems = rec.outstanding.filter(i =>
        ['lease', 'rent received', 'bond', 'rates', 'maintenance', 'insurance', 'agency commission']
            .some(t => i.label.toLowerCase().includes(t)));
    assert.ok(rentalItems.every(i => i.reason.trim().length > 0), 'every rental item carries a reason');
});

// ── Issue 04: foreign + rental topic path ────────────────────────────────

test('Issue 04 foreign_income: proof-of-income + passport, exemption reasoning in reasons, no standalone advice item', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null,
        receivedLabels: [],
        topic: 'foreign_income',
        today: TODAY,
    });
    assert.equal(rec.matchedTopic, 'foreign_income');
    assert.ok(rec.hasPersonalisation, 'a disclosed topic counts as personalisation');
    assert.ok(hasLabel(rec.outstanding, 'Proof of foreign income'), 'proof of foreign income surfaced');
    assert.ok(hasLabel(rec.outstanding, 'Passport showing exit and entry stamps'), 'passport-with-stamps surfaced');
    // Docs only — the 183-day / exemption logic lives in the reason, never as a
    // standalone advice/ruling item.
    assert.ok(rec.outstanding.every(i => i.kind === 'doc'), 'topic surfaces documents only, no advice item');
    const passport = rec.outstanding.find(i => /passport/i.test(i.label));
    assert.ok(passport, 'passport item present');
    assert.match(passport!.reason, /183 days/, '183-day test carried in the reason');
    assert.match(passport!.reason, /60 of them consecutive/, '60-consecutive-day test carried in the reason');
    assert.match(passport!.reason, /R1\.25 ?million/i, 'R1.25m exemption carried in the reason');
});

test('Issue 04 rental_income topic: yields the full rental set even with no rental industry on file', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null, // no rental industry
        receivedLabels: [],
        topic: 'rental_income',
        today: TODAY,
    });
    assert.equal(rec.matchedTopic, 'rental_income');
    for (const needle of [
        'Lease agreement',
        'Bank statement showing rent received',
        'Bond statement',
        'Rates & levies',
        'Maintenance & repairs',
        'Insurance',
        'Agency commission paid',
    ]) {
        assert.ok(hasLabel(rec.outstanding, needle), `rental topic includes "${needle}"`);
    }
});

test('Issue 04 rental_income topic mirrors the rental industry set exactly (one list, not two)', () => {
    const viaTopic = buildDocRecommendation({
        sourceCodes: [], industryName: null, receivedLabels: [], topic: 'rental_income', today: TODAY,
    });
    const viaIndustry = buildDocRecommendation({
        sourceCodes: [], industryName: 'Residential property landlord', receivedLabels: [], today: TODAY,
    });
    const rentalOf = (items: DocRecommendationItem[]) => items
        .map(i => i.label)
        .filter(l => /lease|rent received|bond|rates|maintenance|insurance|agency commission/i.test(l))
        .sort();
    assert.deepEqual(rentalOf(viaTopic.outstanding), rentalOf(viaIndustry.outstanding),
        'the topic surfaces the identical rental docs the industry trigger does');
});

test('Issue 04 year derivation: foreign-income period reason tracks a later tax year, not a hardcoded 2026 range', () => {
    const later = new Date('2031-06-01T00:00:00Z'); // 2031 tax year
    const rec = buildDocRecommendation({
        sourceCodes: [], industryName: null, receivedLabels: [], topic: 'foreign_income', today: later,
    });
    const proof = rec.outstanding.find(i => /proof of foreign income/i.test(i.label));
    assert.ok(proof, 'proof-of-income item present');
    assert.match(proof!.reason, /2031 tax year/, "period reason reflects the injected year's rangeText");
    assert.ok(!/2026/.test(proof!.reason), 'no hardcoded 2026 range');
    assert.ok(!proof!.reason.includes('{taxYearRange}'), 'the period token is interpolated, not leaked');
});

test('Issue 04 topic calls: already-received / client-stated items divert out of outstanding', () => {
    const rec = buildDocRecommendation({
        sourceCodes: [],
        industryName: null,
        receivedLabels: ['Passport showing exit and entry stamps'],
        clientStatedLabels: ['Proof of foreign income for the tax year'],
        topic: 'foreign_income',
        today: TODAY,
    });
    assert.ok(hasLabel(rec.received, 'Passport'), 'received passport recognised');
    assert.ok(!hasLabel(rec.outstanding, 'Passport'), 'received passport not re-asked');
    assert.ok(hasLabel(rec.clientStated, 'Proof of foreign income'), 'client-stated proof surfaced distinctly');
    assert.ok(!hasLabel(rec.outstanding, 'Proof of foreign income'), 'client-stated proof not re-asked');
});

test('Issue 04: existing no-topic calls behave unchanged (matchedTopic null)', () => {
    const withTopic = buildDocRecommendation({
        sourceCodes: [], industryName: null, receivedLabels: [], today: TODAY,
    });
    assert.equal(withTopic.matchedTopic, null, 'no topic → matchedTopic null');
    // Adding no topic leaves the baseline-only outstanding list intact.
    assert.ok(hasLabel(withTopic.outstanding, 'IRP5'));
    assert.ok(!hasLabel(withTopic.outstanding, 'Passport'), 'no foreign docs without the topic');
    assert.ok(!hasLabel(withTopic.outstanding, 'Lease agreement'), 'no rental docs without the topic or industry');
});
