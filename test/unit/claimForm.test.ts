/**
 * TTTFG-5562: the guided claim form on Tina: its links (AC 11), the route's checks, the page (AC 9) and the WhatsApp button.
 * The form's logic is tested in the claims package (ttt-preseason-agent test/claims-guided.test.ts).
 */
import crypto from 'crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGuidedLink, guidedFormOn, LINK_DAYS, memoryLinkStore, openGuidedLink, postFormDone, sha256, type GuidedLinkDeps, type GuidedLinkRow } from '../../src/claimform/links';
import { CLAIM_FORM_CSP, claimFormPage, refusedPage } from '../../src/claimform/page';
import { joinParts, LINK_LOGGED, linkInteractive, withLinkLine } from '../../src/domain/claimsOutbox';
import { claimFormRouter, type ClaimFormSession } from '../../src/routes/claimForm.route';

const INPUT = { claimId: 'claim-1', phone: '27820000000', contactId: 'contact-1' };
const deps = (now = () => new Date('2026-11-03T10:00:00Z')): GuidedLinkDeps & { store: ReturnType<typeof memoryLinkStore> } => ({ store: memoryLinkStore(), publicUrl: 'https://tina.example', now });
const tokenOf = (url: string) => url.split('/').pop()!;

test('AC 11: the link is random, carries nothing about the client, and only its hash is stored', async () => {
    const d = deps();
    const a = await createGuidedLink(d, INPUT);
    const b = await createGuidedLink(d, { ...INPUT, claimId: 'claim-2' });
    assert.notEqual(tokenOf(a.url), tokenOf(b.url));
    assert.match(a.url, /^https:\/\/tina\.example\/claim-form\/[A-Za-z0-9_-]{43}$/);
    for (const secret of [INPUT.phone, INPUT.claimId, INPUT.contactId]) assert.ok(!a.url.includes(secret));
    const row = [...d.store.rows.values()][0];
    assert.equal(row.token_hash, sha256(tokenOf(a.url)));
    assert.ok(!JSON.stringify(row).includes(tokenOf(a.url)), 'the token itself is never stored');
});

test('AC 11: the link expires after 7 days', async () => {
    let at = new Date('2026-11-03T10:00:00Z');
    const d = deps(() => at);
    const { url } = await createGuidedLink(d, INPUT);
    at = new Date(at.getTime() + (LINK_DAYS * 86_400_000) - 1000);
    assert.equal((await openGuidedLink(d, tokenOf(url))).ok, true);
    at = new Date(at.getTime() + 2000);
    assert.deepEqual(await openGuidedLink(d, tokenOf(url)), { ok: false, reason: 'expired' });
    assert.equal([...d.store.rows.values()][0].status, 'expired');
});

test('a new link for the same claim stops the earlier one, and a bad token finds nothing', async () => {
    let at = new Date('2026-11-03T10:00:00Z');
    const d = deps(() => at);
    const first = await createGuidedLink(d, INPUT);
    at = new Date(at.getTime() + 1000);
    const second = await createGuidedLink(d, INPUT);
    assert.deepEqual(await openGuidedLink(d, tokenOf(first.url)), { ok: false, reason: 'superseded' });
    assert.equal((await openGuidedLink(d, tokenOf(second.url))).ok, true);
    assert.deepEqual(await openGuidedLink(d, 'x'.repeat(43)), { ok: false, reason: 'not-found' });
    assert.deepEqual(await openGuidedLink(d, '../../etc/passwd'), { ok: false, reason: 'not-found' });
});

test('CLAIMS_GUIDED_FORM is off by default, on for everyone, or on for listed numbers', () => {
    assert.equal(guidedFormOn(undefined, '27820000000'), false);
    assert.equal(guidedFormOn('', '27820000000'), false);
    assert.equal(guidedFormOn('off', '27820000000'), false);
    assert.equal(guidedFormOn('on', '27820000000'), true);
    assert.equal(guidedFormOn('0820000000, 0831111111', '27820000000'), true);
    assert.equal(guidedFormOn('0831111111', '27820000000'), false);
});

