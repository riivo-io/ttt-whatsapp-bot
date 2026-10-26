import { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import { getServiceBusClient } from './connection';

// Per-conversation FIFO via Azure Service Bus sessions:
//
//   sessionId = phone
//
// ASB guarantees ordered delivery within a session and locks one session at
// a time to a receiver, so per-phone ordering falls out for free. Multiple
// sessions (phones) process in parallel up to `MAX_CONCURRENT_SESSIONS`.
//
// Duplicate detection is set on the queue (10-min window); we set
// `messageId = metaMessageId` so a redelivered Meta webhook is rejected by
// ASB before the worker sees it. Supabase's `whatsapp_inbound_messages`
// unique constraint is the durable layer underneath.

export const WHATSAPP_INBOUND_QUEUE = 'whatsapp-inbound';

// The exact shape passed from the webhook ingester to the worker. Keep this
// minimal — it gets serialized into the ASB message body. Anything
// reconstructible from `phone` + `metaMessageId` should be fetched inside
// the worker, not stashed in the payload.
export type WhatsAppJobPayload = {
    metaMessageId: string;          // wamid.xxx — also used as ASB messageId for dedup
    phone: string;                  // sender E.164 sans `+` — used as sessionId
    phoneNumberId: string | null;   // metadata.phone_number_id (for multi-number routing)
    receivedAt: number;             // Date.now() at ingest — for end-to-end latency
    rawMessage: any;                // Meta's `messages[i]` object, unmodified
};

let sender: ServiceBusSender | null = null;

function getSender(): ServiceBusSender {
    if (sender) return sender;
    sender = getServiceBusClient().createSender(WHATSAPP_INBOUND_QUEUE);
    return sender;
}

/**
 * Enqueue an inbound WhatsApp message for worker processing.
 *
 * `messageId = metaMessageId` activates the queue's duplicate-detection
 * window as a second line of defense on top of Supabase's idempotency table.
 * `sessionId = phone` is what gives strict per-phone FIFO on the receive
 * side.
 */
export async function enqueueInboundMessage(payload: WhatsAppJobPayload): Promise<void> {
    const msg: ServiceBusMessage = {
        body: payload,
        sessionId: payload.phone,
        messageId: payload.metaMessageId,
    };
    await getSender().sendMessages(msg);
}

/**
 * Re-enqueue a job that hit an Anthropic 429. ASB has scheduled messages
 * built in — no separate retry queue, no sleeping worker blocking the
 * session.
 *
 * The messageId is namespaced as `${wamid}:retry:${attemptNum}` so:
 *   - it doesn't collide with the original wamid message in dedup
 *   - Meta redelivering the bare wamid is still rejected by the
 *     idempotency table (claim() returns false → ingester drops)
 *   - successive retries don't collide with each other
 */
export async function enqueueRetryAfterRateLimit(
    payload: WhatsAppJobPayload,
    attemptNum: number,
    delayMs: number,
): Promise<void> {
    const msg: ServiceBusMessage = {
        body: payload,
        sessionId: payload.phone,
        messageId: `${payload.metaMessageId}:retry:${attemptNum}`,
        scheduledEnqueueTimeUtc: new Date(Date.now() + Math.max(1, Math.floor(delayMs))),
    };
    await getSender().sendMessages(msg);
}

/** TTTFG-4830 (claims demo): the rawMessage type of a scheduled batch check (see enqueueClaimsBatchCheck). */
export const CLAIMS_BATCH_CHECK = 'claims_batch_check';

/**
 * TTTFG-4830 (claims demo): after a client answers part of Tina's numbered questions, check back in `delayMs`. The
 * check goes on the sender's own session, so it comes after any message they send in the meantime; the claims demo
 * lists what's still open only if nothing came in since the message `token` (its wamid). `phoneNumberId`: the number
 * the client wrote to, so the reply comes from it.
 */
export async function enqueueClaimsBatchCheck(phone: string, token: string, delayMs: number, phoneNumberId: string | null): Promise<void> {
    const payload: WhatsAppJobPayload = {
        metaMessageId: `${token}:batch-check`,
        phone,
        phoneNumberId,
        receivedAt: Date.now(),
        rawMessage: { type: CLAIMS_BATCH_CHECK, token },
    };
    const msg: ServiceBusMessage = {
        body: payload,
        sessionId: phone,
        messageId: payload.metaMessageId,
        scheduledEnqueueTimeUtc: new Date(Date.now() + Math.max(1, Math.floor(delayMs))),
    };
    await getSender().sendMessages(msg);
}

/** TTTFG-5212 (claims demo): the rawMessage type of the morning reminder (see enqueueClaimsReminder). */
export const CLAIMS_REMINDER = 'claims_reminder';

/**
 * TTTFG-5212 (claims demo): the morning reminder for one demo number, queued by the 08:00 cron on the number's own
 * session, so it runs after anything the client is sending. The message id names the day: with duplicate detection on
 * the queue a second run the same day is dropped (the claims package also skips a claim already reminded today).
 * `test`: one number's reminder sent by hand to see it (claimsDemo.service enqueueClaimsDemoReminders).
 */
export async function enqueueClaimsReminder(phone: string, day: string, test = false): Promise<void> {
    const payload: WhatsAppJobPayload = {
        // A test (one number, by hand) gets its own id, so it never stands in for the day's reminder.
        metaMessageId: test ? `claims-reminder-test:${phone}:${Date.now()}` : `claims-reminder:${phone}:${day}`,
        phone,
        phoneNumberId: null,
        receivedAt: Date.now(),
        rawMessage: { type: CLAIMS_REMINDER, ...(test ? { test: true } : {}) },
    };
    await getSender().sendMessages({ body: payload, sessionId: phone, messageId: payload.metaMessageId });
}

// Pure helper lives in src/utils/jobIdRetry so smoke tests can import it
// without pulling in @azure/service-bus transitively.
export { parseRetryAttempt } from '../utils/jobIdRetry';

export async function closeProducerQueues(): Promise<void> {
    if (sender) {
        await sender.close();
        sender = null;
    }
}
