/**
 * Service routing's insurance side (docs/PLAN-service-routing.md, decision A): what Tina does with a message
 * src/domain/serviceRoute.ts sent to insurance.
 *
 *  - The insurance menu: Report a claim, Something else.
 *  - A claim (claims switched on): the claims package, as before (src/domain/claimsHost.ts), on the number's
 *    insurance contact. With claims off (PROD, 13 Nov 2026) a claim is a hand-over like any other message.
 *  - Everything else: the broker hand-over. A riivo_request (Insurance) and an Agent Action Follow-up for the client's
 *    broker (main broker, else the one owner of their active policies, else the Insurance and Advice team), and a fixed
 *    reply. Tina doesn't answer insurance questions. Later messages in the same session go on the same request.
 *  - A file: a note on the contact, and a hand-over that names it. Never the tax filing.
 *  - Decision B: a tax client who said yes to the offer gets the hand-over to the Insurance and Advice team.
 *
 * Tina never names the broker to the client (TTT, 28 Oct 2026; CLIENT_BROKER): "your broker" or "our insurance team".
 *
 * Pure apart from the ports. src/services/serviceRouting.service.ts wires the real ones.
 */
import { CLIENT_BROKER, type Owner } from '../departments/insurance/claim';
import { detectWrapUp, qualifyMessage } from './caseRouting';
import type { ServiceLines } from './serviceLines';

/** The hand-over this session has open: later messages go on its request. */
export interface Handover { requestId: string; ownerKind: Owner['kind']; contactId: string }

export type HandoverTopic = 'Insurance hand-over' | 'Insurance offer';

export interface InsurancePorts {
    claimsEnabled: boolean;
    /**
     * The claims package (claimFromClient) for this contact. `force`: the client asked to report a claim, so the claim
     * starts without the claim check. True when the package answered the message.
     */
    claim(contact: { id: string; firstName: string }, text: string, o: { force: boolean }): Promise<boolean>;
    /** Who a hand-over goes to. `team`: the Insurance and Advice team, whoever the broker is. */
    owner(contactId: string, o: { team: boolean }): Promise<Owner>;
    /** A riivo_request, category Insurance. Null when Dataverse refused it. */
    openRequest(contactId: string, text: string, topic: HandoverTopic): Promise<string | null>;
    /** The Follow-up. Its due date (the next working day), or null when Dataverse refused it. */
    followUp(row: { owner: Owner; requestId: string; contactId: string; detail: string }): Promise<{ dueOn?: string } | null>;
    /** The client's message on the request (riivo_whatsappcommunications) and in the session history. */
    logIncoming(requestId: string | null, text: string): Promise<void>;
    /** A text; with `buttons`, up to three reply buttons under it. Logged on `requestId` when given. */
    send(text: string, o?: { buttons?: { id: string; title: string }[]; requestId?: string | null }): Promise<void>;
    /** A file as a note on the contact. False when it couldn't be saved. */
    saveFile(contactId: string, file: { name: string; mimeType: string; bytes: Buffer }): Promise<boolean>;
    loadHandover(): Promise<Handover | null>;
    saveHandover(h: Handover): Promise<void>;
}

export interface InsuranceMessage {
    /** The resolved contact (the one Tina's session is for). */
    contact: { id: string; firstName: string };
    lines: ServiceLines;
    text: string;
    menu?: boolean;
    /** The menu is the session's first message (a greeting): it opens with Tina's intro. */
    greeting?: boolean;
    claim?: boolean;
    file?: { name: string; mimeType: string; bytes: Buffer };
}

export type InsuranceOutcome = 'menu' | 'claims' | 'handed-over' | 'added' | 'file' | 'thanks' | 'logged' | 'failed';

/** Ids of the insurance menu's buttons (src/domain/serviceRoute.ts ROUTE_IDS). */
export const INSURANCE_MENU_BUTTONS = [
    { id: 'menu:insurance:claim', title: '🚗 Report a claim' },
    { id: 'menu:insurance:other', title: '💬 Something else' },
];