function fakeSession(calls: string[]): ClaimFormSession {
    return {
        view: async () => ({ reference: 'CLM-1' } as never),
        save: async (input) => { calls.push(`save:${JSON.stringify(input.answers)}`); if (input.termsAccepted) calls.push('terms:true'); return { problems: [], answers: {}, notKnown: [], open: [] }; },
        file: async (file, bytes, item) => { calls.push(`file:${file.fileName.replace(/\d+/, 'N')}:${file.media}:${bytes.length}:${item}`); return { count: 1 }; },
        hear: async (bytes, mime) => { calls.push(`hear:${mime}:${bytes.length}`); return mime === 'audio/mp4' ? { problem: 'unclear' } : { text: 'I heard you' }; },
        finish: async () => { calls.push('finish'); return { open: calls.includes('ready') ? [] : ['vehicleMake'] }; },
        carryOn: async () => { calls.push('carryOn'); },
    };
}

async function server(d: GuidedLinkDeps, calls: string[]) {
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session: (_l: GuidedLinkRow) => fakeSession(calls), whatsApp: '27111111111' })));
    const s = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/claim-form`, close: () => new Promise((r) => s.close(r)) };
}

test('the page is private: no caching, no indexing, no framing, and the token never leaves in a Referer', async () => {
    const d = deps(() => new Date());
    const { url } = await createGuidedLink(d, INPUT);
    const s = await server(d, []);
    try {
        const r = await fetch(`${s.base}/${tokenOf(url)}`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
        assert.equal(r.headers.get('content-security-policy'), CLAIM_FORM_CSP);
        assert.match(CLAIM_FORM_CSP, /frame-ancestors 'none'/);
        const html = await r.text();
        assert.ok(!html.includes(INPUT.phone) && !html.includes(INPUT.claimId), 'the page itself holds nothing about the client');
        assert.ok(!r.headers.get('set-cookie'));
    } finally { await s.close(); }
});

test('a link that does not work gets a page that says why, and no data', async () => {
    const d = deps(() => new Date());
    const s = await server(d, []);
    try {
        const missing = await fetch(`${s.base}/${'x'.repeat(43)}`);
        assert.equal(missing.status, 404);
        assert.match(await missing.text(), /This link does not work/);
        const state = await fetch(`${s.base}/${'x'.repeat(43)}/state`);
        assert.equal(state.status, 404);
        assert.deepEqual(await state.json(), { ok: false, reason: 'not-found' });
    } finally { await s.close(); }
});

test('only the page\'s own fields reach the save, and answers are length-limited', async () => {
    const d = deps(() => new Date());
    const { url } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls);
    try {
        const r = await fetch(`${s.base}/${tokenOf(url)}/answers`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers: [{ key: 'a', value: 'ok' }, { key: 'b', value: { evil: 1 } }, { key: 'c', value: 'x'.repeat(6000) }], somethingElse: true }),
        });
        assert.equal(r.status, 200);
        assert.deepEqual(calls, ['save:[{"key":"a","value":"ok"}]']);
    } finally { await s.close(); }
});

test('a bad link gets no further than the check: the body is not read', async () => {
    const d = deps(() => new Date());
    const s = await server(d, []);
    try {
        const r = await fetch(`${s.base}/${'x'.repeat(43)}/file`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(30 * 1024 * 1024) });
        assert.equal(r.status, 404);
    } finally { await s.close(); }
});

test('AC 7: a photo is taken under a name of our own; other kinds of file are refused', async () => {
    const d = deps(() => new Date());
    const { url } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls);
    try {
        const ok = await fetch(`${s.base}/${tokenOf(url)}/file?item=driversLicence`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': '../../evil.jpg' }, body: Buffer.from('jpeg') });
        assert.equal(ok.status, 200);
        assert.deepEqual(calls, ['file:driversLicence-N.jpg:photo:4:driversLicence']);
        const html = await fetch(`${s.base}/${tokenOf(url)}/file`, { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: '<script>' });
        assert.equal(html.status, 415);
        const svg = await fetch(`${s.base}/${tokenOf(url)}/file`, { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
        assert.equal(svg.status, 415);
        assert.equal(calls.length, 1);
    } finally { await s.close(); }
});

test('AC 4: a recording comes back as text for the box, or a sentence when it couldn\'t be heard', async () => {
    const d = deps(() => new Date());
    const { url } = await createGuidedLink(d, INPUT);
    const s = await server(d, []);
    try {
        const heard = await fetch(`${s.base}/${tokenOf(url)}/voice?key=story`, { method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus' }, body: Buffer.from('audio') });
        assert.deepEqual(await heard.json(), { text: 'I heard you' });
        const unclear = await fetch(`${s.base}/${tokenOf(url)}/voice`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: Buffer.from('audio') });
        assert.match(((await unclear.json()) as { message: string }).message, /make that out/);
        const notAudio = await fetch(`${s.base}/${tokenOf(url)}/voice`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('pdf') });
        assert.equal(notAudio.status, 400);
    } finally { await s.close(); }
});

test('AC 6: Submit with a required question open sends the client back; ready, Tina carries on once and the link is done', async () => {
    const d = deps(() => new Date());
    const { url } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls);
    try {
        const held = await (await fetch(`${s.base}/${tokenOf(url)}/submit`, { method: 'POST' })).json();
        assert.deepEqual(held, { ok: false, open: ['vehicleMake'] });
        assert.ok(!calls.includes('carryOn'));
        calls.push('ready');
        const done = await (await fetch(`${s.base}/${tokenOf(url)}/submit`, { method: 'POST' })).json();
        assert.deepEqual(done, { ok: true, open: [] });
        assert.equal(calls.filter((c) => c === 'carryOn').length, 1);
        // The link has done its work: it now says so, with the way back to WhatsApp, and takes no more answers.
        const page = await fetch(`${s.base}/${tokenOf(url)}`);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Claim submitted/);
        assert.match(html, /wa\.me\/27111111111/);
        const again = await fetch(`${s.base}/${tokenOf(url)}/submit`, { method: 'POST' });
        assert.equal(again.status, 410);
    } finally { await s.close(); }
});

test('AC 9: nothing on the form says whether the claim is covered', () => {
    // The AI disclosure and who checks the claim go on WhatsApp, just before the link (2 Nov 2026: taken off the form).
    const html = claimFormPage();
    assert.doesNotMatch(html, /TTT's AI assistant/);
    for (const page of [html, refusedPage('done'), refusedPage('expired')]) {
        assert.doesNotMatch(page, /\b(is|are|isn't|not) covered\b|\bwill be paid\b|\bapproved\b|\bdeclined\b/i);
    }
});

test('what the page says it agreed to reaches the claims package, and nothing else does', async () => {
    const d = deps(() => new Date());
    const { url } = await createGuidedLink(d, INPUT);
    const calls: string[] = [];
    const s = await server(d, calls);
    try {
        const r = await fetch(`${url.replace(/^.*\/claim-form/, s.base)}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true, somethingElse: 1 }) });
        assert.equal(r.status, 200);
        assert.ok(calls.some((c) => c === 'terms:true'));
    } finally { await s.close(); }
});

