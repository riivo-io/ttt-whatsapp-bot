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
        // messageId = prompt-<caseId> guarantees at most one delayed prompt
        // per case even if the enqueue site is ever retried (within the
        // 10-min dedup window — well under the 2.5-min delay).
        messageId: `prompt-${payload.caseId}`,
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