const who = (kind: Owner['kind']) => (kind === 'user' ? CLIENT_BROKER : 'our insurance team');
const by = (dueOn?: string) => (dueOn
    ? ` by ${new Date(dueOn).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long' })}`
    : '');

export const TEXTS = {
    menuGreeting: (firstName: string) => `Hey ${firstName || 'there'}! 👋 Tina from TTT Financial Group here.\n\nWhat can I help with today?`,
    menu: 'Sure. What can I help with on your insurance?',
    handedOver: (firstName: string, kind: Owner['kind'], dueOn?: string) =>
        `Thanks ${firstName || 'there'}, I've passed this to ${who(kind)}, who will get back to you${by(dueOn)}.`,
    claimHandedOver: (firstName: string, kind: Owner['kind'], dueOn?: string) =>
        `Thanks ${firstName || 'there'}, I've passed this to ${who(kind)}, who will contact you${by(dueOn)} to take your claim.`,
    added: (kind: Owner['kind']) => `Thanks, I've added that for ${who(kind)}.`,
    fileAdded: (kind: Owner['kind']) => `Got it, I've saved your file for ${who(kind)}.`,
    fileFailed: "Sorry, I couldn't save that file. Please try sending it again in a few minutes.",
    failed: "Sorry, I couldn't pass that on just now. Please send it again in a few minutes.",
    thanks: "You're welcome! 🙌",
    offerAccepted: (dueOn?: string) => `Great, I've asked our insurance team to contact you${by(dueOn)}.`,
} as const;

/** Thanks and nothing else ("thank you", "thanks Tina 🙏", "ok cheers"): not a question for the broker. */
export function isThanks(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t || t.length > 50 || t.includes('?')) return false;
    if (detectWrapUp(t)) return true;
    return /^(ok(ay)?[,.! ]*)?(thanks|thank you|thank u|thanx|thx|ty|shot|cheers|great|perfect|awesome|lekker|baie dankie|dankie|appreciate it|much appreciated)( (so much|a lot|very much|tina))*[\s!.,\p{Extended_Pictographic}]*$/u.test(t);
}

const SHARED_NUMBER_NOTE = ' Several contacts share this WhatsApp number: check which client this is before you reply.';

export const DETAILS = {
    question: (text: string) =>
        `The client asked on WhatsApp: "${text}". Tina passes insurance questions to the broker and didn't answer it. Please get back to them.`,
    claimOff: (claimsEnabled: boolean) => (claimsEnabled
        ? "The client asked on WhatsApp to report a claim and Tina couldn't start it there. Please contact them to take the claim."
        : 'The client asked on WhatsApp to report a claim. Claims are not taken on WhatsApp yet: please contact them to take the claim.'),
    file: (name: string) =>
        `The client sent a file on WhatsApp (${name}). It is in the Notes on their contact. Please look at it and get back to them.`,
    offer: (text: string) =>
        `A tax client asked on WhatsApp about insurance${text ? `: "${text}"` : ''}. They have no insurance policy with TTT and asked to be contacted.`,
} as const;

/** The contact an insurance message is about, and whether that is a guess (several insurance contacts on the number). */
function insuranceContact(m: InsuranceMessage): { id: string; firstName: string; shared: boolean } {
    if (m.lines.insuranceContactId && !m.lines.insuranceAmbiguous) {
        return { id: m.lines.insuranceContactId, firstName: m.contact.firstName, shared: false };
    }
    return { id: m.contact.id, firstName: m.contact.firstName, shared: m.lines.insuranceAmbiguous };
}

/**
 * Open a hand-over, or add to the session's. Owner first (it is in the reply), then the request, the Follow-up, and
 * only then the reply that says it was passed on. Any refusal: the client is told to send it again, and nothing is
 * remembered, so the next message opens a fresh one.
 */
