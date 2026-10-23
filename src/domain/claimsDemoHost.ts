/**
 * TTTFG-4830 (claims demo): the whole claims conversation on WhatsApp, for the numbers in CLAIMS_DEMO_NUMBERS only.
 *
 * Every message from a demo number comes here and nowhere else in Tina (no tax flows, no menus). Its claims run
 * against the CRM the demo is pointed at (TTT DEV), never Tina's own CRM. The claims package decides everything that
 * is said and written; this module only joins its parts the way the DEV drivers do:
 *  - a 5168 walkthrough in progress: Claude reads the reply (understand.ts), claimTurn() asks the next question;
 *  - the walkthrough opens the claim: the 5176 follow-on starts at once (SAPS step, duty of disclosure, the form's
 *    questions, the filled form, then the evidence);
 *  - otherwise: Claude reads the message against the open claims (reply.ts) and resumeTurn() (5184) decides which claim
 *    it belongs to, or that there is none;
 *  - no open claim: a claim report starts the walkthrough under a new riivo_request; anything else gets the demo hello.
 * "#reset" withdraws the demo client's open claims and forgets the conversation, so a demo can start clean.
 *
 * Pure apart from the injected deps (Tina's Ports pattern), so it is tested without Meta, Dataverse, Supabase or Claude.
 * src/services/claimsDemo.service.ts wires the real ones.
 */
import { claimTurn, type Conversation } from '../departments/insurance/claim';
import { followOnTurn, type ClientFile, type ResumeFile } from '../departments/insurance/followon';
import { claimRoute, type IntentModel } from '../departments/insurance/intent';
import { readReply, replyContext, type ReplyModel } from '../departments/insurance/reply';
import { NO_RESUME_STATE, resumeTurn, type ResumePorts, type ResumeState } from '../departments/insurance/resume';
import { understand, type UnderstandModel } from '../departments/insurance/understand';
import type { WalkthroughState } from '../departments/insurance/walkthrough';
import { ABANDONED_AFTER_MS, withOpeningFacts } from './claimsHost';

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
    lastSent: string | null;
    updatedAt?: string;
}

export interface DemoMessage {
    phone: string;
    contactId: string;
    /** The text, or a photo's or document's caption ('' when there is none). */
    text: string;
    file?: ClientFile;
    wamid: string;
}

export interface ClaimsDemoDeps {
    load(phone: string): Promise<DemoConversation | null>;
    save(phone: string, c: DemoConversation): Promise<void>;
    remove(phone: string): Promise<void>;
    /** The claims package's ports against the demo CRM. Every text Tina sends through them is passed to `sent`. */
    ports(requestId: string, sent: (text: string) => void): ResumePorts;
    intentModel: IntentModel;
    understandModel: UnderstandModel;
    replyModel: ReplyModel;
    /** Opens the riivo_request (Insurance, topic Claim) a new claim conversation runs under. Null when refused. */
    openRequest(contactId: string, phone: string, text: string): Promise<string | null>;
    /** "#reset": sets the client's open claims to Withdrawn. Returns their references. */
    withdrawOpenClaims(contactId: string): Promise<string[]>;
    /** Tina's own fixed texts (the hello, the reset, a file kept for later), outside the package. */
    say(phone: string, text: string): Promise<void>;
    signUpLink: string;
}

export type DemoOutcome =
    | 'reset' | 'hello' | 'file-held' | 'walkthrough' | 'opened' | 'started' | 'follow-on' | 'new-claim' | 'no-request';

export const helloText = (firstName: string) =>
    `Hi ${firstName}, it's Tina from TTT. On this number I'm set up to help with insurance claims. Tell me what happened `
    + `(for example "someone drove into my car yesterday") and I'll open a claim for you.`;
export const resetText = (refs: string[]) =>
    `Demo reset. ${refs.length ? `I've withdrawn ${refs.join(', ')} and` : 'You had no open claims, and'} I've forgotten our chat. `
    + 'Say hi or tell me what happened to start again.';
export const FILE_KEPT = "Thanks, I've kept that for your claim. I'll add it once your claim is open.";

const THEFT = /\b(stol(e|en)|theft|thie(f|ves)|burglar|broke into|break[- ]in|robbed|robbery|hijack)/i;
/** The follow-on's `describedAsTheft`: the claim type says so, or the client's description does. */
export const describedAsTheft = (w: WalkthroughState) =>
    w.facts.claimType === 'Motor theft' || w.facts.claimType === 'Hijacking' || THEFT.test(w.facts.description ?? '');

export async function claimsDemoTurn(deps: ClaimsDemoDeps, m: DemoMessage, now: Date): Promise<DemoOutcome> {
    if (!m.file && m.text.trim().toLowerCase() === RESET_COMMAND) {
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

    let last: string | undefined;
    const sent = (text: string) => { last = text; };
    const done = async (outcome: DemoOutcome) => {
        if (last !== undefined) c.lastSent = last;
        await deps.save(m.phone, c);
        return outcome;
    };
    const conv = (): Conversation => ({ phone: m.phone, requestId: c.requestId, signUpLink: deps.signUpLink });

    // ---- a 5168 walkthrough in progress ----
    if (c.walk) {
        if (m.file && !m.text.trim()) {
            c.held = [...c.held, { file: m.file }];
            await deps.say(m.phone, FILE_KEPT);
            return done('file-held');
        }
        const ports = deps.ports(c.requestId, sent);
        const walk = c.walk;
        const answer = await understand(deps.understandModel, walk, c.lastSent ?? '', m.text, now);
        const r = await claimTurn(ports, conv(), walk, answer, now);
        if (m.file) c.held = [...c.held, { file: m.file }];
        if (!r.claim) {
            c.walk = r.state;
            return done('walkthrough');
        }
        // The claim is open: the follow-on starts at once, with any files the client sent on the way.
        c.walk = null;
        const fo = await followOnTurn(ports, conv(), null, { kind: 'start', claimId: r.claim.id, describedAsTheft: describedAsTheft(walk), files: c.held }, now);
        c.resume = { followOn: fo.state, pending: null };
        c.held = [];
        return done('opened');
    }

    // ---- no walkthrough: which open claim is this about? ----
    const ports = deps.ports(c.requestId, sent);
    const ctx = await replyContext(ports, m.contactId, c.resume, c.lastSent ?? undefined);
    const reading = await readReply(deps.replyModel, ctx, m.text, m.file, m.wamid, now);
    const r = await resumeTurn(ports, conv(), c.resume, reading, now);
    if (r.route === 'claim') {
        c.resume = r.state;
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
    if (!m.text.trim() || !(await claimRoute(deps.intentModel, m.text, { wordFilter: false }))) {
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
    const t = await claimTurn(deps.ports(requestId, sent), conv(), null, { kind: 'start' }, now);
    c.walk = t.state && (await withOpeningFacts(deps.understandModel, t.state, m.text, now));
    return done('started');
}