test('no intro page: the page opens on what TTT holds, and never waits for a save', () => {
    const html = claimFormPage();
    assert.doesNotMatch(html, /Fill out this form/);
    assert.doesNotMatch(html, /id: 'hello'/);
    assert.match(html, /steps = \[\{ id: 'details' \}\]/);
    assert.doesNotMatch(html, /reply "chat"/i);
    assert.match(html, /Check your claim/);
    // The script must parse, whatever its text holds: a slip here is a blank page on every phone.
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    assert.doesNotThrow(() => new Function(script));
});

test('the link goes as a WhatsApp button, in its own message after what comes before it, and the log never keeps the address', () => {
    const link = { url: 'https://tina.example/claim-form/abc', label: 'Open claim form' };
    const out = joinParts([{ text: 'The duty of disclosure.' }, { text: 'Tap below.', link }, { text: 'Later text.' }], 700);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, 'The duty of disclosure.\n\nTap below.');
    assert.deepEqual(out[0].link, link);
    assert.equal(out[1].text, 'Later text.');
    const i = linkInteractive('Tap below.', link);
    assert.equal(i.type, 'cta_url');
    assert.deepEqual(i.action, { name: 'cta_url', parameters: { display_text: 'Open claim form', url: link.url } });
    assert.ok(link.label.length <= 20);
    assert.ok(withLinkLine('Tap below.', link).endsWith(link.url));
    assert.ok(!LINK_LOGGED.includes('http'));
});

