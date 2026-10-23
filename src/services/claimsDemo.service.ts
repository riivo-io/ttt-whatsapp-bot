/**
 * TTTFG-4830 (claims demo): Tina's real channels for src/domain/claimsDemoHost.ts.
 *
 * Off unless CLAIMS_DEMO_NUMBERS is set. It lists `number:contactId` pairs; a message from any other number never
 * reaches this file, so Tina's clients are untouched. A demo number gets only the claims flow, against the CRM in
 * CLAIMS_DEMO_DATAVERSE_URL (TTT DEV by default), never Tina's own CRM. Settings:
 *   CLAIMS_DEMO_NUMBERS            27821234567:<contact id in the demo CRM>,...
 *   CLAIMS_DEMO_DATAVERSE_URL      default https://tttdevelopment.crm4.dynamics.com
 *   CLAIMS_DEMO_DATAVERSE_CLIENT_ID / _CLIENT_SECRET / _TENANT_ID
 *                                  an app registration that is an application user in that CRM (default: DYNAMICS_*)
 *   CLAIMS_DEMO_SHAREPOINT_SITE    default tttfinancialgroup.sharepoint.com:/sites/TTTDevelopment (Graph: GRAPH_*)
 * Supabase: claim_conversations (migration 20261023120000_claim_conversations.sql).
 */
import { claimsDemoTurn, demoContactFor, parseDemoNumbers, type ClaimsDemoDeps, type DemoConversation } from '../domain/claimsDemoHost';
import type { Dv } from '../departments/insurance/dataverse';
import type { ClientFile, ResumeFile } from '../departments/insurance/followon';
import type { IntentModel } from '../departments/insurance/intent';
import type { ReplyModel } from '../departments/insurance/reply';
import { NO_RESUME_STATE, type ResumeState } from '../departments/insurance/resume';
import type { UnderstandModel } from '../departments/insurance/understand';
import type { WalkthroughState } from '../departments/insurance/walkthrough';
import { RateLimitError } from '../utils/anthropicRateLimit';
import { toolModel } from './claims.service';
import { demoPorts, openDemoRequest, withdrawOpenClaims, type DemoChannels, type Graph } from './claimsDemoWiring';
import { metaWhatsAppService } from './meta.service';
import { supabaseService } from './supabase.service';

const DEV_URL = 'https://tttdevelopment.crm4.dynamics.com';
const DEV_SITE = 'tttfinancialgroup.sharepoint.com:/sites/TTTDevelopment';
const INTENT_MODEL = process.env.CLAIMS_INTENT_MODEL || 'claude-haiku-4-5-20251001';
const UNDERSTAND_MODEL = process.env.CLAIMS_UNDERSTAND_MODEL || 'claude-sonnet-4-6';
const SIGN_UP_LINK = process.env.CLAIMS_SIGNUP_LINK || 'https://www.ttt-tax.co.za/client-onboarding';

/** The demo contact for this sender, or null: not a demo number (or no demo numbers set). */
export const claimsDemoContact = (from: string): string | null => demoContactFor(parseDemoNumbers(process.env.CLAIMS_DEMO_NUMBERS), from);

// --- client-credential tokens ------------------------------------------------------------------------------------------
const tokens = new Map<string, { value: string; until: number }>();
async function appToken(tenant: string, clientId: string, secret: string, scope: string): Promise<string> {
    const key = `${clientId}|${scope}`;
    const t = tokens.get(key);
    if (t && t.until > Date.now() + 60_000) return t.value;
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }),
    });
    if (!res.ok) throw new Error(`[ClaimsDemo] token for ${scope}: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    tokens.set(key, { value: j.access_token, until: Date.now() + j.expires_in * 1000 });
    return j.access_token;
}

function dataverse(): Dv {
    const url = (process.env.CLAIMS_DEMO_DATAVERSE_URL || DEV_URL).replace(/\/$/, '');
    const tenant = process.env.CLAIMS_DEMO_DATAVERSE_TENANT_ID || process.env.DYNAMICS_TENANT_ID || '';
    const id = process.env.CLAIMS_DEMO_DATAVERSE_CLIENT_ID || process.env.DYNAMICS_CLIENT_ID || '';
    const secret = process.env.CLAIMS_DEMO_DATAVERSE_CLIENT_SECRET || process.env.DYNAMICS_CLIENT_SECRET || '';
    return async <T,>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, opts: { formatted?: boolean; returnRow?: boolean } = {}) => {
        const prefer = [opts.formatted ? 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' : '', opts.returnRow ? 'return=representation' : ''].filter(Boolean).join(', ');
        const res = await fetch(`${url}/api/data/v9.2/${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${await appToken(tenant, id, secret, `${url}/.default`)}`, Accept: 'application/json', 'Content-Type': 'application/json',
                'OData-Version': '4.0', 'OData-MaxVersion': '4.0', ...(method === 'PATCH' ? { 'If-Match': '*' } : {}), ...(prefer ? { Prefer: prefer } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
            const err = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? '';
            throw new Error(`Dataverse ${method} ${path.split('?')[0]} ${res.status} ${err.slice(0, 300)}`);
        }
        return (res.status === 204 ? undefined : await res.json()) as T;
    };
}

const graph: Graph = async (method, path, body, contentType) => {
    const token = await appToken(process.env.GRAPH_TENANT_ID || '', process.env.GRAPH_CLIENT_ID || '', process.env.GRAPH_CLIENT_SECRET || '', 'https://graph.microsoft.com/.default');
    return fetch(path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`, {
        method, body, headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    });
};

