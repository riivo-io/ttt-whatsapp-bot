/**
 * TTTFG-5168: Tina hands claim messages to the Insurance and Advice package (src/domain/claimsHost.ts). Scenarios from
 * the Testing subtask (TTTFG-5170) at Tina's seam: a WhatsApp message and the CRM state in; the replies, the request
 * and the records out. Claude, Dataverse, Meta and Supabase are faked. The package's own rules (order, gate, owner,
 * acknowledgement) are tested in ttt-preseason-agent test/claims-open.test.ts and test/claims-wiring.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABANDONED_AFTER_MS, claimFromClient, claimFromUnknownNumber, type ClaimsHostDeps, type StoredWalkthrough } from '../../src/domain/claimsHost';
import { SAFETY_TEXT, type AgentActionRow, type ClaimPorts, type ClaimRow, type Outbound } from '../../src/departments/insurance/claim';
import type { Policy } from '../../src/departments/insurance/walkthrough';

const PHONE = '+27821234567';
const JANE = { id: 'c-jane', firstName: 'Jane' };
const NOW = new Date('2026-11-04T08:00:00Z');
const DISCOVERY: Policy = { id: 'p1', providerId: 'prov-1', insurer: 'Discovery Insure', product: 'Personal', policyNumber: 'DI-1', assistNumber: '0860 751 751' };

const blank = { kind: 'unclear', policyNumber: null, claimType: null, description: null, incidentDate: null, incidentTime: null, place: null,
    thirdParties: null, thirdPartyDetails: null, saps: null, injuries: null, injuryDetails: null, wrongFields: [] as string[] };

/** A fake Claude: the intent model says yes to claim words; the understand model answers from a queue. */
function world(o: { policies?: Policy[]; enabled?: boolean; answers?: Record<string, unknown>[]; requestFails?: boolean; isClaim?: boolean } = {}) {
    const sent: Outbound[] = [];
    const claims: ClaimRow[] = [];
    const actions: AgentActionRow[] = [];
    const requests: string[] = [];
    const incoming: string[] = [];
    const store = new Map<string, StoredWalkthrough>();
    const answers = [...(o.answers ?? [])];
    let intentCalls = 0;
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
        load: async (p) => store.get(p) ?? null,
        save: async (p, w) => void store.set(p, { ...w, updatedAt: NOW.toISOString() }),
        remove: async (p) => void store.delete(p),
        intentModel: async () => { intentCalls++; return { reportingClaim: o.isClaim ?? true }; },
        understandModel: async () => ({ ...blank, ...(answers.shift() ?? {}) }),
        openRequest: async (_c, _p, text) => { if (o.requestFails) return null; requests.push(text); return 'req-1'; },
        logIncoming: async (_r, text) => void incoming.push(text),
        ports: (_r, contact) => ports(contact),
    };
    return { deps, sent, claims, actions, requests, incoming, store, texts: () => sent.map((m) => m.text), intentCalls: () => intentCalls };
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
    const { withOpeningFacts } = await import('../../src/domain/claimsHost');
    const { question } = await import('../../src/departments/insurance/claim');
    const { missingFor } = await import('../../src/departments/insurance/walkthrough');
    const model = async () => ({ ...blank, kind: 'facts', claimType: 'Portable possessions', description: 'my phone was stolen' });
    const start = { contactId: 'c', firstName: 'Jane', policies: [DISCOVERY], policyId: 'p1', step: 'incident' as const, facts: {} };
    const s = await withOpeningFacts(model as never, start, 'Hi, my phone was stolen', NOW);
    assert.equal(s.facts.description, undefined); // still asked for the whole story
    assert.equal(s.opening, 'my phone was stolen');
    const q = question('incident', missingFor('incident', s.facts), s);
    assert.match(q, /what was taken/);
    assert.doesNotMatch(q, /lost/);
});
