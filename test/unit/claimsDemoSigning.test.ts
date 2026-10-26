/**
 * TTTFG-5196: the claims demo on the signing page (src/services/claimsDemoWiring.ts demoClaimSigningStep and
 * demoClaimSigned), against a fake Dataverse and Graph: what the demo client gets on WhatsApp, and what lands in the
 * CRM and the claim folder when they sign.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dv } from '../../src/departments/insurance/dataverse';
import { sha256, type SigningRequestInput } from '../../src/departments/insurance/signing';
import { demoClaimSigned, demoClaimSigningStep, type DemoChannels, type DemoSigning } from '../../src/services/claimsDemoWiring';

const CLAIM = '11111111-1111-1111-1111-111111111111';
const CONTACT = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const DOCTYPE = '44444444-4444-4444-4444-444444444444';
const PHONE = '27723203629';
const PDF = new TextEncoder().encode('%PDF-1.7 filled');

function world(o: { signedOff?: boolean; unsignedHash?: string } = {}) {
    const writes: { method: string; path: string; body: any }[] = [];
    const texts: { to: string; text: string }[] = [];
    const created: SigningRequestInput[] = [];
    const puts: string[] = [];
    const dv = (async (method: string, path: string, body?: unknown) => {
        if (method !== 'GET') {
            writes.push({ method, path, body });
            return path.startsWith('riivo_agentactions') ? { riivo_agentactionid: 'a1' } : path.startsWith('riivo_clientdocuments') ? { riivo_clientdocumentid: 'd-signed' } : undefined;
        }
        if (path.startsWith(`riivo_claims(${CLAIM})`)) {
            return {
                riivo_claimid: CLAIM, riivo_name: 'CLM-000301', riivo_claimtype: null, riivo_channel: 463630001, riivo_signaturestatus: 463630001, riivo_signatureaudit: null,
                _riivo_contact_value: CONTACT, riivo_Provider: { riivo_providername: 'Discovery Insure' },
                // A DEV demo contact's own mobile number is someone else's: the link goes to the demo number.
                riivo_Contact: { firstname: 'Brandon', fullname: 'Brandon Test', mobilephone: '0820000000', emailaddress1: null },
                owninguser: { systemuserid: USER, firstname: 'Marne', fullname: 'Marne Broker' }, owningteam: null,
            };
        }
        if (path.startsWith('riivo_documenttypes')) return { value: [{ riivo_documenttypeid: DOCTYPE }] };
        // The unsigned form's hash; no signed copy filed yet.
        if (path.startsWith('riivo_clientdocuments?$select=riivo_filehash')) return { value: [{ riivo_filehash: o.unsignedHash ?? sha256(PDF) }] };
        if (path.startsWith('riivo_clientdocuments?$select=riivo_clientdocumentid')) return { value: [] };
        throw new Error(`unexpected GET ${path}`);
    }) as Dv;
    const graph: DemoChannels['graph'] = async (method, path) => {
        if (method === 'PUT') { puts.push(decodeURIComponent(path)); return new Response(JSON.stringify({ webUrl: 'https://sp/signed.pdf' })); }
        if (path.startsWith('/sites/') && path.includes('/drives')) return new Response(JSON.stringify({ value: [{ id: 'drive1', name: 'Contact', webUrl: 'https://sp/contact' }] }));
        return new Response(JSON.stringify({ id: 'site1' }));
    };
    const ch: DemoChannels = {
        dv, graph, site: 'host:/sites/Dev',
        sendText: async (to, text) => void texts.push({ to, text }),
        sendDocument: async () => { throw new Error('no document: the link replaces it'); },
        mediaBytes: async () => Buffer.alloc(0),
    };
    const signing: DemoSigning = {
        create: async (input) => { created.push(input); return { id: 'r1', link: 'https://tina.example/sign/abc', expiresAt: '2026-11-02T08:00:00.000Z' }; },
        signedOff: o.signedOff ?? true,
    };
    return { ch, signing, writes, texts, created, puts };
}

const DOC = {
    fileName: 'Claim form - Discovery Insure - Other - unsigned.pdf', fileRef: 'https://sp/unsigned.pdf', clientDocumentId: 'd1', bytes: PDF, fileHash: sha256(PDF),
    stamps: [{ kind: 'signature' as const, page: 1, x: 100, y: 100, width: 160, height: 30 }],
};

test('the demo client gets the signing link on WhatsApp at the demo number; the claim is Link sent and the send is logged', async () => {
    const w = world();
    const sent: string[] = [];
    assert.equal(await demoClaimSigningStep(w.ch, w.signing, PHONE, (t) => sent.push(t))(CLAIM, DOC), 'sent');
    assert.equal(w.created.length, 1);
    assert.equal(w.created[0].sentTo, PHONE);
    assert.equal(w.created[0].channel, 'whatsapp');
    assert.equal(w.texts.length, 1);
    assert.equal(w.texts[0].to, PHONE);
    assert.match(w.texts[0].text, /^Brandon, your claim form for Discovery Insure \(CLM-000301\) is ready\. .*https:\/\/tina\.example\/sign\/abc/);
    assert.deepEqual(sent, [w.texts[0].text]);
    assert.deepEqual(w.writes.find((x) => x.method === 'PATCH')?.body, { riivo_signaturestatus: 463630001 });
    const action = w.writes.find((x) => x.path.startsWith('riivo_agentactions'))!;
    assert.equal(action.body.riivo_subject, 'Claim - form ready to sign (draft-1)');
});

test('with the message not signed off: no link, no status change, a Follow-up for the claim owner', async () => {
    const w = world({ signedOff: false });
    assert.equal(await demoClaimSigningStep(w.ch, w.signing, PHONE)(CLAIM, DOC), 'notAvailable');
    assert.deepEqual([w.created.length, w.texts.length], [0, 0]);
    assert.equal(w.writes.filter((x) => x.method === 'PATCH').length, 0);
    const action = w.writes.find((x) => x.path.startsWith('riivo_agentactions'))!;
    assert.equal(action.body['ownerid@odata.bind'], `/systemusers(${USER})`);
    assert.match(action.body.riivo_name, /isn't signed off for WhatsApp/);
});

test('the signed copy goes to the claim folder as "- signed.pdf", gets its own document row, and the claim is Signed with the audit', async () => {
    const w = world();
    const signed = new TextEncoder().encode('%PDF-1.7 signed');
    const audit = {
        requestId: 'r1', signedAt: '2026-10-26T09:15:00.000Z', ip: '196.25.1.2', userAgent: 'iPhone', channel: 'whatsapp' as const, sentTo: PHONE,
        documentHash: sha256(PDF), signedHash: sha256(signed), linkCreatedAt: '2026-10-26T08:00:00.000Z', openedAt: null,
    };
    const outcome = await demoClaimSigned(w.ch, { requestId: 'r1', caller: 'claim', callerRecordId: CLAIM, signedPdf: signed, audit });
    assert.deepEqual(outcome, { filed: { fileRef: 'https://sp/signed.pdf', documentId: 'd-signed' } });
    assert.match(w.puts[0], /Brandon Test_22222222222222222222222222222222\/Claims\/CLM-000301\/Claim form - Discovery Insure - Other - signed\.pdf/);
    const doc = w.writes.find((x) => x.path.startsWith('riivo_clientdocuments'))!.body;
    assert.equal(doc.riivo_filehash, sha256(signed));
    assert.equal(doc['riivo_Claim@odata.bind'], `/riivo_claims(${CLAIM})`);
    const claim = w.writes.find((x) => x.method === 'PATCH')!.body;
    assert.equal(claim.riivo_signaturestatus, 463630002);
    assert.equal(claim.riivo_signedon, audit.signedAt);
    assert.deepEqual(JSON.parse(claim.riivo_signatureaudit), audit);
});