// ---- TTTFG-5188: an email claim's link

const CLAIM = '8bd61484-9dd7-f111-a05b-002248a35b45';
const CONTACT = '3eb789a1-9cd7-f111-a05b-70a8a52b74f1';
const CALLBACK = 'https://agent.example/api/claim-form-done';

async function emailServer(d: GuidedLinkDeps, apiKey: string | undefined) {
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session: (_l: GuidedLinkRow) => fakeSession([]), whatsApp: '27111111111', apiKey })));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/claim-form`;
    return { base, close: () => new Promise((r) => server.close(r)) };
}
const makeLink = (base: string, key: string, body: unknown) => fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

test('the email agent gets a link only with the key, an https callback that is not Tina, and real ids', async () => {
    const d = deps();
    const s = await emailServer(d, 'k');
    try {
        assert.equal((await makeLink(s.base, 'wrong', { claimId: CLAIM, contactId: CONTACT, callbackUrl: CALLBACK })).status, 401);
        assert.equal((await makeLink(s.base, 'k', { claimId: 'x', contactId: CONTACT, callbackUrl: CALLBACK })).status, 400);
        assert.equal((await makeLink(s.base, 'k', { claimId: CLAIM, contactId: CONTACT, callbackUrl: 'http://agent.example/x' })).status, 400);
        assert.equal((await makeLink(s.base, 'k', { claimId: CLAIM, contactId: CONTACT, callbackUrl: 'https://tina.example/x' })).status, 400);
        assert.equal(d.store.rows.size, 0);
        const r = await makeLink(s.base, 'k', { claimId: CLAIM, contactId: CONTACT, callbackUrl: CALLBACK });
        assert.equal(r.status, 201);
        const made = await r.json() as { url: string; expiresAt: string };
        assert.match(made.url, /^https:\/\/tina\.example\/claim-form\//);
        const row = [...d.store.rows.values()][0];
        assert.deepEqual([row.claim_id, row.contact_id, row.phone, row.callback_url], [CLAIM, CONTACT, '', CALLBACK]);
    } finally { await s.close(); }
});

test('no key set: nobody can ask for a link', async () => {
    const s = await emailServer(deps(), undefined);
    try {
        assert.equal((await makeLink(s.base, 'undefined', { claimId: CLAIM, contactId: CONTACT, callbackUrl: CALLBACK })).status, 401);
    } finally { await s.close(); }
});

test('a WhatsApp link writes no callback column, so it works before the migration runs', async () => {
    const d = deps();
    await createGuidedLink(d, INPUT);
    assert.ok(!('callback_url' in [...d.store.rows.values()][0]));
});

test('an email claim\'s page says email, not WhatsApp, and offers no way back to WhatsApp', async () => {
    const d = deps();
    const s = await emailServer(d, 'k');
    try {
        const { url } = await (await makeLink(s.base, 'k', { claimId: CLAIM, contactId: CONTACT, callbackUrl: CALLBACK })).json() as { url: string };
        const state = await (await fetch(`${s.base}/${tokenOf(url)}/state`)).json() as { emailed?: boolean };
        assert.equal(state.emailed, true);
        await d.store.update([...d.store.rows.values()][0].id, { status: 'done' });
        const done = await (await fetch(`${s.base}/${tokenOf(url)}`)).text();
        assert.match(done, /We will email you/);
        assert.doesNotMatch(done, /WhatsApp/);
    } finally { await s.close(); }
});

test('Submit tells the email agent, signed under its key, and a refusal is an error so the client can try again', async () => {
    const calls: { url: string; body: string; sig: string }[] = [];
    const post = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
        calls.push({ url, body: init.body, sig: init.headers['x-signing-signature'] });
        return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 500 };
    }) as unknown as typeof fetch;
    const link = { callback_url: CALLBACK, claim_id: CLAIM };
    await postFormDone(link, 'key', 'claim-email', post);
    assert.equal(calls[0].url, CALLBACK);
    assert.deepEqual(JSON.parse(calls[0].body), { caller: 'claim-email', claimId: CLAIM });
    assert.equal(calls[0].sig, crypto.createHmac('sha256', 'key').update(calls[0].body).digest('hex'));
    await assert.rejects(postFormDone(link, 'key', 'claim-email', post));
});
