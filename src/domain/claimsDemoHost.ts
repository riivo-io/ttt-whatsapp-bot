/**
 * TTTFG-4830 (claims demo): the whole claims conversation on WhatsApp, for the numbers in CLAIMS_DEMO_NUMBERS only.
 *
 * Every message from a demo number comes here and nowhere else in Tina (no tax flows, no menus). Its claims run
 * against the CRM the demo is pointed at (TTT DEV), never Tina's own CRM. The claims package decides everything that
 * is said and written; this module only joins its parts the way the DEV drivers do:
 *  - a 5168 walkthrough in progress: Claude reads the reply (understand.ts), claimTurn() asks the next question;
 *  - the walkthrough opens the claim: the 5176 follow-on starts at once (SAPS step, duty of disclosure, the form's
 *    questions, the evidence, then the filled form to sign, even with items still to come). What the client said while
 *    reporting it already answers some of the form's questions (reportedAnswers): those are filled in, not asked;
 *  - otherwise: Claude reads the message against the open claims (reply.ts) and resumeTurn() (5184) decides which claim
 *    it belongs to, or that there is none. When it answers part of a batch of the form's questions, Tina waits for the
 *    rest and the queue brings back a check after a quiet spell (claimsDemoBatchCheck);
 *  - no open claim: a claim report starts the walkthrough under a new riivo_request, with what the report already
 *    says read first (openingFacts); anything else gets the demo hello.
 * "#reset" withdraws the demo client's open claims and forgets the conversation, so a demo can start clean.
 * A voice note (TTTFG-4830) is transcribed first (deps.transcribe, with Tina's last message as the hint) and read as
 * what the client said, with Claude told it is a transcript; the package says back what it saved from it. One that
 * can't be heard is answered here, and nothing is read or saved.
 * Every morning at 08:00 (TTTFG-5212, first cut) claimsDemoReminder() sends each demo number what it still has to send
 * on its open claims ("Things we still need from you"), and puts the conversation back on that list.
 *
 * Pure apart from the injected deps (Tina's Ports pattern), so it is tested without Meta, Dataverse, Supabase or Claude.
 * src/services/claimsDemo.service.ts wires the real ones.
 */
import { claimTurn } from '../departments/insurance/claim';
import { followOnTurn, type ClientFile, type ResumeFile } from '../departments/insurance/followon';
import { claimRoute, type IntentModel } from '../departments/insurance/intent';
import { openQuestions, readReply, replyContext, reportedAnswers, type ReplyModel, type ReportedModel } from '../departments/insurance/reply';
import { remindTurn, type BrokerStep, type ReminderOutcome, type ReminderPorts, type ReminderSettings } from '../departments/insurance/reminder';
import { NO_RESUME_STATE, resumeTurn, type ResumePorts, type ResumeState } from '../departments/insurance/resume';
import { openingFacts, understand, type UnderstandModel } from '../departments/insurance/understand';
import type { WalkthroughState } from '../departments/insurance/walkthrough';
import { ABANDONED_AFTER_MS, claimsConversation } from './claimsHost';

export const RESET_COMMAND = '#reset';

/** The demo numbers: `27821234567:<contact id>` pairs, comma separated. Keyed by the number's last 9 digits. */
export function parseDemoNumbers(raw: string | undefined): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const [phone, contactId] = part.split(':').map((s) => s.trim());
        const local = phone?.replace(/\D/g, '').slice(-9);
        if (local?.length === 9 && /^[0-9a-f-]{36}$/i.test(contactId ?? '')) out.set(local, contactId.toLowerCase());
    }
    return out;
}

/**
 * TTTFG-4830: CLAIMS_BATCH_QUIET_MS, how long Tina waits after a reply that answers part of a batch before she lists
 * what's still open. Default 45 seconds; 0 lists it at once. Read on every message, so a changed setting needs no deploy.
 */
