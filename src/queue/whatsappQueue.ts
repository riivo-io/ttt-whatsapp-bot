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

// Pure helper lives in src/utils/jobIdRetry so smoke tests can import it
// without pulling in @azure/service-bus transitively.
export { parseRetryAttempt } from '../utils/jobIdRetry';

export async function closeProducerQueues(): Promise<void> {
    if (sender) {
        await sender.close();
        sender = null;
    }
}
