/**
 * The user (9 Nov 2026): the client signs at the end of the guided form. The route asks for the signature on a WhatsApp
 * link when signing is set up, keeps it on the link once the form is ready, and the signing step signs the filled form
 * with it through the signing page's own signRequest (src/claimform/signOnForm.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import zlib from 'zlib';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { createGuidedLink, formSignatureFor, memoryLinkStore, type GuidedLinkDeps, type GuidedLinkRow } from '../../src/claimform/links';
import { emailClaimSigning, signWithFormSignature } from '../../src/claimform/signOnForm';
import { claimFormRouter, type ClaimFormDeps, type ClaimFormSession } from '../../src/routes/claimForm.route';
import { createSigningRequest, sha256, type SigningDeps } from '../../src/signing/signing';
import { memorySigningStore } from '../../src/signing/store';

const INPUT = { claimId: 'claim-1', phone: '27820000000', contactId: 'contact-1' };
const tokenOf = (url: string) => url.split('/').pop()!;

/** A small PNG with a pen stroke, as the pad makes one. */
function pngSignature(W = 120): string {
    const H = 40, raw = Buffer.alloc((W * 4 + 1) * H);
    for (let x = 5; x < W - 5; x++) {
        const y = Math.round(20 + Math.sin(x / 8) * 10);
        const i = y * (W * 4 + 1) + 1 + x * 4;
        raw[i] = 20; raw[i + 1] = 30; raw[i + 2] = 60; raw[i + 3] = 255;
    }
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t: string, d: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    return `data:image/png;base64,${png.toString('base64')}`;
}

function fakeSession(calls: string[]): ClaimFormSession {
    return {
        view: async () => ({ reference: 'CLM-1' } as never),
        save: async () => ({ problems: [], answers: {}, notKnown: [], open: [] } as never),
        file: async () => ({ count: 1 }),
        hear: async () => ({ text: '' }),
        finish: async () => { calls.push('finish'); return { open: calls.includes('ready') ? [] : ['driversLicence'] }; },
        carryOn: async () => { calls.push('carryOn'); },
    };
}

async function server(d: GuidedLinkDeps, calls: string[], signOnForm: boolean, more: Partial<ClaimFormDeps> = {}) {
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session: (_l: GuidedLinkRow) => fakeSession(calls), whatsApp: '27111111111', signOnForm, ...more })));
    const s = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/claim-form`, close: () => new Promise((r) => s.close(r)) };
}
const submit = (base: string, url: string, body?: unknown) =>
    fetch(`${base}/${tokenOf(url)}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestPhone/1.0' }, body: JSON.stringify(body ?? {}) });

test('a WhatsApp link signs on the form when signing is set up; an email claim\'s link and a Tina without signing don\'t', async () => {
    const d: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const wa = await createGuidedLink(d, INPUT);
    const email = await createGuidedLink(d, { ...INPUT, claimId: 'claim-2', callbackUrl: 'https://agent.example/form-done' });
    const on = await server(d, [], true);
    const off = await server(d, [], false);
    try {
        assert.equal((await (await fetch(`${on.base}/${tokenOf(wa.url)}/state`)).json()).sign, true);
        assert.equal((await (await fetch(`${on.base}/${tokenOf(email.url)}/state`)).json()).sign, undefined);
        assert.equal((await (await fetch(`${off.base}/${tokenOf(wa.url)}/state`)).json()).sign, undefined);
    } finally { await on.close(); await off.close(); }
});

test('no signature, or one that isn\'t a PNG from the pad: refused before anything is checked or saved', async () => {
    const d: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const { url } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls, true);
    try {
        for (const body of [{}, { signature: 'data:image/png;base64,AAAA' }, { signature: 'data:image/jpeg;base64,/9j/4AAQ' }]) {
            const r = await submit(s.base, url, body);
            assert.equal(r.status, 400);
            assert.equal((await r.json()).message, 'Please sign in the box.');
        }
        assert.deepEqual(calls, []);
    } finally { await s.close(); }
});

