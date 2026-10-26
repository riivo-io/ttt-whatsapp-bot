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
 *   CLAIMS_BATCH_QUIET_MS          TTTFG-4830: how long Tina waits, after a reply that answers part of her numbered
 *                                  questions, before she lists what's still open (default 45000; 0: lists it at once)
 *   CLAIMS_REMINDERS               TTTFG-5212: "off" stops the 08:00 reminder of what each demo client still has to
 *                                  send (on by default; the cron is GET /api/cron/claims-reminders)
 *   CLAIMS_REMINDER_TEMPLATE       TTTFG-5212: the approved WhatsApp template for a reminder outside the 24-hour window
 *                                  (body: REMINDER_TEMPLATE.whatsappBody, 3 variables). Unset: those clients are skipped
 *   CLAIMS_REMINDER_TEMPLATE_LANG  its language code (default en)
 * Supabase: claim_conversations (migration 20261023120000_claim_conversations.sql).
 */
import {
    batchQuietMs, claimsDemoBatchCheck, claimsDemoReminder, claimsDemoTurn, demoContactFor, demoPhones, parseDemoNumbers, type ClaimsDemoDeps,
    type DemoConversation,
} from '../domain/claimsDemoHost';
import type { Dv } from '../departments/insurance/dataverse';
import type { ClientFile, ResumeFile } from '../departments/insurance/followon';
import type { IntentModel } from '../departments/insurance/intent';
import type { ReplyModel, ReportedModel } from '../departments/insurance/reply';
import { NO_RESUME_STATE, type ResumeState } from '../departments/insurance/resume';
import { lastReminderPort } from '../departments/insurance/resume-dataverse';
import type { UnderstandModel } from '../departments/insurance/understand';
import type { WalkthroughState } from '../departments/insurance/walkthrough';
import Anthropic from '@anthropic-ai/sdk';
import {
    cachedDv, dataverseCall, demoPorts, newCrmStats, openDemoRequest, withdrawOpenClaims, type CrmStats, type DemoChannels, type Graph,
} from './claimsDemoWiring';
import { enqueueClaimsBatchCheck, enqueueClaimsReminder } from '../queue/whatsappQueue';
import { getActivePhoneNumberId } from '../utils/messageContext';
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
        signal: AbortSignal.timeout(DEADLINE_MS),
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }),
    });
    if (!res.ok) throw new Error(`[ClaimsDemo] token for ${scope}: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    tokens.set(key, { value: j.access_token, until: Date.now() + j.expires_in * 1000 });
    return j.access_token;
}

function dataverse(stats: CrmStats): Dv {
    const url = (process.env.CLAIMS_DEMO_DATAVERSE_URL || DEV_URL).replace(/\/$/, '');
    const tenant = process.env.CLAIMS_DEMO_DATAVERSE_TENANT_ID || process.env.DYNAMICS_TENANT_ID || '';
    const id = process.env.CLAIMS_DEMO_DATAVERSE_CLIENT_ID || process.env.DYNAMICS_CLIENT_ID || '';
    const secret = process.env.CLAIMS_DEMO_DATAVERSE_CLIENT_SECRET || process.env.DYNAMICS_CLIENT_SECRET || '';
    // Each row read once per message (cachedDv); a 429 waited out (dataverseCall).
    return cachedDv(dataverseCall(url, () => appToken(tenant, id, secret, `${url}/.default`), { deadlineMs: DEADLINE_MS, stats }), stats);
}

const graph: Graph = async (method, path, body, contentType) => {
    const token = await appToken(process.env.GRAPH_TENANT_ID || '', process.env.GRAPH_CLIENT_ID || '', process.env.GRAPH_CLIENT_SECRET || '', 'https://graph.microsoft.com/.default');
    return fetch(path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`, {
        method, body, signal: AbortSignal.timeout(DEADLINE_MS), headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    });
};

