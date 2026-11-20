/**
 * The user (20 Nov 2026): when the client's form goes out, the claim's broker gets a link of their own to the same form, so
 * they can fill it in when the client is stuck. It saves to the claim; signing, Submit, the terms and stopping the reminders
 * stay the client's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { BROKER_LINK_DAYS, brokerFormOn, createGuidedLink, kindOf, memoryLinkStore, openGuidedLink, type GuidedLinkDeps, type GuidedLinkRow } from '../../src/claimform/links';
import { claimFormPage } from '../../src/claimform/page';
import { claimFormRouter, type ClaimFormSession } from '../../src/routes/claimForm.route';

const INPUT = { claimId: 'claim-1', phone: '27820000000', contactId: 'contact-1' };
const tokenOf = (url: string) => url.split('/').pop()!;

function deps(now: () => Date) {
    const shared: { claimId: string; url: string; expiresAt: string }[] = [];
    const d: GuidedLinkDeps & { store: ReturnType<typeof memoryLinkStore> } = {
        store: memoryLinkStore(), publicUrl: 'https://tina.example', now,
        onBrokerLink: async (l) => { shared.push(l); },
    };
    return { d, shared };
}
const rowsOf = (d: { store: ReturnType<typeof memoryLinkStore> }) => [...d.store.rows.values()];

test('the client\'s link also makes the broker\'s link, once, and the broker\'s is told to whoever puts it on the claim', async () => {
    let at = new Date('2026-11-20T08:00:00Z');
    const { d, shared } = deps(() => at);
    const client = await createGuidedLink(d, INPUT);
    assert.equal(shared.length, 1);
    assert.notEqual(shared[0].url, client.url);
    assert.equal(shared[0].claimId, 'claim-1');
    assert.equal(Date.parse(shared[0].expiresAt) - at.getTime(), BROKER_LINK_DAYS * 86_400_000);
    const broker = rowsOf(d).find((r) => kindOf(r) === 'broker')!;
    // The client's details, so the broker's answers and files go through the same pipeline as the client's.
    assert.deepEqual([broker.claim_id, broker.phone, broker.contact_id], [INPUT.claimId, INPUT.phone, INPUT.contactId]);
    // The morning reminder makes a new client link: the broker's stays, and no second one is made or emailed.
    at = new Date(at.getTime() + 86_400_000);
    const next = await createGuidedLink(d, INPUT);
    assert.equal(shared.length, 1);
    assert.deepEqual(await openGuidedLink(d, tokenOf(client.url)), { ok: false, reason: 'superseded' });
    assert.equal((await openGuidedLink(d, tokenOf(next.url))).ok, true);
    assert.equal((await openGuidedLink(d, tokenOf(shared[0].url))).ok, true, 'a new client link never stops the broker\'s');
});

test('a broker link that ran out is made again with the next client link', async () => {
    let at = new Date('2026-11-20T08:00:00Z');
    const { d, shared } = deps(() => at);
    await createGuidedLink(d, INPUT);
    at = new Date(at.getTime() + (BROKER_LINK_DAYS + 1) * 86_400_000);
    await createGuidedLink(d, INPUT);
    assert.equal(shared.length, 2);
    assert.deepEqual(await openGuidedLink(d, tokenOf(shared[0].url)), { ok: false, reason: 'superseded' });
    assert.equal((await openGuidedLink(d, tokenOf(shared[1].url))).ok, true);
});

test('without the hook (CLAIMS_BROKER_FORM off) there is no broker link, and a link that can\'t be shared never fails the client\'s', async () => {
    const off = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    await createGuidedLink(off, INPUT);
    assert.equal(rowsOf(off).length, 1);
    const failing = { store: memoryLinkStore(), publicUrl: 'https://tina.example', onBrokerLink: async () => { throw new Error('Dataverse down'); } };
    const made = await createGuidedLink(failing, INPUT);
    assert.equal((await openGuidedLink(failing, tokenOf(made.url))).ok, true);
    assert.equal(brokerFormOn(undefined), false);
    assert.equal(brokerFormOn(' On '), true);
    assert.equal(brokerFormOn('yes'), false);
});

test('a client link written without the broker feature has no kind column, as before the migration', async () => {
    const d = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    await createGuidedLink(d, INPUT);
    assert.ok(!('kind' in rowsOf(d)[0]));
});

function fakeSession(calls: string[]): ClaimFormSession {
    return {
        view: async () => ({ reference: 'CLM-1', terms: { title: 'T', lines: ['l'], agree: 'Agree' } } as never),
        save: async (input) => { calls.push(`save:${JSON.stringify(input.answers)}:terms=${input.termsAccepted}`); return { problems: [], answers: {}, notKnown: [], open: [] }; },
        file: async () => { calls.push('file'); return { count: 1 }; },
        hear: async () => ({ text: '' }),
        finish: async () => { calls.push('finish'); return { open: [] }; },
        carryOn: async () => { calls.push('carryOn'); },
        stopReminders: async () => { calls.push('stopReminders'); },
    };
}

async function server(d: GuidedLinkDeps, calls: string[]) {
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session: (_l: GuidedLinkRow) => fakeSession(calls), whatsApp: '27111111111', signOnForm: true })));
    const s = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/claim-form`, close: () => new Promise((r) => s.close(r)) };
}

test('the broker\'s link saves answers and files, but never signs, submits, accepts the terms or stops the reminders', async () => {
    const { d, shared } = deps(() => new Date());
    const client = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls);
    const post = (token: string, path: string, body: unknown) => fetch(`${s.base}/${token}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        const b = tokenOf(shared[0].url);
        const state = await (await fetch(`${s.base}/${b}/state`)).json() as { broker?: boolean; sign?: boolean; terms?: unknown };
        assert.equal(state.broker, true);
        assert.equal(state.sign, undefined, 'nothing to sign on the broker\'s link');
        assert.equal(state.terms, undefined, 'the terms are the client\'s');
        const own = await (await fetch(`${s.base}/${tokenOf(client.url)}/state`)).json() as { broker?: boolean; sign?: boolean; terms?: unknown };
        assert.deepEqual([own.broker, own.sign, !!own.terms], [undefined, true, true], 'the client\'s own link is unchanged');

        assert.equal((await post(b, '/answers', { answers: [{ key: 'vehicleMake', value: 'Toyota' }], termsAccepted: true })).status, 200);
        assert.deepEqual(calls, ['save:[{"key":"vehicleMake","value":"Toyota"}]:terms=false']);
        const refused = await post(b, '/submit', { signature: 'data:image/png;base64,xx' });
        assert.equal(refused.status, 403);
        assert.match(((await refused.json()) as { message: string }).message, /Only the client/);
        assert.equal((await post(b, '/stop-reminders', {})).status, 403);
        assert.ok(!calls.includes('finish') && !calls.includes('carryOn') && !calls.includes('stopReminders'));
        // The broker's link is still open; the client's link is untouched.
        assert.equal(rowsOf(d).filter((r) => r.status === 'open').length, 2);
    } finally { await s.close(); }
});

test('the page tells the broker whose form it is, saves for the client, and offers no Stop reminders', () => {
    const html = claimFormPage();
    assert.match(html, /You are filling in this claim form for your client/);
    assert.match(html, /Save for the client/);
    assert.match(html, /\$\('stopline'\)\.hidden = !!s\.broker/);
    assert.match(html, /if \(V\.broker\) return brokerSave\(\)/);
});
