/**
 * TTTFG-4830 claims demo: a demo number's whole claim on WhatsApp (src/domain/claimsDemoHost.ts). The claims package
 * runs for real; Claude, the CRM, WhatsApp and Supabase are faked. The package's own rules are tested in
 * ttt-preseason-agent (claims-open, claims-followon, claims-resume, claims-reply).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    batchQuietMs, BUSY, claimsDemoBatchCheck, claimsDemoReminder, claimsDemoTurn, demoContactFor, demoPhones, describedAsTheft, FILE_KEPT, helloText, parseDemoNumbers,
    VOICE_PROBLEM, voiceHint, type ClaimsDemoDeps, type DemoConversation, type VoiceHeard,
} from '../../src/domain/claimsDemoHost';
import { SPOKEN_HELP } from '../../src/departments/insurance/walkthrough';

import type { AgentActionRow, ClaimRow } from '../../src/departments/insurance/claim';
import type { ClaimAnswers, QuestionItem } from '../../src/departments/insurance/contracts';
import type { ClientFile, FollowOnClaim, StoredClaimForm } from '../../src/departments/insurance/followon';
import { isOpenClaim, type OpenClaim, type ResumePorts } from '../../src/departments/insurance/resume';
import type { Policy, WalkthroughState } from '../../src/departments/insurance/walkthrough';

const PHONE = '27821234567';
const CONTACT = '11111111-2222-3333-4444-555555555555';
const DAY1 = new Date('2026-10-23T08:00:00Z');
const SIPHO = { kind: 'user' as const, id: 'u-sipho', name: 'Sipho' };
const tick = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

const q = (key: string, prompt: string, o: Partial<QuestionItem> = {}): QuestionItem => ({ key, kind: 'question', prompt, answerType: 'text', required: true, ...o });
const MOTOR: StoredClaimForm = {
    id: 'cf-motor', provider: 'prov-discovery', claimType: 'Motor accident', formPdf: 'Forms/motor.pdf', notificationPeriodDays: 30, sapsCaseRequired: false,
    active: true, questionGroups: [], fieldMap: [],
    questionList: [q('driverName', 'Who was driving the vehicle?'), q('damagePhoto', 'Photos of the damage.', { kind: 'evidence', answerType: 'photo', name: 'the photos of the damage' })],
};
const GENERIC: StoredClaimForm = { ...MOTOR, id: 'cf-generic', provider: null, claimType: 'Other', formPdf: null, questionList: [q('whatHappened', 'What happened?')] };
const POLICY: Policy = { id: 'pol-car', providerId: 'prov-discovery', insurer: 'Discovery Insure', product: 'Motor', policyNumber: 'DI-9', assistNumber: '0860 333 444' };

type Row = FollowOnClaim & { contactId: string; lastClientMessageOn?: string };

/** The understand model answers by the walkthrough step it is asked about (the step help in its prompt). */
const STEP_ANSWERS: [RegExp, Record<string, unknown>][] = [
    [/which policy the claim is about/, { kind: 'yes' }],
    [/hurt or in danger right now/, { kind: 'no' }],
    [/what kind of claim it is/, { kind: 'facts', claimType: 'Motor accident', description: 'Someone drove into the back of my car at the Claremont robot' }],
    [/what happened, when and where/, { kind: 'facts', incidentDate: '2026-10-22', incidentTime: '17:30', place: 'Claremont' }],
    [/anyone else was involved/, { kind: 'facts', thirdParties: false, saps: false, injuries: false }],
    [/read back a summary/, { kind: 'confirm' }],
];
const blankAnswer = { kind: 'unclear', policyNumber: null, claimType: null, description: null, incidentDate: null, incidentTime: null, place: null,
    thirdParties: null, thirdPartyDetails: null, saps: null, injuries: null, injuryDetails: null, wrongFields: [] as string[] };
