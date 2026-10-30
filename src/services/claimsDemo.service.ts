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
 *   CLAIMS_FILES_QUIET_MS          TTTFG-4830: how long she waits after a photo for an evidence item before answering
 *                                  about all of them (the front and back, photos of the scene; default 15000)
 *   CLAIMS_REMINDERS               TTTFG-5212: "off" stops the 08:00 reminder of what each demo client still has to
 *                                  send (on by default; the cron is GET /api/cron/claims-reminders)
 *   CLAIMS_REMINDER_TEMPLATE       TTTFG-5212: the approved WhatsApp template for a reminder outside the 24-hour window
 *                                  (body: REMINDER_TEMPLATE.whatsappBody, 3 variables). Unset: those clients are skipped
 *   CLAIMS_REMINDER_TEMPLATE_LANG  its language code (default en)
 *   CLAIMS_BROKER_ALERT_DAYS       TTTFG-5212: after this many days without a message from the client, the claim owner
 *                                  gets a Follow-up that the missing items haven't come (default 5)
 *   CLAIMS_STOP_AFTER_DAYS         TTTFG-5212: after this many, the reminders stop and the owner gets a Follow-up to
 *                                  phone the client (default 10; TTTFG-5289 may move it)
 *   CLAIMS_VOICE_NOTES             TTTFG-4830: "off" stops voice notes being transcribed (Tina asks the client to type).
 *                                  On by default; needs OPENAI_API_KEY. CLAIMS_TRANSCRIBE_MODEL, CLAIMS_TRANSCRIBE_LANGUAGE
 *                                  and CLAIMS_VOICE_MAX_SECONDS: see transcribe.service.ts
 *   CLAIMS_SIGN_TEMPLATE_SIGNED_OFF  TTTFG-5196: "yes" lets the "ready to sign" message go out (draft-1 wording until
 *                                  Insurance and Advice signs it off). Otherwise the claim owner gets a Follow-up and
 *                                  the client no link. Needs the signing page set up (src/signing/env.ts: SIGNING_PUBLIC_URL)
 *   CLAIMS_MESSAGE_MAX_CHARS       TTTFG-4830: what one client message makes Tina say goes out as one WhatsApp message,
 *                                  split only past this many characters (default 700; 0: each part on its own). See
 *                                  src/domain/claimsOutbox.ts, which also sends the taps (reply buttons and lists)
 *   CLAIMS_CONTACT_NUMBER          TTTFG-4830 (28 Oct 2026): a TTT number the client can call about the claim, said on
 *                                  the burst-geyser list ("You can also call TTT on ..."). Unset or blank: not said. No
 *                                  default: which number TTT gives out is TTT's decision. Also read by claims.service.ts
 * Supabase: claim_conversations (migration 20261023120000_claim_conversations.sql); signing_requests (20261027120000).
 * TTTFG-4830: every message in and out also goes where Tina keeps her own: Supabase's message log (sessions and
 * messages) and the demo CRM's timeline (riivo_whatsappcommunications), under the claim, else the request, else the
 * contact; a voice note with its transcript and the recording attached (writeDemoLog).
 */
