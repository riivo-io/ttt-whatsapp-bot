import { graphMailService, GraphMessage } from '../services/graphMail.service';
import { parseForwarded, ParsedForwardedEmail } from '../services/forwardedEmail.service';
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

/**
 * Notify the original forwarder that we couldn't relay because we couldn't
 * find a WhatsApp number for the client in Dynamics. Threads under the
 * original forward via Graph's reply endpoint.
 */
async function emailForwarderNoMatch(
    forwarderEmail: string,
    forwarderName: string | null,
    originalSenderEmail: string,
    subject: string | null,
    replyToMessageId: string
): Promise<void> {
    const greetingName = firstName(forwarderName, forwarderEmail);
    await graphMailService.sendMail({
        to: forwarderEmail,
        subject: `Re: ${subject || 'Forwarded message'}`,
        replyToMessageId,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `I tried to reach ${originalSenderEmail} over WhatsApp on your behalf, but I couldn't find a WhatsApp number on record for them in Dynamics. ` +
            `If you'd like me to message them, please reply with their mobile number and I'll take it from there.\n\n` +
            `Tina\n` +
            `TTT Financial Group`,
    });
}

async function emailForwarderParseError(
    forwarderEmail: string,
    forwarderName: string | null,
    replyToMessageId: string
): Promise<void> {
    const greetingName = firstName(forwarderName, forwarderEmail);
    await graphMailService.sendMail({
        to: forwarderEmail,
        subject: `Re: Forwarded message`,
        replyToMessageId,
        bodyText:
            `Hi ${greetingName},\n\n` +
            `I couldn't extract the original sender's email from your forward. Could you reply with the client's email address (and ideally their mobile number) and I'll pick it up from there?\n\n` +
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

/**
 * Main inbound handler. Called from the email webhook with the Graph message
 * id of a freshly-arrived message in tina-bot's Inbox.
 *
 * Idempotent: re-processing the same message id is a no-op (Supabase
 * graph_message_id unique constraint).
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

    const parsed = parseForwarded(message);
    if (!parsed) {
        console.warn(`[EmailRelay] Could not parse forwarded email ${graphMessageId} — replying to forwarder`);
        await emailForwarderParseError(from || 'unknown@unknown', message.from?.emailAddress?.name || null, graphMessageId);
        return;
    }

    console.log(`[EmailRelay] Forward from ${parsed.forwarderEmail} on behalf of ${parsed.originalSenderEmail} (subject: "${parsed.subject || '(none)'}")`);

    const entity = await dynamicsService.getEntityByEmail(parsed.originalSenderEmail);

    // No CRM match, or no phone number on file
    if (!entity || !entity.mobilephone) {
        console.log(`[EmailRelay] No WhatsApp number for ${parsed.originalSenderEmail} (entity=${entity ? entity.type : 'none'}) — emailing forwarder`);

        // Persist a no_match row for audit and de-dup against Graph redelivery.
        await supabaseService.createEmailRelayPending({
            graphMessageId: message.id,
            clientPhone: '',
            clientCrmId: entity?.id || null,
            clientCrmType: entity?.type || null,
            forwarderEmail: parsed.forwarderEmail,
            forwarderName: parsed.forwarderName,
            originalSenderEmail: parsed.originalSenderEmail,
            subject: parsed.subject,
            relayBody: parsed.originalBody,
            status: 'no_match',
            expiresAt: new Date(Date.now() + CONSENT_WINDOW_MS),
        });

        await emailForwarderNoMatch(parsed.forwarderEmail, parsed.forwarderName, parsed.originalSenderEmail, parsed.subject, graphMessageId);
        return;
    }

    const clientPhone = toWhatsAppPhone(entity.mobilephone as string);

    // Only one active relay per phone — supersede any earlier pending consent
    // so the partial unique index doesn't collide and a stale Yes/No tap from
    // a prior forward doesn't get applied to this one.
    await supabaseService.supersedeActiveRelaysForPhone(clientPhone);

    const relayBody = composeRelayBody(parsed);

    const pending = await supabaseService.createEmailRelayPending({
        graphMessageId: message.id,
        clientPhone,
        clientCrmId: entity.id,
        clientCrmType: entity.type,
        forwarderEmail: parsed.forwarderEmail,
        forwarderName: parsed.forwarderName,
        originalSenderEmail: parsed.originalSenderEmail,
        subject: parsed.subject,
        relayBody,
        status: 'awaiting_consent',
        expiresAt: new Date(Date.now() + CONSENT_WINDOW_MS),
    });

    if (!pending) {
        console.log(`[EmailRelay] Redelivery / duplicate for ${graphMessageId} — already handled`);
        return;
    }

    // Pre-seed conversation history so when the client taps "Yes" and the bot
    // re-enters processMessage with the email body, the welcome-menu branch
    // (which fires only on empty history) is skipped and we go straight to
    // answering. The template body matches what the client sees on WhatsApp.
    const fname = firstName(entity.fullname, parsed.originalSenderEmail);
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
            to: parsed.forwarderEmail,
            subject: `Re: ${parsed.subject || 'Forwarded message'}`,
            replyToMessageId: graphMessageId,
            bodyText:
                `Hi ${firstName(parsed.forwarderName, parsed.forwarderEmail)},\n\n` +
                `I couldn't reach ${parsed.originalSenderEmail} over WhatsApp — the message wasn't accepted by their number (they may not have WhatsApp installed, or our template was rejected).\n\n` +
                `Error: ${result.error || 'unknown'}\n\n` +
                `Please reach out to them directly.\n\n` +
                `Tina\n` +
                `TTT Financial Group`,
        });
    }
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