const channels = (): DemoChannels => ({
    dv: dataverse(),
    graph,
    site: process.env.CLAIMS_DEMO_SHAREPOINT_SITE || DEV_SITE,
    sendText: async (to, text) => {
        const wamid = await metaWhatsAppService.sendMessage(to, text);
        if (!wamid) console.warn(`[ClaimsDemo] WhatsApp send to ${to} returned no message id`);
    },
    sendDocument: async (to, bytes, fileName, caption) => {
        const r = await metaWhatsAppService.sendDocument(to, bytes, fileName, caption);
        if (!r.delivered) console.warn(`[ClaimsDemo] Document ${fileName} to ${to} not delivered: ${r.error ?? (r.dryRun ? 'dry run' : 'unknown')}`);
    },
    mediaBytes: async (mediaId) => (await metaWhatsAppService.downloadMedia(mediaId)).buffer,
    note: (text) => console.log(`[ClaimsDemo] ${text}`),
});

function deps(limits: RateLimitError[], phone: string, contactId: string): ClaimsDemoDeps {
    const ch = channels();
    return {
        async load(phone) {
            const row = await supabaseService.getClaimConversation(phone);
            return row ? {
                contactId: row.contact_id, requestId: row.request_id, walk: (row.walkthrough as WalkthroughState | null) ?? null,
                resume: (row.resume as ResumeState) ?? NO_RESUME_STATE, held: (row.held as ResumeFile[]) ?? [], lastSent: row.last_sent, updatedAt: row.updated_at,
            } : null;
        },
        save: (phone, c: DemoConversation) => supabaseService.saveClaimConversation({
            phone_number: phone, contact_id: c.contactId, request_id: c.requestId, walkthrough: c.walk, resume: c.resume, held: c.held, last_sent: c.lastSent,
        }),
        remove: (phone) => supabaseService.deleteClaimConversation(phone),
        ports: (_requestId, sent) => demoPorts(ch, phone, contactId, sent),
        intentModel: toolModel(INTENT_MODEL, 'record_claim_intent', limits) as IntentModel,
        understandModel: toolModel(UNDERSTAND_MODEL, 'record_answer', limits) as UnderstandModel,
        replyModel: toolModel(UNDERSTAND_MODEL, 'record_reply', limits) as ReplyModel,
        openRequest: (contactId, phone, text) => openDemoRequest(ch.dv, contactId, phone, text),
        withdrawOpenClaims: (contactId) => withdrawOpenClaims(ch.dv, contactId),
        say: (phone, text) => ch.sendText(phone, text),
        signUpLink: SIGN_UP_LINK,
    };
}
export interface DemoInbound {
    from: string;
    text: string;
    document?: { id: string; filename: string; mimeType: string };
    wamid?: string;
}

/**
 * One message from a demo number. Every error but a rate limit is answered with an apology and logged, not retried:
 * a retry could open the same claim twice. A rate limit (nothing sent yet) goes back to the queue as usual.
 */
export async function handleClaimsDemoMessage(m: DemoInbound, contactId: string): Promise<void> {
    const limits: RateLimitError[] = [];
    const file: ClientFile | undefined = m.document
        ? { id: m.document.id, fileName: m.document.filename, mimeType: m.document.mimeType, media: m.document.mimeType.startsWith('image/') ? 'photo' : 'document' }
        : undefined;
    try {
        const outcome = await claimsDemoTurn(deps(limits, m.from, contactId), { phone: m.from, contactId, text: m.text, file, wamid: m.wamid || `wamid.local.${Date.now()}` }, new Date());
        console.log(`[ClaimsDemo] ${m.from}: ${outcome}`);
    } catch (e) {
        if (e instanceof RateLimitError) throw e;
        console.error(`[ClaimsDemo] ${m.from} failed:`, (e as Error).message, (e as Error).stack);
        await metaWhatsAppService.sendMessage(m.from, 'Sorry, something went wrong on my side. Please send that again in a minute.');
        return;
    }
    if (limits.length) throw limits[0];
}