import {
    batchQuietMs, claimsDemoBatchCheck, filesQuietMs, optionalQuietMs, claimsDemoReminder, claimsDemoTurn, demoContactFor, demoPhones, parseDemoNumbers, reminderDays, type ClaimsDemoDeps,
    type DemoConversation, type DemoVoice, type VoiceHeard,
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
import { claimsContactNumber } from '../domain/claimsHost';
import { interactiveFor, loggedText, messageMaxChars, outbox, tappedText, withChoiceLines, type OutPart } from '../domain/claimsOutbox';
import {
    cachedDv, dataverseCall, demoClaimSigned, demoPorts, newCrmStats, newDemoLog, openDemoRequest, withdrawOpenClaims, writeDemoLog,
    type CrmStats, type DemoChannels, type DemoLog, type DemoSigning, type Graph,
} from './claimsDemoWiring';
import type { SignedCallback } from '../departments/insurance/signing';
import { signingFromEnv } from '../signing/env';
import { createSigningRequest } from '../signing/signing';
import { enqueueClaimsBatchCheck, enqueueClaimsReminder } from '../queue/whatsappQueue';
import { getActivePhoneNumberId } from '../utils/messageContext';
import { metaWhatsAppService } from './meta.service';
import { supabaseService, type ClaimConversationRow } from './supabase.service';
import { transcribeVoiceNote } from './transcribe.service';

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

/**
 * TTTFG-4830: one message as WhatsApp gets it: with its choices as buttons or a list when they fit (interactiveFor),
 * else as numbered lines. A send Meta refuses is tried once more, then (with choices) once as plain text with the lines,
 * then logged with Meta's reason. It never stops the turn halfway: the claim is already written, so the conversation
 * state must be saved with it.
 */
async function deliver(to: string, m: OutPart, log: DemoLog): Promise<void> {
    const at = new Date().toISOString();
    const interactive = m.choices?.length ? interactiveFor(m.text, m.choices) : null;
    const lines = m.choices?.length ? withChoiceLines(m.text, m.choices) : m.text;
    const tries: (() => Promise<string | null>)[] = interactive
        ? [() => metaWhatsAppService.sendInteractive(to, interactive), () => metaWhatsAppService.sendInteractive(to, interactive), () => metaWhatsAppService.sendMessage(to, lines)]
        : [() => metaWhatsAppService.sendMessage(to, lines), () => metaWhatsAppService.sendMessage(to, lines)];
    for (const [i, send] of tries.entries()) {
        try {
            const wamid = await send();
            if (!wamid) console.warn(`[ClaimsDemo] WhatsApp send to ${to} returned no message id`);
            log.outbound.push({ text: interactive && i < 2 ? loggedText(m) : lines, at, wamid });
            return;
        } catch (e: any) {
            console.error(`[ClaimsDemo] WhatsApp send to ${to} refused (attempt ${i + 1}):`, JSON.stringify(e?.response?.data ?? e?.message));
            if (i === 0) await new Promise((r) => setTimeout(r, 2000));
        }
    }
    log.outbound.push({ text: `${lines}\n(WhatsApp didn't deliver this message.)`, at });
}

/**
 * TTTFG-4830: every send goes into `log` as well (what WhatsApp didn't deliver says so), for writeDemoLog. Texts wait in
 * the outbox until flush(), at the end of the job, so one client message gets one message back (claimsOutbox.ts); a
 * document or a template goes after the texts before it.
 */
const channels = (stats: CrmStats, log: DemoLog): DemoChannels & { flush(): Promise<void> } => {
    const box = outbox((to, m) => deliver(to, m, log), messageMaxChars(process.env.CLAIMS_MESSAGE_MAX_CHARS));
    return {
        dv: dataverse(stats),
        graph,
        site: process.env.CLAIMS_DEMO_SHAREPOINT_SITE || DEV_SITE,
        sendText: async (to, text, choices) => box.push(to, { text, ...(choices?.length ? { choices } : {}) }),
        flush: () => box.flush(),
        sendDocument: async (to, bytes, fileName, caption) => {
            await box.flush();
            const at = new Date().toISOString();
            const r = await metaWhatsAppService.sendDocument(to, bytes, fileName, caption);
            if (!r.delivered) console.warn(`[ClaimsDemo] Document ${fileName} to ${to} not delivered: ${r.error ?? (r.dryRun ? 'dry run' : 'unknown')}`);
            log.outbound.push({ text: `${caption}\n📎 ${fileName}${r.delivered ? '' : "\n(WhatsApp didn't deliver this document.)"}`, at });
        },
        ...(process.env.CLAIMS_REMINDER_TEMPLATE ? {
            sendTemplate: async (to: string, params: string[]) => {
                await box.flush();
                const at = new Date().toISOString();
                const r = await metaWhatsAppService.sendTemplate(to, {
                    name: process.env.CLAIMS_REMINDER_TEMPLATE!, languageCode: process.env.CLAIMS_REMINDER_TEMPLATE_LANG || 'en', bodyVariables: params,
                });
                if (!r.delivered) throw new Error(`WhatsApp template ${process.env.CLAIMS_REMINDER_TEMPLATE} to ${to} refused: ${r.error ?? 'unknown'}`);
                log.outbound.push({ text: `WhatsApp template ${process.env.CLAIMS_REMINDER_TEMPLATE}: ${params.join(' | ')}`, at });
            },
        } : {}),
        mediaBytes: async (mediaId) => (await metaWhatsAppService.downloadMedia(mediaId)).buffer,
        note: (text) => console.log(`[ClaimsDemo] ${text}`),
        signing: signing(),
    };
};

/** TTTFG-5196: the signing page, when it's set up. Its callback comes back to /webhook/claim-signed (handleClaimSigned). */
function signing(): DemoSigning | undefined {
    const d = signingFromEnv();
    if (!d) return undefined;
    return {
        create: (input) => createSigningRequest(d, { ...input, callbackUrl: `${d.publicUrl}/webhook/claim-signed` }),
        signedOff: process.env.CLAIMS_SIGN_TEMPLATE_SIGNED_OFF === 'yes',
    };
}

/**
 * TTTFG-5196: the client signed a demo claim's form (routes/claimSigned.route.ts). The callback sends the client
 * nothing, so its message log stays empty and isn't written.
 */
export const handleClaimSigned = (cb: SignedCallback) => demoClaimSigned(channels(newCrmStats(), newDemoLog()), cb);

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

/**
 * TTTFG-4830: a voice note as text: downloaded from Meta and transcribed. Logged with its length and timing, never its
 * words. A failure is logged and read as "can't listen right now", so the client is asked to type or send it again.
 */
async function hear(ch: DemoChannels, phone: string, voice: DemoVoice, hint: string, log: DemoLog): Promise<VoiceHeard> {
    const started = Date.now();
    // The recording and what was heard go on the timeline (writeDemoLog), even when it couldn't be used.
    const kept: NonNullable<NonNullable<DemoLog['inbound']>['voice']> = { seconds: null, mimeType: voice.mimeType };
    if (log.inbound) log.inbound.voice = kept;
    try {
        const bytes = await ch.mediaBytes(voice.id);
        kept.bytes = bytes;
        const r = await transcribeVoiceNote(bytes, voice.mimeType, hint);
        kept.seconds = r.seconds;
        const length = r.seconds === null ? `${Math.round(bytes.length / 1024)} KB` : `${r.seconds}s`;
        if ('problem' in r) {
            console.log(`[ClaimsDemo] ${phone}: voice note (${voice.mimeType}, ${length}) not used: ${r.problem}`);
            kept.problem = r.problem;
            return { problem: r.problem };
        }
        console.log(`[ClaimsDemo] ${phone}: voice note ${length} heard in ${Date.now() - started}ms (${r.model} ${r.ms}ms, ${r.text.length} chars)`);
        kept.transcript = r.text;
        return { text: r.text };
    } catch (e: any) {
        console.error(`[ClaimsDemo] ${phone}: voice note not transcribed after ${Date.now() - started}ms:`, e?.response?.data ?? e?.message);
        kept.problem = 'unavailable';
        return { problem: 'unavailable' };
    }
}

/**
 * TTTFG-4830: the job's messages to Supabase's message log and the demo CRM's timeline, filed under the claim the
 * conversation is on after the job (or was on before it), else its request. Never throws.
 */
async function writeLog(ch: DemoChannels, log: DemoLog, phone: string, contactId: string, before: ClaimConversationRow | null): Promise<void> {
    try {
        const after = await supabaseService.getClaimConversation(phone).catch(() => null);
        const claimOf = (row: ClaimConversationRow | null) => (row?.resume as ResumeState | null)?.followOn?.claimId || undefined;
        await writeDemoLog({
            dv: ch.dv,
            saveMessages: async (to, contact, messages) => {
                const session = await supabaseService.getOrCreateSession(to, contact, 'client');
                for (const m of messages) await supabaseService.saveMessage(session.id, m.role, m.content);
            },
        }, log, { phone, contactId, claimId: claimOf(after) ?? claimOf(before), requestId: after?.request_id || before?.request_id || undefined });
    } catch (e) {
        console.error(`[ClaimsDemo] ${phone}: conversation log not written:`, (e as Error).message);
    }
}

function deps(phone: string, contactId: string, ch: DemoChannels, log: DemoLog): ClaimsDemoDeps {
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
        contactNumber: claimsContactNumber(process.env.CLAIMS_CONTACT_NUMBER),
        lastReminderOn: (claimId) => lastReminderPort(ch.dv).lastReminderOn(claimId),
        lastBrokerStepOn: (claimId, step) => lastReminderPort(ch.dv).lastBrokerStepOn(claimId, step),
        ...((process.env.CLAIMS_VOICE_NOTES || '').trim().toLowerCase() === 'off'
            ? {}
            : { transcribe: (voice: DemoVoice, hint: string) => hear(ch, phone, voice, hint, log) }),
        ...(batchQuietMs(process.env.CLAIMS_BATCH_QUIET_MS) > 0
            ? { scheduleBatchCheck: (to: string, token: string, what: 'answers' | 'files' | 'optional') => enqueueClaimsBatchCheck(to, token,
                what === 'files' ? filesQuietMs(process.env.CLAIMS_FILES_QUIET_MS)
                : what === 'optional' ? optionalQuietMs(process.env.CLAIMS_OPTIONAL_QUIET_MS)
                : batchQuietMs(process.env.CLAIMS_BATCH_QUIET_MS), getActivePhoneNumberId() || null) }
            : {}),
    };
}
export interface DemoInbound {
    from: string;
    text: string;
    document?: { id: string; filename: string; mimeType: string };
    /** TTTFG-4830: a voice note or audio file. */
    audio?: { id: string; mimeType: string };
    /** TTTFG-4830: the id of a reply button or list row the client tapped; a claims choice's id says what the tap means. */
    interactiveId?: string;
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
    const log = newDemoLog();
    const ch = channels(stats, log);
    try {
        const outcome = await claimsDemoBatchCheck(deps(phone, contactId, ch, log), phone, token, new Date());
        console.log(`[ClaimsDemo] ${phone}: batch check ${outcome}; CRM ${stats.reads} reads (${stats.cached} from cache), ${stats.writes} writes`);
    } catch (e) {
        console.error(`[ClaimsDemo] ${phone} batch check failed:`, (e as Error).message, (e as Error).stack);
    }
    await ch.flush();
    await writeLog(ch, log, phone, contactId, null);
}

