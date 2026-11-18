/**
 * Service routing's insurance side (src/domain/insuranceHost.ts, decision A and B): the insurance menu, claims, the
 * broker hand-over and files. Dataverse, Meta and the claims package are faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimGate } from '../../src/departments/insurance/gate';
import type { Owner } from '../../src/departments/insurance/claim';
import {
    DETAILS, INSURANCE_MENU_BUTTONS, insuranceTurn, isThanks, offerAccepted, TEXTS, type Handover, type InsuranceMessage, type InsurancePorts,
} from '../../src/domain/insuranceHost';
import { serviceLinesFrom } from '../../src/domain/serviceLines';
import { ROUTE_IDS } from '../../src/domain/serviceRoute';

const BROKER: Owner = { kind: 'user', id: 'u-medupi', name: 'Medupi' };
const TEAM: Owner = { kind: 'team', id: 'team-ia', name: 'the Insurance and Advice team' };
const DUE = '2026-11-16T15:00:00.000Z'; // Monday 16 November, SAST

function world(o: { claimsEnabled?: boolean; claimTakes?: boolean; owner?: Owner; requestFails?: boolean; followUpFails?: boolean; fileFails?: boolean } = {}) {
    const sent: { text: string; buttons?: { id: string; title: string }[]; requestId?: string | null }[] = [];
    const requests: { contactId: string; text: string; topic: string }[] = [];
    const followUps: { owner: Owner; requestId: string; contactId: string; detail: string }[] = [];
    const incoming: { requestId: string | null; text: string }[] = [];
    const claims: { contactId: string; text: string; force: boolean }[] = [];
    const files: { contactId: string; name: string }[] = [];
    const owners: { contactId: string; team: boolean }[] = [];
    let handover: Handover | null = null;
    const ports: InsurancePorts = {
        claimsEnabled: o.claimsEnabled ?? false,
        claim: async (c, text, { force }) => (claims.push({ contactId: c.id, text, force }), o.claimTakes ?? false),
        owner: async (contactId, { team }) => (owners.push({ contactId, team }), team ? TEAM : (o.owner ?? BROKER)),
        openRequest: async (contactId, text, topic) => (o.requestFails ? null : (requests.push({ contactId, text, topic }), `req-${requests.length}`)),
        followUp: async (row) => (o.followUpFails ? null : (followUps.push(row), { dueOn: DUE })),
        logIncoming: async (requestId, text) => void incoming.push({ requestId, text }),
        send: async (text, opts) => void sent.push({ text, ...(opts?.buttons ? { buttons: opts.buttons } : {}), ...(opts?.requestId !== undefined ? { requestId: opts.requestId } : {}) }),
        saveFile: async (contactId, f) => (o.fileFails ? false : (files.push({ contactId, name: f.name }), true)),
        loadHandover: async () => handover,
        saveHandover: async (h) => void (handover = h),
    };
    return { ports, sent, requests, followUps, incoming, claims, files, owners, handover: () => handover, texts: () => sent.map((s) => s.text) };
}

const INS = serviceLinesFrom('c-jane', [{ id: 'c-jane', clientTypes: [3], activePolicies: 1 }]);
const SHARED = serviceLinesFrom('c-tax', [{ id: 'c-tax', clientTypes: [0], activePolicies: 0 }, { id: 'c-ins', clientTypes: [3], activePolicies: 1 }]);
const TWO_INSURED = serviceLinesFrom('c-a', [{ id: 'c-a', clientTypes: [3], activePolicies: 1 }, { id: 'c-b', clientTypes: [3], activePolicies: 1 }]);
const msg = (text: string, o: Partial<InsuranceMessage> = {}): InsuranceMessage => ({ contact: { id: 'c-jane', firstName: 'Jane' }, lines: INS, text, ...o });

test('insurance: every fixed text passes the claims gate and never names the broker', () => {
    const all = [
        TEXTS.menuGreeting('Jane'), TEXTS.menu, TEXTS.handedOver('Jane', 'user', DUE), TEXTS.handedOver('Jane', 'team'),
        TEXTS.claimHandedOver('Jane', 'user', DUE), TEXTS.added('user'), TEXTS.added('team'), TEXTS.fileAdded('user'),
        TEXTS.fileFailed, TEXTS.failed, TEXTS.thanks, TEXTS.offerAccepted(DUE),
    ];
    for (const t of all) {
        assert.ok(claimGate(t).ok, t);
        assert.doesNotMatch(t, /Medupi/);
    }
    assert.equal(TEXTS.handedOver('Jane', 'user', DUE), "Thanks Jane, I've passed this to your broker, who will get back to you by Monday 16 November.");
    assert.equal(TEXTS.handedOver('Jane', 'team'), "Thanks Jane, I've passed this to our insurance team, who will get back to you.");
});

test('insurance: the menu ids are the router\'s', () => {
    assert.deepEqual(INSURANCE_MENU_BUTTONS.map((b) => b.id), [ROUTE_IDS.INSURANCE_CLAIM, ROUTE_IDS.INSURANCE_OTHER]);
    for (const b of INSURANCE_MENU_BUTTONS) assert.ok(b.title.length <= 20, b.title);
});

test('insurance: a greeting gets the insurance menu with Tina\'s intro; a tap on Insurance gets it without', async () => {
    const w = world();
    assert.equal(await insuranceTurn(w.ports, msg('hi', { menu: true, greeting: true })), 'menu');
    assert.equal(await insuranceTurn(w.ports, msg('🛡️ Insurance', { menu: true })), 'menu');
    assert.deepEqual(w.sent, [
        { text: 'Hey Jane! 👋 Tina from TTT Financial Group here.\n\nWhat can I help with today?', buttons: INSURANCE_MENU_BUTTONS },
        { text: 'Sure. What can I help with on your insurance?', buttons: INSURANCE_MENU_BUTTONS },
    ]);
    assert.equal(w.requests.length, 0);
});

test('insurance, claims off: a question is handed to the broker: request, Follow-up, then the reply', async () => {
    const w = world();
    assert.equal(await insuranceTurn(w.ports, msg('can you send me my policy schedule')), 'handed-over');
    assert.deepEqual(w.requests, [{ contactId: 'c-jane', text: 'can you send me my policy schedule', topic: 'Insurance hand-over' }]);
    assert.deepEqual(w.followUps, [{ owner: BROKER, requestId: 'req-1', contactId: 'c-jane', detail: DETAILS.question('can you send me my policy schedule') }]);
    assert.deepEqual(w.incoming, [{ requestId: 'req-1', text: 'can you send me my policy schedule' }]);
    assert.deepEqual(w.texts(), ["Thanks Jane, I've passed this to your broker, who will get back to you by Monday 16 November."]);
    assert.equal(w.claims.length, 0, 'claims off: the package is never asked');
});

test('insurance: a second message in the session goes on the same request, no second Follow-up', async () => {
    const w = world();
    await insuranceTurn(w.ports, msg('can you send me my policy schedule'));
    assert.equal(await insuranceTurn(w.ports, msg('the one for the house please')), 'added');
    assert.equal(w.requests.length, 1);
    assert.equal(w.followUps.length, 1);
    assert.deepEqual(w.incoming[1], { requestId: 'req-1', text: 'the one for the house please' });
    assert.equal(w.texts()[1], "Thanks, I've added that for your broker.");
});

test('insurance: no broker: the Insurance and Advice team, and the client hears "our insurance team"', async () => {
    const w = world({ owner: TEAM });
    await insuranceTurn(w.ports, msg('what is my excess'));
    assert.equal(w.followUps[0].owner, TEAM);
    assert.equal(w.texts()[0], "Thanks Jane, I've passed this to our insurance team, who will get back to you by Monday 16 November.");
});

test('insurance, claims off: Report a claim is a hand-over that says the claim is taken by a person', async () => {
    const w = world();
    assert.equal(await insuranceTurn(w.ports, msg('I want to report an insurance claim.', { claim: true })), 'handed-over');
    assert.equal(w.followUps[0].detail, DETAILS.claimOff(false));
    assert.equal(w.texts()[0], "Thanks Jane, I've passed this to your broker, who will contact you by Monday 16 November to take your claim.");
});

test('insurance, claims on: the claims package takes the message first, forced on a Report a claim tap', async () => {
    const w = world({ claimsEnabled: true, claimTakes: true });
    assert.equal(await insuranceTurn(w.ports, msg('my geyser burst')), 'claims');
    assert.equal(await insuranceTurn(w.ports, msg('I want to report an insurance claim.', { claim: true })), 'claims');
    assert.deepEqual(w.claims, [
        { contactId: 'c-jane', text: 'my geyser burst', force: false },
        { contactId: 'c-jane', text: 'I want to report an insurance claim.', force: true },
    ]);
    assert.equal(w.requests.length, 0);
    assert.equal(w.sent.length, 0, 'the package sends its own messages');
});

test('insurance, claims on: not a claim: the broker hand-over', async () => {
    const w = world({ claimsEnabled: true, claimTakes: false });
    assert.equal(await insuranceTurn(w.ports, msg('is my laptop covered overseas?')), 'handed-over');
    assert.equal(w.claims.length, 1);
    assert.equal(w.followUps.length, 1);
});

test('insurance, claims on, the package could not start the claim: a hand-over that says Tina could not start it', async () => {
    const w = world({ claimsEnabled: true, claimTakes: false });
    await insuranceTurn(w.ports, msg('I want to report an insurance claim.', { claim: true }));
    assert.equal(w.followUps[0].detail, DETAILS.claimOff(true));
});

test('insurance: a shared number: the claim and hand-over are for the insurance contact, not the tax one', async () => {
    const w = world({ claimsEnabled: true, claimTakes: true });
    await insuranceTurn(w.ports, msg('my car was stolen', { contact: { id: 'c-tax', firstName: 'Sam' }, lines: SHARED }));
    assert.equal(w.claims[0].contactId, 'c-ins');
    const w2 = world();
    await insuranceTurn(w2.ports, msg('what is my excess', { contact: { id: 'c-tax', firstName: 'Sam' }, lines: SHARED }));
    assert.equal(w2.requests[0].contactId, 'c-ins');
    assert.equal(w2.followUps[0].contactId, 'c-ins');
});

test('insurance: two insurance contacts on one number: no claim is started, the hand-over says to check who it is', async () => {
    const w = world({ claimsEnabled: true, claimTakes: true });
    await insuranceTurn(w.ports, msg('my car was stolen', { contact: { id: 'c-a', firstName: 'Ann' }, lines: TWO_INSURED }));
    assert.equal(w.claims.length, 0);
    assert.equal(w.requests[0].contactId, 'c-a');
    assert.match(w.followUps[0].detail, /Several contacts share this WhatsApp number/);
});

test('insurance: thanks and "ok" never open a hand-over', async () => {
    for (const t of ['thanks', 'Thank you!', 'thanks Tina 🙏', 'ok cheers', 'perfect', 'baie dankie']) assert.ok(isThanks(t), t);
    for (const t of ['thanks, but my car is still not fixed', 'thank you, what is my excess?', 'my car was stolen']) assert.ok(!isThanks(t), t);

    const w = world({ claimsEnabled: true, claimTakes: true });
    assert.equal(await insuranceTurn(w.ports, msg('Thank you!')), 'thanks');
    assert.equal(await insuranceTurn(w.ports, msg('ok')), 'menu');
    assert.equal(w.requests.length, 0);
    assert.equal(w.claims.length, 0, 'no model call on thanks or ok');
    assert.deepEqual(w.texts(), ["You're welcome! 🙌", 'Sure. What can I help with on your insurance?']);
});

test('insurance: "ok" after a hand-over is logged on its request, no reply', async () => {
    const w = world();
    await insuranceTurn(w.ports, msg('what is my excess'));
    assert.equal(await insuranceTurn(w.ports, msg('ok')), 'logged');
    assert.equal(w.sent.length, 1);
    assert.deepEqual(w.incoming[1], { requestId: 'req-1', text: 'ok' });
});

test('insurance: a file is a note on the contact and a hand-over that names it; never filed as tax', async () => {
    const w = world();
    const file = { name: 'image-1.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') };
    assert.equal(await insuranceTurn(w.ports, msg('I just sent you a document.', { file })), 'file');
    assert.deepEqual(w.files, [{ contactId: 'c-jane', name: 'image-1.jpg' }]);
    assert.equal(w.followUps[0].detail, DETAILS.file('image-1.jpg'));
    assert.equal(w.texts()[0], "Got it, I've saved your file for your broker.");
    // A second file: the same request, no second Follow-up.
    assert.equal(await insuranceTurn(w.ports, msg('I just sent you a document.', { file: { ...file, name: 'image-2.jpg' } })), 'file');
    assert.equal(w.followUps.length, 1);
    assert.equal(w.texts()[1], "Got it, I've saved your file for your broker.");
});

test('insurance: a file that could not be saved: the client is asked to send it again, nothing handed over', async () => {
    const w = world({ fileFails: true });
    assert.equal(await insuranceTurn(w.ports, msg('I just sent you a document.', { file: { name: 'a.pdf', mimeType: 'application/pdf', bytes: Buffer.from('x') } })), 'failed');
    assert.equal(w.requests.length, 0);
    assert.deepEqual(w.texts(), [TEXTS.fileFailed]);
});

test('insurance: Dataverse refuses the request or the Follow-up: the client is told to send it again, and nothing is remembered', async () => {
    const w = world({ requestFails: true });
    assert.equal(await insuranceTurn(w.ports, msg('what is my excess')), 'failed');
    assert.deepEqual(w.texts(), [TEXTS.failed]);
    assert.equal(w.handover(), null);

    const w2 = world({ followUpFails: true });
    assert.equal(await insuranceTurn(w2.ports, msg('what is my excess')), 'failed');
    assert.deepEqual(w2.texts(), [TEXTS.failed]);
    assert.equal(w2.handover(), null, 'the next message opens a fresh hand-over');
    assert.doesNotMatch(w2.texts()[0], /passed/);
});

test('offer accepted (decision B): the Insurance and Advice team, never a broker, topic Insurance offer', async () => {
    const w = world();
    assert.equal(await offerAccepted(w.ports, { contact: { id: 'c-tax', firstName: 'Sam' }, text: 'my car was stolen' }), 'handed-over');
    assert.deepEqual(w.owners, [{ contactId: 'c-tax', team: true }]);
    assert.deepEqual(w.requests, [{ contactId: 'c-tax', text: 'my car was stolen', topic: 'Insurance offer' }]);
    assert.equal(w.followUps[0].owner, TEAM);
    assert.equal(w.followUps[0].detail, DETAILS.offer('my car was stolen'));
    assert.deepEqual(w.texts(), ["Great, I've asked our insurance team to contact you by Monday 16 November."]);
    assert.equal(DETAILS.offer('Insurance!'), 'A tax client asked on WhatsApp about insurance. They have no insurance policy with TTT and asked to be contacted.');
});
