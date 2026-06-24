import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
console.log('[boot] case.service: anthropic+dotenv loaded, loading dynamics');
import {
    dynamicsService,
    REQUEST_STATE,
    REQUEST_STATUSCODE,
    RESOLUTION_METHOD,
    CLIENT_FEEDBACK,
    CLASSIFICATION_LEVEL,
    buildDynamicsRecordUrl,
} from './dynamics.service';
import { supabaseService, WhatsAppCaseRow, CaseLevel } from './supabase.service';
import { graphMailService } from './graphMail.service';
import { RateLimitError } from '../utils/anthropicRateLimit';
import { looksLikeOtherBusinessMessage } from '../utils/autoReply';
import {
    qualifyMessage as qualifyMessageImpl,
    detectWrapUp as detectWrapUpImpl,
    detectFeedback as detectFeedbackImpl,
    CASE_FEEDBACK_BUTTON_YES as CASE_FEEDBACK_BUTTON_YES_DOMAIN,
    CASE_FEEDBACK_BUTTON_NO as CASE_FEEDBACK_BUTTON_NO_DOMAIN,
    CASE_FEEDBACK_BUTTON_YES_PREFIX as CASE_FEEDBACK_BUTTON_YES_PREFIX_DOMAIN,
    CASE_FEEDBACK_BUTTON_NO_PREFIX as CASE_FEEDBACK_BUTTON_NO_PREFIX_DOMAIN,
} from '../domain/caseRouting';
import { CASE_FEEDBACK_PROMPT_TEXT as CASE_FEEDBACK_PROMPT_TEXT_DOMAIN } from '../domain/feedbackReply';

dotenv.config();

/**
 * Case lifecycle service.
 *
 * Every qualifying inbound client query produces one row in whatsapp_cases.
 * The row travels through the states:
 *   created → classified → bot_responded → resolved_by_bot
 *                                       ↘ resolved_by_bot_timeout (12h)
 *                                       ↘ escalated (client clicked "No")
 *
 * Q2 metrics (adoption + L1 auto-resolution) are computed off this table.
 *
 * The classifier runs on Claude with a single forced tool — this is the
 * Anthropic-native pattern for reliable JSON output (no `response_format`
 * equivalent; forcing a specific tool guarantees schema-shaped input in the
 * response).
 */

const FEEDBACK_TIMEOUT_HOURS = 12;
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

// Feedback button ids live in the pure domain routing module (detectFeedback
// depends on them); re-exported here so existing importers are unaffected.
export const CASE_FEEDBACK_BUTTON_YES = CASE_FEEDBACK_BUTTON_YES_DOMAIN;
export const CASE_FEEDBACK_BUTTON_NO = CASE_FEEDBACK_BUTTON_NO_DOMAIN;

// Per-case feedback button id prefixes — re-exported so the feedback prompt
// worker can build `${prefix}:${caseId}` ids without reaching into the domain
// module directly.
export const CASE_FEEDBACK_BUTTON_YES_PREFIX = CASE_FEEDBACK_BUTTON_YES_PREFIX_DOMAIN;
export const CASE_FEEDBACK_BUTTON_NO_PREFIX = CASE_FEEDBACK_BUTTON_NO_PREFIX_DOMAIN;

// The resolution-prompt text now lives in the pure feedback-reply domain
// module (decideFeedbackReply gates on it); re-exported here so the feedback
// prompt worker and any other importer compile unchanged.
export const CASE_FEEDBACK_PROMPT_TEXT = CASE_FEEDBACK_PROMPT_TEXT_DOMAIN;

export const L1_TOPICS = [
    // Tool-backed lookups the bot resolves directly
    'invoice_query',
    'case_status',
    'tax_number_lookup',
    'account_details',
    // Tax-season FAQ topics (each backed by a dedicated tool)
    'refund_status',
    'submission_status',
    'required_documents',
    'received_documents',
    'audit_status',
    'tax_form_request',
    // Knowledge-based topics the bot answers from general SA tax knowledge
    'tax_season_dates',
    'home_office_requirements',
    'document_guidance',
    'basic_tax_structuring',
    'referral_enquiries',
    'general_tax_question',
    // Inbound that isn't a real TTT client query — another business's automated
    // / marketing message. Non-escalating; bucketed so it never shows as an
    // escalation in metrics.
    'non_customer',
] as const;

type L1Topic = typeof L1_TOPICS[number];

