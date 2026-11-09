/**
 * TTTFG-5299: roadside help through Tina (src/domain/claimsHost.ts). A WhatsApp message and the CRM state in; the
 * replies, the requests, the kept conversation and the rows out. Claude, Dataverse, Meta and Supabase are faked. The
 * package's own rules (the number from the CRM, no emergency numbers, which policy) are tested in ttt-preseason-agent
 * test/roadside-*.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimFromClient, claimFromUnknownNumber, roadsideRequestBody, roadsideSwitch, type ClaimsHostDeps, type StoredWalkthrough } from '../../src/domain/claimsHost';
import type { AgentActionRow, ClaimRow, Outbound } from '../../src/departments/insurance/claim';
import type { Insurer, RoadsidePorts } from '../../src/departments/insurance/roadside';
import type { Policy } from '../../src/departments/insurance/walkthrough';

const PHONE = '+27821234567';
const STRANGER = '+27839990000';
const JANE = { id: 'c-jane', firstName: 'Jane' };
const NOW = new Date('2026-11-09T21:40:00Z');
const SANTAM: Policy = { id: 'p1', providerId: 'prov-santam', insurer: 'Santam Ltd', product: 'Motor', policyNumber: 'SAN-1', assistNumber: '0860 505 911' };
const HOLLARD: Policy = { id: 'p2', providerId: 'prov-hollard', insurer: 'Hollard', product: 'Motor', policyNumber: 'HOL-1', assistNumber: '0861 000 123' };
const INSURERS: Insurer[] = [{ id: 'prov-santam', name: 'Santam Ltd', assistNumber: '0860 505 911' }, { id: 'prov-bryte', name: 'Bryte Insurance' }];

const blank = { kind: 'unclear', policyNumber: null, claimType: null, description: null, incidentDate: null, incidentTime: null, place: null,
    thirdParties: null, thirdPartyDetails: null, saps: null, injuries: null, injuryDetails: null, wrongFields: [] as string[] };

function world(o: { roadside?: boolean; route?: Record<string, unknown> | null; policies?: Policy[]; isClaim?: boolean; roadsideRequestFails?: boolean } = {}) {
    const sent: Outbound[] = [];
    const claims: ClaimRow[] = [];
    const actions: AgentActionRow[] = [];
    const requests: { topic: string; contactId: string | null; text: string }[] = [];
    const store = new Map<string, StoredWalkthrough>();
    let roadsideCalls = 0;
    let claimCalls = 0;
    const ports = (contact: { id: string; firstName: string } | null): RoadsidePorts => ({
        contactByWhatsApp: async () => contact,
        activePolicies: async () => o.policies ?? [SANTAM],
        policyOwner: async () => ({ kind: 'user', id: 'u-medupi', firstName: 'Medupi', enabled: true }),
        insuranceTeam: async () => ({ id: 'team-ia', name: 'the Insurance and Advice team' }),
        createClaim: async (row) => { claims.push(row); return { id: `claim-${claims.length}`, reference: `CLM-${String(claims.length).padStart(6, '0')}` }; },
        createAgentAction: async (row) => { actions.push(row); return { id: `aa-${actions.length}` }; },
        send: async (_to, m) => void sent.push(m),
        insurers: async () => INSURERS,
    });
    const deps: ClaimsHostDeps = {
        enabled: true,
        signUpLink: 'https://ttt.example/signup',
        load: async (p) => store.get(p) ?? null,
        save: async (p, w) => void store.set(p, { ...w, updatedAt: NOW.toISOString() }),
        remove: async (p) => void store.delete(p),
        intentModel: async () => { claimCalls++; return { reportingClaim: o.isClaim ?? true }; },
        understandModel: async () => ({ ...blank, kind: 'facts', claimType: 'Motor accident', description: 'a taxi hit me' }),
        openRequest: async (contactId, _p, text) => { requests.push({ topic: 'Claim', contactId, text }); return 'req-claim'; },
        logIncoming: async () => {},
        ports: (_r, contact) => ports(contact),
        roadsideEnabled: o.roadside ?? true,
        roadsideModel: async () => { roadsideCalls++; return o.route === undefined ? { roadside: true, fromDamage: false, someoneHurt: false } : o.route; },
        openRoadsideRequest: async (contactId, _p, text) => {
            requests.push({ topic: 'Roadside assistance', contactId, text });
            return o.roadsideRequestFails ? null : 'req-roadside';
        },
    };
    return { deps, sent, claims, actions, requests, store, texts: () => sent.map((m) => m.text), roadsideCalls: () => roadsideCalls, claimCalls: () => claimCalls };
}

test('TTTFG-5299 AC 1: a known client who has broken down gets the number, under a Roadside assistance request, before any claim check', async () => {
    const w = world();
    const out = await claimFromClient(w.deps, PHONE, JANE, "I've broken down on the N1", NOW);
    assert.deepEqual(out, { handled: true, kind: 'roadside' });
    assert.match(w.texts()[0], /Santam's roadside assist line on \*0860 505 911\*/);
    assert.deepEqual(w.requests, [{ topic: 'Roadside assistance', contactId: 'c-jane', text: "I've broken down on the N1" }]);
    assert.equal(w.claimCalls(), 0, 'roadside comes first: no claim check');
    assert.equal(w.store.size, 0, 'nothing left to ask: nothing kept');
    assert.deepEqual(w.actions.map((a) => [a.kind, a.open, a.regarding.id]), [['Created', true, 'req-roadside']]);
});

