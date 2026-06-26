import { graphMailService, GraphMessage } from '../services/graphMail.service';
import { parseForwarded, ParsedForwardedEmail, extractForwarderReplyIdentifiers } from '../services/forwardedEmail.service';
import { dynamicsService } from '../services/dynamics.service';
import { supabaseService, EmailRelayPendingRow } from '../services/supabase.service';
import { metaWhatsAppService } from '../services/meta.service';

console.log('[boot] emailRelay.controller: imports done');

const RELAY_TEMPLATE_NAME = process.env.WHATSAPP_RELAY_TEMPLATE_NAME || 'client_email_relay_consent';
const RELAY_TEMPLATE_LANG = process.env.WHATSAPP_RELAY_TEMPLATE_LANG || 'en';
const RELAY_BUTTON_YES = 'relay_yes';
const RELAY_BUTTON_NO = 'relay_no';

// 48-hour consent window. After that the client's tap is ignored and the
// forwarder is emailed back saying "no response."
const CONSENT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Local copy of the template body, substituted with the client's first name
// so we can write it to Supabase history when the template goes out. Keep in
// sync with the approved Meta template; if the wording diverges, the WhatsApp
// view is what the client actually sees, and history just serves as context
// for the next AI turn.
function renderTemplateBody(firstName: string): string {
    return `Hi ${firstName} 👋, I'm Tina,\nTTT's 24/7 tax assistant.\n\nWe just received your email and I'd love to help you right here on WhatsApp. You can ask me anything tax-related, any time of day. Want me to assist over WhatsApp?`;
}

function composeRelayBody(parsed: ParsedForwardedEmail): string {
    if (parsed.subject) {
        return `Re: ${parsed.subject}\n\n${parsed.originalBody}`;
    }
    return parsed.originalBody;
}

// Normalize a Dynamics-stored phone to the WhatsApp wire format Meta delivers
// in webhooks ("27832852913" — country code, no leading 0, no +). Without this
// the relay row's client_phone wouldn't match the tapper's wa_id and the Yes/No
// reply would be treated as stale.
function toWhatsAppPhone(raw: string): string {
    const trimmed = raw.trim().replace(/\s+/g, '');
    if (trimmed.startsWith('+27')) return trimmed.slice(1);
    if (trimmed.startsWith('0') && trimmed.length === 10) return '27' + trimmed.slice(1);
    return trimmed;
}

function firstName(fullname: string | null | undefined, fallbackEmail?: string): string {
    const fromName = (fullname || '').trim().split(/\s+/)[0];
    if (fromName) return fromName;
    if (fallbackEmail) return fallbackEmail.split('@')[0] || 'there';
    return 'there';
}

// Why we couldn't relay straight off the forward — drives the wording of the
// email we send the consultant asking for the client's details.
type AskReason = 'not_in_crm' | 'no_phone' | 'parse_failed' | 'forwarder_is_sender';

/**
 * We couldn't resolve the forward to a client we can WhatsApp. Park an
 * `awaiting_forwarder` row keyed to the email thread and reply to the
 * consultant asking for the client's email or mobile. When they reply,
 * processInboundEmail matches it back to this row (by conversation_id) and
 * picks up where we left off. Threads under the original forward.
 */
