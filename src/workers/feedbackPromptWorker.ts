import {
    ServiceBusReceiver,
    ServiceBusReceivedMessage,
    ProcessErrorArgs,
} from '@azure/service-bus';
import { getServiceBusClient } from '../queue/connection';
import {
    FEEDBACK_PROMPT_QUEUE,
    FeedbackPromptJobPayload,
} from '../queue/feedbackPromptQueue';
import { supabaseService } from '../services/supabase.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService, REQUEST_STATUSCODE } from '../services/dynamics.service';
import {
    CASE_FEEDBACK_BUTTON_YES_PREFIX,
    CASE_FEEDBACK_BUTTON_NO_PREFIX,
    CASE_FEEDBACK_PROMPT_TEXT,
} from '../services/case.service';
import { enqueueCaseAutoClose } from '../queue/caseAutoCloseQueue';
import { messageContextStorage } from '../utils/messageContext';

// Idle-window feedback prompt.
//
// Job fires 2.5 minutes after the bot answered an L1 query. We don't actively
// cancel jobs when state changes — instead the handler re-reads case + session
// + messages and decides whether the prompt is still appropriate. This is
// robust to restarts and missed cancellations.
//
// Skip reasons are emitted as structured `[FeedbackPrompt]` log lines so we
// can watch fire/skip ratios without extra infra.

let receiver: ServiceBusReceiver | null = null;
let running = false;

export async function processFeedbackPromptJob(payload: FeedbackPromptJobPayload): Promise<void> {
    const { caseId, sessionId, phoneNumber, crmRequestId, botAnswerSentAt } = payload;

    // 1. Case must still be in bot_responded (not already confirmed, escalated,
    //    timed out, or superseded by some other transition).
    const row = await supabaseService.getCase(caseId);
    if (!row) {
        console.log(`[FeedbackPrompt] skipped_case_resolved caseId=${caseId} sessionId=${sessionId} reason=case_missing`);
        return;
    }
    if (row.status !== 'bot_responded') {
        console.log(`[FeedbackPrompt] skipped_case_resolved caseId=${caseId} sessionId=${sessionId} reason=status=${row.status}`);
        return;
    }

    // 2. Client must not have sent any inbound after the bot's answer.
    const clientReplied = await supabaseService.hasClientInboundSince(sessionId, botAnswerSentAt);
    if (clientReplied) {
        console.log(`[FeedbackPrompt] skipped_client_replied caseId=${caseId} sessionId=${sessionId} reason=inbound_since=${botAnswerSentAt}`);
        return;
    }

    // 3. Session must not have any pending prompt in flight. Multiple enqueues
    //    across a conversation (each bot answer schedules one) collapse here:
    //    once the first prompt fires, pending_case_id is set and every later
    //    prompt skips. pending_case_id is cleared when the client replies or
    //    when their feedback resolves the case, freeing future sessions.
    const session = await supabaseService.getSession(sessionId);
    if (!session) {
        console.log(`[FeedbackPrompt] skipped_session_superseded caseId=${caseId} sessionId=${sessionId} reason=session_missing`);
        return;
    }
    if (session.pending_case_id) {
        console.log(`[FeedbackPrompt] skipped_session_superseded caseId=${caseId} sessionId=${sessionId} reason=pending=${session.pending_case_id}`);
        return;
    }

    // All checks passed — fire the prompt.
    try {
        await metaWhatsAppService.sendReplyButtons(
            phoneNumber,
            CASE_FEEDBACK_PROMPT_TEXT,
            [
                // Per-case ids so a late tap (after auto-close or even after the
                // session rolled over) still resolves to THIS exact case rather
                // than falling through and spawning a duplicate.
                { id: `${CASE_FEEDBACK_BUTTON_YES_PREFIX}:${caseId}`, title: 'Yes, thanks' },
                { id: `${CASE_FEEDBACK_BUTTON_NO_PREFIX}:${caseId}`, title: 'Still need help' },
            ]
        );
        // Persist the prompt as an assistant message so the processor's
        // "previous bot turn was the prompt" gate can match it on the next
        // inbound (otherwise the prompt is button-only and invisible to the
        // gate, which would let any "yes" mid-conversation close the case).
        await supabaseService.saveMessage(sessionId, 'assistant', CASE_FEEDBACK_PROMPT_TEXT);
        const promptSentAt = new Date().toISOString();
        await supabaseService.setSessionPendingCase(sessionId, caseId);
        if (crmRequestId) {
            await dynamicsService.updateRequest(crmRequestId, {
                statuscode: REQUEST_STATUSCODE.AWAITING_FEEDBACK,
            });
        }
        console.log(`[FeedbackPrompt] fired caseId=${caseId} sessionId=${sessionId}`);

        // Schedule the short-tail auto-close. If the client doesn't tap a
        // button (or otherwise reply) within 10 min, the case closes as
        // Resolved (Timeout). Failure to enqueue isn't fatal — the 12h
        // sweep is still the safety net.
        try {
            await enqueueCaseAutoClose({
                caseId,
                sessionId,
                crmRequestId,
                promptSentAt,
            });
        } catch (e: any) {
            console.warn(`[CaseAutoClose] enqueue_failed caseId=${caseId} sessionId=${sessionId} err=${e?.message || e}`);
        }
    } catch (e: any) {
        console.warn(`[FeedbackPrompt] send_failed caseId=${caseId} sessionId=${sessionId} err=${e?.message || e}`);
        throw e;
    }
}

async function handleMessage(
    rec: ServiceBusReceiver,
    msg: ServiceBusReceivedMessage,
): Promise<void> {
    const payload = msg.body as FeedbackPromptJobPayload;
    const deliveryCount = (msg.deliveryCount ?? 0) + 1;
    try {
        // sendMessage requires phoneNumberId in AsyncLocalStorage scope for
        // the multi-number routing path; for now we don't have it on the
        // payload, so we run with an empty ctx (single-number prod setup).
        await messageContextStorage.run({ phoneNumberId: '' }, async () => {
            await processFeedbackPromptJob(payload);
        });
        await rec.completeMessage(msg);
    } catch (err: any) {
        console.warn(
            `[FeedbackPromptWorker] msg=${msg.messageId} delivery=${deliveryCount} err=${err?.message || err}`
        );
        // ASB will redeliver up to max-delivery (5) configured on the queue;
        // after that it lands in the queue's DLQ automatically.
        await rec.abandonMessage(msg);
    }
}

export function startFeedbackPromptWorker(): void {
    if (running) return;
    running = true;
    const client = getServiceBusClient();
    receiver = client.createReceiver(FEEDBACK_PROMPT_QUEUE, { receiveMode: 'peekLock' });

    receiver.subscribe({
        processMessage: async (msg) => {
            if (!receiver) return;
            await handleMessage(receiver, msg);
        },
        processError: async (args: ProcessErrorArgs) => {
            console.error('[FeedbackPromptWorker]', args.error?.message || args.error);
        },
    }, {
        maxConcurrentCalls: 4,
        autoCompleteMessages: false,
    });

    console.log('[FeedbackPromptWorker] Started feedback-prompt receiver (concurrency=4)');
}

export async function stopFeedbackPromptWorker(): Promise<void> {
    running = false;
    if (receiver) {
        try {
            await receiver.close();
        } catch (e: any) {
            console.warn('[FeedbackPromptWorker] receiver.close error:', e?.message || e);
        }
        receiver = null;
    }
}
