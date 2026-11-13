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
 * TTTFG-5299 (roadside help, ROADSIDE_ENABLED): a car that has broken down is asked about before a claim. A known
 * client or an unknown number gets their insurer's assist number from the CRM (src/departments/insurance/roadside*.ts),
 * under a riivo_request with topic Roadside assistance. The roadside conversation is kept where the walkthrough is (its
 * state says `roadside: true`), and a yes to a claim after an accident starts the walkthrough on the same policy.
 *
 * Pure apart from the injected deps (Tina's Ports pattern, see CONTEXT.md), so it is tested without Meta, Dynamics,
 * Supabase or Claude. src/services/claims.service.ts wires the real ones.
 */
import { claimTurn, type Conversation } from '../departments/insurance/claim';
import { claimRoute, type IntentModel } from '../departments/insurance/intent';
import type { RoadsidePorts, RoadsideResult, RoadsideState } from '../departments/insurance/roadside';
import { roadsideRoute, type RoadsideModel } from '../departments/insurance/roadside-intent';
import { isRoadside, roadsideReply, roadsideStart } from '../departments/insurance/roadside-turn';
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
    /** '' for an unknown number's roadside conversation (TTTFG-5299 AC 2). */
    contactId: string;
    requestId: string;
    /** TTTFG-5299: or a roadside conversation (`roadside: true`), kept in the same row. */
    state: WalkthroughState | RoadsideState;
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
    ports(requestId: string, contact: { id: string; firstName: string } | null): RoadsidePorts;
    /** TTTFG-5299: ROADSIDE_ENABLED. Off: no roadside help, and a breakdown goes on to the claim route as before. */
    roadsideEnabled?: boolean;
    roadsideModel?: RoadsideModel;
    /**
     * TTTFG-5299: opens the riivo_request (Insurance, topic Roadside assistance) a roadside conversation runs under; with
     * no contact for an unknown number. Null when Dataverse refused it: the number still goes out.
     */
    openRoadsideRequest?(contactId: string | null, phone: string, text: string): Promise<string | null>;
}

export type ClaimsOutcome =
    | { handled: false }
    | { handled: true; kind: 'unknown-number' | 'started' | 'continued' | 'opened' | 'ended' | 'roadside'; reference?: string };

const NOT_MINE: ClaimsOutcome = { handled: false };

/**
 * TTTFG-5299: the riivo_request a roadside conversation runs under: Insurance, topic Roadside assistance, priority high.
 * An unknown number's request has no client (AC 2: no client record is read). The same payload on every path (Tina, the
 * demo numbers, the terminal chat).
 */
export function roadsideRequestBody(contactId: string | null, phone: string, text: string): Record<string, unknown> {
    return {
        riivo_clientmobilenumber: phone, riivo_channel: 1, riivo_category: 1, riivo_priority: 1, riivo_description: text.slice(0, 100),
        riivo_classificationtopic: 'Roadside assistance', statecode: 0, statuscode: 1,
        ...(contactId ? { 'riivo_Client@odata.bind': `/contacts(${contactId})` } : {}),
    };
}

/** ROADSIDE_ENABLED: off unless 'true'. Tina's main deploys production, so roadside help is off until it is switched on. */
export const roadsideSwitch = (raw: string | undefined) => (raw ?? '').trim().toLowerCase() === 'true';

const roadsideOn = (deps: ClaimsHostDeps) => !!(deps.enabled && deps.roadsideEnabled && deps.roadsideModel && deps.openRoadsideRequest);

/**
 * TTTFG-5299: a roadside message, first or next. Keeps the conversation while it goes on; a yes to a claim after an
 * accident starts the claim walkthrough on the same policy (AC 8).
 */
