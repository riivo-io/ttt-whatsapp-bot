import {
    ServiceBusSessionReceiver,
    ProcessErrorArgs,
    ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { getServiceBusClient } from '../queue/connection';
import {
    WHATSAPP_INBOUND_QUEUE,
    WhatsAppJobPayload,
    enqueueRetryAfterRateLimit,
    parseRetryAttempt,
} from '../queue/whatsappQueue';
import { processInboundJob } from './whatsappProcessor';
import { idempotencyService } from '../services/idempotency.service';
import { RateLimitError } from '../utils/anthropicRateLimit';

// Cap on Anthropic 429 retries before we DLQ. 5 × ~60s ≈ 5 minutes — the
// WhatsApp client has moved on past that.
const MAX_RATE_LIMIT_RETRIES = 5;

// ASB session-based consumer. Each accepted session gives us strict per-phone
// FIFO; we run multiple sessions concurrently up to MAX_CONCURRENT_SESSIONS.
//
// We use the manual `acceptNextSession` loop rather than `createSessionProcessor`
// so we can take a session that has messages, drain it to empty, and release it
// — the processor's session-rotation semantics are opaque enough that the loop
// is easier to reason about and matches the BullMQ "one worker per shard" model
// the rest of the code expects.

function getMaxConcurrentSessions(): number {
    return Math.max(1, parseInt(process.env.MAX_CONCURRENT_SESSIONS || '8', 10));
}

let running = false;
let sessionLoops: Promise<void>[] = [];
const activeReceivers = new Set<ServiceBusSessionReceiver>();

async function handleOne(
    receiver: ServiceBusSessionReceiver,
    msg: ServiceBusReceivedMessage,
    slot: number,
): Promise<void> {
    const payload = msg.body as WhatsAppJobPayload;
    const queuedFor = Date.now() - payload.receivedAt;
    const deliveryCount = (msg.deliveryCount ?? 0) + 1;
    console.log(
        `[Worker:${slot}] msg=${msg.messageId} phone=${payload.phone} queuedMs=${queuedFor} delivery=${deliveryCount}`
    );
    try {
        await processInboundJob(payload);
        await receiver.completeMessage(msg);
        console.log(
            `[Worker:${slot}] completed msg=${msg.messageId} totalMs=${Date.now() - payload.receivedAt}`
        );
    } catch (err: any) {
        // RateLimitError MUST be checked before the generic handler so we
        // re-enqueue with delay instead of letting ASB redeliver — that
        // would block the whole session waiting on the same backoff.
        if (err instanceof RateLimitError) {
            const currentAttempt = parseRetryAttempt(msg.messageId?.toString());
            const nextAttempt = currentAttempt + 1;
            if (currentAttempt >= MAX_RATE_LIMIT_RETRIES) {
                console.error(
                    `[Worker:${slot}] rate-limit retry cap reached for msg=${msg.messageId} phone=${payload.phone} — DLQ`
                );
                await idempotencyService.recordDeadLetter({
                    jobId: msg.messageId?.toString(),
                    queueName: WHATSAPP_INBOUND_QUEUE,
                    metaMessageId: payload?.metaMessageId ?? null,
                    phoneNumber: payload?.phone ?? null,
                    payload,
                    failedReason: 'rate_limit_exceeded_after_5_retries',
                    attemptsMade: currentAttempt,
                    stackTrace: err.stack ?? null,
                });
                // Complete the original so ASB drops it — no redelivery storm,
                // no session blocking.
                await receiver.completeMessage(msg);
                return;
            }
            console.warn(
                `[Worker:${slot}] 429 — re-enqueue msg=${msg.messageId} as retry:${nextAttempt} delayMs=${err.retryAfterMs}`
            );
            await enqueueRetryAfterRateLimit(payload, nextAttempt, err.retryAfterMs);
            await receiver.completeMessage(msg);
            return;
        }

        // Generic failure path: if we've hit the max-delivery ceiling, write
        // to the DLQ row ourselves and dead-letter the ASB message so it
        // stops being redelivered. Otherwise abandon — ASB will redeliver
        // with its built-in backoff and increment deliveryCount.
        const maxDelivery = 5; // matches queue config
        console.warn(
            `[Worker:${slot}] failed msg=${msg.messageId} phone=${payload?.phone} delivery=${deliveryCount}/${maxDelivery} err=${err?.message || err}`
        );
        if (deliveryCount >= maxDelivery) {
            try {
                await idempotencyService.recordDeadLetter({
                    jobId: msg.messageId?.toString(),
                    queueName: WHATSAPP_INBOUND_QUEUE,
                    metaMessageId: payload?.metaMessageId ?? null,
                    phoneNumber: payload?.phone ?? null,
                    payload,
                    failedReason: err?.message ?? 'unknown',
                    attemptsMade: deliveryCount,
                    stackTrace: err?.stack ?? null,
                });
                console.error(
                    `[Worker:${slot}] DLQ landed msg=${msg.messageId} phone=${payload?.phone}`
                );
            } catch (dlqErr: any) {
                console.error(
                    `[Worker:${slot}] DLQ write failed for msg=${msg.messageId}:`,
                    dlqErr?.message || dlqErr
                );
            }
            await receiver.deadLetterMessage(msg, {
                deadLetterReason: 'MaxDeliveryExceeded',
                deadLetterErrorDescription: err?.message ?? 'unknown',
            });
        } else {
            await receiver.abandonMessage(msg);
        }
    }
}

async function sessionLoop(slot: number): Promise<void> {
    const client = getServiceBusClient();
    while (running) {
        let receiver: ServiceBusSessionReceiver;
        try {
            // No sessionId arg → ASB hands us the next available session
            // with messages. The maxWaitTime is enforced by the SDK.
            receiver = await client.acceptNextSession(WHATSAPP_INBOUND_QUEUE, {
                receiveMode: 'peekLock',
            });
        } catch (err: any) {
            // No-sessions-available comes back as a timeout — three flavours in
            // the wild: `code: 'OperationTimeoutError'`, `name:
            // 'OperationTimeoutError'`, or a `ServiceBusError` whose message
            // contains "did not complete within the allotted timeout" or
            // "Unable to create the amqp receiver". All of these are normal
            // when the queue is idle — loop silently.
            const code = err?.code || err?.name || '';
            const message = err?.message || '';
            const isIdleTimeout =
                code === 'OperationTimeoutError' ||
                /did not complete within the allotted timeout/i.test(message) ||
                /Unable to create the amqp receiver/i.test(message);
            if (isIdleTimeout) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            console.error(`[Worker:${slot}] acceptNextSession error:`, err?.message || err);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        activeReceivers.add(receiver);
        const sid = receiver.sessionId;
        console.log(`[Worker:${slot}] session opened phone=${sid}`);

        try {
            while (running) {
                const batch = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
                if (batch.length === 0) {
                    // Session idle — release it so another slot can take a
                    // different session.
                    break;
                }
                await handleOne(receiver, batch[0], slot);
            }
        } catch (err: any) {
            // Session lock lost is normal if the loop sat idle past the
            // session lock duration; just close and re-accept.
            console.warn(`[Worker:${slot}] session ${sid} loop error:`, err?.message || err);
        } finally {
            activeReceivers.delete(receiver);
            try {
                await receiver.close();
            } catch (e: any) {
                console.warn(`[Worker:${slot}] receiver.close error:`, e?.message || e);
            }
            console.log(`[Worker:${slot}] session closed phone=${sid}`);
        }
    }
}

export function startWhatsAppWorkers(): void {
    if (running) return;
    running = true;
    const slots = getMaxConcurrentSessions();
    sessionLoops = Array.from({ length: slots }, (_, i) =>
        sessionLoop(i).catch(err => {
            console.error(`[Worker:${i}] loop crashed:`, err?.message || err);
        })
    );
    console.log(`[Worker] Started ${slots} session loops on ${WHATSAPP_INBOUND_QUEUE}`);
}

export async function stopWhatsAppWorkers(): Promise<void> {
    if (!running) return;
    console.log('[Worker] Stopping session loops...');
    running = false;
    // Close any active receivers so in-flight acceptNextSession / receiveMessages
    // calls return promptly.
    await Promise.all(
        Array.from(activeReceivers).map(r =>
            r.close().catch(e => console.warn('[Worker] receiver.close on stop:', e?.message || e))
        )
    );
    activeReceivers.clear();
    await Promise.all(sessionLoops);
    sessionLoops = [];
    console.log('[Worker] Session loops stopped.');
}

// `ProcessErrorArgs` is exported only to keep the import surface stable for
// any future top-level error handler.
export type { ProcessErrorArgs };