async function parkAndAskForwarder(params: {
    graphMessageId: string;
    conversationId: string | null;
    forwarderEmail: string;
    forwarderName: string | null;
    originalSenderEmail: string | null;
    subject: string | null;
    relayBody: string;
    reason: AskReason;
}): Promise<void> {
    await supabaseService.createEmailRelayPending({
        graphMessageId: params.graphMessageId,
        conversationId: params.conversationId,
        clientPhone: '',
        clientCrmId: null,
        clientCrmType: null,
        forwarderEmail: params.forwarderEmail,
        forwarderName: params.forwarderName,
        originalSenderEmail: params.originalSenderEmail || '',
        subject: params.subject,
        relayBody: params.relayBody,
        status: 'awaiting_forwarder',
        expiresAt: new Date(Date.now() + CONSENT_WINDOW_MS),
    });

    const greetingName = firstName(params.forwarderName, params.forwarderEmail);
    const who = params.originalSenderEmail ? params.originalSenderEmail : 'the client';
    const explanation = (() => {
        switch (params.reason) {
            case 'no_phone':
                return `I found ${who} in Dynamics, but there's no mobile number on their record so I can't reach them on WhatsApp. ` +
                    `Reply with their mobile number (or add it to Dynamics) and I'll take it from there.`;
            case 'parse_failed':
                return `I couldn't work out which client this is about from the forward. ` +
                    `Reply with the client's email address or mobile number and I'll pick it up from there.`;
            case 'forwarder_is_sender':
                return `I couldn't tell the client apart from the email thread — it looked like it resolved back to you. ` +
                    `Reply with the client's email address or mobile number and I'll reach out to them.`;
            case 'not_in_crm':
            default:
                return `I tried to reach ${who} over WhatsApp on your behalf, but I couldn't find a matching contact or lead in Dynamics. ` +
                    `If they should be in the CRM, please add them; otherwise reply with the client's email address or mobile number and I'll take it from there.`;
        }
    })();

    await graphMailService.sendMail({
        to: params.forwarderEmail,
        subject: `Re: ${params.subject || 'Forwarded message'}`,
        replyToMessageId: params.graphMessageId,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `${explanation}\n\n` +
            `Tina\n` +
            `TTT Financial Group`,
    });
}

/**
 * The consultant replied to a parked request, but the email/mobile they gave
 * still doesn't resolve to a client we can reach. Tell them, and close the row
 * so we don't loop. (They can reply again with different details — that starts
 * a fresh request.)
 */
async function emailForwarderUnresolved(
    pending: EmailRelayPendingRow,
    replyToMessageId: string
): Promise<void> {
    const greetingName = firstName(pending.forwarder_name, pending.forwarder_email);
    await graphMailService.sendMail({
        to: pending.forwarder_email,
        subject: `Re: ${pending.subject || 'Forwarded message'}`,
        replyToMessageId,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `Thanks — but I still couldn't find that client in Dynamics from what you sent, so I can't WhatsApp them. ` +
            `They need a contact or lead record (with a mobile number) before I can reach out. ` +
            `Once they're in the CRM, reply here and I'll pick it up.\n\n` +
            `Tina\n` +
            `TTT Financial Group`,
    });
}

async function emailForwarderAccepted(pending: EmailRelayPendingRow): Promise<void> {
    const greetingName = firstName(pending.forwarder_name, pending.forwarder_email);
    await graphMailService.sendMail({
        to: pending.forwarder_email,
        subject: `Re: ${pending.subject || 'Forwarded message'}`,
        replyToMessageId: pending.graph_message_id,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `${pending.original_sender_email} accepted the WhatsApp relay — I'm answering their question over WhatsApp now. I'll keep an eye on the conversation and loop you in if it needs a consultant.\n\n` +
            `Tina\n` +
            `TTT Financial Group`,
    });
}

async function emailForwarderDeclined(pending: EmailRelayPendingRow): Promise<void> {
    const greetingName = firstName(pending.forwarder_name, pending.forwarder_email);
    await graphMailService.sendMail({
        to: pending.forwarder_email,
        subject: `Re: ${pending.subject || 'Forwarded message'}`,
        replyToMessageId: pending.graph_message_id,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `${pending.original_sender_email} declined the WhatsApp relay — they'd prefer to keep things over email. Please follow up with them directly.\n\n` +
            `Tina\n` +
            `TTT Financial Group`,
    });
}

async function emailForwarderExpired(pending: EmailRelayPendingRow): Promise<void> {
    const greetingName = firstName(pending.forwarder_name, pending.forwarder_email);
    await graphMailService.sendMail({
        to: pending.forwarder_email,
        subject: `Re: ${pending.subject || 'Forwarded message'}`,
        replyToMessageId: pending.graph_message_id,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `${pending.original_sender_email} didn't respond to my WhatsApp prompt within 48 hours. The consent window has expired — please follow up with them directly.\n\n` +
            `Tina\n` +
            `TTT Financial Group`,
    });
}

// Everything sendRelayToEntity needs to message a resolved client. Carried by
// both the direct-forward path and the forwarder-reply round-trip.
interface RelayContext {
    graphMessageId: string;       // keys the awaiting_consent row (forward OR reply id)
    conversationId: string | null;
    forwarderEmail: string;
    forwarderName: string | null;
    originalSenderEmail: string;  // for logging + forwarder email copy
    subject: string | null;
    relayBody: string;            // client's original question, replayed to AI on "Yes"
}