const blankReply = { kind: 'unparsed', valueText: null, valueNumber: null, valueBool: null, sapsCaseNumber: null, sapsStation: null, differentIncident: false,
    chosenClaim: null, yesNo: null, forItem: null, claimType: null, description: null, incidentDate: null, place: null, otherAnswers: [], corrections: [] };

function world(o: { isClaim?: boolean; rows?: Row[]; reported?: Record<string, unknown>[]; form?: StoredClaimForm } = {}) {
    const form = o.form ?? MOTOR;
    const reportedSeen: string[] = [];
    const rows: Row[] = o.rows ?? [];
    const sent: string[] = [];
    const created: ClaimRow[] = [];
    const actions: AgentActionRow[] = [];
    const filed: { file: ClientFile; claimId: string; itemKey?: string }[] = [];
    const signatureCalls: string[] = [];
    const requests: string[] = [];
    const withdrawn: string[] = [];
    const store = new Map<string, DemoConversation>();
    const replies: Record<string, unknown>[] = [];
    const row = (id: string) => rows.find((r) => r.id === id)!;
    const ports = (sentTo: (t: string) => void): ResumePorts => ({
        contactByWhatsApp: async () => ({ id: CONTACT, firstName: 'Adriaan' }),
        activePolicies: async () => [POLICY],
        policyOwner: async () => ({ kind: 'user', id: SIPHO.id, firstName: 'Sipho', enabled: true }),
        insuranceTeam: async () => ({ id: 't-ia', name: 'the Insurance and Advice team' }),
        createClaim: async (r) => {
            created.push(r);
            const id = `claim-${rows.length + 1}`;
            const reference = `CLM-00000${rows.length + 1}`;
            rows.push({
                id, reference, contactId: r.contactId, providerId: r.providerId, insurer: 'Discovery Insure', claimType: r.claimType,
                facts: { claimType: r.claimType, description: r.description, incidentAt: r.incidentAt, place: r.place, thirdParties: r.thirdParties, saps: r.saps, injuries: r.injuries },
                status: r.status, signatureStatus: 'Not sent', answers: {}, evidence: [], owner: r.owner, lastClientMessageOn: r.lastClientMessageOn,
            });
            return { id, reference };
        },
        openClaimsForClient: async (contactId): Promise<OpenClaim[]> => rows.filter((r) => r.contactId === contactId && isOpenClaim(r.status))
            .map((r) => ({ id: r.id, reference: r.reference, claimType: r.claimType, incidentAt: r.facts.incidentAt, status: r.status, lastClientMessageOn: r.lastClientMessageOn })),
        loadClaim: async (id) => structuredClone(row(id)),
        activeClaimForm: async (provider, type) => (provider === form.provider && type === form.claimType ? form : null),
        genericClaimForm: async () => GENERIC,
        claimForm: async (id) => (id === form.id ? form : GENERIC),
        setClaimForm: async (id, formId) => void (row(id).claimFormId = formId),
        saveSaps: async () => {},
        setSapsRequired: async (id) => void (row(id).sapsRequired = true),
        saveAnswers: async (id, a: ClaimAnswers) => void (row(id).answers = structuredClone(a)),
        setStatus: async (id, s) => void (row(id).status = s),
        setEvidenceComplete: async () => {},
        setLastClientMessageOn: async (id, at) => void (row(id).lastClientMessageOn = at),
        fileToPipeline: async (file, to) => {
            filed.push({ file, ...to });
            if (to.itemKey) row(to.claimId).evidence = [...row(to.claimId).evidence, { key: to.itemKey }];
            return { documentId: `doc-${filed.length}` };
        },
        storeVideo: async () => ({ documentId: 'v' }),
        requestClaimSignature: async (id) => (signatureCalls.push(id), 'notAvailable'),
        createAgentAction: async (r) => (actions.push(r), { id: `aa-${actions.length}`, dueOn: '2026-10-24T15:00:00Z' }),
        send: async (_to, m) => { sent.push(m.text); sentTo(m.text); },
    });
    const deps: ClaimsDemoDeps = {
        load: async (p) => store.get(p) ?? null,
        save: async (p, c) => void store.set(p, { ...structuredClone(c), updatedAt: DAY1.toISOString() }),
        remove: async (p) => void store.delete(p),
        ports: (_r, s) => ports(s),
        intentModel: async () => ({ reportingClaim: o.isClaim ?? true }),
        understandModel: async (req) => ({ ...blankAnswer, ...(STEP_ANSWERS.find(([re]) => re.test(req.system))?.[1] ?? {}) }),
        replyModel: async () => ({ ...blankReply, ...(replies.shift() ?? {}) }),
        reportedModel: async (req) => (reportedSeen.push(req.user), { answers: o.reported ?? [] }),
        openRequest: async (_c, _p, text) => (requests.push(text), 'req-1'),
        withdrawOpenClaims: async () => { const refs = rows.filter((r) => isOpenClaim(r.status)).map((r) => (r.status = 'Withdrawn', r.reference)); withdrawn.push(...refs); return refs; },
        say: async (_p, text) => void sent.push(text),
        signUpLink: 'https://ttt.example/signup',
    };
    let seen = 0;
    const since = () => { const t = sent.slice(seen); seen = sent.length; return t; };
    return { deps, rows, sent, since, created, actions, filed, signatureCalls, requests, withdrawn, store, replies, reportedSeen };
}