async function roadsideTurn(
    deps: ClaimsHostDeps, phone: string, contact: { id: string; firstName: string } | null, text: string, now: Date,
    stored: StoredWalkthrough | null,
): Promise<ClaimsOutcome | null> {
    let requestId: string;
    let r: RoadsideResult;
    if (stored && isRoadside(stored.state)) {
        requestId = stored.requestId;
        await deps.logIncoming(requestId, text);
        const conv = claimsConversation(phone, requestId, deps.signUpLink, deps.contactNumber);
        r = await roadsideReply(deps.ports(requestId, contact), conv, stored.state, text, now);
    } else {
        const route = await roadsideRoute(deps.roadsideModel!, text);
        if (!route) return null;
        // Help on the road can't wait on the CRM: without a request the number still goes out, and the error is logged.
        requestId = (await deps.openRoadsideRequest!(contact?.id ?? null, phone, text)) ?? '';
        await deps.logIncoming(requestId, text);
        const conv = claimsConversation(phone, requestId, deps.signUpLink, deps.contactNumber);
        r = await roadsideStart(deps.ports(requestId, contact), conv, contact, route, text, now);
    }
    if (r.state) {
        await deps.save(phone, { contactId: contact?.id ?? '', requestId, state: r.state, lastSent: r.lastSent ?? null });
        return { handled: true, kind: 'roadside' };
    }
    await deps.remove(phone);
    if (!r.claim || !contact) return { handled: true, kind: 'roadside' };

    // AC 8: the claim, under its own request (topic Claim), from the client's own words, on the policy roadside settled.
    const claimRequest = await deps.openRequest(contact.id, phone, r.claim.opening);
    if (!claimRequest) return { handled: true, kind: 'roadside' };
    const conv = claimsConversation(phone, claimRequest, deps.signUpLink, deps.contactNumber);
    const opening = await openingFacts(deps.understandModel, r.claim.opening, now);
    const t = await claimTurn(deps.ports(claimRequest, contact), conv, null, { kind: 'start', ...opening, ...(r.claim.policyId ? { policyId: r.claim.policyId } : {}) }, now);
    return persist(deps, phone, contact.id, claimRequest, t.state, t.lastSent ?? null, t.claim?.reference, 'started');
}

/** An inbound from a number that matches no contact. Handled when it asks for roadside help or reports a claim. */
export async function claimFromUnknownNumber(deps: ClaimsHostDeps, phone: string, text: string, now: Date = new Date()): Promise<ClaimsOutcome> {
    if (!deps.enabled) return NOT_MINE;
    // TTTFG-5299 AC 2: roadside help is the one thing an unknown number is given.
    if (roadsideOn(deps)) {
        let stored = await deps.load(phone);
        if (stored && (stored.contactId !== '' || !isRoadside(stored.state) || now.getTime() - Date.parse(stored.updatedAt) > ABANDONED_AFTER_MS)) stored = null;
        const out = await roadsideTurn(deps, phone, null, text, now, stored);
        if (out) return out;
    }
    if (!(await claimRoute(deps.intentModel, text))) return NOT_MINE;
    const conv = claimsConversation(phone, '', deps.signUpLink, deps.contactNumber);
    // The package's own start with no contact: the unknown-number reply through the gate, and nothing else.
    await claimTurn(deps.ports('', null), conv, null, { kind: 'start' }, new Date());
    return { handled: true, kind: 'unknown-number' };
}

/**
 * An inbound from a known client.
 * Service routing (docs/PLAN-service-routing.md): `force` starts a claim without the claim check (the client tapped
 * Report a claim); `wordFilter: false` asks Claude about every message (an insurance client's message, as on the demo
 * numbers). Neither changes a walkthrough or roadside conversation in progress.
 */
export async function claimFromClient(
    deps: ClaimsHostDeps, phone: string, contact: { id: string; firstName: string }, text: string, now: Date,
    o: { force?: boolean; wordFilter?: boolean } = {},
): Promise<ClaimsOutcome> {
    if (!deps.enabled) return NOT_MINE;
    let stored = await deps.load(phone);
    if (stored && (stored.contactId !== contact.id || now.getTime() - Date.parse(stored.updatedAt) > ABANDONED_AFTER_MS)) {
        await deps.remove(phone);
        stored = null;
    }

    // TTTFG-5299: a roadside conversation in progress, or a new one (asked before the claim route).
    if (roadsideOn(deps) && (stored ? isRoadside(stored.state) : !o.force)) {
        const out = await roadsideTurn(deps, phone, contact, text, now, stored);
        if (out) return out;
    }
    if (stored && isRoadside(stored.state)) {
        // Roadside was switched off mid-conversation: it ends, and the message goes on as any other.
        await deps.remove(phone);
        stored = null;
    }

    if (stored) {
        await deps.logIncoming(stored.requestId, text);
        const conv = claimsConversation(phone, stored.requestId, deps.signUpLink, deps.contactNumber);
        const answer = await understand(deps.understandModel, stored.state as WalkthroughState, stored.lastSent ?? '', text, now);
        const r = await claimTurn(deps.ports(stored.requestId, contact), conv, stored.state as WalkthroughState, answer, now);
        return persist(deps, phone, contact.id, stored.requestId, r.state, r.lastSent ?? stored.lastSent, r.claim?.reference, 'continued');
    }

    if (!o.force && !(await claimRoute(deps.intentModel, text, { wordFilter: o.wordFilter }))) return NOT_MINE;
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
