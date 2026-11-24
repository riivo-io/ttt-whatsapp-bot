/**
 * TTTFG-5340 (SPEC-05 "Unknown numbers"): a WhatsApp number on no contact and no lead (src/domain/unknownNumber.ts).
 * A message and the CRM state in; the replies, the lead, the Created action and what is kept out. Meta, Dynamics and Supabase
 * are faked. The ports a stranger's message can reach are only these: there is no contact write and no ID-number lookup to
 * call, which is acceptance criteria 2 and 3 by construction. toolRegistry.test.ts proves the tool is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    answerUnknownNumber, createdActionColumns, createdActionName, isPlaceholderLead, placeholderLeadNames, placeholderLeadParams, REPLY_WINDOW_MS,
    routeUnknownNumber, TAX_LEAD_TYPE, unknownNumberReply, type UnknownNumberPorts,
} from '../../src/domain/unknownNumber';
import { claimFromUnknownNumber, type ClaimsHostDeps, type StoredWalkthrough } from '../../src/domain/claimsHost';
import type { Outbound } from '../../src/departments/insurance/claim';
import type { Insurer, RoadsidePorts } from '../../src/departments/insurance/roadside';

const LINK = 'https://www.ttt-tax.co.za/client-onboarding';
const JANE_ID = '8001015009087';
const JANE_MESSAGE = `Hi, I'm Jane Smith, ID ${JANE_ID}, where is my refund?`;
const STRANGER = '27839990000';
const T0 = new Date('2026-11-18T08:00:00Z');
const hoursLater = (h: number) => new Date(T0.getTime() + h * 3_600_000);

/** A fake world that behaves like the reply table: one statement decides who may answer. */
function world(o: { leadFails?: boolean; actionFails?: boolean; sendFails?: boolean; sendThrows?: boolean; known?: boolean; lookupFails?: boolean } = {}) {
    const replies = new Map<string, { repliedAt: number; leadId: string | null; actionId: string | null }>();
    const sent: { to: string; text: string }[] = [];
    const leads: { phone: string; id: string }[] = [];
    const actions: { phone: string; leadId: string; at: string; source?: string }[] = [];
    const log: string[] = [];
    let confirms = 0;
    const contacts = [{ id: 'c-jane', name: 'Jane Smith', mobile: '27821110000', idNumber: JANE_ID }];
    const ports: UnknownNumberPorts = {
        async claim(phone, now) {
            const row = replies.get(phone);
            if (!row) { replies.set(phone, { repliedAt: now.getTime(), leadId: null, actionId: null }); return { claimed: true, leadId: null, actionId: null }; }
            if (row.repliedAt < now.getTime() - REPLY_WINDOW_MS) { row.repliedAt = now.getTime(); return { claimed: true, leadId: row.leadId, actionId: row.actionId }; }
            return { claimed: false, leadId: row.leadId, actionId: row.actionId };
        },
        async release(phone) { replies.get(phone)!.repliedAt = 0; },
        async confirmUnknown() {
            confirms++;
            if (o.lookupFails) throw new Error('Request failed with status code 429');
            if (o.known) throw new Error('the CRM says this number is known after all');
        },
        async createLead(phone) {
            if (o.leadFails) throw new Error('the CRM did not make the lead');
            // As the real port: a lead already on the number is adopted, never doubled.
            const existing = leads.find((l) => l.phone === phone);
            if (existing) return existing.id;
            const id = `lead-${leads.length + 1}`;
            leads.push({ phone, id });
            return id;
        },
        async createAction(phone, leadId, at, source) {
            if (o.actionFails) throw new Error('the CRM refused the action');
            actions.push({ phone, leadId, at, ...(source ? { source } : {}) });
            return `aa-${actions.length}`;
        },
        async remember(phone, leadId, actionId) {
            const row = replies.get(phone)!;
            row.leadId = leadId;
            if (actionId) row.actionId = actionId;
        },
        async send(phone, text) {
            if (o.sendThrows) throw new Error('Meta is down');
            if (o.sendFails) return false;
            sent.push({ to: phone, text });
            return true;
        },
        log: (line) => void log.push(line),
    };
    return { ports, replies, sent, leads, actions, log, contacts, confirms: () => confirms, texts: () => sent.map((m) => m.text) };
}