const CLASSIFIER_SYSTEM_PROMPT = `Classify the following client WhatsApp query.

Default heavily to "L1" (bot can handle). The bot's job is to engage and try
to help — even with complaints, payment disputes, requests to change account
details, or sensitive scenarios. The bot stays inside its tool set; it doesn't
need to "solve" everything to classify as L1, it just needs to be the right
first responder.

ONLY classify as "escalation" when the client's message is itself a direct,
explicit request to speak to a human, a consultant, or a person — e.g.
"can a consultant call me", "I want to speak to someone", "please get a human
on this", "transfer me to your team". Frustration, complaints, "this is wrong",
or "I'm not happy" alone are NOT escalation — the bot tries to help first.

A short request that just names a tax form ("vehicle detail sheet", "logbook",
"commission expense sheet") is the client asking the bot to send that form —
classify as tax_form_request, not escalation.

If the message is clearly an AUTOMATED REPLY or MARKETING / SALES intro from
ANOTHER business — e.g. "Thank you for contacting [dealership]", "Welcome to
[shop]", a real-estate agent's welcome blast, a car-finance requirements list
("3 months bank statements, payslips, ID, driver's licence") — it is NOT a TTT
client query. Classify it as L1 with topic "non_customer". NEVER classify these
as escalation.

L1 topics — tool-backed lookups the bot answers directly from CRM data:
- invoice_query: outstanding balance, invoice list, invoice details, "do I have any invoices"
- case_status: "what's happening with my tax return / claim / case"
- tax_number_lookup: the client asking for their own tax number
- account_details: profile info, email, phone on file
- refund_status: "what's my refund?", "how much will I get back?", refund amount or refund-issued questions
- submission_status: "have you submitted me?", "did you file my return?"
- required_documents: "what docs do you need?", "what's outstanding?", what to send
- received_documents: "have you received my docs?", "what have you got from me?"
- audit_status: "am I on audit?", verification, SARS reviewing the case
- tax_form_request: "send me the vehicle detail sheet", "can I have the logbook", any ask for a fillable tax form / template

L1 topics — general knowledge the bot answers without CRM lookups:
- tax_season_dates: dates, deadlines, filing windows
- home_office_requirements: documents / rules for home office tax deduction
- document_guidance: which forms / documents to send in
- basic_tax_structuring: simple tax-planning questions, not personal advice
- referral_enquiries: how the referral programme works
- general_tax_question: any other South African tax question answerable from general knowledge`;

const CLASSIFIER_TOOL: Anthropic.Tool = {
    name: 'record_classification',
    description: 'Record the classification of the client query. Always call this once per query.',
    input_schema: {
        type: 'object',
        properties: {
            level: {
                type: 'string',
                enum: ['L1', 'escalation'],
                description: "'L1' if the bot can handle this; 'escalation' if it needs a human.",
            },
            topic: {
                type: 'string',
                enum: [...(L1_TOPICS as readonly string[]), 'none'],
                description: "For L1 queries, one of the L1 topics. Use 'none' for escalation.",
            },
        },
        required: ['level', 'topic'],
    },
};

class CaseService {
    private anthropic: Anthropic | null = null;

