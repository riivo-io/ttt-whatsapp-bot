/**
 * Characterization tests for the pure CLIENT role-context builder in
 * src/domain/clientRoleContext.ts (Issue 24 — doc-journey greeting + trigger).
 *
 * These lock the journey-driven prompt copy: a clean greeting with no IRP5
 * demand, launch-on-commitment / offer-on-fuzzy guidance, the protective IRP5
 * ask copy, and the no-IRP5 / season-timing branches. Driven directly with
 * fixtures — no mocks, no DB, no clock.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildClientRoleContext,
    IRP5_ASK_COPY,
} from '../../src/domain/clientRoleContext';

// Extract just the "First-message greeting — REQUIRED FORMAT" section so we can
// assert on the greeting in isolation from the journey guidance.
function greetingBlock(ctx: string): string {
    const marker = '**First-message greeting — REQUIRED FORMAT:**';
    const idx = ctx.indexOf(marker);
    return idx === -1 ? '' : ctx.slice(idx);
}

test('first message: greeting keeps its shape', () => {
    const ctx = buildClientRoleContext({ firstName: 'Luc', isFirstMessage: true });
    const greeting = greetingBlock(ctx);
    assert.ok(greeting, 'greeting block present on first message');
    assert.match(greeting, /Hey Luc! 👋/);
    assert.match(greeting, /TTT tax sidekick/);
    assert.match(greeting, /What do you need today\?/);
    // The four emoji-signposted capabilities stay. Consultant callbacks are NOT
    // advertised as a capability (proactive consultant handoffs are off — Tina
    // only routes a consultant on an explicit client ask).
    for (const cap of ['📄 invoices', '📂 tax return updates', '📎 uploading tax docs', '📅 tax season info']) {
        assert.ok(greeting.includes(cap), `greeting mentions ${cap}`);
    }
    assert.ok(!greeting.includes('📞 consultant callbacks'), 'greeting does NOT advertise consultant callbacks');
});

test('first message: greeting carries NO IRP5 / document demand', () => {
    const ctx = buildClientRoleContext({ firstName: 'Luc', isFirstMessage: true });
    const greeting = greetingBlock(ctx);
    // The greeting must explicitly forbid asking for a doc — and must not carry
    // the old first-message IRP5 injection hint.
    assert.match(greeting, /Do NOT ask for an IRP5 or any document in the greeting/);
    assert.ok(!greeting.includes('IRP5 STATUS'), 'no injected IRP5 status hint');
    assert.ok(
        !/ask(ing)? if they have their latest IRP5/i.test(greeting),
        'no greeting-time IRP5 ask hint',
    );
});

test('not first message: greeting block omitted', () => {
    const ctx = buildClientRoleContext({ firstName: 'Luc', isFirstMessage: false });
    assert.equal(greetingBlock(ctx), '', 'no greeting format block when not first message');
});

test('journey is launch-on-commitment, offer-on-fuzzy', () => {
    const ctx = buildClientRoleContext({ firstName: 'Luc', isFirstMessage: false });
    assert.match(ctx, /LAUNCH the journey/);
    assert.match(ctx, /OFFER/);
    // Fuzzy signal is an offer, not a launch.
    assert.match(ctx, /it's tax season/);
    // Unprompted IRP5 upload launches.
    assert.match(ctx, /sends an IRP5 unprompted/);
});

test('IRP5 ask copy is protective, multi-employer, already-sent-aware', () => {
    const ctx = buildClientRoleContext({ firstName: 'Luc', isFirstMessage: true });
    assert.ok(ctx.includes(IRP5_ASK_COPY), 'ask copy woven into the context');
    // The three framings the PRD requires, in one message.
    assert.match(IRP5_ASK_COPY, /changed jobs/);
    assert.match(IRP5_ASK_COPY, /every one for an accurate return/);
    assert.match(IRP5_ASK_COPY, /already sent these to your consultant/);
});

test('no-IRP5 and season-timing branches explain rather than demand', () => {
    const ctx = buildClientRoleContext({ firstName: 'Luc', isFirstMessage: false });
    // No-IRP5 branch: explain why, fall back to CRM profile.
    assert.match(ctx, /sole prop/i);
    assert.match(ctx, /EXPLAIN why they wouldn't have one/);
    assert.match(ctx, /get_required_documents/);
    // Season timing: explain, and prior-year proceeds normally.
    assert.match(ctx, /TOO EARLY in the season/);
    assert.match(ctx, /prior-year or catch-up return proceeds normally/);
});