const say = (w: ReturnType<typeof world>, text: string, now: Date, file?: ClientFile) =>
    claimsDemoTurn(w.deps, { phone: PHONE, contactId: CONTACT, text, file, wamid: `wamid.${now.getTime()}` }, now);
const photo: ClientFile = { id: 'media-1', fileName: 'image-1.jpeg', mimeType: 'image/jpeg', media: 'photo' };

test('demo numbers: any SA format matches; anything else, or a bad entry, does not', () => {
    const n = parseDemoNumbers(`27723203629:${CONTACT}, +27 83 285 2913:${CONTACT.replace('1', '9')}, 0821234567:not-a-guid, 123:${CONTACT}`);
    assert.equal(n.size, 2);
    assert.equal(demoContactFor(n, '27723203629'), CONTACT);
    assert.equal(demoContactFor(n, '+27723203629'), CONTACT);
    assert.equal(demoContactFor(n, '0832852913'), CONTACT.replace('1', '9'));
    assert.equal(demoContactFor(n, '27821234567'), null);
    assert.equal(demoContactFor(parseDemoNumbers(undefined), '27723203629'), null);
});

test('a hello with no open claim gets the demo hello, and opens nothing', async () => {
    const w = world({ isClaim: false });
    assert.equal(await say(w, 'Hi Tina', DAY1), 'hello');
    assert.deepEqual(w.since(), [helloText('Adriaan')]);
    assert.equal(w.requests.length, 0);
    assert.equal(w.created.length, 0);
});