test('AC 1, 2, 3, 5: the Jane Smith message gets one fixed reply with the tax link, one Tax lead and one Created action, and no contact is touched', async () => {
    const w = world();
    const before = JSON.stringify(w.contacts);
    const out = await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.deepEqual(out, { replied: true, leadCreated: true, leadId: 'lead-1' });
    assert.deepEqual(w.sent, [{
        to: STRANGER,
        text: `I can't find this number on our system. If you're already a TTT client, please email us from the address we have on file. If you're new, you can sign up here: ${LINK}`,
    }]);
    assert.deepEqual(w.leads, [{ phone: STRANGER, id: 'lead-1' }]);
    assert.deepEqual(w.actions, [{ phone: STRANGER, leadId: 'lead-1', at: T0.toISOString(), source: 'wamid.1' }]);
    assert.equal(JSON.stringify(w.contacts), before, 'Jane\'s record is not touched');
    assert.deepEqual(w.replies.get(STRANGER), { repliedAt: T0.getTime(), leadId: 'lead-1', actionId: 'aa-1' });
});

test('AC 1: the reply answers no question and asks for nothing', () => {
    const text = unknownNumberReply(LINK);
    assert.doesNotMatch(text, /refund|\bID\b|id number|13-digit|policy number|\?/i);
    assert.match(text, /^I can't find this number on our system\./);
    assert.ok(text.endsWith(LINK));
});

test('AC 2, 3: what the person typed is never handed to a port: no ID number is read, searched or stored', async () => {
    const w = world();
    const seen: unknown[][] = [];
    for (const name of ['claim', 'release', 'createLead', 'createAction', 'remember', 'send'] as const) {
        const real = w.ports[name] as (...a: unknown[]) => Promise<unknown>;
        (w.ports[name] as unknown) = (...a: unknown[]) => { seen.push(a); return real(...a); };
    }
    await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    // answerUnknownNumber is never given the message text (its parameters are the phone, the link, the time and the message id),
    // so the ID number cannot reach the CRM, the table or the reply.
    assert.equal(JSON.stringify(seen).includes(JANE_ID), false);
    assert.equal(JSON.stringify(seen).includes('refund'), false);
    assert.doesNotMatch(createdActionName(STRANGER), new RegExp(JANE_ID));
});

test('AC 5: the lead is made for the Tax team from the number alone', () => {
    assert.equal(TAX_LEAD_TYPE, 100000000, 'riivo_leadtype Tax');
    assert.deepEqual(placeholderLeadNames('27839990000'), { firstName: 'WhatsApp', lastName: '27839990000' });
    assert.match(createdActionName('27839990000'), /^New lead from WhatsApp 27839990000: Tina sent the tax sign-up link\./);
    assert.ok(createdActionName('27839990000').length <= 300);
});

test('AC 5: the lead is a Tax lead owned by the Tax team, with only the number to go on and no lead source (DEV labels 463630005 "Refer and Earn")', () => {
    assert.deepEqual(placeholderLeadParams('27839990000', 'team-tax'), {
        firstName: 'WhatsApp', lastName: '27839990000', phone: '27839990000', leadType: 100000000, ownerTeamId: 'team-tax',
    });
    assert.equal('ownerTeamId' in placeholderLeadParams('27839990000'), false, 'no team found: the CRM default owner');
});

test('AC 5: the Created action is open, department Tax, owned by the Tax team, regarding the lead; it carries no message text', () => {
    const row = createdActionColumns({ phone: '27839990000', leadId: 'lead-1', at: T0.toISOString(), sourceMessageId: 'wamid.1', ownerTeamId: 'team-tax' });
    assert.equal(row.riivo_kind, 463630007, 'Kind Created');
    assert.equal(row.riivo_status, 463630000, 'open: it shows in My Day until a person has checked it');
    assert.equal(row.riivo_channel, 463630001, 'WhatsApp');
    assert.equal(row.riivo_department, 463630000, 'Tax');
    assert.equal(row['ownerid@odata.bind'], '/teams(team-tax)');
    assert.equal(row['riivo_Client_new_lead@odata.bind'], '/new_leads(lead-1)');
    assert.equal(row.riivo_sourcemessageid, 'wamid.1');
    assert.equal(row.riivo_recipient, '27839990000');
    assert.equal(JSON.stringify(row).includes(JANE_ID), false);
    assert.equal(createdActionColumns({ phone: '27839990000', leadId: 'lead-1', at: T0.toISOString() }).riivo_sourcemessageid, 'whatsapp:27839990000');
    assert.equal('ownerid@odata.bind' in createdActionColumns({ phone: '27839990000', leadId: 'lead-1', at: T0.toISOString() }), false);
});

test('AC 6: a second message from the same number inside 24 hours gets no reply and no second lead', async () => {
    const w = world();
    await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    const second = await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(0.01), 'wamid.2');
    const third = await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(23.9), 'wamid.3');
    assert.deepEqual(second, { replied: false, leadCreated: false, leadId: 'lead-1' });
    assert.deepEqual(third, { replied: false, leadCreated: false, leadId: 'lead-1' });
    assert.equal(w.sent.length, 1);
    assert.equal(w.leads.length, 1);
    assert.equal(w.actions.length, 1);
});

