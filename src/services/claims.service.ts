/**
 * TTTFG-5168: the real dependencies for src/domain/claimsHost.ts. Dynamics for the claim rows, Meta for the replies,
 * Supabase for the walkthrough between messages, and Claude (forced tool calls, as in caseService.classifyCase) to read
 * each message.
 *
 * Off unless CLAIMS_ENABLED=true. This repo deploys to production on every push to main, and claims are not meant to
 * be live in PROD yet (21 Oct 2026). The switch is a deployment switch, not an agent setting: once on, opening a claim
 * is always live (decision D7).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ClaimPorts, Outbound } from '../departments/insurance/claim';
import { dataverseClaimPorts } from '../departments/insurance/dataverse';
import type { IntentModel } from '../departments/insurance/intent';
import type { UnderstandModel } from '../departments/insurance/understand';
import type { WalkthroughState } from '../departments/insurance/walkthrough';
import { claimFromClient, claimFromUnknownNumber, type ClaimsHostDeps, type ClaimsOutcome } from '../domain/claimsHost';
import type { CrmEntity } from '../types/crm.types';
import { RateLimitError } from '../utils/anthropicRateLimit';
import { dynamicsService } from './dynamics.service';
import { metaWhatsAppService } from './meta.service';
import { supabaseService } from './supabase.service';

const INTENT_MODEL = process.env.CLAIMS_INTENT_MODEL || 'claude-haiku-4-5-20251001';
const UNDERSTAND_MODEL = process.env.CLAIMS_UNDERSTAND_MODEL || 'claude-sonnet-4-6';
/** SPEC-05: the Insurance and Advice online sign-up link, in the unknown-number reply. */
const SIGN_UP_LINK = process.env.CLAIMS_SIGNUP_LINK || 'https://www.ttt-tax.co.za/client-onboarding';
const REQUEST_CATEGORY_INSURANCE = 1; // riivo_request.riivo_category: 0 Tax, 1 Insurance, 2 Accounting

export const claimsEnabled = () => process.env.CLAIMS_ENABLED === 'true';

let anthropic: Anthropic | undefined;
const client = () => (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '', maxRetries: 0 }));

/**
 * One forced tool call; the tool's input is the answer. A 429 is remembered in `limits` and rethrown after the package
 * returns: the package reads a model error as "unclear", but a rate limit must re-enqueue the message instead.
 */
function toolModel(model: string, name: string, limits: RateLimitError[]) {
    return async (req: { system: string; user: string; schema: object }): Promise<unknown> => {
        try {
            const res = await client().messages.create({
                model,
                max_tokens: 1024,
                system: req.system,
                messages: [{ role: 'user', content: req.user }],
                tools: [{ name, description: 'Record the answer.', input_schema: req.schema as Anthropic.Tool.InputSchema }],
                tool_choice: { type: 'tool', name },
            });
            return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')?.input;
        } catch (e: any) {
            const status = e?.status ?? e?.response?.status;
            if (status === 429) {
                const after = Number(e?.headers?.['retry-after'] ?? 60);
                limits.push(new RateLimitError(Math.max(1000, (Number.isFinite(after) ? after : 60) * 1000), 1, e));
            }
            throw e;
        }
    };
}