const channels = (stats: CrmStats): DemoChannels => ({
    dv: dataverse(stats),
    graph,
    site: process.env.CLAIMS_DEMO_SHAREPOINT_SITE || DEV_SITE,
    // A send Meta refuses is tried once more, then logged with Meta's reason. It never stops the turn halfway: the claim
    // is already written, so the conversation state must be saved with it.
    sendText: async (to, text) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const wamid = await metaWhatsAppService.sendMessage(to, text);
                if (!wamid) console.warn(`[ClaimsDemo] WhatsApp send to ${to} returned no message id`);
                return;
            } catch (e: any) {
                console.error(`[ClaimsDemo] WhatsApp send to ${to} refused (attempt ${attempt}):`, JSON.stringify(e?.response?.data ?? e?.message));
                if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
            }
        }
    },
    sendDocument: async (to, bytes, fileName, caption) => {
        const r = await metaWhatsAppService.sendDocument(to, bytes, fileName, caption);
        if (!r.delivered) console.warn(`[ClaimsDemo] Document ${fileName} to ${to} not delivered: ${r.error ?? (r.dryRun ? 'dry run' : 'unknown')}`);
    },
    ...(process.env.CLAIMS_REMINDER_TEMPLATE ? {
        sendTemplate: async (to: string, params: string[]) => {
            const r = await metaWhatsAppService.sendTemplate(to, {
                name: process.env.CLAIMS_REMINDER_TEMPLATE!, languageCode: process.env.CLAIMS_REMINDER_TEMPLATE_LANG || 'en', bodyVariables: params,
            });
            if (!r.delivered) throw new Error(`WhatsApp template ${process.env.CLAIMS_REMINDER_TEMPLATE} to ${to} refused: ${r.error ?? 'unknown'}`);
        },
    } : {}),
    mediaBytes: async (mediaId) => (await metaWhatsAppService.downloadMedia(mediaId)).buffer,
    note: (text) => console.log(`[ClaimsDemo] ${text}`),
});

/** Every outside call gets a deadline, so one slow call can't hold the client's queue. */
const DEADLINE_MS = 20_000;

/**
 * The demo's Claude call: one forced tool call. A rate limit or overload is retried here, with the SDK's backoff,
 * rather than sending the message back to the queue: a message handled twice is read against the next question.
 */
let anthropic: Anthropic | undefined;
const claude = () => (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '', maxRetries: 3, timeout: 30_000 }));
function demoModel(model: string, name: string) {
    return async (req: { system: string; user: string; schema: object }): Promise<unknown> => {
        const t = Date.now();
        const res = await claude().messages.create({
            model, max_tokens: 2048, system: req.system, messages: [{ role: 'user', content: req.user }],
            tools: [{ name, description: 'Record the answer.', input_schema: req.schema as Anthropic.Tool.InputSchema }],
            tool_choice: { type: 'tool', name },
        });
        console.log(`[ClaimsDemo] Claude ${name} ${Date.now() - t}ms`);
        return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')?.input;
    };
}

function deps(phone: string, contactId: string, stats: CrmStats): ClaimsDemoDeps {
    const ch = channels(stats);
    return {
        async load(phone) {
            const row = await supabaseService.getClaimConversation(phone);
            return row ? {
                contactId: row.contact_id, requestId: row.request_id, walk: (row.walkthrough as WalkthroughState | null) ?? null,
                said: ((row.walkthrough as { said?: string[] } | null)?.said) ?? [],
                resume: (row.resume as ResumeState) ?? NO_RESUME_STATE, held: (row.held as ResumeFile[]) ?? [], lastSent: row.last_sent, updatedAt: row.updated_at,
            } : null;
        },
        save: (phone, c: DemoConversation) => supabaseService.saveClaimConversation({
            // The client's walkthrough messages ride along in the walkthrough column (no extra column needed).
            phone_number: phone, contact_id: c.contactId, request_id: c.requestId, walkthrough: c.walk ? { ...c.walk, said: c.said ?? [] } : null,
            resume: c.resume, held: c.held, last_sent: c.lastSent,
        }),
        remove: (phone) => supabaseService.deleteClaimConversation(phone),
        ports: (_requestId, sent) => demoPorts(ch, phone, contactId, sent),
        intentModel: demoModel(INTENT_MODEL, 'record_claim_intent') as IntentModel,
        understandModel: demoModel(UNDERSTAND_MODEL, 'record_answer') as UnderstandModel,
        replyModel: demoModel(UNDERSTAND_MODEL, 'record_reply') as ReplyModel,
        reportedModel: demoModel(UNDERSTAND_MODEL, 'record_known_answers') as ReportedModel,
        openRequest: (contactId, phone, text) => openDemoRequest(ch.dv, contactId, phone, text),
        withdrawOpenClaims: (contactId) => withdrawOpenClaims(ch.dv, contactId),
        say: (phone, text) => ch.sendText(phone, text),
        signUpLink: SIGN_UP_LINK,
        lastReminderOn: (claimId) => lastReminderPort(ch.dv).lastReminderOn(claimId),
        ...(batchQuietMs(process.env.CLAIMS_BATCH_QUIET_MS) > 0
            ? { scheduleBatchCheck: (to: string, token: string) =>
                enqueueClaimsBatchCheck(to, token, batchQuietMs(process.env.CLAIMS_BATCH_QUIET_MS), getActivePhoneNumberId() || null) }
            : {}),
    };
}
export interface DemoInbound {
    from: string;
    text: string;
    document?: { id: string; filename: string; mimeType: string };
    wamid?: string;
}

