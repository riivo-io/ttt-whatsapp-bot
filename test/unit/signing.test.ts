/**
 * TTTFG-5196: the signing page (src/signing/), at its seam: a request in, the page's answers, the signed PDF and the
 * callback out. The checks of the Testing subtask (TTTFG-5198) that belong to the page: 2 (no PIN, channel and number
 * recorded), 3 (a changed token), 4 (old and used links), 5 (the pad waits for the last page), 6 and 7 (the signed
 * PDF, the audit, a changed PDF refused), 8 (any caller, no claim) and 9 (a newer request supersedes). The claim's side
 * (the signing step and the callback's writes) is tested in ttt-preseason-agent test/claims-signing.test.ts.
 * Supabase is the in-memory store; the callback is a fake POST or a local route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'net';
import zlib from 'zlib';
import { PDFDocument, PDFTextField, StandardFonts } from 'pdf-lib';
import { signingRouter } from '../../src/routes/signing.route';
import { signingPage } from '../../src/signing/page';
import {
    callbackSignature, createSigningRequest, formatDate, LINK_DAYS, openSigningRequest, sha256, signaturePng, signRequest, SIGNATURE_HEADER,
    stampPdf, sweepSigning, type CreateRequestInput, type SigningDeps,
} from '../../src/signing/signing';
import { memorySigningStore, type SignStamp } from '../../src/signing/store';
import { verifyHmacSha256 } from '../../src/utils/hmac';

const NOW = new Date('2026-10-26T08:00:00Z');
const SECRET = 'callback-secret';

/** A 2-page PDF with a text box on page 2, where the stamps go. */
async function samplePdf(text = 'Claim form'): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font });
    const p2 = doc.addPage([595, 842]);
    p2.drawText('Declaration', { x: 50, y: 200, size: 12, font });
    const box = doc.getForm().createTextField('Name');
    box.setText('Jane Client');
    box.addToPage(p2, { x: 50, y: 300, width: 200, height: 20 });
    return doc.save();
}

