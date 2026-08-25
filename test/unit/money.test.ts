/**
 * Tests for the single rand formatter in src/domain/money.ts.
 *
 * These lock the exact string Tina quotes to a client. The point of the module
 * is that no amount reaches the model without a currency on it, so the cases
 * that matter are: the R is always there, the decimals are always two, and the
 * output does not drift with the Node build's ICU locale data.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatZar } from '../../src/domain/money';

test('formats whole rands with two decimals', () => {
    assert.equal(formatZar(0), 'R0.00');
    assert.equal(formatZar(5), 'R5.00');
    assert.equal(formatZar(500), 'R500.00');
});

test('groups thousands with commas', () => {
    assert.equal(formatZar(1725), 'R1,725.00');
    assert.equal(formatZar(12340.5), 'R12,340.50');
    assert.equal(formatZar(1234567.891), 'R1,234,567.89');
});

test('rounds to cents', () => {
    assert.equal(formatZar(1.005), 'R1.00');   // binary float rounds down here
    assert.equal(formatZar(1.006), 'R1.01');
    assert.equal(formatZar(0.994), 'R0.99');
});

test('puts the sign outside the R for credits', () => {
    assert.equal(formatZar(-1725), '-R1,725.00');
    assert.equal(formatZar(-0.5), '-R0.50');
});

test('never renders a foreign or missing currency', () => {
    for (const amount of [0, 1, 1725, -1725, 1234567.891]) {
        const out = formatZar(amount);
        assert.ok(out.includes('R'), `expected an R in "${out}"`);
        assert.ok(!/[$€£]/.test(out), `unexpected foreign symbol in "${out}"`);
    }
});

test('degrades safely on non-finite input', () => {
    assert.equal(formatZar(NaN), 'R0.00');
    assert.equal(formatZar(Infinity), 'R0.00');
});