/**
 * TTTFG-4830: the check scheduled after a part-answered batch of claim questions (whatsappProcessor routes it here).
 * Never throws: a check that fails leaves Tina waiting, and the client's next message carries on as usual.
 */
export async function handleClaimsDemoBatchCheck(phone: string, token: string): Promise<void> {
    const contactId = claimsDemoContact(phone);
    if (!contactId || !token) return;
    const stats = newCrmStats();
    try {
        const outcome = await claimsDemoBatchCheck(deps(phone, contactId, stats), phone, token, new Date());
        console.log(`[ClaimsDemo] ${phone}: batch check ${outcome}; CRM ${stats.reads} reads (${stats.cached} from cache), ${stats.writes} writes`);
    } catch (e) {
        console.error(`[ClaimsDemo] ${phone} batch check failed:`, (e as Error).message, (e as Error).stack);
    }
}

/**
 * TTTFG-5212 (first cut): the 08:00 cron queues one reminder per demo number on its own session (the worker runs
 * handleClaimsDemoReminder). Returns how many were queued; none when CLAIMS_REMINDERS is "off".
 */
export async function enqueueClaimsDemoReminders(now: Date = new Date()): Promise<number> {
    if ((process.env.CLAIMS_REMINDERS || '').trim().toLowerCase() === 'off') return 0;
    const day = new Date(now.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
    const phones = demoPhones(process.env.CLAIMS_DEMO_NUMBERS);
    for (const { phone } of phones) await enqueueClaimsReminder(phone, day);
    return phones.length;
}

/** TTTFG-5212: one demo number's morning reminder (whatsappProcessor routes it here). Never throws. */
export async function handleClaimsDemoReminder(phone: string): Promise<void> {
    const contactId = claimsDemoContact(phone);
    if (!contactId) return;
    const stats = newCrmStats();
    try {
        const r = await claimsDemoReminder(deps(phone, contactId, stats), phone, contactId, new Date(), { template: !!process.env.CLAIMS_REMINDER_TEMPLATE });
        const said = r === 'walkthrough' ? 'reporting a claim, no reminder' : r.map((o) => `${o.reference} ${'sent' in o ? `sent (${o.sent})` : o.skipped}`).join(', ') || 'no open claims';
        console.log(`[ClaimsDemo] ${phone}: morning reminder: ${said}; CRM ${stats.reads} reads, ${stats.writes} writes`);
    } catch (e) {
        console.error(`[ClaimsDemo] ${phone} morning reminder failed:`, (e as Error).message, (e as Error).stack);
    }
}

/**
 * One message from a demo number, handled exactly once. Nothing is thrown back to the worker: a redelivered message
 * would be read again against the next question (and could open the same claim twice). An error is logged and
 * answered with an apology.
 */
export async function handleClaimsDemoMessage(m: DemoInbound, contactId: string): Promise<void> {
    const started = Date.now();
    const stats = newCrmStats();
    const file: ClientFile | undefined = m.document
        ? { id: m.document.id, fileName: m.document.filename, mimeType: m.document.mimeType, media: m.document.mimeType.startsWith('image/') ? 'photo' : 'document' }
        : undefined;
    try {
        const outcome = await claimsDemoTurn(deps(m.from, contactId, stats), { phone: m.from, contactId, text: m.text, file, wamid: m.wamid || `wamid.local.${Date.now()}` }, new Date());
        console.log(`[ClaimsDemo] ${m.from}: ${outcome} in ${Date.now() - started}ms; CRM ${stats.reads} reads (${stats.cached} from cache), ${stats.writes} writes${stats.throttled ? `, ${stats.throttled} throttled` : ''}`);
    } catch (e) {
        console.error(`[ClaimsDemo] ${m.from} failed after ${Date.now() - started}ms:`, (e as Error).message, (e as Error).stack);
        await metaWhatsAppService.sendMessage(m.from, 'Sorry, something went wrong on my side. Please send that again in a minute.')
            .catch((err) => console.error(`[ClaimsDemo] ${m.from} apology not sent:`, err?.response?.data ?? err?.message));
    }
}