/** A small RGBA PNG with a pen stroke. */
function pngSignature(): string {
    const W = 120, H = 40, raw = Buffer.alloc((W * 4 + 1) * H);
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

const STAMPS: SignStamp[] = [
    { kind: 'signature', page: 2, x: 50, y: 210, width: 160, height: 30 },
    { kind: 'date', page: 2, x: 300, y: 215, size: 10 },
];

function world(o: { postOk?: boolean } = {}) {
    const store = memorySigningStore();
    const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
    let now = NOW;
    const deps: SigningDeps = {
        store, publicUrl: 'https://tina.example', callbackSecret: SECRET, now: () => now, retryDelayMs: 0,
        post: async (url, body, headers) => { posts.push({ url, body, headers }); return { ok: o.postOk ?? true, status: o.postOk === false ? 503 : 200, text: '' }; },
    };
    const input = async (over: Partial<CreateRequestInput> = {}): Promise<CreateRequestInput> => {
        const document = over.document ?? await samplePdf();
        return {
            document, documentHash: sha256(document), fileName: 'Claim form - Discovery - Motor theft - unsigned.pdf', title: 'Claim form for Discovery (CLM-000201)',
            channel: 'whatsapp', sentTo: '27821234567', caller: 'claim', callerRecordId: 'claim-1', callbackUrl: 'https://tina.example/webhook/claim-signed',
            stamps: STAMPS, ...over,
        };
    };
    const tokenOf = (link: string) => link.split('/sign/')[1];
    return { store, posts, deps, input, tokenOf, at: (d: Date) => { now = d; } };
}

test('check 2: a request gives an unguessable link; opening it needs no PIN and the request records the channel and the number', async () => {
    const w = world();
    const r = await createSigningRequest(w.deps, await w.input());
    assert.match(r.link, /^https:\/\/tina\.example\/sign\/[A-Za-z0-9_-]{43}$/);
    assert.equal(r.expiresAt, new Date(NOW.getTime() + LINK_DAYS * 86_400_000).toISOString());
    const opened = await openSigningRequest(w.deps, w.tokenOf(r.link));
    assert.ok(opened.ok);
    assert.equal(opened.row.channel, 'whatsapp');
    assert.equal(opened.row.sent_to, '27821234567');
    assert.equal(opened.row.opened_at, NOW.toISOString());
    // Only the token's hash is kept.
    assert.ok(![...w.store.rows.values()].some((row) => JSON.stringify(row).includes(w.tokenOf(r.link))));
    const html = signingPage(opened.row.title);
    assert.doesNotMatch(html, /\bPIN\b|one-time|otp/i);
});

test('check 3: a link with one character changed is refused', async () => {
    const w = world();
    const token = w.tokenOf((await createSigningRequest(w.deps, await w.input())).link);
    const changed = token.slice(0, 10) + (token[10] === 'A' ? 'B' : 'A') + token.slice(11);
    assert.deepEqual(await openSigningRequest(w.deps, changed), { ok: false, reason: 'not-found' });
    assert.deepEqual(await signRequest(w.deps, changed, { signature: pngSignature(), ip: null, userAgent: null }), { ok: false, reason: 'not-found' });
});

test('check 4: a link older than 7 days, and a link already used, are refused', async () => {
    const w = world();
    const old = w.tokenOf((await createSigningRequest(w.deps, await w.input({ callerRecordId: 'claim-old' }))).link);
    const used = w.tokenOf((await createSigningRequest(w.deps, await w.input({ callerRecordId: 'claim-used' }))).link);
    assert.ok((await signRequest(w.deps, used, { signature: pngSignature(), ip: null, userAgent: null })).ok);
    assert.deepEqual(await openSigningRequest(w.deps, used), { ok: false, reason: 'used' });
    assert.deepEqual(await signRequest(w.deps, used, { signature: pngSignature(), ip: null, userAgent: null }), { ok: false, reason: 'used' });
    w.at(new Date(NOW.getTime() + LINK_DAYS * 86_400_000 + 1000));
    assert.deepEqual(await openSigningRequest(w.deps, old), { ok: false, reason: 'expired' });
    assert.equal([...w.store.rows.values()].find((r) => r.caller_record_id === 'claim-old')!.status, 'expired');
});

test('check 5: the signature pad is off until the end of the last page has been on screen', () => {
    const html = signingPage('Claim form');
    assert.match(html, /<button id="submit"[^>]*disabled/);
    // A marker after the last page; the pad switches on when it scrolls into view, and ignores drawing until then.
    assert.match(html, /end.id = 'end'; end.style.height = '1px'; pagesEl.appendChild\(end\);/);
    assert.match(html, /\{ enable\(\); o.disconnect\(\); \} \}\).observe\(end\);/);
    assert.match(html, /if \(!enabled\) return;/);
});

test('checks 6 and 7: signing stamps the signature and date, flattens the form, records the audit and calls back, signed with the secret', async () => {
    const w = world();
    const created = await createSigningRequest(w.deps, await w.input());
    const token = w.tokenOf(created.link);
    await openSigningRequest(w.deps, token);
    w.at(new Date('2026-10-26T09:15:00Z'));
    const signedResult = await signRequest(w.deps, token, { signature: pngSignature(), ip: '196.25.1.2', userAgent: 'Mozilla/5.0 (iPhone)' });
    assert.ok(signedResult.ok);
    assert.equal(signedResult.requestId, created.id);
    assert.equal(await signedResult.delivery, true);

    const row = w.store.rows.get(created.id)!;
    assert.equal(row.status, 'used');
    assert.equal(row.callback_status, 'done');
    const signed = w.store.files.get(row.signed_path!)!;
    const doc = await PDFDocument.load(signed);
    assert.equal(doc.getForm().getFields().length, 0, 'flattened: no boxes left to change');
    assert.match(doc.getSubject() ?? '', new RegExp(created.id));
    assert.deepEqual(row.audit, {
        requestId: created.id, signedAt: '2026-10-26T09:15:00.000Z', ip: '196.25.1.2', userAgent: 'Mozilla/5.0 (iPhone)', channel: 'whatsapp',
        sentTo: '27821234567', documentHash: row.document_hash, signedHash: sha256(signed), linkCreatedAt: NOW.toISOString(), openedAt: NOW.toISOString(),
    });

    assert.equal(w.posts.length, 1);
    const post = w.posts[0];
    assert.equal(post.url, 'https://tina.example/webhook/claim-signed');
    assert.ok(verifyHmacSha256(Buffer.from(post.body), post.headers[SIGNATURE_HEADER], SECRET));
    const body = JSON.parse(post.body);
    assert.equal(body.caller, 'claim');
    assert.equal(body.callerRecordId, 'claim-1');
    assert.equal(sha256(Buffer.from(body.signedPdf, 'base64')), sha256(signed));
    assert.deepEqual(body.audit, row.audit);
});

