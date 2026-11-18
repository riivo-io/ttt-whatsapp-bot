/**
 * TTTFG-5340: the real ports behind src/domain/unknownNumber.ts. An unknown WhatsApp number gets one reply with the tax
 * sign-up link, one Tax lead and one Created action for the Tax team; a second message in 24 hours gets nothing.
 */
import {
    answerUnknownNumber, createdActionColumns, isPlaceholderLead, placeholderLeadParams, REPLY_WINDOW_MS,
    type UnknownNumberOutcome, type UnknownNumberPorts,
} from '../domain/unknownNumber';
import { dynamicsService } from './dynamics.service';
import { metaWhatsAppService } from './meta.service';
import { supabaseService } from './supabase.service';

/** The tax department's online sign-up: the link in the one reply. TAX_SIGNUP_LINK overrides it. */
const SIGN_UP_LINK = process.env.TAX_SIGNUP_LINK || 'https://www.ttt-tax.co.za/client-onboarding';

let taxTeam: Promise<string | null> | undefined;

/** The Tax department's fallback owner team (made in TTTFG-4833), by name as the email agent finds it. Read once. */
function taxTeamId(): Promise<string | null> {
    taxTeam ??= dynamicsService
        .webApi<{ value: { teamid: string }[] }>('GET', "teams?$select=teamid&$top=1&$filter=teamtype eq 0 and name eq 'Tax'")
        .then((r) => { const id = r.value[0]?.teamid ?? null; if (!id) { taxTeam = undefined; console.error("[UnknownNumber] no team named 'Tax': the lead and its action will have no Tax owner"); } return id; })
        .catch((e) => { taxTeam = undefined; console.error('[UnknownNumber] Tax team lookup failed: the lead and its action will have no Tax owner:', (e as Error).message); return null; });
    return taxTeam;
}

export function unknownNumberPorts(): UnknownNumberPorts {
    return {
        claim: (phone, now) => supabaseService.claimUnknownNumberReply(phone, now, REPLY_WINDOW_MS),
        release: (phone) => supabaseService.releaseUnknownNumberReply(phone),
        remember: (phone, leadId, actionId) => supabaseService.saveUnknownNumberLead(phone, leadId, actionId),
        send: async (phone, text) => !!(await metaWhatsAppService.sendMessage(phone, text)),
        log: (line) => console.log(`[UnknownNumber] ${line}`),

        async createLead(phone) {
            // A lead already on the number (made by an earlier attempt whose bookkeeping failed) is adopted, never doubled.
            const existing = await dynamicsService.findActiveLeadByPhone(phone);
            if (existing) return existing.id;
            const created = await dynamicsService.createLead(placeholderLeadParams(phone, (await taxTeamId()) ?? undefined));
            if (!created?.new_leadid) throw new Error('the CRM did not make the lead');
            return String(created.new_leadid);
        },

        async createAction(phone, leadId, at, sourceMessageId) {
            const row = await dynamicsService.webApi<{ riivo_agentactionid: string }>(
                'POST', 'riivo_agentactions?$select=riivo_agentactionid',
                createdActionColumns({ phone, leadId, at, sourceMessageId, ownerTeamId: await taxTeamId() }), { returnRow: true },
            );
            return row.riivo_agentactionid;
        },
    };
}

/** An unknown number's message (not roadside, a claim or a referral code): the one reply, the one lead. */
export function handleUnknownNumber(from: string, wamid?: string): Promise<UnknownNumberOutcome> {
    return answerUnknownNumber(unknownNumberPorts(), from, SIGN_UP_LINK, new Date(), wamid);
}

/**
 * Whether a lead found on a number is the placeholder Tina made for it (so the number is still unknown). Reads the reply
 * table; an error throws, and the worker retries the message rather than serve a stranger as a lead.
 */
export async function isUnknownNumberPlaceholder(phone: string, lead: { id: string; email?: string | null }): Promise<boolean> {
    // A lead with an email is a person who signed up: not a placeholder, so most leads cost no Supabase read at all.
    if (lead.email?.trim()) return false;
    return isPlaceholderLead(await supabaseService.getUnknownNumberLeadId(phone, { tolerateMissingTable: true }), lead);
}