/**
 * Send the consent template to a resolved client and persist the awaiting_consent
 * row. Shared by the direct-forward path and the forwarder-reply round-trip.
 * Idempotent on ctx.graphMessageId. Returns true if the template went out.
 */
async function sendRelayToEntity(entity: any, ctx: RelayContext): Promise<boolean> {
    const clientPhone = toWhatsAppPhone(entity.mobilephone as string);

    // Only one active relay per phone — supersede any earlier pending consent
    // so the partial unique index doesn't collide and a stale Yes/No tap from
    // a prior forward doesn't get applied to this one.
    await supabaseService.supersedeActiveRelaysForPhone(clientPhone);

    const pending = await supabaseService.createEmailRelayPending({
        graphMessageId: ctx.graphMessageId,
        conversationId: ctx.conversationId,
        clientPhone,
        clientCrmId: entity.id,
        clientCrmType: entity.type,
        forwarderEmail: ctx.forwarderEmail,
        forwarderName: ctx.forwarderName,
        originalSenderEmail: ctx.originalSenderEmail,
        subject: ctx.subject,
        relayBody: ctx.relayBody,
        status: 'awaiting_consent',
        expiresAt: new Date(Date.now() + CONSENT_WINDOW_MS),
    });

    if (!pending) {
        console.log(`[EmailRelay] Redelivery / duplicate for ${ctx.graphMessageId} — already handled`);
        return false;
    }

    // Pre-seed conversation history so when the client taps "Yes" and the bot
    // re-enters processMessage with the email body, the welcome-menu branch
    // (which fires only on empty history) is skipped and we go straight to
    // answering. The template body matches what the client sees on WhatsApp.
    const fname = firstName(entity.fullname, ctx.originalSenderEmail);
    const session = await supabaseService.getOrCreateSession(
        clientPhone,
        entity.id,
        entity.type,
        null,
        []
    );
    await supabaseService.saveMessage(session.id, 'assistant', renderTemplateBody(fname));

    // Send the approved template with the two quick-reply payloads. The
    // template is defined with a NAMED body variable ({{customer_name}}), so
    // we must pass bodyNamedVariables — positional params would be rejected.
    const result = await metaWhatsAppService.sendTemplate(clientPhone, {
        name: RELAY_TEMPLATE_NAME,
        languageCode: RELAY_TEMPLATE_LANG,
        bodyNamedVariables: { customer_name: fname },
        buttonPayloads: [
            { index: 0, payload: RELAY_BUTTON_YES },
            { index: 1, payload: RELAY_BUTTON_NO },
        ],
    });

    if (!result.delivered) {
        // Template send failed (often because the client isn't a WhatsApp user
        // or Meta cred issue). Mark the pending row and email the forwarder.
        await supabaseService.markRelayResponded(pending.id, 'expired');
        await graphMailService.sendMail({
            to: ctx.forwarderEmail,
            subject: `Re: ${ctx.subject || 'Forwarded message'}`,
            replyToMessageId: ctx.graphMessageId,
            bodyText:
                `Hi ${firstName(ctx.forwarderName, ctx.forwarderEmail)},\n\n` +
                `I couldn't reach ${ctx.originalSenderEmail} over WhatsApp — the message wasn't accepted by their number (they may not have WhatsApp installed, or our template was rejected).\n\n` +
                `Error: ${result.error || 'unknown'}\n\n` +
                `Please reach out to them directly.\n\n` +
                `Tina\n` +
                `TTT Financial Group`,
        });
        return false;
    }
    return true;
}

/**
 * A consultant replied to a parked request with (hopefully) the client's email
 * or mobile. Resolve it to a CRM contact/lead — never staff, and never a raw
 * number with no record behind it — and send the relay. If it still doesn't
 * resolve, tell them and close the request.
 */