export function batchQuietMs(raw: string | undefined, fallback = 45_000): number {
    const ms = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
    return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

/**
 * TTTFG-4830: CLAIMS_FILES_QUIET_MS, how long Tina waits after a photo or document for an evidence item before she
 * answers about all of them (the front and back, several photos of the scene). Default 15 seconds: photos picked
 * together arrive within seconds of each other.
 */
export const filesQuietMs = (raw: string | undefined): number => batchQuietMs(raw, 15_000);

/**
 * TTTFG-5196: CLAIMS_OPTIONAL_QUIET_MS, how long Tina waits on an optional item, with nothing required missing, before
 * she ends the claim without it and sends the signing link. Default 10 minutes: long enough to find a document.
 */
export const optionalQuietMs = (raw: string | undefined): number => batchQuietMs(raw, 600_000);

/** TTTFG-5196: which quiet spell the follow-on is waiting on (FollowOnState.waitingFor). */
export const quietSpell = (waitingFor: 'files' | 'optional' | undefined): 'answers' | 'files' | 'optional' => waitingFor ?? 'answers';

/**
 * TTTFG-5212: the demo numbers as WhatsApp numbers (27 and nine digits, as Meta sends them and the conversation is kept
 * under), for the morning reminder, which starts from the list rather than from a message.
 */
export function demoPhones(raw: string | undefined): { phone: string; contactId: string }[] {
    return [...parseDemoNumbers(raw)].map(([local, contactId]) => ({ phone: `27${local}`, contactId }));
}

/**
 * TTTFG-5212: CLAIMS_BROKER_ALERT_DAYS and CLAIMS_STOP_AFTER_DAYS, how many quiet days before the claim owner's alert,
 * and before the reminders stop and the owner gets a Follow-up to phone the client. Unset or not above 0: the package's
 * 5 and 10. Read at every run, so TTTFG-5289 can move the stop day without a deploy.
 */
export function reminderDays(alert: string | undefined, stop: string | undefined): Pick<ReminderSettings, 'brokerAlertDays' | 'stopAfterDays'> {
    const days = (raw: string | undefined) => (raw?.trim() && Number(raw) > 0 ? Number(raw) : undefined);
    const brokerAlertDays = days(alert);
    const stopAfterDays = days(stop);
    return { ...(brokerAlertDays ? { brokerAlertDays } : {}), ...(stopAfterDays ? { stopAfterDays } : {}) };
}

/** The demo contact for a WhatsApp sender, or null when the number isn't a demo number. */
export function demoContactFor(numbers: Map<string, string>, from: string): string | null {
    const local = from.replace(/\D/g, '').slice(-9);
    return local.length === 9 ? numbers.get(local) ?? null : null;
}

/** What Tina keeps between messages. Where the conversation is, never what the claim holds. */
export interface DemoConversation {
    contactId: string;
    /** The riivo_request the latest claim conversation runs under ('' before the first claim). */
    requestId: string;
    walk: WalkthroughState | null;
    resume: ResumeState;
    /** Files sent before the claim existed, for the follow-on's start. */
    held: ResumeFile[];
    /** What the client wrote during the walkthrough in progress: read for the form's questions when the claim opens. */
    said?: string[];
    lastSent: string | null;
    updatedAt?: string;
}

export interface DemoMessage {
    phone: string;
    contactId: string;
    /** The text, or a photo's or document's caption ('' when there is none, and for a voice note). */
    text: string;
    file?: ClientFile;
    /** TTTFG-4830: a WhatsApp voice note (or audio file): Meta's media id and its type. */
    voice?: DemoVoice;
    wamid: string;
}

export interface DemoVoice { id: string; mimeType: string }

/**
 * TTTFG-4830: what the transcription made of a voice note. `unclear`: nothing came out (silence, noise); `too-long`:
 * over CLAIMS_VOICE_MAX_SECONDS; `unsupported`: an audio type speech recognition can't take; `unavailable`: voice
 * notes are off, or the service failed.
 */
export type VoiceHeard = { text: string } | { problem: 'unclear' | 'too-long' | 'unsupported' | 'unavailable' };

export interface ClaimsDemoDeps {
    load(phone: string): Promise<DemoConversation | null>;
    save(phone: string, c: DemoConversation): Promise<void>;
    remove(phone: string): Promise<void>;
    /** The claims package's ports against the demo CRM. Every text Tina sends through them is passed to `sent`. */
    ports(requestId: string, sent: (text: string) => void): ResumePorts;
    intentModel: IntentModel;
    understandModel: UnderstandModel;
    replyModel: ReplyModel;
    reportedModel: ReportedModel;
    /** Opens the riivo_request (Insurance, topic Claim) a new claim conversation runs under. Null when refused. */
    openRequest(contactId: string, phone: string, text: string): Promise<string | null>;
    /** "#reset": sets the client's open claims to Withdrawn. Returns their references. */
    withdrawOpenClaims(contactId: string): Promise<string[]>;
    /** Tina's own fixed texts (the hello, the reset, a file kept for later), outside the package. */
    say(phone: string, text: string): Promise<void>;
    signUpLink: string;
    /** TTTFG-4830: CLAIMS_CONTACT_NUMBER (claimsHost.ts claimsContactNumber). Absent: the client isn't given a TTT number. */
    contactNumber?: string;
    /**
     * TTTFG-4830: calls claimsDemoBatchCheck(phone, token) after a quiet spell, on the phone's own queue, so it comes
     * after anything the client sends meanwhile. With it, Tina waits for the rest of a part-answered batch of questions,
     * and for the rest of the photos for an evidence item (`what` 'files': a shorter spell); without it, she answers
     * straight away. TTTFG-5196: `what` 'optional' (a longer spell): on an optional item with nothing required missing,
     * the check ends the claim and the signing link goes out.
     */
    scheduleBatchCheck?(phone: string, token: string, what: 'answers' | 'files' | 'optional'): Promise<void>;
    /** TTTFG-5212: when the claim's last morning reminder went out (its agent action). Absent: never. */
    lastReminderOn?(claimId: string): Promise<string | null>;
    /** TTTFG-5212: when the claim owner last got this broker step's Follow-up (day 5's alert, the stop day's call). Absent: never. */
    lastBrokerStepOn?(claimId: string, step: BrokerStep): Promise<string | null>;
    /**
     * TTTFG-4830: a voice note as text. `hint`: what the client is answering (voiceHint), so names and numbers are
     * heard as they're likely meant. Absent: voice notes are off, and Tina asks the client to type.
     */
    transcribe?(voice: DemoVoice, hint: string): Promise<VoiceHeard>;
}

export type DemoOutcome =
    | 'reset' | 'hello' | 'file-held' | 'walkthrough' | 'opened' | 'started' | 'follow-on' | 'new-claim' | 'no-request' | 'busy'
    | 'voice-unheard';

export const helloText = (firstName: string) =>
    `Hi ${firstName}, it's Tina from TTT. On this number I'm set up to help with insurance claims. Tell me what happened `
    + `(for example "someone drove into my car yesterday") and I'll open a claim for you.`;
export const resetText = (refs: string[]) =>
    `Demo reset. ${refs.length ? `I've withdrawn ${refs.join(', ')} and` : 'You had no open claims, and'} I've forgotten our chat. `
    + 'Say hi or tell me what happened to start again.';
export const FILE_KEPT = "Thanks, I've kept that for your claim. I'll add it once your claim is open.";
/**
 * Claude couldn't be reached (after the SDK's retries). The package reads that as "unclear", which would tell the
 * client they weren't understood and count a miss against a perfectly good answer. Instead nothing is read or saved,
 * and the client is asked to send it again.
 */
export const BUSY = "Sorry, I'm a bit slow right now and couldn't read that. Please send it again in a minute.";

/** TTTFG-4830: a voice note Tina couldn't use, by what went wrong (VoiceHeard). */
export const VOICE_PROBLEM: Record<Exclude<VoiceHeard, { text: string }>['problem'], string> = {
    unclear: "Sorry, I couldn't make out that voice note. Could you send it again, or type your answer?",
    'too-long': 'That voice note is a bit long for me. Could you send it in shorter parts, or type your answer?',
    unsupported: "Sorry, I can't play that kind of audio file. Could you record a WhatsApp voice note instead, or type your answer?",
    unavailable: "Sorry, I can't listen to voice notes right now. Please type your answer, or send the voice note again in a few minutes.",
};

/**
 * TTTFG-4830: the transcription's hint: who is speaking and what they're answering (Tina's last message, the numbered
 * questions of a batch), so the insurer's words, makes and names come out spelt as they're meant. The questions go
 * last and the hint is kept short: a speech model may keep only the end of a long prompt (Whisper: 224 tokens).
 */
export function voiceHint(lastSent: string | null): string {
    const asked = (lastSent ?? '').replace(/\s+/g, ' ').trim().slice(0, 900);
    return 'A South African client answers Tina, TTT Financial Group\'s assistant, about a short-term insurance claim '
        + '(insurers Discovery Insure, Hybrid, Momentum, Old Mutual; SAPS case number; registration number).'
        + (asked ? ` Tina asked: ${asked}` : '');
}

const THEFT = /\b(stol(e|en)|theft|thie(f|ves)|burglar|broke into|break[- ]in|robbed|robbery|hijack)/i;
/** The follow-on's `describedAsTheft`: the claim type says so, or the client's description does. */
export const describedAsTheft = (w: WalkthroughState) =>
    w.facts.claimType === 'Motor theft' || w.facts.claimType === 'Hijacking' || THEFT.test(w.facts.description ?? '');

export async function claimsDemoTurn(deps: ClaimsDemoDeps, m: DemoMessage, now: Date): Promise<DemoOutcome> {
    if (!m.file && !m.voice && m.text.trim().toLowerCase() === RESET_COMMAND) {
        const refs = await deps.withdrawOpenClaims(m.contactId);
        await deps.remove(m.phone);
        await deps.say(m.phone, resetText(refs));
        return 'reset';
    }

    const stored = await deps.load(m.phone);
    const c: DemoConversation = stored && stored.contactId === m.contactId
        ? stored
        : { contactId: m.contactId, requestId: '', walk: null, resume: NO_RESUME_STATE, held: [], lastSent: null };
    // A walkthrough untouched for three days is abandoned, as on Tina's claims path (claimsHost.ts).
    if (c.walk && c.updatedAt && now.getTime() - Date.parse(c.updatedAt) > ABANDONED_AFTER_MS) c.walk = null;

    // A model call that fails is noted, so the turn stops instead of treating the message as unclear.
    let unavailable = false;
    const watch = <F extends (req: never) => Promise<unknown>>(f: F): F =>
        (async (req: never) => { try { return await f(req); } catch (e) { unavailable = true; throw e; } }) as F;
    const busy = async () => {
        await deps.say(m.phone, BUSY);
        return done('busy');
    };

    let last: string | undefined;
    const sent = (text: string) => { last = text; };
    const done = async (outcome: DemoOutcome) => {
        if (last !== undefined) c.lastSent = last;
        await deps.save(m.phone, c);
        return outcome;
    };
    const conv = () => claimsConversation(m.phone, c.requestId, deps.signUpLink, deps.contactNumber);

    // ---- TTTFG-4830: a voice note is read as what the client said ----
    const spoken = !!m.voice;
    if (m.voice) {
        const heard = deps.transcribe ? await deps.transcribe(m.voice, voiceHint(c.lastSent)) : { problem: 'unavailable' as const };
        if ('problem' in heard) {
            // Nothing is read or saved, and Tina's last message stays what the next reply is read against.
            await deps.say(m.phone, VOICE_PROBLEM[heard.problem]);
            return 'voice-unheard';
        }
        m = { ...m, text: heard.text };
    }

    // ---- a 5168 walkthrough in progress ----
    if (c.walk) {
        if (m.file && !m.text.trim()) {
            c.held = [...c.held, { file: m.file }];
            await deps.say(m.phone, FILE_KEPT);
            return done('file-held');
        }
        const ports = deps.ports(c.requestId, sent);
        const walk = c.walk;
        const answer = await understand(watch(deps.understandModel), walk, c.lastSent ?? '', m.text, now, { spoken });
        if (unavailable) return busy();
        const r = await claimTurn(ports, conv(), walk, answer, now);
        if (m.file) c.held = [...c.held, { file: m.file }];
        if (m.text.trim()) c.said = [...(c.said ?? []), m.text.trim()];
        if (!r.claim) {
            c.walk = r.state;
            // TTTFG-4830 (QC): the client stopped, or a person takes it from here: nothing carries over to a next claim.
            if (!r.state) {
                c.held = [];
                c.said = [];
            }
            return done('walkthrough');
        }
        // The claim is open: the follow-on starts at once, with any files the client sent on the way and the form
        // answers their report already gave.
        c.walk = null;
        const reported = await formAnswersFromReport(deps, ports, r.claim.id, walk, c.said ?? [], now);
        const fo = await followOnTurn(ports, conv(), null, {
            kind: 'start', claimId: r.claim.id, describedAsTheft: describedAsTheft(walk), files: c.held, reported,
        }, now);
        c.resume = { followOn: fo.state, pending: null };
        c.held = [];
        c.said = [];
        return done('opened');
    }

    // ---- no walkthrough: which open claim is this about? ----
    const ports = deps.ports(c.requestId, sent);
    const ctx = await replyContext(ports, m.contactId, c.resume, c.lastSent ?? undefined);
    const reading = await readReply(watch(deps.replyModel), ctx, m.text, m.file, m.wamid, now, { spoken });
    if (unavailable) return busy();
    const r = await resumeTurn(ports, conv(), c.resume, reading, now, deps.scheduleBatchCheck ? { waitForMore: true } : {});
    if (r.route === 'claim') {
        c.resume = r.state;
        // TTTFG-4830: part of a batch answered: Tina waits for the rest, and lists what's open after a quiet spell. If
        // the check can't be scheduled, she lists it now rather than wait for nothing.
        const token = r.state.followOn?.waiting;
        if (token && deps.scheduleBatchCheck) {
            try {
                await deps.scheduleBatchCheck(m.phone, token, quietSpell(r.state.followOn?.waitingFor));
            } catch (e) {
                console.warn('[ClaimsDemo] Scheduling the batch check failed; listing what is open now:', (e as Error).message);
                const listed = await followOnTurn(ports, conv(), r.state.followOn, { kind: 'nudge', wamid: token }, now, { waitForMore: true });
                c.resume = { followOn: listed.state, pending: null };
            }
        }
        return done('follow-on');
    }
    if (r.route === 'new-claim') {
        c.resume = NO_RESUME_STATE;
        c.walk = r.walkthrough;
        c.held = r.held;
        return done('new-claim');
    }

    // ---- no open claim ----
    c.resume = NO_RESUME_STATE;
    if (m.file) c.held = [...c.held, { file: m.file }];
    const route = m.text.trim() ? await claimRoute(watch(deps.intentModel), m.text, { wordFilter: false }) : null;
    if (unavailable) return busy();
    if (!route) {
        if (m.file) await deps.say(m.phone, FILE_KEPT);
        else {
            const contact = await ports.contactByWhatsApp(m.phone);
            await deps.say(m.phone, helloText(contact?.firstName ?? 'there'));
        }
        return done(m.file ? 'file-held' : 'hello');
    }
    const requestId = await deps.openRequest(m.contactId, m.phone, m.text);
    if (!requestId) {
        await deps.say(m.phone, "Sorry, I couldn't open your claim just now. Please try again in a few minutes.");
        return done('no-request');
    }
    c.requestId = requestId;
    c.said = [m.text.trim()];
    // TTTFG-4830 (28 Oct 2026): what the report already says goes into the start, so the policy question offers only the
    // policies that fit the claim. As before, a failed read here only means Tina asks for it.
    const opening = await openingFacts(deps.understandModel, m.text, now);
    const t = await claimTurn(deps.ports(requestId, sent), conv(), null, { kind: 'start', ...opening }, now);
    c.walk = t.state;
    return done('started');
}

/**
 * TTTFG-4830: the quiet spell after a part-answered batch of questions is over (scheduleBatchCheck). If Tina is still
 * waiting on that message, she lists what's still open; if the client wrote since, or the conversation moved on,
 * nothing happens and nothing is read from the CRM. TTTFG-5196: when the check leaves Tina waiting again (the photos
 * stopped coming and she asked an optional item), the next check is scheduled; if it can't be, it runs now.
 */
export async function claimsDemoBatchCheck(deps: ClaimsDemoDeps, phone: string, token: string, now: Date): Promise<'listed' | 'stale'> {
    const c = await deps.load(phone);
    const followOn = c?.resume.followOn;
    if (!c || !followOn || followOn.waiting !== token) return 'stale';
    let last: string | undefined;
    const ports = deps.ports(c.requestId, (text) => { last = text; });
    const conversation = claimsConversation(phone, c.requestId, deps.signUpLink, deps.contactNumber);
    let r = await followOnTurn(ports, conversation, followOn, { kind: 'nudge', wamid: token }, now, { waitForMore: true });
    const again = r.state?.waiting;
    if (again && again !== token) {
        try {
            if (!deps.scheduleBatchCheck) throw new Error('no scheduler');
            await deps.scheduleBatchCheck(phone, again, quietSpell(r.state?.waitingFor));
        } catch (e) {
            console.warn('[ClaimsDemo] Scheduling the next check failed; running it now:', (e as Error).message);
            r = await followOnTurn(ports, conversation, r.state, { kind: 'nudge', wamid: again }, now, { waitForMore: true });
        }
    }
    c.resume = { followOn: r.state, pending: null };
    if (last !== undefined) c.lastSent = last;
    await deps.save(phone, c);
    return 'listed';
}

/**
 * TTTFG-5212: the morning reminder for one demo number, on the number's own queue so it never crosses a message the
 * client is sending. Not while the client is reporting a claim (a 5168 walkthrough in progress). remindTurn() decides
 * per open claim, sends, and writes the claim owner's day-5 and stop-day Follow-ups; when it puts the conversation back
 * on a claim's list, that is kept, with the reminder as Tina's last message, so the reply is read against it. Nothing
 * sent: the conversation isn't written.
 */
export async function claimsDemoReminder(
    deps: ClaimsDemoDeps, phone: string, contactId: string, now: Date, settings: ReminderSettings = {},
): Promise<ReminderOutcome[] | 'walkthrough'> {
    const stored = await deps.load(phone);
    const c: DemoConversation = stored && stored.contactId === contactId
        ? stored
        : { contactId, requestId: '', walk: null, resume: NO_RESUME_STATE, held: [], lastSent: null };
    const abandoned = c.updatedAt && now.getTime() - Date.parse(c.updatedAt) > ABANDONED_AFTER_MS;
    if (c.walk && !abandoned) return 'walkthrough';
    const ports: ReminderPorts = {
        ...deps.ports(c.requestId, () => {}),
        lastReminderOn: deps.lastReminderOn ?? (async () => null),
        lastBrokerStepOn: deps.lastBrokerStepOn ?? (async () => null),
    };
    const r = await remindTurn(ports, claimsConversation(phone, c.requestId, deps.signUpLink, deps.contactNumber), c.resume, contactId, now, settings);
    if (!r.outcomes.some((o) => 'sent' in o)) return r.outcomes;
    c.resume = r.state;
    if (r.lastSent) c.lastSent = r.lastSent;
    await deps.save(phone, c);
    return r.outcomes;
}

/** The client's report as Claude reads it for the form: their own messages, then the facts they confirmed. */
export function reportText(walk: WalkthroughState, said: readonly string[]): string {
    const f = walk.facts;
    const yn = (v: boolean | undefined, details?: string) => (v === undefined ? undefined : v ? `yes${details ? ` (${details})` : ''}` : 'no');
    const confirmed = [
        ['Claim type', f.claimType], ['What happened', f.description], ['When', [f.incidentDate, f.incidentTime].filter(Boolean).join(' ')],
        ['Where', f.place], ['Anyone else involved', yn(f.thirdParties, f.thirdPartyDetails)], ['Police (SAPS) involved', yn(f.saps)],
        ['Anyone injured', yn(f.injuries, f.injuryDetails)],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    return `The client's messages:\n${said.map((t) => `- ${t}`).join('\n')}\n\nWhat the client confirmed:\n${confirmed.join('\n')}`;
}

/** The form questions the client's report already answers, for the follow-on's start. Never fails the turn. */
async function formAnswersFromReport(
    deps: ClaimsDemoDeps, ports: ResumePorts, claimId: string, walk: WalkthroughState, said: readonly string[], now: Date,
) {
    try {
        const claim = await ports.loadClaim(claimId);
        const form = (await ports.activeClaimForm(claim.providerId, claim.claimType)) ?? (await ports.genericClaimForm());
        const questions = openQuestions(form, claim.answers, { ...claim.facts, claimType: claim.claimType });
        return await reportedAnswers(deps.reportedModel, questions, reportText(walk, said), now);
    } catch (e) {
        console.warn('[ClaimsDemo] Reading the report for form answers failed:', (e as Error).message);
        return [];
    }
}
