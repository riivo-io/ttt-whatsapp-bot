import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Persistent webhook idempotency keyed on Meta's `messages[].id` (wamid.xxx).
//
// Meta WhatsApp Cloud API is at-least-once with up to 7 days of exponential-
// backoff retry on any non-2xx (or timeout) webhook response. Without dedupe,
// every redelivery generates a fresh reply and double-bills Claude/Dynamics.
//
// The in-memory Map this replaces lost state on dev-server restart and
// couldn't span multiple ingester replicas; a Postgres unique-key insert is
// the canonical fix.

class IdempotencyService {
    private client: SupabaseClient;

    constructor() {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
        }
        this.client = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
    }

    /**
     * Record an inbound webhook event. Returns true if this is the first
     * time we've seen this Meta message id; false if it's a duplicate
     * redelivery. Duplicates should be silently dropped.
     *
     * Uses INSERT with ignoreDuplicates=true (Postgres ON CONFLICT DO NOTHING
     * on the primary key) so concurrent ingester replicas can race without
     * either of them seeing an error — exactly one row ends up persisted and
     * exactly one caller sees `true`.
     */
    async claim(metaMessageId: string, phoneNumber: string): Promise<boolean> {
        const { data, error } = await this.client
            .from('whatsapp_webhook_events')
            .upsert(
                { meta_message_id: metaMessageId, phone_number: phoneNumber },
                { onConflict: 'meta_message_id', ignoreDuplicates: true }
            )
            .select('meta_message_id');

        if (error) {
            // Fail open: if the dedupe table is unavailable we still want to
            // process the message rather than drop it on the floor. Logging
            // surfaces the outage; the worst-case outcome is a duplicate reply
            // on Meta retry, which is the same failure mode as before this
            // table existed.
            console.warn('[Idempotency] claim() failed, falling open:', error.message);
            return true;
        }

        // Supabase returns the inserted row(s) on success, an empty array on
        // ON CONFLICT DO NOTHING (duplicate).
        return Array.isArray(data) && data.length > 0;
    }

    /**
     * Acquire an in-flight mutex for the post-LoE activation flow for a given
     * lead. Returns true if the caller holds the claim and should proceed;
     * false if another invocation already holds it and the caller should bail.
     *
     * Backs the race fix in activateLeadPostLoe(): the Dynamics sentinel
     * check-then-write is not atomic, so two concurrent invocations both
     * passed the check and both ran the side effects (double "Got your LoE"
     * WhatsApp). A Postgres unique-key insert on `loe_activation_inflight` IS
     * atomic — exactly one concurrent caller gets the row.
     */
    async claimLoeActivation(leadId: string): Promise<boolean> {
        const { data, error } = await this.client
            .from('loe_activation_inflight')
            .upsert(
                { lead_id: leadId },
                { onConflict: 'lead_id', ignoreDuplicates: true }
            )
            .select('lead_id');

        if (error) {
            // Fail open: better to risk a rare duplicate than to block the
            // activation entirely when Supabase is down. Same posture as
            // claim() above.
            console.warn('[Idempotency] claimLoeActivation failed, falling open:', error.message);
            return true;
        }

        return Array.isArray(data) && data.length > 0;
    }

    /**
     * Release the in-flight mutex for a lead. Called in the activation
     * function's finally block — both success and failure release the lock
     * because the Dynamics sentinel is the long-term completion record. On
     * failure, releasing lets the hourly sweep retry; on success, the
     * Dynamics sentinel check at the top of the activation function
     * short-circuits any subsequent invocation.
     */
    async releaseLoeActivation(leadId: string): Promise<void> {
        const { error } = await this.client
            .from('loe_activation_inflight')
            .delete()
            .eq('lead_id', leadId);
        if (error) {
            // Non-fatal: a stale row will block re-entry until manually
            // cleared, but the immediate activation has already happened.
            console.warn(`[Idempotency] releaseLoeActivation failed for ${leadId}:`, error.message);
        }
    }

    /**
     * Delete webhook idempotency rows older than 7 days. Meta's at-least-once
     * retry window is 7 days, so anything older is dead weight that can't
     * cause a duplicate. Returns the number of rows deleted.
     */
    async cleanupOldWebhookEvents(): Promise<number> {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { error, count } = await this.client
            .from('whatsapp_webhook_events')
            .delete({ count: 'exact' })
            .lt('received_at', cutoff);
        if (error) {
            throw new Error(`cleanupOldWebhookEvents: ${error.message}`);
        }
        return count ?? 0;
    }

    /**
     * Land a failed job in the DLQ. Called from the BullMQ worker's `failed`
     * event after all retry attempts have been exhausted.
     */
    async recordDeadLetter(args: {
        jobId: string | undefined;
        queueName: string;
        metaMessageId: string | null;
        phoneNumber: string | null;
        payload: unknown;
        failedReason: string;
        attemptsMade: number;
        stackTrace: string | null;
    }): Promise<void> {
        const { error } = await this.client
            .from('whatsapp_queue_dlq')
            .insert({
                job_id: args.jobId,
                queue_name: args.queueName,
                meta_message_id: args.metaMessageId,
                phone_number: args.phoneNumber,
                payload: args.payload as any,
                failed_reason: args.failedReason,
                attempts_made: args.attemptsMade,
                stack_trace: args.stackTrace,
            });
        if (error) {
            console.error('[Idempotency] recordDeadLetter failed:', error.message);
        }
    }
}

export const idempotencyService = new IdempotencyService();