test('TTTFG-5299 AC 3: the "which policy" question is kept between messages, and the tap sends that number', async () => {
    const w = world({ policies: [SANTAM, HOLLARD] });
    await claimFromClient(w.deps, PHONE, JANE, 'Car broke down', NOW);
    assert.equal(w.texts()[0], 'Which policy is this car on?');
    const kept = w.store.get(PHONE)!;
    assert.equal(kept.contactId, 'c-jane');
    assert.equal(kept.requestId, 'req-roadside');
    assert.equal((kept.state as { roadside?: boolean }).roadside, true);
    const out = await claimFromClient(w.deps, PHONE, JANE, '2. Hollard Motor policy (HOL-1)', NOW);
    assert.deepEqual(out, { handled: true, kind: 'roadside' });
    assert.match(w.texts()[1], /0861 000 123/);
    assert.equal(w.store.size, 0);
    assert.equal(w.roadsideCalls(), 1, 'the reply is read by code, not by Claude');
});

test('TTTFG-5299 AC 8: yes after an accident starts the claim walkthrough on the same policy, under a Claim request', async () => {
    const w = world({ route: { roadside: true, fromDamage: true, someoneHurt: false }, policies: [SANTAM, HOLLARD] });
    await claimFromClient(w.deps, PHONE, JANE, 'A taxi hit me, I need a tow', NOW);
    await claimFromClient(w.deps, PHONE, JANE, 'Santam', NOW);
    assert.equal(w.texts().at(-1), "Once you're safe, would you like me to start a claim for the damage?");
    const out = await claimFromClient(w.deps, PHONE, JANE, 'Yes', NOW);
    assert.deepEqual(out, { handled: true, kind: 'started' });
    assert.deepEqual(w.requests.map((r) => r.topic), ['Roadside assistance', 'Claim']);
    assert.equal(w.requests[1].text, 'A taxi hit me, I need a tow', 'the claim starts from the client\'s own words');
    const walk = w.store.get(PHONE)!.state as { policyId?: string; step: string; roadside?: true };
    assert.equal(walk.roadside, undefined);
    assert.equal(walk.policyId, 'p1', 'the policy roadside settled');
    assert.doesNotMatch(w.texts().at(-1)!, /Which policy|Is this claim about/);
});

test('TTTFG-5299 AC 8: no after an accident opens nothing', async () => {
    const w = world({ route: { roadside: true, fromDamage: true, someoneHurt: false } });
    await claimFromClient(w.deps, PHONE, JANE, 'Hit a pothole, need a tow', NOW);
    const out = await claimFromClient(w.deps, PHONE, JANE, 'No thanks', NOW);
    assert.deepEqual(out, { handled: true, kind: 'roadside' });
    assert.equal(w.claims.length, 0);
    assert.equal(w.store.size, 0);
    assert.deepEqual(w.requests.map((r) => r.topic), ['Roadside assistance']);
});

