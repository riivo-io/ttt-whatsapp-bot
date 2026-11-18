/**
 * TTTFG-5340 (SPEC-05 "Unknown numbers", decided 12 October 2026): how Tina answers a WhatsApp number that is on no contact
 * and no lead, when it is not asking for roadside help, reporting a claim or quoting a referral code.
 *
 *  - It gets ONE fixed reply with the tax sign-up link and nothing else: no tax question is answered, no ID number is asked
 *    for, and a typed ID number is never used to find a client (AC 1 to 3). The wording is the package's
 *    `unknownNumberText`, so an unknown number is told the same thing whichever department it asks about.
 *  - Tina makes ONE lead for the Tax team (riivo_leadtype Tax, lead source WhatsApp) and a riivo_agentaction of Kind Created
 *    owned by the Tax team, so the team sees it in My Day (AC 5).
 *  - A second message inside 24 hours gets no reply, and no second lead is ever made (AC 6).
 *  - A lead Tina made herself, with no email yet, is that same unknown number: it is not served as a lead (Tina would chat to
 *    a stranger) until the online sign-up, or a consultant, gives it an email.
 *
 * Pure apart from the injected ports (Tina's Ports pattern, see CONTEXT.md): tested without Meta, Dynamics or Supabase.
 * src/services/unknownNumber.service.ts wires the real ones.
 */
import { unknownNumberText } from '../departments/insurance/claim';

/** A second message inside this long after the reply is not answered. */
export const REPLY_WINDOW_MS = 24 * 3_600_000;

/** riivo_leadtype Tax (the global riivo_leadtypes: 100000000 Tax, 100000001 Accounting, 463630001 Long Term, 463630002 Short Term). */
export const TAX_LEAD_TYPE = 100000000;
/** riivo_leadsource WhatsApp. A dev-only option in some environments: createLead retries without it when it is refused. */
export const WHATSAPP_LEAD_SOURCE = 463630005;

/** The one reply an unknown number gets. */
export const unknownNumberReply = (signUpLink: string): string => unknownNumberText(signUpLink);

/** The name of the lead Tina makes: she knows only the number. The Tax team renames it when the person is known. */
export const placeholderLeadNames = (phone: string): { firstName: string; lastName: string } => ({ firstName: 'WhatsApp', lastName: phone });

/**
 * The Created action's name: what the Tax team reads in My Day. Not the message text: the person is not known, so what they
 * typed (an ID number, say) is not kept.
 */
export const createdActionName = (phone: string): string =>
    `New lead from WhatsApp ${phone}: Tina sent the tax sign-up link. She asked for no ID number and answered no question.`.slice(0, 300);

// riivo_agentaction choices: the values ship with 2Tables, so they are the same in every environment.
const KIND_CREATED = 463630007;
const STATUS_OPEN = 463630000;
const CHANNEL_WHATSAPP = 463630001;
const DEPARTMENT_TAX = 463630000;
const URGENCY_NORMAL = 463630002;

/** What createLead is given for an unknown number's lead (the Tax team owns it when the team is known). */
export const placeholderLeadParams = (phone: string, ownerTeamId?: string) => ({
    ...placeholderLeadNames(phone), phone, leadType: TAX_LEAD_TYPE, leadSource: WHATSAPP_LEAD_SOURCE, ...(ownerTeamId ? { ownerTeamId } : {}),
});

/**
 * The riivo_agentaction row for the lead: Kind Created, open (so it shows in My Day until a person has checked it), department
 * Tax, owned by the Tax team, regarding the lead. The service and the DEV rehearsal both write exactly this.
 */
export function createdActionColumns(o: { phone: string; leadId: string; at: string; sourceMessageId?: string; ownerTeamId?: string | null }): Record<string, unknown> {
    return {
        riivo_name: createdActionName(o.phone),
        riivo_kind: KIND_CREATED,
        riivo_status: STATUS_OPEN,
        riivo_channel: CHANNEL_WHATSAPP,
        riivo_department: DEPARTMENT_TAX,
        riivo_urgency: URGENCY_NORMAL,
        riivo_urgencyreason: 'The agent created a lead to check',
        riivo_actedon: o.at,
        riivo_recipient: o.phone,
        riivo_sourcemessageid: o.sourceMessageId || `whatsapp:${o.phone}`,
        'riivo_Client_new_lead@odata.bind': `/new_leads(${o.leadId})`,
        ...(o.ownerTeamId ? { 'ownerid@odata.bind': `/teams(${o.ownerTeamId})` } : {}),
    };
}

/** What the reply table says about a number. */
export interface ReplyClaim {
    /** True when this message may be answered: no reply in the last 24 hours. */
    claimed: boolean;
    /** The lead Tina already made for this number, if she did. */
    leadId: string | null;
}