test('a required photo still missing: not signed, nothing kept; ready: the signature is kept on the link with who and when, and Tina carries on once', async () => {
    const d: GuidedLinkDeps & { store: ReturnType<typeof memoryLinkStore> } = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const { url, id } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls, true);
    const sig = pngSignature();
    try {
        assert.deepEqual(await (await submit(s.base, url, { signature: sig })).json(), { ok: false, open: ['driversLicence'] });
        assert.equal(await formSignatureFor(d, INPUT.claimId), null);
        calls.push('ready');
        assert.deepEqual(await (await submit(s.base, url, { signature: sig })).json(), { ok: true, open: [] });
        const kept = d.store.rows.get(id)!;
        assert.equal(kept.signature, sig);
        assert.equal(kept.signature_user_agent, 'TestPhone/1.0');
        assert.ok(kept.signature_ip);
        assert.ok(kept.signed_at);
        assert.equal(kept.status, 'done');
        assert.equal(calls.filter((c) => c === 'carryOn').length, 1);
    } finally { await s.close(); }
});

test('the signing step signs the filled form with the form\'s signature: the drawing is taken off the link, the callback goes, the request is used', async () => {
    const links: GuidedLinkDeps & { store: ReturnType<typeof memoryLinkStore> } = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const posted: string[] = [];
    const store = memorySigningStore();
    const signing: SigningDeps = {
        store, publicUrl: 'https://tina.example', callbackSecret: 'secret', retryDelayMs: 0,
        post: async (url, body) => { posted.push(`${url} ${JSON.parse(body).audit?.ip}`); return { ok: true, status: 200, text: 'ok' }; },
    };
    const { id } = await createGuidedLink(links, INPUT);
    await links.store.update(id, { signature: pngSignature(), signature_ip: '196.1.2.3', signature_user_agent: 'TestPhone/1.0', signed_at: new Date().toISOString() });

    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const pdf = await doc.save();
    const request = await createSigningRequest(signing, {
        document: pdf, documentHash: sha256(pdf), fileName: 'Claim form.pdf', title: 'Claim form', channel: 'whatsapp', sentTo: INPUT.phone,
        caller: 'claim', callerRecordId: INPUT.claimId, callbackUrl: 'https://tina.example/webhook/claim-signed',
        stamps: [{ kind: 'signature', page: 1, x: 100, y: 100, width: 160, height: 30 }],
    });

    const s = signWithFormSignature(signing, links);
    const held = await s.formSignature!(INPUT.claimId);
    assert.ok(held);
    assert.equal(held.ip, '196.1.2.3');
    // Taken: the link keeps no drawing once the signing step has it.
    assert.equal(links.store.rows.get(id)!.signature, null);
    assert.equal(await s.formSignature!(INPUT.claimId), null);

    assert.equal(await s.signWithFormSignature!(request, held), true);
    const row = store.rows.get(request.id)!;
    assert.equal(row.status, 'used');
    assert.equal(row.audit?.ip, '196.1.2.3');
    assert.equal(row.audit?.userAgent, 'TestPhone/1.0');
    assert.deepEqual(posted, ['https://tina.example/webhook/claim-signed 196.1.2.3']);
});

