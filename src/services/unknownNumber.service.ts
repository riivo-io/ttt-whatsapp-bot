/**
 * TTTFG-5340: the real ports behind src/domain/unknownNumber.ts. An unknown WhatsApp number gets one reply with the tax
 * sign-up link, one Tax lead and one Created action for the Tax team; a second message in 24 hours gets nothing.
 */
import {
    answerUnknownNumber, createdActionName, isPlaceholderLead, placeholderLeadNames, REPLY_WINDOW_MS,
    TAX_LEAD_TYPE, WHATSAPP_LEAD_SOURCE, type UnknownNumberOutcome, type UnknownNumberPorts,
} from '../domain/unknownNumber';
import { dynamicsService } from './dynamics.service';
import { metaWhatsAppService } from './meta.service';
import { supabaseService } from './supabase.service';

/** The tax department's online sign-up: the link in the one reply. TAX_SIGNUP_LINK overrides it. */
const SIGN_UP_LINK = process.env.TAX_SIGNUP_LINK || 'https://www.ttt-tax.co.za/client-onboarding';

// riivo_agentaction choices: the values ship with 2Tables, so they are the same in every environment.
const KIND_CREATED = 463630007;
const STATUS_OPEN = 463630000;
const CHANNEL_WHATSAPP = 463630001;
const DEPARTMENT_TAX = 463630000;
const URGENCY_NORMAL = 463630002;

let taxTeam: Promise<string | null> | undefined;

/** The Tax department's fallback owner team (made in TTTFG-4833), by name as the email agent finds it. Read once. */
function taxTeamId(): Promise<string | null> {
    taxTeam ??= dynamicsService
        .webApi<{ value: { teamid: string }[] }>('GET', "teams?$select=teamid&$top=1&$filter=teamtype eq 0 and name eq 'Tax'")
        .then((r) => r.value[0]?.teamid ?? null)
        .catch((e) => { taxTeam = undefined; console.warn('[UnknownNumber] Tax team lookup failed:', (e as Error).message); return null; });
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
            const ownerTeamId = (await taxTeamId()) ?? undefined;
            const created = await dynamicsService.createLead({
                ...placeholderLeadNames(phone), phone, leadType: TAX_LEAD_TYPE, leadSource: WHATSAPP_LEAD_SOURCE, ownerTeamId,
            });
            if (!created?.new_leadid) throw new Error('the CRM did not make the lead');
            return String(created.new_leadid);
        },

        async createAction(phone, leadId, at, sourceMessageId) {
            const teamId = await taxTeamId();
            const row = await dynamicsService.webApi<{ riivo_agentactionid: string }>('POST', 'riivo_agentactions?$select=riivo_agentactionid', {
                riivo_name: createdActionName(phone),
                riivo_kind: KIND_CREATED,
                // Open: a Created row is for the team to check, so it shows in My Day until a person has.
                riivo_status: STATUS_OPEN,
                riivo_channel: CHANNEL_WHATSAPP,
                riivo_department: DEPARTMENT_TAX,
                riivo_urgency: URGENCY_NORMAL,
                riivo_urgencyreason: 'The agent created a lead to check',
                riivo_actedon: at,
                riivo_recipient: phone,
                riivo_sourcemessageid: sourceMessageId || `whatsapp:${phone}`,
                'riivo_Client_new_lead@odata.bind': `/new_leads(${leadId})`,
                ...(teamId ? { 'ownerid@odata.bind': `/teams(${teamId})` } : {}),
            }, { returnRow: true });
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
    return isPlaceholderLead(await supabaseService.getUnknownNumberLeadId(phone), lead);
}
