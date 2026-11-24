/**
 * The user (20 Nov 2026): the client's link and the broker's link save to the same claim, maybe at the same time. The page
 * says what it showed for every key it saves untyped (`seen`), so the claims package never blanks the other person's answer
 * (guided.ts withoutStale, tested in the agent), and each save says whose link it came from (`by`), from the link only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGuidedLink, kindOf, memoryLinkStore, type GuidedLinkDeps, type GuidedLinkRow } from '../../src/claimform/links';
import { claimFormPage } from '../../src/claimform/page';
import { claimFormRouter, type ClaimFormSession } from '../../src/routes/claimForm.route';
import type { GuidedSave } from '../../src/departments/insurance/guided';

const INPUT = { claimId: 'claim-1', phone: '27820000000', contactId: 'contact-1' };
const tokenOf = (url: string) => url.split('/').pop()!;

async function setup() {
    const brokerUrls: string[] = [];
    const d: GuidedLinkDeps & { store: ReturnType<typeof memoryLinkStore> } = {
        store: memoryLinkStore(), publicUrl: 'https://tina.example', onBrokerLink: async (l) => { brokerUrls.push(l.url); },
    };
    const client = await createGuidedLink(d, INPUT);
    const saves: Array<{ kind: string; input: GuidedSave }> = [];
    const session = (link: GuidedLinkRow): ClaimFormSession => ({
        view: async () => ({ reference: 'CLM-1' } as never),
        save: async (input) => { saves.push({ kind: kindOf(link), input }); return { problems: [], answers: {}, notKnown: [], open: [], kept: ['vehicleModel'] }; },
        file: async () => ({ count: 1 }),
        hear: async () => ({ text: '' }),
        finish: async () => ({ open: [] }),
        carryOn: async () => undefined,
        stopReminders: async () => undefined,
    });
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session, whatsApp: '27111111111', signOnForm: true })));
    const s = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/claim-form`;
    const post = (token: string, body: unknown) => fetch(`${base}/${token}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { client: tokenOf(client.url), broker: tokenOf(brokerUrls[0]), saves, post, close: () => new Promise((r) => s.close(r)) };
}

test('each save says whose link it came from, from the link and never from what the page sent', async () => {
    const t = await setup();
    try {
        assert.equal((await t.post(t.client, { answers: [{ key: 'vehicleMake', value: 'Toyota' }], by: 'broker' })).status, 200);
        assert.equal((await t.post(t.broker, { answers: [{ key: 'vehicleModel', value: 'Hilux' }], by: 'client' })).status, 200);
        assert.deepEqual(t.saves.map((s) => [s.kind, s.input.by]), [['client', 'client'], ['broker', 'broker']]);
    } finally { await t.close(); }
});

test('what the page showed reaches the claims package, and what it kept comes back to the page', async () => {
    const t = await setup();
    try {
        const r = await t.post(t.client, { notKnown: ['vehicleModel', 'vehicleMake'], seen: { vehicleModel: null, vehicleMake: 'Toyota', count: 2, more: false } });
        assert.deepEqual(t.saves[0].input.seen, { vehicleModel: null, vehicleMake: 'Toyota', count: 2, more: false });
        assert.deepEqual(((await r.json()) as { kept?: string[] }).kept, ['vehicleModel']);
    } finally { await t.close(); }
});

test('a `seen` the page could not have sent is dropped, key by key, and never touches an object\'s prototype', async () => {
    const t = await setup();
    try {
        await t.post(t.client, { notKnown: ['a'], seen: { ok: 'x', [`k${'x'.repeat(130)}`]: 'long key', obj: { a: 1 }, arr: [1], big: 'y'.repeat(5001) } });
        assert.deepEqual(t.saves[0].input.seen, { ok: 'x' });
        await t.post(t.client, { notKnown: ['a'], seen: ['not', 'an', 'object'] });
        assert.equal(t.saves[1].input.seen, undefined);
        await t.post(t.client, { notKnown: ['a'], seen: 'nope' });
        assert.equal(t.saves[2].input.seen, undefined);
        // A key called __proto__ is just a key: an own property, and the map's prototype is a plain object's.
        await t.post(t.client, { notKnown: ['a'], seen: JSON.parse('{"__proto__": "x", "b": null}') });
        const seen = t.saves[3].input.seen!;
        assert.equal(Object.getPrototypeOf(seen), Object.prototype);
        assert.ok(Object.prototype.hasOwnProperty.call(seen, '__proto__'));
        assert.equal(seen.b, null);
        // A save with no `seen` (a page opened before this change) has none, so the claims package saves as before.
        await t.post(t.client, { notKnown: ['a'] });
        assert.ok(!('seen' in t.saves[4].input));
    } finally { await t.close(); }
});

test('the page sends what it showed for untyped keys, merges it across queued saves, and says when an answer was kept', () => {
    const html = claimFormPage();
    // The user (24 Nov 2026, code review): `seen` is what the server last said (SA), never a value a queued save of this page
    // still has on its way, and says which of them were an "I don't know" (SNK).
    assert.match(html, /function saw\(k\) \{ seen\[k\] = SA\[k\] !== undefined \? SA\[k\] : null; if \(SNK\[k\]/);
    assert.match(html, /return \{ answers: answers, notKnown: notKnown, cleared: cleared, seen: seen, seenNotKnown: seenNotKnown \};/);
    // A typed value (in draft) is sent without `seen`: the latest typed answer wins.
    assert.match(html, /if \(!\(f\.key in draft\)\) saw\(f\.key\)/);
    assert.match(html, /to\.seen = seen;/);
    // A reply sets what the server holds, and a waiting save is rebased on what this page's own save just wrote.
    assert.match(html, /fromServer\(r\);\s+rebase\(sent, r\.kept \|\| \[\]\);/);
    assert.match(html, /if \(r\.kept && r\.kept\.length\) \{ keptNote = true; keptCount\+\+; redraw = true; \}/);
    // Submit never goes with kept answers the client hasn't seen on the review page.
    assert.match(html, /if \(keptCount !== keptReviewed\) \{/);
    assert.match(html, /keptReviewed = keptCount;/);
    // One function per name: a second "function heard" would replace the voice notes' own.
    assert.equal(html.match(/function fromServer\(/g)?.length, 1);
    assert.equal(html.match(/function heard\(/g)?.length, 1);
    assert.match(html, /so we kept them/);
    assert.match(html, /data-keptok/);
});

test('the user (24 Nov 2026): which seen keys the page showed as "I don\'t know" reaches the claims package, only for keys in `seen`', async () => {
    const t = await setup();
    try {
        await t.post(t.client, { notKnown: ['a'], seen: { a: null, b: 'x' }, seenNotKnown: ['a', 'c', 7] });
        assert.deepEqual(t.saves[0].input.seenNotKnown, ['a']);
        // Without a `seen` there is nothing for it to say about.
        await t.post(t.client, { notKnown: ['a'], seenNotKnown: ['a'] });
        assert.ok(!('seenNotKnown' in t.saves[1].input));
        // A page opened before this change sends none, and the claims package reads it as before.
        await t.post(t.client, { notKnown: ['a'], seen: { a: null } });
        assert.ok(!('seenNotKnown' in t.saves[2].input));
    } finally { await t.close(); }
});