test('the whole claim: walkthrough, the form after the last question, then the photo; nothing asked twice', async () => {
    const w = world();
    let t = DAY1;
    assert.equal(await say(w, 'Someone drove into the back of my car at the Claremont robot', t), 'started');
    assert.deepEqual(w.requests, ['Someone drove into the back of my car at the Claremont robot']);
    assert.match(w.since().join('\n'), /Discovery Insure/); // the policy question

    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'opened'; i++) outcome = await say(w, 'reply', (t = tick(t, 1)));
    assert.equal(outcome, 'opened');
    assert.equal(w.rows.length, 1);
    const opened = w.since().join('\n');
    assert.match(opened, /CLM-000001/); // the acknowledgement
    assert.match(opened, /Who was driving the vehicle\?/); // the follow-on's first question, straight after
    assert.equal(w.store.get(PHONE)?.walk, null);
    assert.equal(w.store.get(PHONE)?.resume.followOn?.asking, 'driverName');

    w.replies.push({ kind: 'value', valueText: 'Me, Adriaan' });
    assert.equal(await say(w, 'Me, Adriaan', (t = tick(t, 2))), 'follow-on');
    assert.deepEqual(w.signatureCalls, ['claim-1']); // the form, after the last question and before any evidence
    assert.equal(w.rows[0].answers.driverName?.value, 'Me, Adriaan');
    assert.match(w.since().join('\n'), /Please send me photos of the damage/i);

    w.replies.push({});
    assert.equal(await say(w, '', (t = tick(t, 2)), photo), 'follow-on');
    assert.deepEqual(w.filed.map((f) => [f.file.id, f.claimId, f.itemKey]), [['media-1', 'claim-1', 'damagePhoto']]);
    assert.equal(w.store.get(PHONE)?.resume.followOn, null); // nothing more to ask
    assert.equal(w.signatureCalls.length, 1);
});

test('a photo sent during the walkthrough is kept and filed when the claim opens', async () => {
    const w = world();
    let t = DAY1;
    await say(w, 'Someone drove into the back of my car at the Claremont robot', t);
    assert.equal(await say(w, '', (t = tick(t, 1)), photo), 'file-held');
    assert.deepEqual(w.since().at(-1), FILE_KEPT);
    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'opened'; i++) outcome = await say(w, 'reply', (t = tick(t, 1)));
    assert.equal(outcome, 'opened');
    assert.deepEqual(w.filed.map((f) => [f.file.id, f.claimId]), [['media-1', 'claim-1']]);
    assert.deepEqual(w.store.get(PHONE)?.held, []);
});