async function handleForwarderReply(message: GraphMessage, pending: EmailRelayPendingRow): Promise<void> {
    const ourMailbox = (process.env.GRAPH_SHARED_MAILBOX || '').toLowerCase();
    const ids = extractForwarderReplyIdentifiers(message, [pending.forwarder_email, ourMailbox]);
    console.log(
        `[EmailRelay] Forwarder reply on parked request ${pending.id} — ` +
        `phones=[${ids.phones.join(', ')}] emails=[${ids.emails.join(', ')}]`
    );

    // Prefer a phone number (the consultant's most direct answer), then fall
    // back to any email they gave. Either way it must map to a real CRM record
    // with a mobile — we don't WhatsApp a number with nothing behind it.
    let entity: any = null;
    for (const phone of ids.phones) {
        const e = await dynamicsService.getEntityByPhone(phone);
        if (e && e.type !== 'user' && e.mobilephone) { entity = e; break; }
    }
    if (!entity) {
        for (const email of ids.emails) {
            const e = await dynamicsService.getEntityByEmail(email);
            if (e && e.type !== 'user' && e.mobilephone) { entity = e; break; }
        }
    }

    if (!entity) {
        console.log(`[EmailRelay] Forwarder reply ${message.id} still unresolved — closing request ${pending.id}`);
        await supabaseService.closeForwarderRequest(pending.id, 'no_match');
        await emailForwarderUnresolved(pending, message.id);
        return;
    }

    console.log(`[EmailRelay] Forwarder reply resolved to ${entity.type}/${entity.id} — relaying`);
    await sendRelayToEntity(entity, {
        graphMessageId: message.id,
        conversationId: message.conversationId,
        forwarderEmail: pending.forwarder_email,
        forwarderName: pending.forwarder_name,
        originalSenderEmail: entity.email || pending.original_sender_email || '',
        subject: pending.subject,
        relayBody: pending.relay_body,
    });

    // The parked request is resolved regardless of whether the template landed
    // (a failed send already emailed the forwarder its own note).
    await supabaseService.closeForwarderRequest(pending.id, 'superseded');
}

/**
 * Main inbound handler. Called from the email webhook with the Graph message
 * id of a freshly-arrived message in tina-bot's Inbox.
 *
 * Idempotent: re-processing the same message id is a no-op — every message we
 * act on leaves a row keyed by its graph_message_id.
 */
export async function processInboundEmail(graphMessageId: string): Promise<void> {
    const message = await graphMailService.getMessage(graphMessageId);
    if (!message) return;

    // Avoid responding to messages WE sent (Tina replying to forwarders shouldn't
    // re-trigger). Filter on `from` matching the shared mailbox.
    const from = (message.from?.emailAddress?.address || '').toLowerCase();
    const ourMailbox = (process.env.GRAPH_SHARED_MAILBOX || '').toLowerCase();
    if (from === ourMailbox) {
        console.log(`[EmailRelay] Skipping message ${graphMessageId} — sent by tina-bot itself`);
        return;
    }

    // Idempotency: if we've already acted on this exact message, stop. Catches
    // Graph redelivery for both forwards and forwarder replies.
    const already = await supabaseService.getRelayByGraphMessageId(message.id);
    if (already) {
        console.log(`[EmailRelay] Already handled ${graphMessageId} (row ${already.id}, status ${already.status}) — skipping`);
        return;
    }

    // Round-trip: is this a consultant replying to a request we parked? Match
    // the open awaiting_forwarder row on the email thread, from the same person.
    const parked = await supabaseService.findOpenForwarderRequest(message.conversationId || '');
    if (parked && parked.forwarder_email.toLowerCase() === from) {
        console.log(`[EmailRelay] Inbound ${graphMessageId} matches parked request ${parked.id} — treating as forwarder reply`);
        await handleForwarderReply(message, parked);
        return;
    }

    const parsed = parseForwarded(message);
    if (!parsed) {
        console.warn(`[EmailRelay] Could not parse forwarded email ${graphMessageId} — asking forwarder for client details`);
        await parkAndAskForwarder({
            graphMessageId: message.id,
            conversationId: message.conversationId,
            forwarderEmail: from || 'unknown@unknown',
            forwarderName: message.from?.emailAddress?.name || null,
            originalSenderEmail: null,
            subject: message.subject?.replace(/^(?:Fwd?|Re|FW)\s*:\s*/gi, '').trim() || null,
            relayBody: message.bodyPreview || '',
            reason: 'parse_failed',
        });
        return;
    }

    console.log(`[EmailRelay] Forward from ${parsed.forwarderEmail} on behalf of ${parsed.originalSenderEmail} (subject: "${parsed.subject || '(none)'}")`);

    // Guard: never relay back to the consultant who forwarded. If the parse
    // resolved the "original sender" to the forwarder's own address, the thread
    // was ambiguous (e.g. a long alternating reply chain) — ask them instead.
    if (parsed.originalSenderEmail === parsed.forwarderEmail) {
        console.log(`[EmailRelay] Original sender == forwarder (${parsed.forwarderEmail}) — asking for client details`);
        await parkAndAskForwarder({
            graphMessageId: message.id,
            conversationId: message.conversationId,
            forwarderEmail: parsed.forwarderEmail,
            forwarderName: parsed.forwarderName,
            originalSenderEmail: null,
            subject: parsed.subject,
            relayBody: composeRelayBody(parsed),
            reason: 'forwarder_is_sender',
        });
        return;
    }

    const entity = await dynamicsService.getEntityByEmail(parsed.originalSenderEmail);

    // No CRM match (or, defensively, a staff record), or no phone on file.
    if (!entity || entity.type === 'user' || !entity.mobilephone) {
        const reason: AskReason = !entity || entity.type === 'user' ? 'not_in_crm' : 'no_phone';
        console.log(
            `[EmailRelay] Cannot relay ${parsed.originalSenderEmail} — ${reason} ` +
            `(entity=${entity ? `${entity.type}/${entity.id}` : 'none'}) — asking forwarder`
        );
        await parkAndAskForwarder({
            graphMessageId: message.id,
            conversationId: message.conversationId,
            forwarderEmail: parsed.forwarderEmail,
            forwarderName: parsed.forwarderName,
            originalSenderEmail: parsed.originalSenderEmail,
            subject: parsed.subject,
            relayBody: composeRelayBody(parsed),
            reason,
        });
        return;
    }

    await sendRelayToEntity(entity, {
        graphMessageId: message.id,
        conversationId: message.conversationId,
        forwarderEmail: parsed.forwarderEmail,
        forwarderName: parsed.forwarderName,
        originalSenderEmail: parsed.originalSenderEmail,
        subject: parsed.subject,
        relayBody: composeRelayBody(parsed),
    });
}