    private getAnthropic(): Anthropic {
        if (!this.anthropic) {
            this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '', maxRetries: 0 });
        }
        return this.anthropic;
    }

    /**
     * Decide whether an inbound client message is a genuine query worth
     * tracking as a case. Rule-based — no model call — so it's free.
     */
    qualifyMessage(text: string): boolean {
        return qualifyMessageImpl(text);
    }

    /**
     * Create a case in Supabase and mirror it in Dynamics. The Dynamics call
     * is best-effort — if it fails we still keep the Supabase row so metrics
     * are not skewed.
     */
    async createCase(params: {
        sessionId: string;
        contactId: string;
        contactType: 'client' | 'lead';
        phoneNumber: string;
        queryText: string;
    }): Promise<WhatsAppCaseRow | null> {
        const row = await supabaseService.insertCase({
            sessionId: params.sessionId,
            contactId: params.contactId,
            phoneNumber: params.phoneNumber,
            queryText: params.queryText,
        });
        if (!row) return null;

        // Mirror to Dynamics as a riivo_request record. Only when contactId is
        // a GUID — applies to both clients (contacts table) and leads (new_leads table).
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (guidRe.test(params.contactId)) {
            try {
                const dynRes = await dynamicsService.createRequest({
                    contactId: params.contactType === 'client' ? params.contactId : undefined,
                    leadId: params.contactType === 'lead' ? params.contactId : undefined,
                    contactType: params.contactType,
                    phoneNumber: params.phoneNumber,
                    description: params.queryText.slice(0, 500),
                });
                const crmCaseId = dynRes?.riivo_requestid || null;
                if (crmCaseId) {
                    await supabaseService.updateCase(row.id, { crm_case_id: crmCaseId });
                    row.crm_case_id = crmCaseId;
                }
            } catch (e: any) {
                console.warn(`[CaseService] Dynamics mirror failed for case ${row.id}:`, e?.message || e);
            }
        }

        return row;
    }

    /**
     * Classify a case as L1 (bot can attempt resolution) or escalation.
     *
     * Uses Claude with a single forced tool — Anthropic's recommended pattern
     * for reliable JSON output. The tool is never actually "executed"; the tool
     * call's `input` field is the structured response we want.
     */
    /**
     * Record a case as a non-customer message: L1 level (never escalation) with
     * the non_customer topic. Mirrors the same Supabase + Dynamics writes the
     * classifier uses for an L1 outcome.
     */
    private async recordNonCustomer(caseId: string): Promise<{ level: CaseLevel; topic: string | null }> {
        await supabaseService.updateCase(caseId, {
            level: 'L1',
            level_topic: 'non_customer',
            status: 'classified',
        });
        try {
            const crmId = await this.resolveCrmId(caseId);
            if (crmId) {
                await dynamicsService.updateRequest(crmId, {
                    statuscode: REQUEST_STATUSCODE.CLASSIFIED,
                    riivo_classificationlevel: CLASSIFICATION_LEVEL.L1,
                    riivo_classificationtopic: 'non_customer',
                });
            }
        } catch (e: any) {
            console.warn(`[CaseService] recordNonCustomer mirror failed for ${caseId}: ${e?.message || e}`);
        }
        return { level: 'L1', topic: 'non_customer' };
    }

    async classifyCase(caseId: string, queryText: string): Promise<{ level: CaseLevel; topic: string | null }> {
        // Deterministic guard: another business's automated / marketing message
        // is never an escalation. Force it into the non_customer bucket and skip
        // the model call entirely. Backstop for ones the classifier might miss.
        if (looksLikeOtherBusinessMessage(queryText)) {
            const out = await this.recordNonCustomer(caseId);
            return out;
        }
        try {
            const res = await this.getAnthropic().messages.create({
                model: CLASSIFIER_MODEL,
                max_tokens: 200,
                system: CLASSIFIER_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: `Query: """${queryText}"""` }],
                tools: [CLASSIFIER_TOOL],
                tool_choice: { type: 'tool', name: 'record_classification' },
            });
            const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
            const parsed: any = toolUse?.input ?? {};

            const level: CaseLevel = parsed.level === 'L1' ? 'L1' : 'escalation';
            const topic = (L1_TOPICS as readonly string[]).includes(parsed.topic) ? parsed.topic : null;

            await supabaseService.updateCase(caseId, {
                level,
                level_topic: topic,
                status: 'classified',
            });

            const crmId = await this.resolveCrmId(caseId);
            if (crmId) {
                await dynamicsService.updateRequest(crmId, {
                    statuscode: REQUEST_STATUSCODE.CLASSIFIED,
                    riivo_classificationlevel: level === 'L1' ? CLASSIFICATION_LEVEL.L1 : CLASSIFICATION_LEVEL.ESCALATION,
                    riivo_classificationtopic: topic,
                });
            }

            return { level, topic };
        } catch (e: any) {
            // A 429 must propagate so the worker can re-enqueue with delay.
            // Other classifier errors fall through to the escalation fallback.
            const status = e?.status ?? e?.response?.status;
            if (status === 429) {
                const retryAfterHeader = e?.headers?.['retry-after'] ?? e?.response?.headers?.['retry-after'];
                const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 60;
                const retryAfterMs = Math.max(1, Math.floor((Number.isFinite(retryAfterSec) ? retryAfterSec : 60) * 1000));
                throw new RateLimitError(retryAfterMs, 1, e);
            }
            console.error(`[CaseService] classifyCase failed for ${caseId}:`, e?.message || e);
            // Default to escalation on classifier failure — safer than falsely marking L1
            await supabaseService.updateCase(caseId, { level: 'escalation', status: 'classified' });
            const crmId = await this.resolveCrmId(caseId);
            if (crmId) {
                await dynamicsService.updateRequest(crmId, {
                    statuscode: REQUEST_STATUSCODE.CLASSIFIED,
                    riivo_classificationlevel: CLASSIFICATION_LEVEL.ESCALATION,
                });
            }
            return { level: 'escalation', topic: null };
        }
    }

    /**
     * Record that the bot has produced a candidate answer for this case.
     * After this, the feedback flow decides whether it resolves or escalates.
     */
    async recordBotResponse(caseId: string, method: string, answerText?: string, crmRequestId?: string | null): Promise<void> {
        await supabaseService.updateCase(caseId, {
            status: 'bot_responded',
            resolution_method: method,
        });
        const crmId = crmRequestId ?? await this.resolveCrmId(caseId);
        if (crmId) {
            const patch: Record<string, any> = {
                statuscode: REQUEST_STATUSCODE.BOT_ANSWERED,
                riivo_resolutionmethod: RESOLUTION_METHOD.AUTO_DIRECT_ANSWER,
            };
            if (answerText) patch.riivo_botanswers = answerText;
            await dynamicsService.updateRequest(crmId, patch);
        }
    }

    /**
     * Close a single case as resolved_by_bot without involving the feedback
     * prompt. Used by the topic-shift path in the processor: when the client's
     * next inbound clearly opens a new question, we treat the previous
     * bot-answered case as implicitly satisfied (they moved on rather than
     * pushing back). `reason` lands in resolution_method so reporting can tell
     * implicit resolutions from explicit "Yes, thanks" taps.
     */
    async markResolvedByBot(caseId: string, reason: string, crmRequestId?: string | null): Promise<void> {
        const resolvedAt = new Date().toISOString();
        await supabaseService.updateCase(caseId, {
            status: 'resolved_by_bot',
            resolution_method: reason,
            resolved_at: resolvedAt,
        });
        const crmId = crmRequestId ?? await this.resolveCrmId(caseId);
        if (crmId) {
            await dynamicsService.updateRequest(crmId, {
                statecode: REQUEST_STATE.INACTIVE,
                statuscode: REQUEST_STATUSCODE.RESOLVED_BY_BOT,
                riivo_clientfeedback: CLIENT_FEEDBACK.NOT_ASKED,
                riivo_resolvedon: resolvedAt,
                riivo_resolutionmethod: RESOLUTION_METHOD.AUTO_DIRECT_ANSWER,
            });
        }

        const closed = await supabaseService.getCase(caseId);
        if (closed?.session_id) this.triggerCloseSummary(closed.session_id);
    }

    /**
     * Mark a case as escalated in both Supabase and Dynamics. Escalation
     * keeps the Dynamics request in statecode=Active (the consultant still
     * needs to work it) with statuscode=Escalated.
     */
    async markEscalated(caseId: string, reason: string, crmRequestId?: string | null): Promise<void> {
        await supabaseService.updateCase(caseId, { status: 'escalated' });
        const escalated = await supabaseService.getCase(caseId);
        if (escalated?.session_id) await supabaseService.flagSessionEscalation(escalated.session_id);
        const crmId = crmRequestId ?? await this.resolveCrmId(caseId);
        if (crmId) {
            await dynamicsService.updateRequest(crmId, {
                statuscode: REQUEST_STATUSCODE.ESCALATED,
                riivo_escalationreason: reason,
                riivo_escalatedon: new Date().toISOString(),
            });
        }
    }

    /**
     * Re-classify a case that's currently escalated, using the full session
     * conversation as context. First-turn classifications can over-flag vague
     * openers like "To do my tax" as escalation; once the client clarifies,
     * the case is often clearly L1. Only flips escalation → L1 (never the
     * other way). On a flip, the Dynamics escalation footprint is cleared
     * via `recoverFromEscalation`.
     */
    async reclassifyCase(
        caseId: string,
        history: { role: 'user' | 'assistant'; content: string }[],
        latestText: string,
        crmRequestId?: string | null,
    ): Promise<{ level: CaseLevel; topic: string | null; recovered: boolean }> {
        // Another business's automated / marketing message is never an
        // escalation — recover it straight into the non_customer bucket.
        if (looksLikeOtherBusinessMessage(latestText)) {
            await this.recoverFromEscalation(caseId, 'non_customer', crmRequestId);
            return { level: 'L1', topic: 'non_customer', recovered: true };
        }

        const transcript = [
            ...history.map(m => `[${m.role === 'user' ? 'Client' : 'Bot'}] ${m.content}`),
            `[Client] ${latestText}`,
        ].join('\n');

        try {
            const res = await this.getAnthropic().messages.create({
                model: CLASSIFIER_MODEL,
                max_tokens: 200,
                system: CLASSIFIER_SYSTEM_PROMPT,
                messages: [{
                    role: 'user',
                    content: `Conversation so far:\n${transcript}\n\nClassify the client's intent across this conversation. The first turn may have been ambiguous — judge from the full exchange.`,
                }],
                tools: [CLASSIFIER_TOOL],
                tool_choice: { type: 'tool', name: 'record_classification' },
            });
            const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
            const parsed: any = toolUse?.input ?? {};

            const level: CaseLevel = parsed.level === 'L1' ? 'L1' : 'escalation';
            const topic = (L1_TOPICS as readonly string[]).includes(parsed.topic) ? parsed.topic : null;

            if (level === 'L1') {
                await this.recoverFromEscalation(caseId, topic, crmRequestId);
                return { level, topic, recovered: true };
            }
            return { level, topic: null, recovered: false };
        } catch (e: any) {
            const status = e?.status ?? e?.response?.status;
            if (status === 429) {
                const retryAfterHeader = e?.headers?.['retry-after'] ?? e?.response?.headers?.['retry-after'];
                const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 60;
                const retryAfterMs = Math.max(1, Math.floor((Number.isFinite(retryAfterSec) ? retryAfterSec : 60) * 1000));
                throw new RateLimitError(retryAfterMs, 1, e);
            }
            console.warn(`[CaseService] reclassifyCase failed for ${caseId}:`, e?.message || e);
            return { level: 'escalation', topic: null, recovered: false };
        }
    }

    /**
     * Move a case from escalation back to L1. Clears Dynamics escalation
     * fields (escalatedon/reason) so reporting sees a clean L1 case rather
     * than "escalated then recovered" — the misclassification isn't preserved.
     */
    async recoverFromEscalation(caseId: string, topic: string | null, crmRequestId?: string | null): Promise<void> {
        await supabaseService.updateCase(caseId, {
            level: 'L1',
            level_topic: topic,
            status: 'classified',
        });
        const crmId = crmRequestId ?? await this.resolveCrmId(caseId);
        if (crmId) {
            await dynamicsService.updateRequest(crmId, {
                statuscode: REQUEST_STATUSCODE.CLASSIFIED,
                riivo_classificationlevel: CLASSIFICATION_LEVEL.L1,
                riivo_classificationtopic: topic,
                riivo_escalatedon: null,
                riivo_escalationreason: null,
            });
        }
        console.log(`[CaseService] case ${caseId} recovered from escalation → L1 topic=${topic ?? 'none'}`);
    }

    /**
     * Handle the client's follow-up after the feedback prompt.
     * "confirmed" → resolve every open sibling case in the same session
     *               (one positive signal closes the whole conversation).
     * "rejected"  → escalate ONLY the case identified by caseId. Dynamics
     *               case already exists; humans pick up from there.
     */
    async handleFeedback(
        caseId: string,
        feedback: 'confirmed' | 'rejected',
        opts?: { clearEscalation?: boolean },
    ): Promise<WhatsAppCaseRow | null> {
        const resolvedAt = new Date().toISOString();
        if (feedback === 'confirmed') {
            const anchor = await supabaseService.getCase(caseId);
            const siblings = anchor
                ? await supabaseService.findOpenCasesForSession(anchor.session_id)
                : [];

            const toClose = new Map<string, WhatsAppCaseRow>();
            // An escalated anchor is normally left alone here, but a confirmed
            // tap with clearEscalation means the client says it's sorted — close
            // it and pull the consultant off too.
            if (anchor && anchor.status !== 'resolved_by_bot'
                && anchor.status !== 'resolved_by_bot_timeout'
                && (anchor.status !== 'escalated' || opts?.clearEscalation)) {
                toClose.set(anchor.id, anchor);
            }
            for (const s of siblings) toClose.set(s.id, s);

            for (const row of toClose.values()) {
                await supabaseService.updateCase(row.id, {
                    status: 'resolved_by_bot',
                    feedback_received: 'confirmed',
                    resolved_at: resolvedAt,
                });
                const crmId = row.crm_case_id;
                if (crmId) {
                    const patch: Record<string, any> = {
                        statecode: REQUEST_STATE.INACTIVE,
                        statuscode: REQUEST_STATUSCODE.RESOLVED_BY_BOT,
                        riivo_clientfeedback: CLIENT_FEEDBACK.CONFIRMED,
                        riivo_resolvedon: resolvedAt,
                        riivo_resolutionmethod: RESOLUTION_METHOD.FEEDBACK_CONFIRMED,
                    };
                    // Clear the escalation footprint for a case the client just
                    // confirmed is resolved, so reporting doesn't leave it
                    // flagged as escalated-then-closed.
                    if (row.status === 'escalated') {
                        patch.riivo_escalatedon = null;
                        patch.riivo_escalationreason = null;
                    }
                    await dynamicsService.updateRequest(crmId, patch);
                }
            }

            // One summary for the whole session — the claim inside dedups the
            // sibling fan-out down to a single consultant email.
            if (anchor?.session_id) this.triggerCloseSummary(anchor.session_id);
        } else {
            await supabaseService.updateCase(caseId, {
                status: 'escalated',
                feedback_received: 'rejected',
            });
            const rejected = await supabaseService.getCase(caseId);
            if (rejected?.session_id) await supabaseService.flagSessionEscalation(rejected.session_id);
            const crmId = await this.resolveCrmId(caseId);
            if (crmId) {
                await dynamicsService.updateRequest(crmId, {
                    statuscode: REQUEST_STATUSCODE.ESCALATED,
                    riivo_clientfeedback: CLIENT_FEEDBACK.REJECTED,
                    riivo_escalationreason: 'Client rejected bot answer',
                    riivo_escalatedon: resolvedAt,
                });
            }
        }
        return supabaseService.getCase(caseId);
    }

    /**
     * Re-engage a case after the client tapped "Still need help" (or typed an
     * equivalent). Pulls the case back to bot-owned so the client's follow-up
     * routes through Claude for another attempt — the opposite of the old
     * behaviour, which escalated to a human on a single tap.
     *
     * - Supabase: status → `bot_responded`, clear `resolved_at`, stamp
     *   `feedback_received = 'rejected'` as a visibility signal (NOT an
     *   escalation — the session is never flagged).
     * - Dynamics: revert the request to the in-progress BOT_ANSWERED statuscode
     *   (the prompt had set AWAITING_FEEDBACK). When `clearEscalation` is set
     *   the case had a consultant on it — clear the escalation footprint and
     *   keep the request Active so nobody is left holding a case Tina re-owns.
     *
     * Returns the refreshed row so the caller has the session id it needs to
     * enqueue a fresh auto-close.
     */
    async reengageCase(
        caseId: string,
        clearEscalation: boolean,
        crmRequestId?: string | null,
    ): Promise<WhatsAppCaseRow | null> {
        await supabaseService.updateCase(caseId, {
            status: 'bot_responded',
            feedback_received: 'rejected',
            resolved_at: null,
        });
        const crmId = crmRequestId ?? await this.resolveCrmId(caseId);
        if (crmId) {
            const patch: Record<string, any> = {
                statecode: REQUEST_STATE.ACTIVE,
                statuscode: REQUEST_STATUSCODE.BOT_ANSWERED,
                riivo_clientfeedback: CLIENT_FEEDBACK.REJECTED,
            };
            if (clearEscalation) {
                patch.riivo_escalatedon = null;
                patch.riivo_escalationreason = null;
            }
            await dynamicsService.updateRequest(crmId, patch);
        }
        console.log(`[CaseService] case ${caseId} re-engaged (clearEscalation=${clearEscalation})`);
        return supabaseService.getCase(caseId);
    }

    /**
     * Upgrade an auto-closed case (`resolved_by_bot_timeout`) to a genuine
     * confirmation when the client belatedly taps "Yes, thanks". No reopen —
     * the case stays closed; we just record that the answer actually worked
     * rather than that the client went silent.
     */
    async confirmFeedbackUpgrade(caseId: string, crmRequestId?: string | null): Promise<void> {
        const resolvedAt = new Date().toISOString();
        await supabaseService.updateCase(caseId, { feedback_received: 'confirmed' });
        const crmId = crmRequestId ?? await this.resolveCrmId(caseId);
        if (crmId) {
            await dynamicsService.updateRequest(crmId, {
                riivo_clientfeedback: CLIENT_FEEDBACK.CONFIRMED,
                riivo_resolvedon: resolvedAt,
                riivo_resolutionmethod: RESOLUTION_METHOD.FEEDBACK_CONFIRMED,
            });
        }
        console.log(`[CaseService] case ${caseId} feedback upgraded to confirmed (no reopen)`);
    }

    /**
     * Resolve any open case for the given lead as `resolved_by_bot`. Used by
     * the post-LoE activation handler so the lead's existing WhatsApp case
     * (if any) gets closed without firing the feedback prompt — the activation
     * itself is the resolution, no buttons needed. Silently no-ops when no
     * case is open.
     */
    async resolveByLeadId(leadId: string, opts?: { skipFeedback?: boolean; reason?: string }): Promise<number> {
        const rows = await supabaseService.findOpenCasesForLead(leadId);
        if (rows.length === 0) return 0;

        const resolvedAt = new Date().toISOString();
        const reason = opts?.reason || 'resolved_by_lead_event';

        for (const row of rows) {
            await supabaseService.updateCase(row.id, {
                status: 'resolved_by_bot',
                resolution_method: reason,
                resolved_at: resolvedAt,
            });
            if (row.crm_case_id) {
                await dynamicsService.updateRequest(row.crm_case_id, {
                    statecode: REQUEST_STATE.INACTIVE,
                    statuscode: REQUEST_STATUSCODE.RESOLVED_BY_BOT,
                    riivo_clientfeedback: CLIENT_FEEDBACK.NO_RESPONSE_TIMEOUT,
                    riivo_resolvedon: resolvedAt,
                    riivo_resolutionmethod: RESOLUTION_METHOD.AUTO_TOOL_CALL,
                });
            }
            // skipFeedback is honored implicitly — we never enqueue a feedback
            // prompt from this path. The flag is in the signature so the caller
            // can be explicit about intent.
        }

        if (rows.length > 0) {
            console.log(`[CaseService] Resolved ${rows.length} open case(s) for lead ${leadId} reason=${reason} skipFeedback=${opts?.skipFeedback === true}`);
        }

        for (const sessionId of new Set(rows.map(r => r.session_id))) {
            this.triggerCloseSummary(sessionId);
        }
        return rows.length;
    }

    /**
     * Resolve the Dynamics riivo_request id for a Supabase case. Small helper
     * used by state-transition methods so they can PATCH Dynamics after the
     * Supabase write.
     */
    private async resolveCrmId(caseId: string): Promise<string | null> {
        const row = await supabaseService.getCase(caseId);
        return row?.crm_case_id || null;
    }

    /**
     * Detect a natural wrap-up signal — a short closing acknowledgement like
     * "thanks", "perfect", "got it". Used for cases that are still open but
     * not in the explicit pending-feedback window (the client kept chatting
     * past the feedback prompt or never received one). Conservative on purpose:
     * skips long messages, anything containing "?", or qualifiers like "but"
     * that suggest the client is actually asking for more.
     */
    detectWrapUp(text: string): boolean {
        return detectWrapUpImpl(text);
    }

    /**
     * Close every open case in the session as if the client had tapped "Yes".
     * Used by the natural wrap-up path. A single positive signal ("thanks")
     * closes the whole conversation, not just the most recent case. Returns
     * the number of cases closed so the caller can decide whether to
     * short-circuit Claude.
     */
    async resolveAllOpenCasesAsConfirmed(sessionId: string): Promise<number> {
        const rows = await supabaseService.findOpenCasesForSession(sessionId);
        if (rows.length === 0) return 0;
        // handleFeedback('confirmed') already fans out across siblings — one
        // call closes them all; calling per-row would be redundant.
        await this.handleFeedback(rows[0].id, 'confirmed');
        console.log(`[CaseService] Wrap-up closed ${rows.length} case(s) for session ${sessionId}`);
        return rows.length;
    }

    /**
     * Detect a feedback reply from an incoming message. The Meta interactive
     * button reply arrives as its title (e.g. "Yes, thanks") via extractIncoming,
     * so we match on both button ids (if the text matches one) and a tight
     * yes/no heuristic.
     *
     * "thanks" is deliberately NOT a confirmed trigger here — clients commonly
     * thank intermediate replies, and equating gratitude with case-resolution
     * caused premature closes (e.g. Francis Kabelo: "Yes" to "want me to list
     * docs?" was read as feedback-confirmed instead of "yes please list"). The
     * caller (whatsappProcessor) additionally gates this on the previous bot
     * turn being the explicit resolution prompt.
     */
    detectFeedback(text: string): 'confirmed' | 'rejected' | null {
        return detectFeedbackImpl(text);
    }

    /**
     * Idempotent timeout sweep. Runs daily via cron + fire-and-forget on
     * every client inbound as a safety net. For each swept case, mirrors
     * the terminal state onto the Dynamics riivo_request (best-effort).
     */
    async handleTimeout(): Promise<number> {
        const swept = await supabaseService.sweepTimedOutCases(FEEDBACK_TIMEOUT_HOURS);
        if (swept.length === 0) return 0;

        const resolvedAt = new Date().toISOString();
        await Promise.all(
            swept
                .filter(r => r.crm_case_id)
                .map(r => dynamicsService.updateRequest(r.crm_case_id!, {
                    statecode: REQUEST_STATE.INACTIVE,
                    statuscode: REQUEST_STATUSCODE.RESOLVED_TIMEOUT,
                    riivo_clientfeedback: CLIENT_FEEDBACK.NO_RESPONSE_TIMEOUT,
                    riivo_resolvedon: resolvedAt,
                    riivo_resolutionmethod: RESOLUTION_METHOD.TIMEOUT_ASSUMED_RESOLVED,
                }))
        );

        // One close-summary per swept session (claimCloseSummary dedups within
        // the session, so siblings swept together still email the consultant once).
        for (const sessionId of new Set(swept.map(r => r.session_id))) {
            this.triggerCloseSummary(sessionId);
        }
        return swept.length;
    }

    // -------------------------------------------------------------------------
    // Consultant close-summary
    // -------------------------------------------------------------------------

    /**
     * Fire-and-forget entry point for the consultant close-summary. Safe to call
     * from any close path — it never throws and never blocks the caller. The
     * actual work (gate check, claim, summarise, email) runs in the background;
     * the worker process is long-lived (a queue consumer, not an HTTP request),
     * so the promise completes well after the close path returns.
     */
    triggerCloseSummary(sessionId: string): void {
        this.sendConsultantCloseSummary(sessionId).catch(e =>
            console.warn(`[CaseService] close-summary failed for session ${sessionId}:`, e?.message || e)
        );
    }

    /**
     * Email the client's owning consultant a short summary of the conversation
     * when a noteworthy session closes. "Noteworthy" = the client uploaded a
     * document or an escalation fired in the session; quiet/ghost closes send
     * nothing. Idempotent per session via claimCloseSummary, so a fan-out close
     * or the timeout sweep can't double-send.
     */
    private async sendConsultantCloseSummary(sessionId: string): Promise<void> {
        const session = await supabaseService.getSession(sessionId);
        if (!session) return;

        // Gate first, claim second — non-noteworthy sessions stay unclaimed so a
        // later upload + close in the same session could still qualify. A
        // bad-debt session is always noteworthy (PRD-bad-debt-collection.md §9).
        if (!session.had_doc_upload && !session.had_escalation && !session.bad_debt) return;
        if (!session.crm_id) return;
        if (!(await supabaseService.claimCloseSummary(sessionId))) return;

        const isClient = session.crm_type === 'client' || session.crm_type === 'contact';

        // Resolve the owning consultant. Fall back to the taxcrew inbox so a
        // client with no owner on file still produces a summary somewhere.
        const TAXCREW_INBOX = 'taxcrew@ttt-tax.co.za';
        let ownerName: string | null = null;
        let ownerEmail: string | null = null;
        try {
            const ownerId = isClient
                ? await dynamicsService.getContactOwnerId(session.crm_id)
                : await dynamicsService.getLeadOwnerId(session.crm_id);
            if (ownerId) {
                const consultant = await dynamicsService.getSystemUserById(ownerId);
                if (consultant?.email) {
                    ownerName = consultant.fullname || null;
                    ownerEmail = consultant.email;
                }
            }
        } catch (e: any) {
            console.warn(`[CaseService] close-summary owner lookup failed: ${e?.message || e}`);
        }

        // Best-effort client name for the subject/body.
        let clientName: string | null = null;
        if (isClient) {
            try {
                const contact = await dynamicsService.getContactDetails(session.crm_id);
                clientName = contact?.fullname || null;
            } catch { /* non-fatal */ }
        }
        const clientLabel = clientName || session.phone_number || 'the client';

        const history = await supabaseService.getHistory(sessionId);
        if (history.length === 0) return;

        const summary = await this.summariseConversation(history, clientLabel, session.had_doc_upload);

        // Link the conversation's riivo_request when we have one (PRD §9),
        // falling back to the contact/lead record otherwise.
        const requestId = await supabaseService.getLatestCrmRequestForSession(sessionId);
        const recordLink = (requestId && buildDynamicsRecordUrl('riivo_request', requestId))
            || buildDynamicsRecordUrl(isClient ? 'contact' : 'new_lead', session.crm_id);

        // Bad-debt sessions get a prepended ⚠️ warning line with the headline
        // numbers so the consultant sees the arrears at a glance (PRD §9).
        const bd = session.bad_debt ? session.bad_debt_detail : null;
        const badDebtLine = bd
            ? `⚠️ BAD DEBT — R${(bd.totalOutstanding || 0).toFixed(2)} outstanding across ${bd.openInvoiceCount} invoice(s); oldest ${bd.oldestAgeDays} days old.`
            : null;

        const greeting = ownerName ? `${ownerName.split(/\s+/)[0]},` : 'Team,';
        const bodyLines = [
            ...(badDebtLine ? [badDebtLine, ''] : []),
            greeting,
            '',
            `Tina wrapped up a WhatsApp conversation with ${clientLabel}. Quick summary:`,
            '',
            summary,
            '',
        ];
        if (session.had_doc_upload) {
            bodyLines.push('Documents were uploaded during this conversation — they\'re on the client\'s record.', '');
        }
        if (recordLink) {
            bodyLines.push('View client record:', recordLink, '');
        }
        bodyLines.push('— Tina');

        const subject = `Tina conversation summary — ${clientLabel}`;
        try {
            const sent = await graphMailService.sendMail({
                to: ownerEmail || TAXCREW_INBOX,
                subject,
                bodyText: bodyLines.join('\n'),
            });
            console.log(`[CaseService] close-summary ${sent ? 'sent' : 'send failed'} for session ${sessionId} → ${ownerEmail || TAXCREW_INBOX} (docs=${session.had_doc_upload} esc=${session.had_escalation})`);
        } catch (e: any) {
            console.error(`[CaseService] close-summary sendMail threw for session ${sessionId}: ${e?.message || e}`);
        }
    }

    /**
     * Summarise a conversation for the consultant in a few tight lines. Uses the
     * same lightweight Haiku model as the classifier. Returns a plain-text
     * summary; on any failure returns a short fallback so the email still sends.
     */
    private async summariseConversation(
        history: { role: 'user' | 'assistant'; content: string }[],
        clientLabel: string,
        hadDocUpload: boolean,
    ): Promise<string> {
        const transcript = history
            .map(m => `[${m.role === 'user' ? 'Client' : 'Tina'}] ${m.content}`)
            .join('\n')
            .slice(0, 12000);

        const system = `You are summarising a closed WhatsApp conversation between a tax client and Tina (an AI assistant at TTT Financial Group) for the client's consultant.

Write a tight summary (2-4 short bullet points or sentences, no preamble) covering:
- what the client wanted / asked about
- what Tina did or resolved
- anything the consultant should follow up on (open questions, documents received, promises made)

Be factual and specific. Do not invent details. No greeting, no sign-off — just the summary.`;

        try {
            const res = await this.getAnthropic().messages.create({
                model: CLASSIFIER_MODEL,
                max_tokens: 400,
                system,
                messages: [{ role: 'user', content: `Conversation with ${clientLabel}:\n\n${transcript}` }],
            });
            const text = res.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map(b => b.text)
                .join('\n')
                .trim();
            if (text) return text;
        } catch (e: any) {
            console.warn(`[CaseService] summariseConversation failed: ${e?.message || e}`);
        }
        return hadDocUpload
            ? `${clientLabel} sent documents via WhatsApp. See the client record for details.`
            : `Conversation with ${clientLabel} closed. See the client record for details.`;
    }
}

export const caseService = new CaseService();

// The routing predicates now live in the pure domain module; re-exported here
// so module-level importers of case.service keep working unchanged.
export {
    qualifyMessage,
    detectWrapUp,
    detectFeedback,
} from '../domain/caseRouting';