test('#reset withdraws the open claims and forgets the conversation', async () => {
    const w = world();
    await say(w, 'Someone drove into the back of my car at the Claremont robot', DAY1);
    for (let i = 0; i < 8 && !w.rows.length; i++) await say(w, 'reply', tick(DAY1, i + 1));
    assert.equal(await say(w, ' #RESET ', tick(DAY1, 30)), 'reset');
    assert.deepEqual(w.withdrawn, ['CLM-000001']);
    assert.equal(w.store.has(PHONE), false);
    assert.match(w.sent.at(-1)!, /Demo reset\. I've withdrawn CLM-000001/);
    // A fresh start: no open claim, so a new report starts a new walkthrough.
    assert.equal(await say(w, 'My geyser burst this morning', tick(DAY1, 31)), 'started');
});

test('the SAPS step applies when the client describes a theft', () => {
    const w = (claimType: string, description: string) => ({ facts: { claimType, description } }) as unknown as WalkthroughState;
    assert.equal(describedAsTheft(w('Motor theft', '')), true);
    assert.equal(describedAsTheft(w('Property loss or damage', 'Someone broke into the house and took the TV')), true);
    assert.equal(describedAsTheft(w('Motor accident', 'A taxi drove into me')), false);
});

test('what the client said while reporting the claim answers the form: Tina says so and skips that question', async () => {
    const w = world({ reported: [{ key: 'driverName', valueText: 'Adriaan', valueNumber: null, valueBool: null }] });
    let t = DAY1;
    await say(w, 'I was driving my car when someone drove into the back of it at the Claremont robot', t);
    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'opened'; i++) outcome = await say(w, 'reply', (t = tick(t, 1)));
    assert.equal(outcome, 'opened');
    // Claude read the whole report: the opening message, the replies and the facts confirmed.
    assert.match(w.reportedSeen[0], /I was driving my car when someone drove into the back of it/);
    assert.match(w.reportedSeen[0], /What the client confirmed:/);
    assert.equal(w.rows[0].answers.driverName?.value, 'Adriaan');
    assert.equal(w.rows[0].answers.driverName?.source, 'report');
    const opened = w.since().join('\n');
    assert.match(opened, /I've filled in one of the insurer's questions from what you've already told me/);
    assert.doesNotMatch(opened, /Who was driving the vehicle\?/);
    assert.match(opened, /Please send me photos of the damage/i); // straight on to what's still missing
    assert.deepEqual(w.store.get(PHONE)?.said, []);
});

test('Claude unavailable: Tina asks for the message again, and nothing is read, saved or counted as a miss', async () => {
    const w = world();
    let t = DAY1;
    await say(w, 'Someone drove into the back of my car at the Claremont robot', t);
    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'opened'; i++) outcome = await say(w, 'reply', (t = tick(t, 1)));
    w.since();
    const before = structuredClone(w.store.get(PHONE)!.resume);
    const down = w.deps.replyModel;
    w.deps.replyModel = async () => { throw new Error('529 overloaded'); };
    assert.equal(await say(w, 'Me, Adriaan', (t = tick(t, 1))), 'busy');
    assert.deepEqual(w.since(), [BUSY]);
    assert.deepEqual(w.store.get(PHONE)!.resume, before); // still asking the same question, no miss
    assert.equal(w.rows[0].answers.driverName, undefined);
    w.deps.replyModel = down;
    w.replies.push({ kind: 'value', valueText: 'Me, Adriaan' });
    assert.equal(await say(w, 'Me, Adriaan', (t = tick(t, 1))), 'follow-on');
    assert.equal(w.rows[0].answers.driverName?.value, 'Me, Adriaan');
    assert.doesNotMatch(w.since().join('\n'), /didn't quite get that/);
});

test('Claude unavailable during the walkthrough or on the first message: the same, never "I didn\'t get that"', async () => {
    const w = world();
    const intent = w.deps.intentModel;
    w.deps.intentModel = async () => { throw new Error('429'); };
    assert.equal(await say(w, 'Someone drove into my car', DAY1), 'busy');
    assert.deepEqual(w.since(), [BUSY]);
    assert.equal(w.requests.length, 0);
    w.deps.intentModel = intent;
    assert.equal(await say(w, 'Someone drove into my car', tick(DAY1, 1)), 'started');
    w.since();
    const step = w.store.get(PHONE)!.walk!.step;
    w.deps.understandModel = async () => { throw new Error('timeout'); };
    assert.equal(await say(w, 'Yes', tick(DAY1, 2)), 'busy');
    assert.deepEqual(w.since(), [BUSY]);
    assert.equal(w.store.get(PHONE)!.walk!.step, step);
});

// ---- TTTFG-4830: the form's questions in batches, and the quiet spell before Tina lists what's still open ----

/** A form whose three car questions go together (one section), then a photo. */
const CAR: StoredClaimForm = {
    ...MOTOR, id: 'cf-car',
    questionList: [
        q('carMake', 'What make is the car?', { section: 'your car' }),
        q('carModel', 'What model is it?', { section: 'your car' }),
        q('carRegistration', "What is the car's registration number?", { section: 'your car' }),
        q('damagePhoto', 'Photos of the damage.', { kind: 'evidence', answerType: 'photo', name: 'the photos of the damage' }),
    ],
};
const other = (key: string, valueText: string) => ({ key, valueText, valueNumber: null, valueBool: null });

/** A claim opened on the CAR form; the first batch has just gone out. */
async function openedOnCar(o: { schedule?: (phone: string, token: string) => Promise<void> } = {}) {
    const w = world({ form: CAR });
    const scheduled: [string, string][] = [];
    if (o.schedule !== null) w.deps.scheduleBatchCheck = o.schedule ?? (async (phone, token) => void scheduled.push([phone, token]));
    let t = DAY1;
    await say(w, 'Someone drove into the back of my car at the Claremont robot', t);
    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'opened'; i++) outcome = await say(w, 'reply', (t = tick(t, 1)));
    assert.equal(outcome, 'opened');
    assert.match(w.since().join('\n'), /A few questions about your car\. Answer as best you can, and if you don't know something, just say so\.\n1\. What make is the car\?\n2\. What model is it\?/);
    return { w, scheduled, t };
}

test('TTTFG-4830: part of a batch answered: saved at once, Tina waits, and the check after the quiet spell lists the rest', async () => {
    const { w, scheduled, t } = await openedOnCar();
    w.replies.push({ kind: 'value', otherAnswers: [other('carMake', 'Toyota')] });
    const first = tick(t, 1);
    assert.equal(await say(w, '1. Toyota', first), 'follow-on');
    assert.deepEqual(w.since(), []); // nothing said while the client may still be typing
    assert.equal(w.rows[0].answers.carMake?.value, 'Toyota');
    const token = `wamid.${first.getTime()}`;
    assert.deepEqual(scheduled, [[PHONE, token]]);
    assert.equal(w.store.get(PHONE)?.resume.followOn?.waiting, token);

    assert.equal(await claimsDemoBatchCheck(w.deps, PHONE, 'wamid.older', tick(first, 1)), 'stale');
    assert.deepEqual(w.since(), []);
    assert.equal(await claimsDemoBatchCheck(w.deps, PHONE, token, tick(first, 1)), 'listed');
    const listed = w.since();
    assert.deepEqual(listed, ["Thanks. I still need these:\n1. What model is it?\n2. What is the car's registration number?"]);
    assert.equal(w.store.get(PHONE)?.resume.followOn?.waiting, undefined);
    assert.equal(w.store.get(PHONE)?.lastSent, listed[0]); // the next reply is read against the list as renumbered
});

test('TTTFG-4830: a second small message finishes the batch: Tina moves on at once, and the old check does nothing', async () => {
    const { w, scheduled, t } = await openedOnCar();
    w.replies.push({ kind: 'value', otherAnswers: [other('carMake', 'Toyota')] });
    await say(w, 'Toyota', tick(t, 1));
    w.replies.push({ kind: 'value', otherAnswers: [other('carModel', 'Corolla'), other('carRegistration', 'CA 123-456')] });
    assert.equal(await say(w, 'Corolla, CA 123-456', tick(t, 2)), 'follow-on');
    assert.match(w.since().join('\n'), /Please send me photos of the damage/i);
    assert.equal(scheduled.length, 1);
    assert.equal(await claimsDemoBatchCheck(w.deps, PHONE, scheduled[0][1], tick(t, 3)), 'stale');
    assert.deepEqual(w.since(), []);
});

test('TTTFG-4830: with no scheduler (CLAIMS_BATCH_QUIET_MS=0), or when scheduling fails, Tina lists what is open straight away', async () => {
    for (const schedule of [null, async () => { throw new Error('Service Bus down'); }] as const) {
        const { w } = await openedOnCar({ schedule: schedule as never });
        if (schedule === null) delete w.deps.scheduleBatchCheck;
        w.replies.push({ kind: 'value', otherAnswers: [other('carMake', 'Toyota')] });
        await say(w, 'Toyota', tick(DAY1, 30));
        assert.deepEqual(w.since(), ["Thanks. I still need these:\n1. What model is it?\n2. What is the car's registration number?"]);
        assert.equal(w.store.get(PHONE)?.resume.followOn?.waiting, undefined);
    }
    assert.equal(batchQuietMs(undefined), 45_000);
    assert.equal(batchQuietMs('0'), 0);
    assert.equal(batchQuietMs('20000'), 20_000);
    assert.equal(batchQuietMs('soon'), 45_000);
});

test('TTTFG-4830: the end of the questions lists what the client still has to send, and the 08:00 reminder (TTTFG-5212) sends it again', async () => {
    const w = world();
    let t = DAY1;
    await say(w, 'Someone drove into the back of my car at the Claremont robot', t);
    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'opened'; i++) outcome = await say(w, 'reply', (t = tick(t, 1)));
    w.replies.push({ kind: 'value', valueText: 'Me, Adriaan' });
    await say(w, 'Me, Adriaan', (t = tick(t, 2)));
    w.since();

    // "Not yet" to the photos: the list, and Tina stays on it.
    w.replies.push({ kind: 'not-yet' });
    await say(w, "I'll take them tonight", (t = tick(t, 2)));
    assert.deepEqual(w.since(), ["Thanks, that's all for now. Things we still need from you:\n- Photos of the damage\nPlease send them here when you have them."]);
    assert.equal(w.store.get(PHONE)?.resume.followOn?.phase, 'still-need');

    // 08:00 the next day: the reminder, as a message (the client wrote less than 24 hours ago).
    const morning = new Date('2026-10-24T06:00:00Z');
    const outcomes = await claimsDemoReminder(w.deps, PHONE, CONTACT, morning);
    assert.deepEqual(outcomes, [{ reference: 'CLM-000001', sent: 'text', lines: ['Photos of the damage'] }]);
    const reminder = w.since();
    assert.deepEqual(reminder, ["Good morning Adriaan, it's Tina from TTT. Things we still need from you for your motor accident claim (CLM-000001):\n"
        + '- Photos of the damage\nPlease send them here when you have them.']);
    assert.equal(w.store.get(PHONE)?.lastSent, reminder[0]);
    assert.match(w.actions.at(-1)!.detail, /^Morning reminder sent on WhatsApp for claim CLM-000001: Photos of the damage\.$/);
    // A second run the same morning sends nothing (the agent action says it went out today).
    w.deps.lastReminderOn = async () => morning.toISOString();
    assert.deepEqual(await claimsDemoReminder(w.deps, PHONE, CONTACT, tick(morning, 5)), [{ reference: 'CLM-000001', skipped: 'reminded-today' }]);
    assert.deepEqual(w.since(), []);

    // The photo half an hour later goes on the list: filed as the photos of the damage, and that's everything.
    w.replies.push({});
    assert.equal(await say(w, '', tick(morning, 30), photo), 'follow-on');
    assert.deepEqual(w.filed.map((f) => f.itemKey), ['damagePhoto']);
    assert.match(w.since().join('\n'), /That's everything the insurer needs for now\./);
    assert.equal(w.store.get(PHONE)?.resume.followOn, null);
});

test('TTTFG-5212: no reminder while the client is reporting a claim; the demo numbers as WhatsApp numbers', async () => {
    const w = world();
    await say(w, 'Someone drove into the back of my car at the Claremont robot', DAY1);
    w.since();
    assert.equal(await claimsDemoReminder(w.deps, PHONE, CONTACT, tick(DAY1, 22 * 60)), 'walkthrough');
    assert.deepEqual(w.since(), []);
    assert.deepEqual(demoPhones(`27723203629:${CONTACT}, +27 83 285 2913:${CONTACT}, bad`), [
        { phone: '27723203629', contactId: CONTACT }, { phone: '27832852913', contactId: CONTACT },
    ]);
});

// ---- TTTFG-4830: voice notes ----

const VOICE = { id: 'media-voice-1', mimeType: 'audio/ogg; codecs=opus' };
const speak = (w: ReturnType<typeof world>, now: Date) =>
    claimsDemoTurn(w.deps, { phone: PHONE, contactId: CONTACT, text: '', voice: VOICE, wamid: `wamid.${now.getTime()}` }, now);
/** The transcription answers `heard`, and keeps the hint it was given. */
function hearing(w: ReturnType<typeof world>, heard: VoiceHeard) {
    const hints: string[] = [];
    w.deps.transcribe = async (voice, hint) => { assert.equal(voice.id, VOICE.id); hints.push(hint); return heard; };
    return hints;
}

test('TTTFG-4830: a voice note answering the batch: transcribed with the questions as the hint, read as a transcript, and said back', async () => {
    const { w, t } = await openedOnCar({ schedule: null as never });
    delete w.deps.scheduleBatchCheck;
    const asked = w.store.get(PHONE)!.lastSent!;
    const hints = hearing(w, { text: 'um ja so one is a Toyota two Corolla and the registration is C A one two three four five six' });
    const systems: string[] = [];
    const reply = w.deps.replyModel;
    w.deps.replyModel = async (req) => (systems.push(req.system), reply(req));
    w.replies.push({ kind: 'value', otherAnswers: [other('carMake', 'Toyota'), other('carModel', 'Corolla'), other('carRegistration', 'CA 123456')] });

    assert.equal(await speak(w, tick(t, 1)), 'follow-on');
    assert.ok(hints[0].endsWith(`Tina asked: ${asked.replace(/\s+/g, ' ')}`), hints[0]);
    assert.match(hints[0], /1\. What make is the car\? 2\. What model is it\?/);
    assert.ok(systems[0].includes(SPOKEN_HELP));
    const said = w.since();
    assert.equal(said[0], 'From your voice note I noted:\n1. Toyota\n2. Corolla\n3. CA 123456\nIf I misheard anything, just tell me.');
    assert.match(said.slice(1).join('\n'), /Please send me photos of the damage/i);
    assert.equal(w.rows[0].answers.carRegistration?.value, 'CA 123456');
});

test('TTTFG-4830: a voice note Tina can\'t use: she says why, and nothing is read or saved', async () => {
    for (const problem of ['unclear', 'too-long', 'unsupported', 'unavailable'] as const) {
        const { w, t } = await openedOnCar();
        const before = structuredClone(w.store.get(PHONE));
        hearing(w, { problem });
        let read = 0;
        w.deps.replyModel = async () => (read++, blankReply);
        assert.equal(await speak(w, tick(t, 1)), 'voice-unheard');
        assert.deepEqual(w.since(), [VOICE_PROBLEM[problem]]);
        assert.equal(read, 0);
        assert.deepEqual(w.store.get(PHONE), before); // Tina's questions stay what the next reply is read against
        assert.deepEqual(w.rows[0].answers, {});
    }
    // Voice notes off (no transcription): "can't listen right now".
    const { w, t } = await openedOnCar();
    delete w.deps.transcribe;
    assert.equal(await speak(w, tick(t, 1)), 'voice-unheard');
    assert.deepEqual(w.since(), [VOICE_PROBLEM.unavailable]);
});

test('TTTFG-4830: a voice note while reporting the claim is read as a transcript too; a voice note is never "#reset"', async () => {
    const w = world();
    await say(w, 'Someone drove into the back of my car at the Claremont robot', DAY1);
    w.since();
    const systems: string[] = [];
    const understand = w.deps.understandModel;
    w.deps.understandModel = async (req) => (systems.push(req.system), understand(req));
    hearing(w, { text: 'yes the discovery one' });
    assert.equal(await speak(w, tick(DAY1, 1)), 'walkthrough');
    assert.ok(systems[0].includes(SPOKEN_HELP));
    assert.deepEqual(w.store.get(PHONE)?.said, ['Someone drove into the back of my car at the Claremont robot', 'yes the discovery one']);

    hearing(w, { text: '#reset' });
    assert.notEqual(await speak(w, tick(DAY1, 2)), 'reset');
    assert.equal(w.withdrawn.length, 0);
});

test('TTTFG-4830: the transcription hint says who is speaking and ends with what Tina asked, kept short', () => {
    assert.match(voiceHint(null), /^A South African client answers Tina/);
    assert.ok(!voiceHint(null).includes('Tina asked'));
    const long = voiceHint(`A few questions about your car.\n1. ${'What make is the car? '.repeat(100)}`);
    assert.match(long, /Tina asked: A few questions about your car\. 1\. What make/);
    assert.ok(long.length < 1200);
});

