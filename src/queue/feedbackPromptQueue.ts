import { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import { getServiceBusClient } from './connection';

// Delayed-job queue for the L1 feedback prompt.
//
// After the bot answers an L1 query we don't ping the client with buttons
// immediately. Instead we schedule a 2.5-minute delayed message here, and
// the worker checks at fire time whether the client has gone idle (no
// inbound since the bot's answer, no superseding case in the session). If
// the checks pass, the buttons go out; otherwise the prompt is silently
// skipped.
//
// Sessions are OFF — the rate of L1 answers is low and ordering across
// phones doesn't matter. ASB's scheduledEnqueueTimeUtc replaces BullMQ's
// `delay` option.

export const FEEDBACK_PROMPT_QUEUE = 'feedback-prompt';

export const FEEDBACK_PROMPT_DELAY_MS = 150_000; // 2.5 minutes

export interface FeedbackPromptJobPayload {
    caseId: string;              // whatsapp_cases.id (uuid)
    sessionId: string;           // sessions.id
    phoneNumber: string;         // E.164, recipient
    crmRequestId: string | null; // riivo_request guid for Dynamics patch
    botAnswerSentAt: string;     // ISO 8601 timestamp of the bot's answer outbound
}

let sender: ServiceBusSender | null = null;

function getSender(): ServiceBusSender {
    if (sender) return sender;
    sender = getServiceBusClient().createSender(FEEDBACK_PROMPT_QUEUE);
    return sender;
}

export async function enqueueFeedbackPrompt(payload: FeedbackPromptJobPayload): Promise<void> {
    const msg: ServiceBusMessage = {
        body: payload,
        // messageId is keyed by case AND answer timestamp — one delayed prompt
        // per bot answer, not per case. A case reused across a multi-turn
        // conversation (each answer calls enqueueFeedbackPrompt) must schedule a
        // fresh prompt per answer: keying on caseId alone would let the queue's
        // 10-min duplicate detection drop every prompt after the first, leaving
        // only a stale one pinned to the earliest answer — which then always
        // fails the worker's "client replied since?" idle check and never fires.
        // Per-answer keying lets every answer schedule its own check; the worker
        // collapses them (pending_case_id + idle check) so at most one sends.
        // Same answer re-enqueued (enqueue-site retry) still dedups on the
        // identical botAnswerSentAt.
        messageId: `prompt-${payload.caseId}-${payload.botAnswerSentAt}`,
        scheduledEnqueueTimeUtc: new Date(Date.now() + FEEDBACK_PROMPT_DELAY_MS),
    };
    await getSender().sendMessages(msg);
}

export async function closeFeedbackPromptQueue(): Promise<void> {
    if (sender) {
        await sender.close();
        sender = null;
    }
}