test('a signature the signing page refuses: false, so the link goes instead', async () => {
    const links: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const signing: SigningDeps = { store: memorySigningStore(), publicUrl: 'https://tina.example', callbackSecret: 'secret', retryDelayMs: 0, post: async () => ({ ok: true, status: 200, text: 'ok' }) };
    const s = signWithFormSignature(signing, links);
    const gone = { id: 'r-x', link: 'https://tina.example/sign/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expiresAt: '2026-11-16T00:00:00Z' };
    assert.equal(await s.signWithFormSignature!(gone, { signature: pngSignature(), ip: null, userAgent: null }), false);
});

// ---- the user (9 Nov 2026): an email claim's client signs on the form too -------------------------------------------

const EMAIL_CLAIM = '0b7e7c1e-1111-4a2b-9c3d-000000000002';

async function emailSetup() {
    const links: GuidedLinkDeps & { store: ReturnType<typeof memoryLinkStore> } = { store: memoryLinkStore(), publicUrl: 'https://tina.example' };
    const posted: string[] = [];
    const store = memorySigningStore();
    const signing: SigningDeps = {
        store, publicUrl: 'https://tina.example', callbackSecret: 'secret', retryDelayMs: 0,
        post: async (url) => { posted.push(url); return { ok: true, status: 200, text: 'ok' }; },
    };
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const pdf = await doc.save();
    const request = (caller: string) => createSigningRequest(signing, {
        document: pdf, documentHash: sha256(pdf), fileName: 'Claim form.pdf', title: 'Claim form', channel: 'email', sentTo: 'client@example.com',
        caller, callerRecordId: EMAIL_CLAIM, callbackUrl: 'https://agent.example/api/claim-signed',
        stamps: [{ kind: 'signature', page: 1, x: 100, y: 100, width: 160, height: 30 }],
    });
    return { links, signing, store, posted, request };
}

test('an email claim\'s link signs on the form when the email agent can use the signature', async () => {
    const { links, signing } = await emailSetup();
    const email = await createGuidedLink(links, { ...INPUT, claimId: EMAIL_CLAIM, phone: '', callbackUrl: 'https://agent.example/form-done' });
    const s = await server(links, [], true, { emailSigning: emailClaimSigning(signing, links) });
    try {
        assert.equal((await (await fetch(`${s.base}/${tokenOf(email.url)}/state`)).json()).sign, true);
    } finally { await s.close(); }
});

test('the email agent\'s half: is there a signature, then sign its own claim-email request with it, with the API key only', async () => {
    const { links, signing, store, posted, request } = await emailSetup();
    const { id } = await createGuidedLink(links, { ...INPUT, claimId: EMAIL_CLAIM, phone: '', callbackUrl: 'https://agent.example/form-done' });
    const s = await server(links, [], true, { apiKey: 'k', emailSigning: emailClaimSigning(signing, links) });
    const call = (path: string, body: unknown, key = 'k') => fetch(`${s.base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    try {
        assert.equal((await call('form-signature', { claimId: EMAIL_CLAIM }, 'wrong')).status, 401);
        assert.deepEqual(await (await call('form-signature', { claimId: EMAIL_CLAIM })).json(), { ok: true, found: false });
        await links.store.update(id, { signature: pngSignature(), signature_ip: '196.1.2.3', signature_user_agent: 'TestPhone/1.0', signed_at: new Date().toISOString() });
        assert.deepEqual(await (await call('form-signature', { claimId: EMAIL_CLAIM })).json(), { ok: true, found: true });

        // Only the email agent's own requests: one made as Tina's 'claim' caller is refused, and the drawing stays.
        const tinas = await request('claim');
        const refused = await call('sign-with-form', { link: tinas.link });
        assert.equal(refused.status, 409);
        assert.equal((await refused.json()).reason, 'not-this-caller');
        assert.ok(links.store.rows.get(id)!.signature);

        const mine = await request('claim-email');
        assert.equal((await call('sign-with-form', { link: mine.link }, 'wrong')).status, 401);
        assert.deepEqual(await (await call('sign-with-form', { link: mine.link })).json(), { ok: true });
        const row = store.rows.get(mine.id)!;
        assert.equal(row.status, 'used');
        assert.equal(row.audit?.ip, '196.1.2.3');
        // Used once: the drawing is off the link, and a second request gets the link instead.
        assert.equal(links.store.rows.get(id)!.signature, null);
        const again = await request('claim-email');
        assert.equal((await (await call('sign-with-form', { link: again.link })).json()).reason, 'no-signature');
        await new Promise((r) => setTimeout(r, 20));
        assert.deepEqual(posted, ['https://agent.example/api/claim-signed']);
    } finally { await s.close(); }
});