test('AC 6: after 24 hours the same number is answered again, and still never gets a second lead', async () => {
    const w = world();
    await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    const later = await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(24.5), 'wamid.4');
    assert.deepEqual(later, { replied: true, leadCreated: false, leadId: 'lead-1' });
    assert.equal(w.sent.length, 2);
    assert.equal(w.leads.length, 1);
    assert.equal(w.actions.length, 1);
});

test('AC 6: two messages handled at the same moment give one reply and one lead', async () => {
    const w = world();
    const [a, b] = await Promise.all([
        answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1'),
        answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.2'),
    ]);
    assert.deepEqual([a.replied, b.replied].sort(), [false, true]);
    assert.equal(w.sent.length, 1);
    assert.equal(w.leads.length, 1);
});

test('AC 6: different numbers are answered separately', async () => {
    const w = world();
    await answerUnknownNumber(w.ports, STRANGER, LINK, T0);
    await answerUnknownNumber(w.ports, '27831112222', LINK, T0);
    assert.equal(w.sent.length, 2);
    assert.equal(w.leads.length, 2);
});

test('a CRM that refuses the lead never stops the reply; the next answer (after 24 hours) tries the lead again', async () => {
    const failing = world({ leadFails: true });
    const out = await answerUnknownNumber(failing.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.deepEqual(out, { replied: true, leadCreated: false, leadId: null });
    assert.equal(failing.sent.length, 1);
    assert.equal(failing.actions.length, 0, 'no action for a lead that does not exist');
    assert.match(failing.log.join('\n'), /no lead made/);

    // The same table, the CRM back: the number has no lead, so the next answer makes it.
    const healthy = world();
    healthy.replies.set(STRANGER, { repliedAt: T0.getTime(), leadId: null, actionId: null });
    const next = await answerUnknownNumber(healthy.ports, STRANGER, LINK, hoursLater(25), 'wamid.9');
    assert.deepEqual(next, { replied: true, leadCreated: true, leadId: 'lead-1' });
});

test('a CRM that refuses the Created action keeps the lead (so there is never a second one) and still replies', async () => {
    const w = world({ actionFails: true });
    const out = await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.deepEqual(out, { replied: true, leadCreated: true, leadId: 'lead-1' });
    assert.equal(w.replies.get(STRANGER)!.leadId, 'lead-1');
    assert.equal(w.replies.get(STRANGER)!.actionId, null);
    assert.match(w.log.join('\n'), /has no Created action yet/);
    const later = await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(30), 'wamid.2');
    assert.equal(later.leadCreated, false);
    assert.equal(w.leads.length, 1);
});

test('a reply WhatsApp did not take gives the claim back, so the next message is answered, with the lead kept', async () => {
    const w = world({ sendFails: true });
    const out = await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.deepEqual(out, { replied: false, leadCreated: true, leadId: 'lead-1' });
    assert.equal(w.leads.length, 1, 'the lead is made before the reply: a refused reply is not a lead nobody hears of');
    assert.equal(w.actions.length, 1);
    w.ports.send = async (to, text) => { w.sent.push({ to, text }); return true; };
    const retry = await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(0.02), 'wamid.2');
    assert.deepEqual(retry, { replied: true, leadCreated: false, leadId: 'lead-1' });
    assert.equal(w.leads.length, 1);
});

