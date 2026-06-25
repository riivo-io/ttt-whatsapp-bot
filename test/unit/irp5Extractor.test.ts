/**
 * Focused check that the IRP5 extractor surfaces source code 3802 (company car /
 * use-of-motor-vehicle fringe benefit) — the 3802 doc scenario in the
 * recommendation kernel (Issue 02) depends on it.
 *
 * The live `extractIrp5Fields` path lists "every visible 4-digit code" via the
 * forced-tool prompt, and 3802 is in `CODE_TO_COLUMN` (→ riivo_useofmotorvehiclepaye),
 * so it surfaces both from the model's `sourceCodes`/`codeAmounts` and from the
 * stored-row round-trip. The pure, deterministic surface we can assert without a
 * Claude call is the row→codes inverse, which is what the multi-employer union
 * (pendingUpload.service) actually relies on.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inferSourceCodesFromIrp5Row } from '../../src/services/irp5-extractor.service';

test('inferSourceCodesFromIrp5Row surfaces 3802 when the use-of-motor-vehicle column is set', () => {
    const row = { riivo_useofmotorvehiclepaye: 48000 };
    const codes = inferSourceCodesFromIrp5Row(row);
    assert.ok(codes.includes('3802'), '3802 inferred from a non-zero use-of-motor-vehicle column');
});

test('inferSourceCodesFromIrp5Row does NOT surface 3802 when the column is zero/absent', () => {
    assert.ok(!inferSourceCodesFromIrp5Row({ riivo_useofmotorvehiclepaye: 0 }).includes('3802'), 'zero → no 3802');
    assert.ok(!inferSourceCodesFromIrp5Row({ riivo_incomepaye: 350000 }).includes('3802'), 'unrelated column → no 3802');
});
