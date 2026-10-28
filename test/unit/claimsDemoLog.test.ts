/**
 * TTTFG-4830 claims demo: every message in and out goes where Tina keeps her own: Supabase's message log, and the CRM
 * timeline (riivo_whatsappcommunications, the row dynamicsService.logMessage writes), a voice note with its transcript
 * and its recording attached as a note (src/services/claimsDemoWiring.ts writeDemoLog, src/domain/whatsappLog.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboundText, newDemoLog, writeDemoLog, type DemoLog } from '../../src/services/claimsDemoWiring';
import { NOTE_ATTACHMENT_MAX_BYTES, voiceNoteNote, whatsappCommunicationRow } from '../../src/domain/whatsappLog';
import type { Dv } from '../../src/departments/insurance/dataverse';

const PHONE = '27723203629';
const WHERE = { phone: PHONE, contactId: 'ct-1', claimId: 'cl-1', requestId: 'rq-1' };

function fakeCrm(o: { refuse?: (body: Record<string, unknown>) => boolean } = {}) {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const dv = (async (_method: string, path: string, body?: unknown) => {
        const b = body as Record<string, unknown>;
        if (o.refuse?.(b)) throw new Error('400 undeclared property');
        posts.push({ path, body: b });
        return path.startsWith('riivo_whatsappcommunicationses') ? { activityid: `act-${posts.length}` } : undefined;
    }) as Dv;
    return { dv, posts, rows: () => posts.filter((p) => p.path.startsWith('riivo_whatsappcommunicationses')).map((p) => p.body) };
}
const saved: { role: string; content: string }[][] = [];
const saveMessages = async (_p: string, _c: string, m: { role: 'user' | 'assistant'; content: string }[]) => void saved.push(m);

const conversation = (): DemoLog => ({
    inbound: { text: '1. Toyota 2. Corolla', wamid: 'wamid.in-1', at: '2026-10-26T14:00:00.000Z' },
    outbound: [
        { text: 'Thanks. Next, a few questions about the finance on your car.', at: '2026-10-26T14:00:05.000Z', wamid: 'wamid.out-1' },
        { text: 'Please send me photos of the damage.', at: '2026-10-26T14:00:06.000Z' },
    ],
});

test('the client\'s message and each of Tina\'s go to the message log and the claim\'s timeline, in order, as Tina\'s own rows', async () => {
    const crm = fakeCrm();
    saved.length = 0;
    await writeDemoLog({ dv: crm.dv, saveMessages }, conversation(), WHERE);
    assert.deepEqual(saved, [[
        { role: 'user', content: '1. Toyota 2. Corolla' },
        { role: 'assistant', content: 'Thanks. Next, a few questions about the finance on your car.' },
        { role: 'assistant', content: 'Please send me photos of the damage.' },
    ]]);
    const rows = crm.rows();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], whatsappCommunicationRow({
        text: '1. Toyota 2. Corolla', direction: 'Incoming', phone: PHONE, wamid: 'wamid.in-1', regarding: { table: 'riivo_claim', id: 'cl-1' },
        party: { table: 'contact', id: 'ct-1' }, at: '2026-10-26T14:00:00.000Z',
    }));
    assert.equal(rows[0]['regardingobjectid_riivo_claim@odata.bind'], '/riivo_claims(cl-1)');
    assert.equal(rows[1].riivo_messagedirection, 463630001);
    assert.equal(rows[1].riivo_messageid, 'wamid.out-1');
    assert.equal(rows[1].riivo_from, 'Bot');
    assert.equal(rows[2].riivo_timestamp, '2026-10-26T14:00:06.000Z');
});

test('a voice note: what Tina heard on the row, and the recording attached to it as a note', async () => {
    const crm = fakeCrm();
    const log = conversation();
    log.inbound = { text: '', wamid: 'wamid.voice', at: '2026-10-26T14:10:00.000Z',
        voice: { seconds: 23.4, mimeType: 'audio/ogg; codecs=opus', bytes: Buffer.from('OggS...'), transcript: 'it is a Toyota Corolla' } };
    await writeDemoLog({ dv: crm.dv, saveMessages }, log, WHERE);
    assert.equal(crm.rows()[0].description, '🎙️ Voice note (23.4s): it is a Toyota Corolla');
    const note = crm.posts.find((p) => p.path === 'annotations')!.body;
    assert.equal(note['objectid_riivo_whatsappcommunications@odata.bind'], '/riivo_whatsappcommunicationses(act-1)');
    assert.equal(note.documentbody, Buffer.from('OggS...').toString('base64'));
    assert.equal(note.mimetype, 'audio/ogg');
    assert.match(String(note.filename), /^voice-note-2026-10-26T14-10-00-000Z\.ogg$/);
    // One that couldn't be used is kept too, saying why.
    assert.equal(inboundText({ text: '', at: 'x', voice: { seconds: 2, mimeType: 'audio/ogg', problem: 'unclear' } }), '🎙️ Voice note (2s), not transcribed (unclear)');
});

test('a recording over the attachment limit: no note, and the row says so', async () => {
    const crm = fakeCrm();
    const log: DemoLog = { outbound: [], inbound: { text: '', at: '2026-10-26T14:10:00.000Z',
        voice: { seconds: 900, mimeType: 'audio/ogg', bytes: Buffer.alloc(NOTE_ATTACHMENT_MAX_BYTES + 1), transcript: 'a long story' } } };
    await writeDemoLog({ dv: crm.dv, saveMessages }, log, WHERE);
    assert.equal(crm.posts.filter((p) => p.path === 'annotations').length, 0);
    assert.match(String(crm.rows()[0].description), /over the 5 MB attachment limit/);
    assert.equal(voiceNoteNote({ communicationId: 'a', bytes: Buffer.alloc(NOTE_ATTACHMENT_MAX_BYTES + 1), mimeType: 'audio/ogg', seconds: 1, at: 'x' }), null);
});

const parties = (r: Record<string, unknown>) => r.riivo_WhatsAppCommunications_activity_parties as Record<string, unknown>[] | undefined;

test('the contact is the From of the client\'s message and the To of each of Tina\'s, so all of it shows on the contact too', async () => {
    const crm = fakeCrm();
    await writeDemoLog({ dv: crm.dv, saveMessages }, conversation(), WHERE);
    assert.deepEqual(crm.rows().map(parties), [
        [{ 'partyid_contact@odata.bind': '/contacts(ct-1)', participationtypemask: 1 }],
        [{ 'partyid_contact@odata.bind': '/contacts(ct-1)', participationtypemask: 2 }],
        [{ 'partyid_contact@odata.bind': '/contacts(ct-1)', participationtypemask: 2 }],
    ]);
});

test('a contact the CRM refuses as participant: the rows still go under the claim, and the rest of the job goes without it', async () => {
    const tries: Record<string, unknown>[] = [];
    const crm = fakeCrm({ refuse: (b) => (tries.push(b), !!parties(b)) });
    await writeDemoLog({ dv: crm.dv, saveMessages }, conversation(), WHERE);
    const rows = crm.rows();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r['regardingobjectid_riivo_claim@odata.bind'] === '/riivo_claims(cl-1)' && !parties(r)));
    assert.equal(tries.length, 4, 'one refused try, then three rows without the contact');
});

test('a link the CRM refuses falls back to the request, then the contact; the rest of the job follows it', async () => {
    const crm = fakeCrm({ refuse: (b) => 'regardingobjectid_riivo_claim@odata.bind' in b });
    await writeDemoLog({ dv: crm.dv, saveMessages }, conversation(), WHERE);
    assert.deepEqual(crm.rows().map((r) => r['regardingobjectid_riivo_request@odata.bind']), ['/riivo_requests(rq-1)', '/riivo_requests(rq-1)', '/riivo_requests(rq-1)']);
    assert.ok(crm.rows().every((r) => parties(r)?.length === 1), 'a refused link keeps the contact');
    const noClaim = fakeCrm();
    await writeDemoLog({ dv: noClaim.dv, saveMessages }, conversation(), { phone: PHONE, contactId: 'ct-1' });
    assert.equal(noClaim.rows()[0]['regardingobjectid_contact@odata.bind'], '/contacts(ct-1)');
});

test('a failed message log never stops the timeline, and a job that said nothing writes nothing', async () => {
    const crm = fakeCrm();
    await writeDemoLog({ dv: crm.dv, saveMessages: async () => { throw new Error('Supabase down'); } }, conversation(), WHERE);
    assert.equal(crm.rows().length, 3);
    const quiet = fakeCrm();
    await writeDemoLog({ dv: quiet.dv, saveMessages }, newDemoLog(), WHERE);
    assert.equal(quiet.posts.length, 0);
});

test('Tina\'s own row is unchanged: under the request, else the contact or lead', () => {
    assert.deepEqual(whatsappCommunicationRow({ text: 'Hi', direction: 'Incoming', phone: PHONE, wamid: 'w1', regarding: { table: 'riivo_request', id: 'rq' }, at: 'T' }), {
        subject: `WhatsApp Incoming: ${PHONE}`, description: 'Hi', riivo_messagedirection: 463630000, riivo_from: PHONE, riivo_to: 'Bot', riivo_timestamp: 'T',
        riivo_messageid: 'w1', 'regardingobjectid_riivo_request@odata.bind': '/riivo_requests(rq)',
    });
    assert.ok(!('riivo_messageid' in whatsappCommunicationRow({ text: 'x', direction: 'Outgoing', phone: PHONE })));
    assert.ok(!('riivo_WhatsAppCommunications_activity_parties' in whatsappCommunicationRow({ text: 'x', direction: 'Outgoing', phone: PHONE })));
});

test('Tina\'s own row has the client as From or To: a contact, or a lead', () => {
    const row = (direction: 'Incoming' | 'Outgoing', party: { table: 'contact' | 'new_lead'; id: string }) =>
        whatsappCommunicationRow({ text: 'Hi', direction, phone: PHONE, regarding: { table: 'riivo_request', id: 'rq' }, party, at: 'T' });
    assert.deepEqual(row('Incoming', { table: 'contact', id: 'ct' }).riivo_WhatsAppCommunications_activity_parties,
        [{ 'partyid_contact@odata.bind': '/contacts(ct)', participationtypemask: 1 }]);
    assert.deepEqual(row('Outgoing', { table: 'new_lead', id: 'ld' }).riivo_WhatsAppCommunications_activity_parties,
        [{ 'partyid_new_lead@odata.bind': '/new_leads(ld)', participationtypemask: 2 }]);
});
