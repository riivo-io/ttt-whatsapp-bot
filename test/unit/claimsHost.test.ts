/**
 * TTTFG-5168: Tina hands claim messages to the Insurance and Advice package (src/domain/claimsHost.ts). Scenarios from
 * the Testing subtask (TTTFG-5170) at Tina's seam: a WhatsApp message and the CRM state in; the replies, the request
 * and the records out. Claude, Dataverse, Meta and Supabase are faked. The package's own rules (order, gate, owner,
 * acknowledgement) are tested in ttt-preseason-agent test/claims-open.test.ts and test/claims-wiring.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ABANDONED_AFTER_MS, claimFromClient, claimFromUnknownNumber, claimsContactNumber, claimsConversation, type ClaimsHostDeps, type StoredWalkthrough,
} from '../../src/domain/claimsHost';
import { question, SAFETY_TEXT, type AgentActionRow, type ClaimPorts, type ClaimRow, type Outbound } from '../../src/departments/insurance/claim';
import { missingFor, type Policy } from '../../src/departments/insurance/walkthrough';

const PHONE = '+27821234567';
const JANE = { id: 'c-jane', firstName: 'Jane' };
const NOW = new Date('2026-11-04T08:00:00Z');
const DISCOVERY: Policy = { id: 'p1', providerId: 'prov-1', insurer: 'Discovery Insure', product: 'Personal', policyNumber: 'DI-1', assistNumber: '0860 751 751' };

const blank = { kind: 'unclear', policyNumber: null, claimType: null, description: null, incidentDate: null, incidentTime: null, place: null,
    thirdParties: null, thirdPartyDetails: null, saps: null, injuries: null, injuryDetails: null, wrongFields: [] as string[] };

/** A fake Claude: the intent model says yes to claim words; the understand model answers from a queue. */
function world(o: {
    policies?: Policy[]; enabled?: boolean; answers?: Record<string, unknown>[]; requestFails?: boolean; isClaim?: boolean; contactNumber?: string;
} = {}) {
    const sent: Outbound[] = [];
    const claims: ClaimRow[] = [];
    const actions: AgentActionRow[] = [];
    const requests: string[] = [];
    const incoming: string[] = [];
    const store = new Map<string, StoredWalkthrough>();
    const answers = [...(o.answers ?? [])];
    let intentCalls = 0;
    /** Each understand-model call: how many messages Tina had sent by then, and what it was given to read. */
    const reads: { sentBefore: number; user: string }[] = [];
    const ports = (contact: { id: string; firstName: string } | null): ClaimPorts => ({
        contactByWhatsApp: async () => contact,
        activePolicies: async () => o.policies ?? [DISCOVERY],
        policyOwner: async () => ({ kind: 'user', id: 'u-medupi', firstName: 'Medupi', enabled: true }),
        insuranceTeam: async () => ({ id: 'team-ia', name: 'the Insurance and Advice team' }),
        createClaim: async (row) => { claims.push(row); return { id: `claim-${claims.length}`, reference: `CLM-${String(claims.length).padStart(6, '0')}` }; },
        createAgentAction: async (row) => { actions.push(row); return { id: `aa-${actions.length}`, dueOn: '2026-11-05T15:00:00.000Z' }; },
        send: async (_to, m) => void sent.push(m),
    });
    const deps: ClaimsHostDeps = {
        enabled: o.enabled ?? true,
        signUpLink: 'https://ttt.example/signup',
        ...(o.contactNumber !== undefined ? { contactNumber: o.contactNumber } : {}),
        load: async (p) => store.get(p) ?? null,
        save: async (p, w) => void store.set(p, { ...w, updatedAt: NOW.toISOString() }),
        remove: async (p) => void store.delete(p),
        intentModel: async () => { intentCalls++; return { reportingClaim: o.isClaim ?? true }; },
        understandModel: async (req) => (reads.push({ sentBefore: sent.length, user: req.user }), { ...blank, ...(answers.shift() ?? {}) }),
        openRequest: async (_c, _p, text) => { if (o.requestFails) return null; requests.push(text); return 'req-1'; },
        logIncoming: async (_r, text) => void incoming.push(text),
        ports: (_r, contact) => ports(contact),
    };
    return { deps, sent, claims, actions, requests, incoming, store, reads, texts: () => sent.map((m) => m.text), intentCalls: () => intentCalls };
}