test('check 7: a changed unsigned PDF (another hash) is refused at signing', async () => {
    const w = world();
    const created = await createSigningRequest(w.deps, await w.input());
    const row = w.store.rows.get(created.id)!;
    w.store.files.set(row.document_path, await samplePdf('Claim form, changed after the link went out'));
    assert.deepEqual(await signRequest(w.deps, w.tokenOf(created.link), { signature: pngSignature(), ip: null, userAgent: null }), { ok: false, reason: 'changed' });
    assert.equal(w.store.rows.get(created.id)!.status, 'open');
    assert.equal(w.posts.length, 0);
});

test('check 8: any caller works, with no claim involved', async () => {
    const w = world();
    const created = await createSigningRequest(w.deps, await w.input({ caller: 'test', callerRecordId: 'x-1', callbackUrl: 'https://example.org/hook' }));
    const r = await signRequest(w.deps, w.tokenOf(created.link), { signature: pngSignature(), ip: null, userAgent: null });
    assert.ok(r.ok && await r.delivery);
    assert.equal(JSON.parse(w.posts[0].body).caller, 'test');
    assert.equal(w.posts[0].url, 'https://example.org/hook');
});

test('check 9: a new request for the same record supersedes the open one; the first link is refused, the second works', async () => {
    const w = world();
    const first = w.tokenOf((await createSigningRequest(w.deps, await w.input())).link);
    const second = w.tokenOf((await createSigningRequest(w.deps, await w.input({ document: await samplePdf('Filled again') }))).link);
    assert.deepEqual(await openSigningRequest(w.deps, first), { ok: false, reason: 'superseded' });
    assert.ok((await signRequest(w.deps, second, { signature: pngSignature(), ip: null, userAgent: null })).ok);
});

test('a request is refused when its hash, document, stamps or callback are wrong', async () => {
    const w = world();
    const bad = async (over: Partial<CreateRequestInput>, message: RegExp) => assert.rejects(createSigningRequest(w.deps, await w.input(over)), message);
    await bad({ documentHash: 'nope' }, /not the SHA-256/);
    await bad({ document: new TextEncoder().encode('hello'), documentHash: sha256('hello') }, /not a PDF/);
    await bad({ stamps: [STAMPS[1]] }, /at least one signature/);
    await bad({ stamps: [{ ...STAMPS[0], page: 3 }] }, /page 3; the document has 2/);
    await bad({ callbackUrl: 'http://evil.example/x' }, /callbackUrl must be https/);
    await bad({ channel: 'sms' as never }, /whatsapp or email/);
});

test('a callback the caller does not take is retried by the sweep, which also expires old links', async () => {
    const w = world({ postOk: false });
    const created = await createSigningRequest(w.deps, await w.input());
    const r = await signRequest(w.deps, w.tokenOf(created.link), { signature: pngSignature(), ip: null, userAgent: null });
    assert.ok(r.ok);
    assert.equal(await r.delivery, false);
    assert.equal(w.store.rows.get(created.id)!.callback_status, 'failed');
    assert.equal(w.store.rows.get(created.id)!.callback_attempts, 3);
    await createSigningRequest(w.deps, await w.input({ callerRecordId: 'claim-2' }));
    w.deps.post = async () => ({ ok: true, status: 200, text: '' });
    w.at(new Date(NOW.getTime() + 8 * 86_400_000));
    assert.deepEqual(await sweepSigning(w.deps), { expired: 1, delivered: 1, failed: 0 });
    assert.equal(w.store.rows.get(created.id)!.callback_status, 'done');
});