async function handOver(
    ports: InsurancePorts, contact: { id: string; firstName: string; shared: boolean }, text: string, detail: string,
    o: { team?: boolean; topic?: HandoverTopic; reply: (kind: Owner['kind'], dueOn?: string) => string; added?: (kind: Owner['kind']) => string },
): Promise<InsuranceOutcome> {
    const open = await ports.loadHandover();
    if (open) {
        await ports.logIncoming(open.requestId, text);
        await ports.send((o.added ?? TEXTS.added)(open.ownerKind), { requestId: open.requestId });
        return 'added';
    }
    const owner = await ports.owner(contact.id, { team: !!o.team });
    const requestId = await ports.openRequest(contact.id, text, o.topic ?? 'Insurance hand-over');
    if (!requestId) {
        await ports.logIncoming(null, text);
        await ports.send(TEXTS.failed);
        return 'failed';
    }
    await ports.logIncoming(requestId, text);
    const row = await ports.followUp({ owner, requestId, contactId: contact.id, detail: contact.shared ? detail + SHARED_NUMBER_NOTE : detail });
    if (!row) {
        await ports.send(TEXTS.failed, { requestId });
        return 'failed';
    }
    await ports.saveHandover({ requestId, ownerKind: owner.kind, contactId: contact.id });
    await ports.send(o.reply(owner.kind, row.dueOn), { requestId });
    return 'handed-over';
}

/** One message on the insurance side. */
export async function insuranceTurn(ports: InsurancePorts, m: InsuranceMessage): Promise<InsuranceOutcome> {
    const contact = insuranceContact(m);

    if (m.menu) {
        await ports.logIncoming(null, m.text);
        await ports.send(m.greeting ? TEXTS.menuGreeting(m.contact.firstName) : TEXTS.menu, { buttons: INSURANCE_MENU_BUTTONS });
        return 'menu';
    }

    if (m.file) {
        const saved = await ports.saveFile(contact.id, m.file);
        if (!saved) {
            await ports.logIncoming(null, m.text);
            await ports.send(TEXTS.fileFailed);
            return 'failed';
        }
        const out = await handOver(ports, contact, m.text, DETAILS.file(m.file.name), { reply: TEXTS.fileAdded, added: TEXTS.fileAdded });
        return out === 'failed' ? out : 'file';
    }

    if (!m.claim) {
        if (isThanks(m.text)) {
            await ports.logIncoming((await ports.loadHandover())?.requestId ?? null, m.text);
            await ports.send(TEXTS.thanks);
            return 'thanks';
        }
        if (!qualifyMessage(m.text)) {
            // "ok", "hi", an emoji: on the open hand-over if there is one (no reply), else the menu.
            const open = await ports.loadHandover();
            await ports.logIncoming(open?.requestId ?? null, m.text);
            if (open) return 'logged';
            await ports.send(TEXTS.menu, { buttons: INSURANCE_MENU_BUTTONS });
            return 'menu';
        }
    }

    // A claim tap, or (claims on) any message the claims package takes (roadside help, a claim report): the package
    // answers. Its claim check runs without the word filter here (as on the demo numbers). Several insurance contacts
    // on the number: no claim is started on a guess; the hand-over below says so.
    if (ports.claimsEnabled && !contact.shared) {
        if (await ports.claim({ id: contact.id, firstName: contact.firstName }, m.text, { force: !!m.claim })) return 'claims';
    }

    if (m.claim) {
        return handOver(ports, contact, m.text, DETAILS.claimOff(ports.claimsEnabled), { reply: (kind, due) => TEXTS.claimHandedOver(m.contact.firstName, kind, due) });
    }
    return handOver(ports, contact, m.text, DETAILS.question(m.text), { reply: (kind, due) => TEXTS.handedOver(m.contact.firstName, kind, due) });
}

/** Decision B: a tax client said yes to the insurance offer. The Insurance and Advice team, never a broker. */
export async function offerAccepted(ports: InsurancePorts, m: { contact: { id: string; firstName: string }; text: string }): Promise<InsuranceOutcome> {
    return handOver(ports, { ...m.contact, shared: false }, m.text || 'Yes, contact me', DETAILS.offer(m.text),
        { team: true, topic: 'Insurance offer', reply: (_kind, due) => TEXTS.offerAccepted(due) });
}