test('TTTFG-5168 check 1: "I need to claim, my car was hit" opens an Insurance request and starts the walkthrough', async () => {
    const w = world({ answers: [{ kind: 'facts', claimType: 'Motor accident', description: 'my car was hit' }] });
    const out = await claimFromClient(w.deps, PHONE, JANE, 'I need to claim, my car was hit', NOW);
    assert.deepEqual(out, { handled: true, kind: 'started' });
    assert.deepEqual(w.requests, ['I need to claim, my car was hit']);
    assert.deepEqual(w.incoming, ['I need to claim, my car was hit']);
    assert.equal(w.texts()[0], 'Is this claim about your Discovery Insure Personal policy (DI-1)?');
    const stored = w.store.get(PHONE)!;
    assert.equal(stored.state.step, 'policy');
    assert.equal(stored.state.facts.claimType, 'Motor accident', 'what the client already said is kept');
    assert.equal(stored.state.facts.description, undefined, 'a four-word opening line is not the description: Tina asks for it');
    assert.equal(stored.lastSent, w.texts()[0]);
});

test('TTTFG-5168: a message that is not a claim report goes back to Tina\'s normal path', async () => {
    const tax = world();
    assert.deepEqual(await claimFromClient(tax.deps, PHONE, JANE, 'When is my tax return due?', NOW), { handled: false });
    assert.equal(tax.intentCalls(), 0, 'no claim words: no model call');
    const question = world({ isClaim: false });
    assert.deepEqual(await claimFromClient(question.deps, PHONE, JANE, 'Is my geyser covered if it bursts?', NOW), { handled: false });
    assert.equal(question.requests.length, 0);
});

test('TTTFG-5168 check 2: an unknown number reporting a claim gets only the unknown-number reply', async () => {
    const w = world();
    const out = await claimFromUnknownNumber(w.deps, PHONE, 'I need to claim, my car was hit');
    assert.deepEqual(out, { handled: true, kind: 'unknown-number' });
    assert.equal(w.texts().length, 1);
    assert.match(w.texts()[0], /I can't find this number on our system\. If you're already a TTT client, please email us from the address we have on file/);
    assert.doesNotMatch(w.texts()[0], /\bID\b|identity|policy number/i);
    assert.equal(w.claims.length, 0);
    assert.equal(w.actions.length, 0);
    assert.equal(w.requests.length, 0);
    assert.deepEqual(await claimFromUnknownNumber(world().deps, PHONE, 'Hi, how do I sign up?'), { handled: false });
});