/**
 * TTTFG-5212 (first cut): the 08:00 cron queues one reminder per demo number on its own session (the worker runs
 * handleClaimsDemoReminder). Returns how many were queued; none when CLAIMS_REMINDERS is "off".
 * `testPhone`: a test by hand: only that demo number (any SA format), now, even if the client wrote in the last 12 hours.
 */
export async function enqueueClaimsDemoReminders(now: Date = new Date(), testPhone?: string): Promise<number> {
    if ((process.env.CLAIMS_REMINDERS || '').trim().toLowerCase() === 'off') return 0;
    const day = new Date(now.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
    const local = testPhone?.replace(/\D/g, '').slice(-9);
    const phones = demoPhones(process.env.CLAIMS_DEMO_NUMBERS).filter((p) => !testPhone || p.phone.endsWith(local ?? '-'));
    for (const { phone } of phones) await enqueueClaimsReminder(phone, day, !!testPhone);
    return phones.length;
}

/** TTTFG-5212: one demo number's morning reminder (whatsappProcessor routes it here). Never throws. */
export async function handleClaimsDemoReminder(phone: string, o: { test?: boolean } = {}): Promise<void> {
    const contactId = claimsDemoContact(phone);
    if (!contactId) return;
    const stats = newCrmStats();
    const log = newDemoLog();
    const ch = channels(stats, log);
    try {
        // A test by hand goes out even if the client wrote in the last 12 hours (still once per claim per day).
        const r = await claimsDemoReminder(deps(phone, contactId, ch, log), phone, contactId, new Date(), {
            template: !!process.env.CLAIMS_REMINDER_TEMPLATE, ...(o.test ? { quietHours: 0 } : {}),
            ...reminderDays(process.env.CLAIMS_BROKER_ALERT_DAYS, process.env.CLAIMS_STOP_AFTER_DAYS),
        });
        const said = r === 'walkthrough' ? 'reporting a claim, no reminder' : r.map((o) => `${o.reference} ${'sent' in o ? `sent (${o.sent})` : o.skipped}`
            + (o.broker ? `, owner's ${o.broker} Follow-up` : '')).join(', ') || 'no open claims';
        console.log(`[ClaimsDemo] ${phone}: ${o.test ? 'test' : 'morning'} reminder: ${said}; CRM ${stats.reads} reads, ${stats.writes} writes`);
    } catch (e) {
        console.error(`[ClaimsDemo] ${phone} morning reminder failed:`, (e as Error).message, (e as Error).stack);
    }
    await ch.flush();
    await writeLog(ch, log, phone, contactId, null);
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
    const log = newDemoLog();
    log.inbound = { text: file ? `${m.text ? `${m.text}\n` : ''}📎 ${file.fileName}` : m.text, wamid: m.wamid, at: new Date().toISOString() };
    const ch = channels(stats, log);
    const before = await supabaseService.getClaimConversation(m.from).catch(() => null);
    try {
        // A tap on a claims choice is read as what it says ("1. Discovery Insure Motor policy (DI-1)"), not its short title.
        const text = tappedText(m.interactiveId) ?? m.text;
        const outcome = await claimsDemoTurn(deps(m.from, contactId, ch, log), {
            phone: m.from, contactId, text, file, ...(m.audio ? { voice: m.audio } : {}), wamid: m.wamid || `wamid.local.${Date.now()}`,
        }, new Date());
        console.log(`[ClaimsDemo] ${m.from}: ${outcome} in ${Date.now() - started}ms; CRM ${stats.reads} reads (${stats.cached} from cache), ${stats.writes} writes${stats.throttled ? `, ${stats.throttled} throttled` : ''}`);
    } catch (e) {
        console.error(`[ClaimsDemo] ${m.from} failed after ${Date.now() - started}ms:`, (e as Error).message, (e as Error).stack);
        await ch.sendText(m.from, 'Sorry, something went wrong on my side. Please send that again in a minute.');
    }
    await ch.flush();
    await writeLog(ch, log, m.from, contactId, before);
}
