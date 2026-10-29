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
import { openingFacts, understand, type UnderstandModel } from '../departments/insurance/understand';
import type { WalkthroughState } from '../departments/insurance/walkthrough';

/** A walkthrough untouched this long is abandoned: the next message starts afresh. */
export const ABANDONED_AFTER_MS = 72 * 3_600_000;

/**
 * TTTFG-4830 (28 Oct 2026): CLAIMS_CONTACT_NUMBER, a TTT number the client can call about the claim. The package says it
 * where the client may need a person quickly (the burst-geyser list: "You can also call TTT on ..."). Unset or blank:
 * not said. Which number TTT gives out is TTT's choice, so there is no default.
 */
export function claimsContactNumber(raw: string | undefined): string | undefined {
    const n = raw?.trim();
    return n ? n : undefined;
}

/** The package's Conversation for one message: the contact number only when one is set. */
export const claimsConversation = (phone: string, requestId: string, signUpLink: string, contactNumber?: string): Conversation =>
    ({ phone, requestId, signUpLink, ...(contactNumber ? { contactNumber } : {}) });

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
    /** TTTFG-4830: CLAIMS_CONTACT_NUMBER (claimsContactNumber). Absent: the client isn't given a TTT number. */
    contactNumber?: string;
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
    const conv = claimsConversation(phone, '', deps.signUpLink, deps.contactNumber);
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
        const conv = claimsConversation(phone, stored.requestId, deps.signUpLink, deps.contactNumber);
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

    const conv = claimsConversation(phone, requestId, deps.signUpLink, deps.contactNumber);
    // What the client already said in the message that started the claim ("my car was hit at the Claremont robot") is
    // read first and goes into the start, so Tina doesn't ask for it again, and (TTTFG-4830, 28 Oct 2026) the policy
    // question offers only the policies that fit the claim. A short opening ("my phone was stolen") is kept as a hint,
    // not as the description (understand.ts openingFacts).
    const opening = await openingFacts(deps.understandModel, text, now);
    const r = await claimTurn(deps.ports(requestId, contact), conv, null, { kind: 'start', ...opening }, now);
    return persist(deps, phone, contact.id, requestId, r.state, r.lastSent ?? null, r.claim?.reference, 'started');
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