test('TTTFG-5168 checks 4 to 8 through Tina: a whole claim from first message to acknowledgement', async () => {
    const w = world({ answers: [
        {}, // first read of "my car was hit": nothing beyond the claim words
        { kind: 'yes' }, // policy confirmed
        { kind: 'facts', claimType: 'Motor accident' },
        // "ready" after the on-scene list is read without the model (understand.ts READY_WORDS).
        { kind: 'facts', description: 'A car drove into the back of mine at the robot.', incidentDate: '2026-11-03', incidentTime: '14:30', place: 'Main Rd, Claremont' },
        { kind: 'facts', thirdParties: true, thirdPartyDetails: 'the other driver, CA 123-456', saps: false, injuries: true, injuryDetails: 'passenger hurt her neck' },
        { kind: 'correct', wrongFields: ['incidentAt'] },
        { kind: 'correct', incidentDate: '2026-11-03', incidentTime: '14:30' },
        { kind: 'confirm' },
    ] });
    const say = (t: string) => claimFromClient(w.deps, PHONE, JANE, t, NOW);
    await say('I need to claim, my car was hit');
    await say('yes');
    // TTTFG-4830 (28 Oct 2026): what to do if anyone is hurt is a line, not a question, and comes first.
    assert.deepEqual(w.texts().slice(-2), [SAFETY_TEXT, 'What kind of claim is it?']);
    await say('car accident');
    assert.match(w.texts().at(-1)!, /Tap \*Ready\* to begin\.$/);
    await say('ready');
    await say('yesterday at 14:30, someone drove into the back of me at the robot on Main Rd, Claremont');
    await say('yes the other driver, CA 123-456; no police; my passenger hurt her neck');
    assert.match(w.texts().at(-1)!, /^Here's what I have/);
    await say('no, the date is wrong');
    assert.equal(w.claims.length, 0, 'no claim before the client confirms');
    assert.match(w.texts().at(-1)!, /^What should it be\?/);
    await say('3 November at 14:30');
    const out = await say('yes that is right');
    assert.deepEqual(out, { handled: true, kind: 'opened', reference: 'CLM-000001' });
    assert.equal(w.claims.length, 1);
    assert.equal(w.claims[0].incidentAt, '2026-11-03T14:30:00+02:00');
    assert.equal(w.claims[0].status, 'FNOL logged');
    assert.equal(w.claims[0].channel, 'WhatsApp');
    assert.equal(w.sent.at(-1)!.kind, 'template');
    assert.match(w.texts().at(-1)!, /CLM-000001/);
    assert.equal(w.store.has(PHONE), false, 'the walkthrough ends when the claim opens');
    assert.equal(w.requests.length, 1, 'one request for the whole conversation');
    for (const t of w.texts()) assert.doesNotMatch(t, /(?:your|the) policy number|ID number/i);
});

test('TTTFG-5168 check 10 through Tina: no active policy, no claim, the walkthrough isn\'t kept', async () => {
    const w = world({ policies: [] });
    const out = await claimFromClient(w.deps, PHONE, JANE, 'my geyser burst', NOW);
    assert.deepEqual(out, { handled: true, kind: 'ended' });
    assert.equal(w.claims.length, 0);
    assert.equal(w.actions[0].kind, 'Follow-up');
    assert.equal(w.actions[0].owner.id, 'team-ia');
    assert.equal(w.store.has(PHONE), false);
});

test('TTTFG-5168: an abandoned walkthrough, or one for another contact, is dropped', async () => {
    const w = world({ isClaim: false });
    const old: StoredWalkthrough = { contactId: JANE.id, requestId: 'req-0', lastSent: 'q', updatedAt: new Date(NOW.getTime() - ABANDONED_AFTER_MS - 1).toISOString(),
        state: { contactId: JANE.id, firstName: 'Jane', policies: [DISCOVERY], step: 'policy', facts: {} } };
    w.store.set(PHONE, old);
    assert.deepEqual(await claimFromClient(w.deps, PHONE, JANE, 'hi', NOW), { handled: false });
    assert.equal(w.store.has(PHONE), false);
    w.store.set(PHONE, { ...old, updatedAt: NOW.toISOString() });
    assert.deepEqual(await claimFromClient(w.deps, PHONE, { id: 'c-other', firstName: 'Sam' }, 'hi', NOW), { handled: false });
    assert.equal(w.store.has(PHONE), false);
});

test('TTTFG-5168: switched off, or no request could be opened: Tina answers as before', async () => {
    const off = world({ enabled: false });
    assert.deepEqual(await claimFromClient(off.deps, PHONE, JANE, 'I need to claim, my car was hit', NOW), { handled: false });
    assert.deepEqual(await claimFromUnknownNumber(off.deps, PHONE, 'I need to claim'), { handled: false });
    assert.equal(off.intentCalls(), 0);
    const noReq = world({ requestFails: true });
    assert.deepEqual(await claimFromClient(noReq.deps, PHONE, JANE, 'I need to claim, my car was hit', NOW), { handled: false });
    assert.equal(noReq.sent.length, 0);
});

test('TTTFG-4830: a short opening ("Hi, my phone was stolen") is kept as a hint, so the questions are for a stolen phone', async () => {
    const w = world({ answers: [{ kind: 'facts', claimType: 'Portable possessions', description: 'my phone was stolen' }] });
    assert.deepEqual(await claimFromClient(w.deps, PHONE, JANE, 'Hi, my phone was stolen', NOW), { handled: true, kind: 'started' });
    const s = w.store.get(PHONE)!.state;
    assert.equal(s.step, 'policy'); // the policy is still the first question
    assert.equal(s.facts.claimType, 'Portable possessions');
    assert.equal(s.facts.description, undefined); // still asked for the whole story
    assert.equal(s.opening, 'my phone was stolen');
    const q = question('incident', missingFor('incident', s.facts, s.opening), { ...s, policyId: 'p1', step: 'incident' });
    assert.match(q, /what was taken/);
    assert.doesNotMatch(q, /lost/);
});

test('TTTFG-4830 (28 Oct 2026): the opening is read before the walkthrough starts, so the policy question offers only the policies that fit', async () => {
    const CAR: Policy = { ...DISCOVERY, id: 'p-car', product: 'Motor', policyNumber: 'DI-CAR' };
    const HOME: Policy = { ...DISCOVERY, id: 'p-home', product: 'Household', policyNumber: 'DI-HOME' };
    const opening = 'Someone broke into my house last night and took the TV and my laptop';
    const w = world({ policies: [CAR, HOME], answers: [{ kind: 'facts', claimType: 'Property loss or damage', description: opening }] });
    await claimFromClient(w.deps, PHONE, JANE, opening, NOW);
    // One read, of the opening, before anything was sent.
    assert.equal(w.reads.length, 1);
    assert.equal(w.reads[0].sentBefore, 0);
    assert.match(w.reads[0].user, /Someone broke into my house last night/);
    assert.deepEqual(w.texts(), ['Is this claim about your Discovery Insure Household policy (DI-HOME)?']);
    const s = w.store.get(PHONE)!.state;
    assert.deepEqual(s.policies.map((p) => p.id), ['p-home']);
    assert.deepEqual(s.allPolicies?.map((p) => p.id), ['p-car', 'p-home'], 'the motor policy is kept, in case the client says no');
    assert.equal(s.facts.description, opening);
});

test('TTTFG-4830 (28 Oct 2026): an opening that says nothing about the claim offers every policy, and nothing is kept', async () => {
    const CAR: Policy = { ...DISCOVERY, id: 'p-car', product: 'Motor', policyNumber: 'DI-CAR' };
    const HOME: Policy = { ...DISCOVERY, id: 'p-home', product: 'Household', policyNumber: 'DI-HOME' };
    const w = world({ policies: [CAR, HOME], answers: [{}] }); // the model reads it as unclear
    await claimFromClient(w.deps, PHONE, JANE, 'I need to make a claim', NOW);
    const s = w.store.get(PHONE)!.state;
    assert.deepEqual(s.policies.map((p) => p.id), ['p-car', 'p-home']);
    assert.equal(s.allPolicies, undefined);
    assert.deepEqual(s.facts, {});
    assert.equal(s.opening, undefined);
});

test('TTTFG-4830 (28 Oct 2026): CLAIMS_CONTACT_NUMBER goes on the burst-geyser list after the insurer\'s assist line; unset or blank, it is left out', async () => {
    const HOME: Policy = { id: 'p-home', providerId: 'prov-om', insurer: 'Old Mutual Insure', product: 'Household', policyNumber: 'OM-1', assistNumber: '0860 111 222' };
    const GEYSER = 'My geyser burst this morning and water came through the bedroom ceiling';
    const geyserList = async (raw: string | undefined, assistNumber = HOME.assistNumber) => {
        const w = world({
            policies: [{ ...HOME, assistNumber }], contactNumber: claimsContactNumber(raw),
            answers: [{ kind: 'facts', claimType: 'Property loss or damage', description: GEYSER }, { kind: 'yes' }],
        });
        await claimFromClient(w.deps, PHONE, JANE, GEYSER, NOW);
        await claimFromClient(w.deps, PHONE, JANE, 'yes', NOW);
        const list = w.texts().find((t) => t.startsWith("If you're at the property")) ?? '';
        assert.match(list, /Turn off the water/);
        return list;
    };
    assert.match(await geyserList(' 021 555 0100 '),
        /\n\nNeed a plumber urgently\? Call Old Mutual Insure's assist line on 0860 111 222\. You can also call TTT on 021 555 0100\.\n\n/);
    assert.match(await geyserList('021 555 0100', ''), /\n\nYou can also call TTT on 021 555 0100\.\n\n/);
    for (const raw of [undefined, '', '   ']) {
        const list = await geyserList(raw);
        assert.match(list, /Call Old Mutual Insure's assist line on 0860 111 222\./);
        assert.doesNotMatch(list, /call TTT/i);
    }
    assert.doesNotMatch(await geyserList(undefined, ''), /plumber urgently|call TTT/i);
});

test('TTTFG-4830: CLAIMS_CONTACT_NUMBER is trimmed; unset or blank is no number (TTT chooses which number, so there is no default)', () => {
    assert.equal(claimsContactNumber(undefined), undefined);
    assert.equal(claimsContactNumber(''), undefined);
    assert.equal(claimsContactNumber('   '), undefined);
    assert.equal(claimsContactNumber(' 021 555 0100 '), '021 555 0100');
    assert.deepEqual(claimsConversation(PHONE, 'req-1', 'https://ttt.example/signup'), { phone: PHONE, requestId: 'req-1', signUpLink: 'https://ttt.example/signup' });
    assert.deepEqual(claimsConversation(PHONE, 'req-1', 'https://ttt.example/signup', '021 555 0100'),
        { phone: PHONE, requestId: 'req-1', signUpLink: 'https://ttt.example/signup', contactNumber: '021 555 0100' });
});