export interface UnknownNumberPorts {
    /** Atomic: the first of two messages handled at once claims, the other does not. */
    claim(phone: string, now: Date): Promise<ReplyClaim>;
    /** Gives the claim back, so the person's next message is answered. The stored lead stays. */
    release(phone: string): Promise<void>;
    /** Makes the Tax lead for this number. Throws when the CRM refuses it. */
    createLead(phone: string): Promise<string>;
    /** Makes the Created action for the lead. Throws when the CRM refuses it. */
    createAction(phone: string, leadId: string, at: string, sourceMessageId?: string): Promise<string>;
    /** Keeps the lead (and the action) against the number. */
    remember(phone: string, leadId: string, actionId: string | null): Promise<void>;
    /** Sends the reply. False when WhatsApp did not take it. */
    send(phone: string, text: string): Promise<boolean>;
    log(line: string): void;
}

export interface UnknownNumberOutcome {
    /** True when the reply went out. */
    replied: boolean;
    /** The lead made by this message. */
    leadCreated: boolean;
    leadId: string | null;
}

/** Keeps the lead against the number, twice if need be. False (and a log line naming the lead) when it could not. */
async function keep(p: UnknownNumberPorts, phone: string, leadId: string, actionId: string | null, quiet = false): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await p.remember(phone, leadId, actionId);
            return true;
        } catch (e) {
            if (attempt === 2) {
                if (!quiet) p.log(`${phone}: the lead ${leadId} was made but could not be kept against the number: ${(e as Error).message}`);
                return false;
            }
        }
    }
    return false;
}

/**
 * An unknown number's message. Answered once in 24 hours, with one lead for good.
 * The lead and its action come before the reply, so a reply that WhatsApp refuses is not a lead the team never hears of; a CRM
 * that refuses them never stops the reply, because the person is waiting on it.
 */
export async function answerUnknownNumber(
    p: UnknownNumberPorts, phone: string, signUpLink: string, now: Date, sourceMessageId?: string,
): Promise<UnknownNumberOutcome> {
    const claim = await p.claim(phone, now);
    if (!claim.claimed) {
        p.log(`${phone} already answered in the last 24 hours: no reply`);
        return { replied: false, leadCreated: false, leadId: claim.leadId };
    }

    let leadId = claim.leadId;
    let leadCreated = false;
    if (!leadId) {
        try {
            leadId = await p.createLead(phone);
            leadCreated = true;
        } catch (e) {
            p.log(`${phone}: no lead made: ${(e as Error).message}`);
        }
        if (leadId) {
            // The lead is kept at once, and the keeping is tried twice: a lead that is made but not kept is not a placeholder, and
            // the number would be served as an ordinary lead. (createLead adopts a lead already on the number, so it is never doubled.)
            const kept = await keep(p, phone, leadId, null);
            if (kept) {
                try {
                    await keep(p, phone, leadId, await p.createAction(phone, leadId, now.toISOString(), sourceMessageId), true);
                } catch (e) {
                    p.log(`${phone}: the lead ${leadId} was made but its Created action was not: ${(e as Error).message}`);
                }
            }
        }
    }

    let sent = false;
    try {
        sent = await p.send(phone, unknownNumberReply(signUpLink));
    } catch (e) {
        // Give the claim back before the worker retries the message, or the retry is read as a repeat.
        await p.release(phone);
        throw e;
    }
    if (!sent) {
        await p.release(phone);
        p.log(`${phone}: the reply was not delivered; the next message is answered`);
    }
    return { replied: sent, leadCreated, leadId };
}

/**
 * Whether the lead on this number is the placeholder Tina made (and so the number is still unknown): the lead she stored
 * for it, with no email yet. A lead that has an email signed up, or a consultant filled it in: that is a person.
 */
export function isPlaceholderLead(storedLeadId: string | null | undefined, lead: { id: string; email?: string | null }): boolean {
    return !!storedLeadId && storedLeadId === lead.id && !lead.email?.trim();
}

/**
 * What Tina tries, in order, for a message from a number on no contact and no lead:
 *  1. the claims flow: roadside help (an unknown number that has broken down gets its insurer's assist number, TTTFG-5299 /
 *     AC 7) or a claim report (the unknown-number reply, TTTFG-5168). Either way no sign-up reply and no Tax lead;
 *  2. a quoted referral code: the referral reply, as before;
 *  3. anything else: the one reply and the one Tax lead.
 */
export interface UnknownNumberRoute {
    claims(): Promise<boolean>;
    referral(): Promise<boolean>;
    tax(): Promise<UnknownNumberOutcome>;
}

export async function routeUnknownNumber(r: UnknownNumberRoute): Promise<'claims' | 'referral' | UnknownNumberOutcome> {
    if (await r.claims()) return 'claims';
    if (await r.referral()) return 'referral';
    return r.tax();
}