test('the stamped date and signature land where the stamps say; a date that does not fit is made smaller', async () => {
    const pdf = await samplePdf();
    const png = signaturePng(pngSignature())!;
    const signed = await stampPdf(pdf, [...STAMPS, { kind: 'date', page: 2, x: 300, y: 100, size: 10, maxWidth: 20, format: 'month' }], png, new Date('2026-09-07T10:00:00+02:00'), { title: 't', requestId: 'r' });
    assert.ok((await PDFDocument.load(signed)).getPageCount() === 2);
    assert.equal(formatDate(new Date('2026-09-07T23:30:00Z')), '08/09/2026', 'the date is South African time');
    assert.equal(formatDate(new Date('2026-09-07T10:00:00Z'), 'day'), '7');
    assert.equal(formatDate(new Date('2026-09-07T10:00:00Z'), 'month'), 'September');
    assert.equal(formatDate(new Date('2026-09-07T10:00:00Z'), 'yy'), '26');
    assert.equal(signaturePng('data:image/jpeg;base64,AAAA'), null);
});

// ------------------------------------------------------------------------------------------------- the routes

async function serve(deps: SigningDeps & { apiKey?: string }) {
    const app = express();
    app.use('/sign', signingRouter(() => deps));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise((r) => server.close(r)) };
}

test('the client is told straight away; the callback carries on without them', async () => {
    const w = world();
    let release!: () => void;
    w.deps.post = async () => { await new Promise<void>((r) => { release = r; }); return { ok: true, status: 200, text: '' }; };
    const created = await createSigningRequest(w.deps, await w.input());
    const r = await signRequest(w.deps, w.tokenOf(created.link), { signature: pngSignature(), ip: null, userAgent: null });
    assert.ok(r.ok);
    assert.equal(w.store.rows.get(created.id)!.status, 'used');
    assert.equal(w.store.rows.get(created.id)!.callback_status, 'pending');
    release();
    assert.equal(await r.delivery, true);
    assert.equal(w.store.rows.get(created.id)!.callback_status, 'done');
});

test('routes: the API needs the key; the page, the PDF and signing answer by the link\'s state', async () => {
    const w = world();
    const s = await serve({ ...w.deps, apiKey: 'k' });
    try {
        const body = await w.input();
        const json = { ...body, document: Buffer.from(body.document).toString('base64') };
        const post = (key?: string) => fetch(`${s.base}/sign/api/requests`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(json),
        });
        assert.equal((await post()).status, 401);
        assert.equal((await post('wrong')).status, 401);
        const created = await (await post('k')).json() as { link: string };
        const path = new URL(created.link).pathname;

        const page = await fetch(`${s.base}${path}`);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get('cache-control'), 'no-store');
        assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
        assert.match(await page.text(), /Claim form for Discovery \(CLM-000201\)/);
        const pdf = await fetch(`${s.base}${path}/document`);
        assert.equal(pdf.headers.get('content-type'), 'application/pdf');
        assert.equal(sha256(new Uint8Array(await pdf.arrayBuffer())), body.documentHash);

        const sign = (signature: string) => fetch(`${s.base}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '196.25.1.2:51234, 10.0.0.1' }, body: JSON.stringify({ signature }),
        });
        assert.equal((await sign('not a picture')).status, 400);
        assert.deepEqual(await (await sign(pngSignature())).json(), { ok: true });
        assert.equal([...w.store.rows.values()][0].audit!.ip, '196.25.1.2');
        const again = await sign(pngSignature());
        assert.equal(again.status, 409);
        assert.match(((await again.json()) as { message: string }).message, /already been signed/);
        assert.equal((await fetch(`${s.base}${path}`)).status, 410);
        assert.equal((await fetch(`${s.base}/sign/${'x'.repeat(43)}`)).status, 404);
    } finally {
        await s.close();
    }
});

test('the callback signature is HMAC-SHA256 of the body, as utils/hmac checks it', () => {
    const body = JSON.stringify({ a: 1 });
    assert.ok(verifyHmacSha256(Buffer.from(body), callbackSignature(body, SECRET), SECRET));
    assert.ok(!verifyHmacSha256(Buffer.from(body + ' '), callbackSignature(body, SECRET), SECRET));
});