test('a send that throws gives the claim back and throws on, so the worker\'s retry is not read as a repeat', async () => {
    const w = world({ sendThrows: true });
    await assert.rejects(answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1'), /Meta is down/);
    assert.equal(w.replies.get(STRANGER)!.repliedAt, 0);
    w.ports.send = async (to, text) => { w.sent.push({ to, text }); return true; };
    const retry = await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.equal(retry.replied, true);
    assert.equal(w.leads.length, 1);
});

test('a lead that is made but could not be kept is kept on a second try, and the Created action still follows', async () => {
    const w = world();
    let tries = 0;
    const remember = w.ports.remember;
    w.ports.remember = async (phone, leadId, actionId) => { if (++tries === 1) throw new Error('Supabase blip'); return remember(phone, leadId, actionId); };
    const out = await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.deepEqual(out, { replied: true, leadCreated: true, leadId: 'lead-1' });
    assert.equal(w.replies.get(STRANGER)!.leadId, 'lead-1');
    assert.equal(w.actions.length, 1);
});

test('a lead that cannot be kept at all gives the claim back and throws, so the worker retries: the retry adopts the lead and keeps it', async () => {
    const w = world();
    const remember = w.ports.remember;
    w.ports.remember = async () => { throw new Error('Supabase is down'); };
    await assert.rejects(answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1'), /could not be kept against the number/);
    assert.equal(w.sent.length, 0, 'no reply: the message is retried, not answered half-done');
    assert.equal(w.replies.get(STRANGER)!.repliedAt, 0, 'the claim is given back');
    assert.equal(w.actions.length, 0);

    w.ports.remember = remember;
    const retry = await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.deepEqual(retry, { replied: true, leadCreated: true, leadId: 'lead-1' });
    assert.equal(w.leads.length, 1, 'the retry adopted the lead: never two');
    assert.equal(w.replies.get(STRANGER)!.leadId, 'lead-1');
    assert.equal(w.actions.length, 1);
});

test('a Created action that failed is written on the next answer, so the Tax team does hear of the lead', async () => {
    const w = world({ actionFails: true });
    await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.equal(w.actions.length, 0);
    assert.equal(w.replies.get(STRANGER)!.actionId, null);
    assert.match(w.log.join('\n'), /has no Created action yet/);

    // The CRM is back (a fresh world with the same row, minus the action).
    const healthy = world();
    healthy.replies.set(STRANGER, { repliedAt: T0.getTime(), leadId: 'lead-1', actionId: null });
    healthy.leads.push({ phone: STRANGER, id: 'lead-1' });
    const later = await answerUnknownNumber(healthy.ports, STRANGER, LINK, hoursLater(25), 'wamid.9');
    assert.deepEqual(later, { replied: true, leadCreated: false, leadId: 'lead-1' });
    assert.equal(healthy.leads.length, 1, 'no second lead');
    assert.equal(healthy.actions.length, 1, 'the action that was missing');
    assert.equal(healthy.replies.get(STRANGER)!.actionId, 'aa-1');
    // And once it exists it is not written again.
    await answerUnknownNumber(healthy.ports, STRANGER, LINK, hoursLater(50), 'wamid.10');
    assert.equal(healthy.actions.length, 1);
});

test('a number the CRM says is known after all (or whose lookup failed) gets no reply and no lead; the claim is given back and the message is retried', async () => {
    for (const o of [{ known: true }, { lookupFails: true }]) {
        const w = world(o);
        await assert.rejects(answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1'));
        assert.equal(w.sent.length, 0);
        assert.equal(w.leads.length, 0);
        assert.equal(w.replies.get(STRANGER)!.repliedAt, 0);
    }
});

test('the CRM is asked again once, when the reply is claimed and Tina has no lead on the number: a repeat or the placeholder costs no call', async () => {
    const w = world();
    await answerUnknownNumber(w.ports, STRANGER, LINK, T0, 'wamid.1');
    assert.equal(w.confirms(), 1);
    await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(1), 'wamid.2');
    assert.equal(w.confirms(), 1, 'a repeat inside 24 hours: not even claimed, so no CRM call');
    await answerUnknownNumber(w.ports, STRANGER, LINK, hoursLater(25), 'wamid.3');
    assert.equal(w.confirms(), 1, 'Tina\'s own lead is on the number: the placeholder needs no lookup');
});

// ---- AC 8: a known number is served as before ------------------------------------------------------------------------

test('AC 8: only the lead Tina made, with no email yet, is still the unknown number; a client\'s or a real lead\'s number never is', () => {
    assert.equal(isPlaceholderLead('lead-1', { id: 'lead-1', email: null }), true, 'Tina\'s own placeholder');
    assert.equal(isPlaceholderLead('lead-1', { id: 'lead-1' }), true);
    assert.equal(isPlaceholderLead('lead-1', { id: 'lead-1', email: '  ' }), true);
    assert.equal(isPlaceholderLead('lead-1', { id: 'lead-1', email: 'jane@example.com' }), false, 'signed up: a person, served as a lead');
    assert.equal(isPlaceholderLead('lead-1', { id: 'lead-2', email: null }), false, 'a different lead on the number');
    assert.equal(isPlaceholderLead(null, { id: 'lead-1', email: null }), false, 'a lead Tina did not make');
    assert.equal(isPlaceholderLead(undefined, { id: 'lead-1', email: null }), false);
});

// ---- AC 7 and the order: roadside and claims first ------------------------------------------------------------------

const INSURERS: Insurer[] = [{ id: 'prov-santam', name: 'Santam Ltd', assistNumber: '0860 505 911' }];

/** The real roadside and claims host for an unknown number, with Claude, Dataverse and Meta faked (as roadsideHost.test.ts). */
function claimsWorld(o: { roadside: boolean; isClaim?: boolean } = { roadside: true }) {
    const sent: Outbound[] = [];
    const store = new Map<string, StoredWalkthrough>();
    const ports = (): RoadsidePorts => ({
        contactByWhatsApp: async () => null,
        activePolicies: async () => [],
        policyOwner: async () => null,
        insuranceTeam: async () => ({ id: 'team-ia', name: 'the Insurance and Advice team' }),
        createClaim: async () => { throw new Error('an unknown number never opens a claim'); },
        createAgentAction: async () => ({ id: 'aa-roadside' }),
        send: async (_to, m) => void sent.push(m),
        insurers: async () => INSURERS,
    });
    const deps: ClaimsHostDeps = {
        enabled: true,
        signUpLink: LINK,
        load: async (p) => store.get(p) ?? null,
        save: async (p, w) => void store.set(p, { ...w, updatedAt: T0.toISOString() }),
        remove: async (p) => void store.delete(p),
        intentModel: async () => ({ reportingClaim: o.isClaim ?? false }),
        understandModel: async () => { throw new Error('not reached'); },
        openRequest: async () => 'req-claim',
        logIncoming: async () => {},
        ports,
        roadsideEnabled: o.roadside,
        roadsideModel: async (req) => /broke|breakdown|tow|stuck/i.test(req.user) ? { roadside: true, fromDamage: false, someoneHurt: false } : { roadside: false, fromDamage: false, someoneHurt: false },
        openRoadsideRequest: async () => 'req-roadside',
    };
    return { deps, sent, store };
}

/** The processor's order for a number on no contact: what routeUnknownNumber is given. */
function route(text: string, claims: ReturnType<typeof claimsWorld>, tax: ReturnType<typeof world>, referral = false, now = T0) {
    return routeUnknownNumber({
        claims: async () => (await claimFromUnknownNumber(claims.deps, STRANGER, text, now)).handled,
        referral: async () => referral,
        tax: () => answerUnknownNumber(tax.ports, STRANGER, LINK, now),
    });
}

test('AC 7: an unknown number that has broken down gets its insurer\'s assist number, no sign-up reply and no tax lead', async () => {
    const claims = claimsWorld();
    const tax = world();
    assert.equal(await route('My car broke down on the N1, please help', claims, tax), 'claims');
    assert.match(claims.sent[0].text, /Which insurer is your car insured with\?/);
    assert.equal(tax.sent.length, 0, 'no sign-up reply');
    assert.equal(tax.leads.length, 0, 'no tax lead');
    assert.equal(tax.actions.length, 0);

    // The answer to "which insurer?" stays in the roadside conversation: it is not a tax enquiry either.
    assert.equal(await route('Santam', claims, tax), 'claims');
    assert.match(claims.sent[1].text, /0860 505 911/);
    assert.equal(tax.sent.length, 0);
    assert.equal(tax.leads.length, 0);
});

test('an unknown number reporting a claim gets the claims flow\'s unknown-number reply, no tax lead', async () => {
    const claims = claimsWorld({ roadside: false, isClaim: true });
    const tax = world();
    assert.equal(await route('Someone stole my phone, I need to claim', claims, tax), 'claims');
    assert.equal(tax.sent.length, 0);
    assert.equal(tax.leads.length, 0);
});

test('a quoted referral code keeps the referral reply, and makes no tax lead', async () => {
    const claims = claimsWorld({ roadside: true });
    const tax = world();
    assert.equal(await route('Hi, my friend gave me code TTT-ABC123', claims, tax, true), 'referral');
    assert.equal(tax.sent.length, 0);
    assert.equal(tax.leads.length, 0);
});

test('AC 1, 5: with roadside on, a tax question that is not a breakdown or a claim still gets the one reply and the one lead', async () => {
    const claims = claimsWorld({ roadside: true });
    const tax = world();
    const out = await route(JANE_MESSAGE, claims, tax);
    assert.deepEqual(out, { replied: true, leadCreated: true, leadId: 'lead-1' });
    assert.equal(claims.sent.length, 0, 'the claims flow said nothing');
    assert.equal(tax.sent.length, 1);
    assert.equal(tax.leads.length, 1);
    // And "Hi" is a first contact like any other.
    const hello = world();
    assert.deepEqual(await route('Hi', claimsWorld({ roadside: false }), hello), { replied: true, leadCreated: true, leadId: 'lead-1' });
});
