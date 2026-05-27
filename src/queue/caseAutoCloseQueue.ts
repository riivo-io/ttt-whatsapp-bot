import { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import { getServiceBusClient } from './connection';

// Delayed auto-close for cases left in the feedback-prompt window. When the
// feedback prompt worker successfully sends the Yes/No buttons, it enqueues
// one of these jobs 10 minutes out. At fire time the worker re-reads the
// case and only closes it as Resolved (Timeout) if the client never replied
// and the case is still in `bot_responded`. This is the short-tail close
// mechanism so we don't sit on the 12h sweep for every silent client.

export const CASE_AUTO_CLOSE_QUEUE = 'case-auto-close';

export const CASE_AUTO_CLOSE_DELAY_MS = 600_000; // 10 minutes

export interface CaseAutoCloseJobPayload {
    caseId: string;              // whatsapp_cases.id (uuid)
    sessionId: string;           // sessions.id
    crmRequestId: string | null; // riivo_request guid for Dynamics patch
    promptSentAt: string;        // ISO 8601 timestamp of when the buttons went out
}

let sender: ServiceBusSender | null = null;

function getSender(): ServiceBusSender {
    if (sender) return sender;
    sender = getServiceBusClient().createSender(CASE_AUTO_CLOSE_QUEUE);
    return sender;
}

export async function enqueueCaseAutoClose(payload: CaseAutoCloseJobPayload): Promise<void> {
    const msg: ServiceBusMessage = {
        body: payload,
        // messageId = autoclose-<caseId> guarantees at most one delayed close
        // per case even if the enqueue site is retried within the ASB dedup
        // window. The 10-min delay is comfortably under that window.
        messageId: `autoclose-${payload.caseId}`,
        scheduledEnqueueTimeUtc: new Date(Date.now() + CASE_AUTO_CLOSE_DELAY_MS),
    };
    await getSender().sendMessages(msg);
}

export async function closeCaseAutoCloseQueue(): Promise<void> {
    if (sender) {
        await sender.close();
        sender = null;
    }
}