export type RelayResponse =
    | { kind: 'declined' }
    | { kind: 'stale' }
    | { kind: 'accepted'; pending: EmailRelayPendingRow };

/**
 * Called from the WhatsApp webhook when a client taps the Yes/No quick-reply
 * button on the relay-consent template.
 *
 * For 'declined' / 'stale': everything happens here (ack to client, email
 *   forwarder) and the caller can return.
 * For 'accepted': we mark the pending row, email the forwarder, and return
 *   the row so the caller can run the email body through the AI Q&A flow.
 */
export async function handleClientRelayResponse(
    clientPhone: string,
    payload: 'relay_yes' | 'relay_no'
): Promise<RelayResponse> {
    const pending = await supabaseService.findActiveRelayByPhone(clientPhone);
    if (!pending) {
        console.log(`[EmailRelay] Stale ${payload} from ${clientPhone} — no active relay`);
        return { kind: 'stale' };
    }

    if (payload === 'relay_no') {
        await supabaseService.markRelayResponded(pending.id, 'declined');
        await metaWhatsAppService.sendMessage(
            clientPhone,
            "No problem, we'll keep things over email. A consultant will be in touch shortly."
        );
        emailForwarderDeclined(pending).catch(e =>
            console.warn('[EmailRelay] Forwarder-declined email failed:', e?.message || e)
        );
        return { kind: 'declined' };
    }

    // relay_yes
    await supabaseService.markRelayResponded(pending.id, 'accepted');
    emailForwarderAccepted(pending).catch(e =>
        console.warn('[EmailRelay] Forwarder-accepted email failed:', e?.message || e)
    );
    return { kind: 'accepted', pending };
}

/**
 * Cron-safe sweep: any awaiting_consent rows past their 48h window flip to
 * expired and the forwarder is emailed.
 */
export async function sweepExpiredRelays(): Promise<number> {
    const expired = await supabaseService.expireOldRelays();
    for (const row of expired) {
        emailForwarderExpired(row).catch(e =>
            console.warn(`[EmailRelay] Forwarder-expired email failed for ${row.id}:`, e?.message || e)
        );
    }
    return expired.length;
}

export const RELAY_BUTTON_PAYLOAD = { YES: RELAY_BUTTON_YES, NO: RELAY_BUTTON_NO } as const;