test('TTTFG-5299 AC 2: an unknown number is asked which insurer, kept with no contact, and gets that insurer\'s number', async () => {
    const w = world();
    const first = await claimFromUnknownNumber(w.deps, STRANGER, 'My car broke down, please help', NOW);
    assert.deepEqual(first, { handled: true, kind: 'roadside' });
    assert.match(w.texts()[0], /Which insurer is your car insured with\?/);
    assert.deepEqual(w.requests, [{ topic: 'Roadside assistance', contactId: null, text: 'My car broke down, please help' }]);
    assert.equal(w.store.get(STRANGER)!.contactId, '');
    await claimFromUnknownNumber(w.deps, STRANGER, 'Santam', NOW);
    assert.match(w.texts()[1], /0860 505 911/);
    assert.match(w.texts()[1], /email TTT from the email address we have on file/);
    assert.equal(w.claimCalls(), 0, 'an unknown number never gets near a claim');
    assert.deepEqual(w.actions.map((a) => [a.kind, a.owner.kind, a.contactId]), [['Created', 'team', undefined]]);
});

test('TTTFG-5299: not roadside goes on as before (the claim route, then Tina\'s normal path)', async () => {
    const w = world({ route: { roadside: false, fromDamage: false, someoneHurt: false } });
    const out = await claimFromClient(w.deps, PHONE, JANE, 'My car was stolen, I need to claim', NOW);
    assert.deepEqual(out, { handled: true, kind: 'started' });
    assert.deepEqual(w.requests.map((r) => r.topic), ['Claim']);
    const unknown = world({ route: { roadside: false, fromDamage: false, someoneHurt: false } });
    const u = await claimFromUnknownNumber(unknown.deps, STRANGER, 'I need to claim, my car was stolen', NOW);
    assert.deepEqual(u, { handled: true, kind: 'unknown-number' });
});

test('TTTFG-5299: ROADSIDE_ENABLED off is no roadside at all: no model call, and a breakdown is read as before', async () => {
    const w = world({ roadside: false, isClaim: false });
    assert.deepEqual(await claimFromClient(w.deps, PHONE, JANE, "I've broken down on the N1", NOW), { handled: false });
    assert.deepEqual(await claimFromUnknownNumber(w.deps, STRANGER, "I've broken down on the N1", NOW), { handled: false });
    assert.equal(w.roadsideCalls(), 0);
    assert.equal(roadsideSwitch(undefined), false);
    assert.equal(roadsideSwitch(''), false);
    assert.equal(roadsideSwitch('yes'), false);
    assert.equal(roadsideSwitch(' TRUE '), true);
});

test('TTTFG-5299: a claim walkthrough in progress keeps its messages; roadside isn\'t asked in the middle of it', async () => {
    const w = world({ route: { roadside: false, fromDamage: false, someoneHurt: false } });
    await claimFromClient(w.deps, PHONE, JANE, 'I need to claim, a taxi hit me', NOW);
    const before = w.roadsideCalls();
    await claimFromClient(w.deps, PHONE, JANE, 'the car had to be towed', NOW);
    assert.equal(w.roadsideCalls(), before);
});

test('TTTFG-5299: the CRM refusing the roadside request doesn\'t keep the number from the client', async () => {
    const w = world({ roadsideRequestFails: true });
    await claimFromClient(w.deps, PHONE, JANE, 'Broke down', NOW);
    assert.match(w.texts()[0], /0860 505 911/);
});

test('TTTFG-5299: the roadside request: Insurance, topic Roadside assistance; an unknown number\'s has no client', () => {
    assert.deepEqual(roadsideRequestBody('c-jane', PHONE, 'Broke down'), {
        riivo_clientmobilenumber: PHONE, riivo_channel: 1, riivo_category: 1, riivo_priority: 1, riivo_description: 'Broke down',
        riivo_classificationtopic: 'Roadside assistance', statecode: 0, statuscode: 1, 'riivo_Client@odata.bind': '/contacts(c-jane)',
    });
    assert.equal('riivo_Client@odata.bind' in roadsideRequestBody(null, STRANGER, 'Broke down'), false);
});
