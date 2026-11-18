/**
 * The user (18 Nov 2026): once a claim's form is submitted, Tina lists what's still missing with a link to a form of only
 * those items (the claims package's guided.ts topUp). That form has nothing to sign: the route asks for no signature,
 * keeps none, and tells Tina the client is done so she can thank them and list what's left.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGuidedLink, formSignatureFor, memoryLinkStore, openGuidedLink, type GuidedLinkDeps, type GuidedLinkRow } from '../../src/claimform/links';
import { claimFormPage } from '../../src/claimform/page';
import { claimFormRouter, type ClaimFormSession } from '../../src/routes/claimForm.route';

const INPUT = { claimId: 'claim-1', phone: '27820000000', contactId: 'contact-1' };
const tokenOf = (url: string) => url.split('/').pop()!;

function topUpSession(calls: string[]): ClaimFormSession {
    return {
        view: async () => ({ reference: 'CLM-1', topUp: true, screens: [], evidence: [{ key: 'driversLicence' }] } as never),
        save: async () => ({ problems: [], answers: {}, notKnown: [], open: [] } as never),
        file: async () => ({ count: 1 }),
        hear: async () => ({ text: '' }),
        finish: async () => { calls.push('finish'); return { open: [], topUp: true }; },
        carryOn: async () => { calls.push('carryOn'); },
    };
}

async function server(d: GuidedLinkDeps, calls: string[]) {
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session: (_l: GuidedLinkRow) => topUpSession(calls), whatsApp: '27111111111', signOnForm: true })));
    const s = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/claim-form`, close: () => new Promise((r) => s.close(r)) };
}

test('the missing-items form: no signature asked for, Send carries on with Tina and closes the link, nothing kept to sign with', async () => {
    const d: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const { url } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls);
    try {
        const state = await (await fetch(`${s.base}/${tokenOf(url)}/state`)).json();
        assert.equal(state.topUp, true);
        assert.equal(state.sign, undefined, 'signing is set up, but there is nothing to sign');
        const r = await fetch(`${s.base}/${tokenOf(url)}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { ok: true, open: [] });
        assert.deepEqual(calls, ['finish', 'carryOn']);
        assert.equal(await formSignatureFor(d, INPUT.claimId), null);
        assert.equal((await openGuidedLink(d, tokenOf(url))).ok, false, 'the link is done');
    } finally { await s.close(); }
});

test('an email claim\'s missing-items link: saved on the claim, but the email agent is not told to sign or fill again', async () => {
    const d: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const { url } = await createGuidedLink(d, { ...INPUT, callbackUrl: 'https://agent.example/form-done' });
    const calls: string[] = [];
    const s = await server(d, calls);
    try {
        const r = await fetch(`${s.base}/${tokenOf(url)}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(r.status, 200);
        assert.deepEqual(calls, ['finish']);
    } finally { await s.close(); }
});

test('the page knows the missing-items form: its own route, Send, and its own last words', () => {
    const html = claimFormPage();
    assert.match(html, /if \(V\.topUp\) \{/);
    assert.match(html, /'Send'/);
    assert.match(html, /We have added this to your claim\./);
    assert.match(html, /Nothing more needed/);
});