function deps(from: string, sessionId: string | null, entity: CrmEntity | null, limits: RateLimitError[]): ClaimsHostDeps {
    return {
        enabled: claimsEnabled(),
        signUpLink: SIGN_UP_LINK,

        async load(phone) {
            const row = await supabaseService.getClaimWalkthrough(phone);
            return row ? { contactId: row.contact_id, requestId: row.request_id, state: row.state as WalkthroughState, lastSent: row.last_sent, updatedAt: row.updated_at } : null;
        },
        save: (phone, w) => supabaseService.saveClaimWalkthrough({ phone_number: phone, contact_id: w.contactId, request_id: w.requestId, state: w.state, last_sent: w.lastSent }),
        remove: (phone) => supabaseService.deleteClaimWalkthrough(phone),

        intentModel: toolModel(INTENT_MODEL, 'record_claim_intent', limits) as IntentModel,
        understandModel: toolModel(UNDERSTAND_MODEL, 'record_answer', limits) as UnderstandModel,

        async openRequest(contactId, phone, text) {
            // Not dynamicsService.createRequest: that gives the request the client's owner, and the insurance roles
            // can't read riivo_request (DEV, 21 Oct 2026), so Dataverse refuses a broker as owner. The request stays
            // with Tina's app user; the claim and its follow-ups carry the broker. AC 1's routing result is on the
            // request: category Insurance, topic Claim.
            try {
                const r = await dynamicsService.webApi<{ riivo_requestid: string }>('POST', 'riivo_requests?$select=riivo_requestid', {
                    riivo_clientmobilenumber: phone, riivo_channel: 1, riivo_category: REQUEST_CATEGORY_INSURANCE, riivo_priority: 1,
                    riivo_description: text.slice(0, 100), riivo_classificationtopic: 'Claim', statecode: 0, statuscode: 1,
                    'riivo_Client@odata.bind': `/contacts(${contactId})`,
                }, { returnRow: true });
                return r.riivo_requestid;
            } catch (e) {
                console.error('[Claims] Could not open the claim request:', (e as Error).message);
                return null;
            }
        },

        async logIncoming(requestId, text) {
            try {
                await dynamicsService.logMessage(entity, text, 'Incoming', from, requestId || null);
            } catch (e) {
                console.warn('[Claims] Incoming log failed:', (e as Error).message);
            }
            if (sessionId) await supabaseService.saveMessage(sessionId, 'user', text);
        },

        ports(requestId, contact): ClaimPorts {
            const ports = dataverseClaimPorts({
                dv: (method, path, body, opts) => dynamicsService.webApi(method, path, body, opts),
                // The acknowledgement is part of Tina's live conversation (D18): sent in the session, not as a Meta template.
                send: async (to: string, m: Outbound) => {
                    const wamid = await metaWhatsAppService.sendMessage(to, m.text);
                    // Null is a failed send or the 60-second duplicate guard (a question asked twice in a row). The
                    // walkthrough state is saved either way; the client's next message gets the question again.
                    if (!wamid) console.warn(`[Claims] WhatsApp send to ${to} returned no message id`);
                    if (entity) {
                        try {
                            await dynamicsService.logMessage(entity, m.text, 'Outgoing', to, requestId || null, wamid);
                        } catch (e) {
                            console.warn('[Claims] Outgoing log failed:', (e as Error).message);
                        }
                    }
                    if (sessionId) await supabaseService.saveMessage(sessionId, 'assistant', m.text);
                },
            });
            // Tina has already resolved the sender (resolveSender): the walkthrough uses that contact, not a second lookup.
            return { ...ports, contactByWhatsApp: async () => contact };
        },
    };
}

async function guarded(limits: RateLimitError[], run: () => Promise<ClaimsOutcome>): Promise<ClaimsOutcome> {
    const out = await run();
    if (limits.length) throw limits[0];
    return out;
}

/** A message from a number that matches no contact. True when the claims flow answered it. */
export async function handleUnknownNumberClaim(from: string, text: string): Promise<boolean> {
    if (!claimsEnabled()) return false;
    const limits: RateLimitError[] = [];
    const out = await guarded(limits, () => claimFromUnknownNumber(deps(from, null, null, limits), from, text));
    if (out.handled) console.log(`[Claims] ${from} unknown number reported a claim: unknown-number reply sent`);
    return out.handled;
}

/** A message from a known client. True when the claims flow answered it, so Tina's normal path must not run. */
export async function handleClientClaimMessage(from: string, text: string, entity: CrmEntity, sessionId: string): Promise<boolean> {
    if (!claimsEnabled() || entity.type !== 'client') return false;
    const limits: RateLimitError[] = [];
    const firstName = await contactFirstName(entity);
    const out = await guarded(limits, () => claimFromClient(deps(from, sessionId, entity, limits), from, { id: entity.id, firstName }, text, new Date()));
    if (out.handled) console.log(`[Claims] ${from} ${out.kind}${out.reference ? ` ${out.reference}` : ''}`);
    return out.handled;
}

async function contactFirstName(entity: CrmEntity): Promise<string> {
    try {
        const c = await dynamicsService.webApi<{ firstname?: string }>('GET', `contacts(${entity.id})?$select=firstname`);
        if (c.firstname?.trim()) return c.firstname.trim();
    } catch {
        // fall through to the full name
    }
    return (entity.fullname || '').trim().split(/\s+/)[0] || 'there';
}
