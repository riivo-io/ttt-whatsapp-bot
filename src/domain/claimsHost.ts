/**
 * TTTFG-5168: how Tina hands a WhatsApp message to the Insurance and Advice claims package
 * (src/departments/insurance, a generated copy; see scripts/sync-insurance-package.sh).
 *
 * The package owns the conversation: the order of questions, the fixed texts, the claim-outcome gate and the CRM rows.
 * This module only decides whether a message belongs to it, and keeps the walkthrough between messages:
 *  - a client with a walkthrough in progress: every message goes to the walkthrough, read by Claude into a typed answer;
 *  - a client with none: the claim route (AC 1) decides. A claim report opens a riivo_request (Insurance, topic Claim)
 *    and starts the walkthrough. Anything else goes back to Tina's normal path;
 *  - an unknown number reporting a claim gets only the unknown-number reply (AC 2): no claim, no follow-up.
 *
 * Pure apart from the injected deps (Tina's Ports pattern, see CONTEXT.md), so it is tested without Meta, Dynamics,
 * Supabase or Claude. src/services/claims.service.ts wires the real ones.
 */
import { claimTurn, type ClaimPorts, type Conversation } from '../departments/insurance/claim';
import { claimRoute, type IntentModel } from '../departments/insurance/intent';
import { understand, type UnderstandModel } from '../departments/insurance/understand';
import { advance, type WalkthroughState } from '../departments/insurance/walkthrough';

/** A description shorter than this in the opening message isn't kept (Tina asks "what happened?"). */
const MIN_OPENING_DESCRIPTION_WORDS = 8;

/** A walkthrough untouched this long is abandoned: the next message starts afresh. */
export const ABANDONED_AFTER_MS = 72 * 3_600_000;

export interface StoredWalkthrough {
    contactId: string;
    requestId: string;
    state: WalkthroughState;
    lastSent: string | null;
    updatedAt: string;
}

export interface ClaimsHostDeps {
    enabled: boolean;
    signUpLink: string;
    load(phone: string): Promise<StoredWalkthrough | null>;
    save(phone: string, w: Omit<StoredWalkthrough, 'updatedAt'>): Promise<void>;
    remove(phone: string): Promise<void>;
    intentModel: IntentModel;
    understandModel: UnderstandModel;
    /** Opens the riivo_request the claim conversation runs under. Null when Dataverse refused it. */
    openRequest(contactId: string, phone: string, text: string): Promise<string | null>;
    /** Logs the client's inbound on the request (riivo_whatsappcommunications) and in the session history. */
    logIncoming(requestId: string, text: string): Promise<void>;
    /** The package's ports for this conversation. `contact` is the sender Tina already resolved. */
    ports(requestId: string, contact: { id: string; firstName: string } | null): ClaimPorts;
}

export type ClaimsOutcome =
    | { handled: false }
    | { handled: true; kind: 'unknown-number' | 'started' | 'continued' | 'opened' | 'ended'; reference?: string };

const NOT_MINE: ClaimsOutcome = { handled: false };

/** An inbound from a number that matches no contact. Handled only when it reports a claim. */
export async function claimFromUnknownNumber(deps: ClaimsHostDeps, phone: string, text: string): Promise<ClaimsOutcome> {
    if (!deps.enabled || !(await claimRoute(deps.intentModel, text))) return NOT_MINE;
    const conv: Conversation = { phone, requestId: '', signUpLink: deps.signUpLink };
    // The package's own start with no contact: the unknown-number reply through the gate, and nothing else.
    await claimTurn(deps.ports('', null), conv, null, { kind: 'start' }, new Date());
    return { handled: true, kind: 'unknown-number' };
}

/** An inbound from a known client. */
export async function claimFromClient(
    deps: ClaimsHostDeps, phone: string, contact: { id: string; firstName: string }, text: string, now: Date,
): Promise<ClaimsOutcome> {
    if (!deps.enabled) return NOT_MINE;
    let stored = await deps.load(phone);
    if (stored && (stored.contactId !== contact.id || now.getTime() - Date.parse(stored.updatedAt) > ABANDONED_AFTER_MS)) {
        await deps.remove(phone);
        stored = null;
    }

    if (stored) {
        await deps.logIncoming(stored.requestId, text);
        const conv: Conversation = { phone, requestId: stored.requestId, signUpLink: deps.signUpLink };
        const answer = await understand(deps.understandModel, stored.state, stored.lastSent ?? '', text, now);
        const r = await claimTurn(deps.ports(stored.requestId, contact), conv, stored.state, answer, now);
        return persist(deps, phone, contact.id, stored.requestId, r.state, r.lastSent ?? stored.lastSent, r.claim?.reference, 'continued');
    }

    if (!(await claimRoute(deps.intentModel, text))) return NOT_MINE;
    const requestId = await deps.openRequest(contact.id, phone, text);
    // Without a request there is nothing to hang the follow-ups and messages on. Tina's normal path answers instead,
    // and the error is in the log; better than a claim conversation the CRM can't see.
    if (!requestId) return NOT_MINE;
    await deps.logIncoming(requestId, text);

    const conv: Conversation = { phone, requestId, signUpLink: deps.signUpLink };
    const r = await claimTurn(deps.ports(requestId, contact), conv, null, { kind: 'start' }, now);
    const state = r.state && (await withOpeningFacts(deps.understandModel, r.state, text, now));
    return persist(deps, phone, contact.id, requestId, state, r.lastSent ?? null, r.claim?.reference, 'started');
}

/**
 * Whatever the client already said about the incident in the message that started the claim ("my car was hit at the
 * Claremont robot") is kept, so Tina doesn't ask for it again later. The steps keep their order: the next question is
 * still the policy. An opening line like "my car was hit" is not the client's account of what happened: Tina still
 * asks for it.
 */
export async function withOpeningFacts(model: UnderstandModel, state: WalkthroughState, text: string, now: Date): Promise<WalkthroughState> {
    const firstRead = await understand(model, { ...state, step: 'claim-type' }, 'What happened?', text, now);
    if (firstRead.kind !== 'facts') return state;
    const facts = { ...firstRead.facts };
    // TTTFG-4830: a short opening isn't the description, but it still says what kind of claim it is ("my phone was
    // stolen"): kept as the walkthrough's hint, so Tina asks for the whole story in the right words.
    let opening: string | undefined;
    if (facts.description && facts.description.split(/\s+/).length < MIN_OPENING_DESCRIPTION_WORDS) {
        opening = facts.description;
        delete facts.description;
    }
    const hinted: WalkthroughState = opening ? { ...state, opening } : state;
    return { ...hinted, facts: advance({ ...hinted, step: 'claim-type' }, { kind: 'facts', facts }).state?.facts ?? state.facts };
}

async function persist(
    deps: ClaimsHostDeps, phone: string, contactId: string, requestId: string, state: WalkthroughState | null,
    lastSent: string | null, reference: string | undefined, kind: 'started' | 'continued',
): Promise<ClaimsOutcome> {
    if (state) {
        await deps.save(phone, { contactId, requestId, state, lastSent });
        return { handled: true, kind };
    }
    await deps.remove(phone);
    return reference ? { handled: true, kind: 'opened', reference } : { handled: true, kind: 'ended' };
}
