import { Request, Response } from 'express';
import { extractIncoming } from '../workers/whatsappProcessor';
import { enqueueInboundMessage } from '../queue/whatsappQueue';
import { idempotencyService } from '../services/idempotency.service';

// Hard denylist — phones whose inbound messages we ack-and-drop without any
// processing or reply. Comma-separated `WEBHOOK_BLOCKED_PHONES` env var (digits
// only, no `+`). Used as an emergency stop for runaway test numbers.
const BLOCKED_PHONES = new Set(
    (process.env.WEBHOOK_BLOCKED_PHONES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);

// Hard allowlist on inbound `phone_number_id`. If set, any inbound whose PID
// is not in this list is dropped before we touch Supabase or Redis. Empty/unset
// means allow all (preserves prior behavior).
//
// Why: the webhook is shared by every WABA subscribed to this Meta App. If a
// foreign (e.g. prod) WABA is subscribed, its traffic burns Upstash request
// quota on idempotency + BullMQ enqueue. Gating at the door costs ~0 ops.
const ALLOWED_PHONE_NUMBER_IDS = new Set(
    (process.env.WEBHOOK_ALLOWED_PHONE_NUMBER_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);

export function verifyWebhook(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.error('Webhook verification failed: Invalid token');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
}

/**
 * Thin webhook ingester:
 *
 *   1. Ack Meta within 10s (we 200 immediately).
 *   2. For each inbound message: parse, dedupe in Supabase, enqueue.
 *   3. All Claude/Dynamics/Supabase work happens in the BullMQ worker process.
 *
 * Idempotency lives in `whatsapp_webhook_events` (Postgres unique key on
 * Meta's `messages[].id`); the BullMQ jobId is also set to the same id so
 * concurrent ingester replicas can't double-enqueue the same message.
 */
export async function handleIncomingMessage(req: Request, res: Response): Promise<void> {
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object !== 'whatsapp_business_account') {
            console.warn('[Webhook] Non-Meta payload ignored:', JSON.stringify(body).slice(0, 200));
            return;
        }

        for (const entry of body.entry || []) {
            for (const change of entry.changes || []) {
                const value = change.value;
                const messages = value?.messages;
                if (!messages || messages.length === 0) continue;

                // Phone number id of the WhatsApp number this inbound came in
                // on. Threaded through to the worker so outbound replies route
                // from the same number, even when multiple numbers are attached
                // to the same WABA.
                const inboundPhoneNumberId: string | undefined = value?.metadata?.phone_number_id;

                if (
                    ALLOWED_PHONE_NUMBER_IDS.size > 0 &&
                    (!inboundPhoneNumberId || !ALLOWED_PHONE_NUMBER_IDS.has(inboundPhoneNumberId))
                ) {
                    console.log(
                        `[Webhook] DROP pid=${inboundPhoneNumberId || 'unknown'} waba=${entry.id} — not in WEBHOOK_ALLOWED_PHONE_NUMBER_IDS`
                    );
                    continue;
                }

                for (const message of messages) {
                    const incoming = extractIncoming(message);
                    if (!incoming) {
                        console.log(`[Webhook] Unsupported message type: ${message.type}`);
                        continue;
                    }

                    if (BLOCKED_PHONES.has(incoming.from)) {
                        console.log(`[Webhook] BLOCKED ${incoming.from} — dropping inbound (no reply)`);
                        continue;
                    }

                    if (!message.id) {
                        console.warn(`[Webhook] Inbound without messages[].id — cannot dedupe; dropping`);
                        continue;
                    }

                    const claimed = await idempotencyService.claim(message.id, incoming.from);
                    if (!claimed) {
                        console.log(`[Webhook] Duplicate ${message.id} from ${incoming.from} — skipping`);
                        continue;
                    }

                    console.log(
                        `[Webhook] ${incoming.from} → [pid ${inboundPhoneNumberId || 'env'}] ${incoming.document ? `[doc ${incoming.document.filename}]` : ''} ${incoming.text}`
                    );

                    try {
                        await enqueueInboundMessage({
                            metaMessageId: message.id,
                            phone: incoming.from,
                            phoneNumberId: inboundPhoneNumberId || null,
                            receivedAt: Date.now(),
                            rawMessage: message,
                        });
                    } catch (err: any) {
                        console.error(
                            `[Webhook] enqueue failed for ${message.id} (${incoming.from}):`,
                            err?.message || err
                        );
                        // Don't surface the failure to Meta — we already 200'd. The
                        // idempotency row is in place though, so a future Meta retry
                        // would be silently dropped as a "duplicate". Catching this
                        // failure end-to-end requires a queue-side audit; for now
                        // it's an alert-worthy log line.
                    }
                }
            }
        }
    } catch (error: any) {
        console.error('[Webhook] fatal error handling webhook:', error?.message || error);
    }
}
