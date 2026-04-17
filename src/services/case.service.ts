import OpenAI from 'openai';
import dotenv from 'dotenv';
import { dynamicsService } from './dynamics.service';
import { supabaseService, WhatsAppCaseRow, CaseLevel } from './supabase.service';

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
 * The classifier currently uses OpenAI gpt-4o-mini as a lightweight model.
 * Once the Claude migration ships (Phase 1d), swap the internals of
 * `classifyCase` to call claude-haiku-4-5. The public API stays the same.
 */

const FEEDBACK_TIMEOUT_HOURS = 12;

export const CASE_FEEDBACK_BUTTON_YES = 'case_feedback_yes';
export const CASE_FEEDBACK_BUTTON_NO = 'case_feedback_no';

export const L1_TOPICS = [
    'tax_season_dates',
    'case_status',
    'home_office_requirements',
    'document_guidance',
    'basic_tax_structuring',
    'referral_enquiries',
] as const;

type L1Topic = typeof L1_TOPICS[number];

const NOISE_WORDS = new Set([
    'thanks', 'thank', 'thx', 'ty', 'ok', 'okay', 'k', 'kk',
    'noted', 'cool', 'great', 'test', 'hi', 'hello', 'hey',
    'yes', 'no', 'yep', 'nope', 'sure', 'fine',
]);

const EMOJI_ONLY_RE = /^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

class CaseService {
    private openai: OpenAI | null = null;

    private getOpenAI(): OpenAI {
        if (!this.openai) {
            this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        }
        return this.openai;
    }

    /**
     * Decide whether an inbound client message is a genuine query worth
     * tracking as a case. Rule-based — no model call — so it's free.
     */
    qualifyMessage(text: string): boolean {
        const trimmed = (text || '').trim();
        if (trimmed.length < 3) return false;
        if (EMOJI_ONLY_RE.test(trimmed)) return false;

        const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 1 && NOISE_WORDS.has(words[0].replace(/[^a-z]/g, ''))) return false;

        return true;
    }

    /**
     * Create a case in Supabase and mirror it in Dynamics. The Dynamics call
     * is best-effort — if it fails we still keep the Supabase row so metrics
     * are not skewed.
     */
    async createCase(params: {
        sessionId: string;
        contactId: string;
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

        // Mirror to Dynamics. Only do this when contactId is a GUID
        // (clients identified in CRM); skip for non-client types.
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (guidRe.test(params.contactId)) {
            try {
                const description = params.queryText.slice(0, 500);
                const dynRes: any = await dynamicsService.createCase(
                    params.contactId,
                    'Query',
                    `[WhatsApp] ${description}`,
                    'Medium'
                );
                const crmCaseId = dynRes?.new_caseid || null;
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
     * Uses a small JSON-mode call to gpt-4o-mini; swap to Claude Haiku
     * once Phase 1 lands.
     */
    async classifyCase(caseId: string, queryText: string): Promise<{ level: CaseLevel; topic: string | null }> {
        const prompt = `Classify the following client WhatsApp query.

L1 topics the bot can handle without a human:
- tax_season_dates: dates, deadlines, filing windows
- case_status: "what's happening with my tax return / claim / case"
- home_office_requirements: documents / rules for home office tax deduction
- document_guidance: which forms / documents to send in
- basic_tax_structuring: simple tax-planning questions, not advice
- referral_enquiries: how the referral programme works

Anything else — personal advice, complex claims, complaints, payment disputes,
staff requests — is "escalation".

Reply with strict JSON of shape {"level": "L1" | "escalation", "topic": <one of the L1 topics above, or null>}.

Query: """${queryText}"""`;

        try {
            const res = await this.getOpenAI().chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' },
                temperature: 0,
                max_tokens: 80,
            });
            const content = res.choices[0]?.message?.content || '{}';
            const parsed = JSON.parse(content);

            const level: CaseLevel = parsed.level === 'L1' ? 'L1' : 'escalation';
            const topic = (L1_TOPICS as readonly string[]).includes(parsed.topic) ? parsed.topic : null;

            await supabaseService.updateCase(caseId, {
                level,
                level_topic: topic,
                status: 'classified',
            });

            return { level, topic };
        } catch (e: any) {
            console.error(`[CaseService] classifyCase failed for ${caseId}:`, e?.message || e);
            // Default to escalation on classifier failure — safer than falsely marking L1
            await supabaseService.updateCase(caseId, { level: 'escalation', status: 'classified' });
            return { level: 'escalation', topic: null };
        }
    }

    /**
     * Record that the bot has produced a candidate answer for this case.
     * After this, the feedback flow decides whether it resolves or escalates.
     */
    async recordBotResponse(caseId: string, method: string): Promise<void> {
        await supabaseService.updateCase(caseId, {
            status: 'bot_responded',
            resolution_method: method,
        });
    }

    /**
     * Handle the client's follow-up after the feedback prompt.
     * "confirmed" → resolved_by_bot (final, counted toward L1 auto-resolution)
     * "rejected"  → escalated. Dynamics case already exists; humans pick up from there.
     */
    async handleFeedback(caseId: string, feedback: 'confirmed' | 'rejected'): Promise<WhatsAppCaseRow | null> {
        if (feedback === 'confirmed') {
            await supabaseService.updateCase(caseId, {
                status: 'resolved_by_bot',
                feedback_received: 'confirmed',
                resolved_at: new Date().toISOString(),
            });
        } else {
            await supabaseService.updateCase(caseId, {
                status: 'escalated',
                feedback_received: 'rejected',
            });
        }
        return supabaseService.getCase(caseId);
    }

    /**
     * Detect a feedback reply from an incoming message. The Meta interactive
     * button reply arrives as its title (e.g. "Yes, thanks") via extractIncoming,
     * so we match on both button ids (if the text matches one) and a fuzzy
     * yes/no heuristic.
     */
    detectFeedback(text: string): 'confirmed' | 'rejected' | null {
        const t = (text || '').trim().toLowerCase();
        if (!t) return null;

        if (t === CASE_FEEDBACK_BUTTON_YES || t.includes('yes, thanks') || /^(y|yes|yep|resolved|solved|sorted|thanks)\b/.test(t)) {
            return 'confirmed';
        }
        if (t === CASE_FEEDBACK_BUTTON_NO || t.includes('still need help') || /^(n|no|nope|not really|still)\b/.test(t)) {
            return 'rejected';
        }
        return null;
    }

    /**
     * Idempotent timeout sweep. Runs daily via cron + fire-and-forget on
     * every client inbound as a safety net.
     */
    async handleTimeout(): Promise<number> {
        return supabaseService.sweepTimedOutCases(FEEDBACK_TIMEOUT_HOURS);
    }
}

export const caseService = new CaseService();
