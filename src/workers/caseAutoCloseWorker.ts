import {
    ServiceBusReceiver,
    ServiceBusReceivedMessage,
    ProcessErrorArgs,
} from '@azure/service-bus';
import { getServiceBusClient } from '../queue/connection';
import {
    CASE_AUTO_CLOSE_QUEUE,
    CaseAutoCloseJobPayload,
} from '../queue/caseAutoCloseQueue';
import { supabaseService } from '../services/supabase.service';
import {
    dynamicsService,
    REQUEST_STATE,
    REQUEST_STATUSCODE,
    RESOLUTION_METHOD,
    CLIENT_FEEDBACK,
} from '../services/dynamics.service';
import { caseService } from '../services/case.service';
import { messageContextStorage } from '../utils/messageContext';

// 10-min auto-close for cases left in the feedback-prompt window.
//
// Enqueued by the feedback prompt worker right after the Yes/No buttons go
// out. At fire time we re-read the case + check for client inbound since the
// prompt. If the case is still in `bot_responded` and the client hasn't said
// anything, we close it as Resolved (Timeout). Same terminal state as the
// 12h sweep — just earlier so cases don't pile up.

let receiver: ServiceBusReceiver | null = null;
let running = false;

export async function processCaseAutoCloseJob(payload: CaseAutoCloseJobPayload): Promise<void> {
    const { caseId, sessionId, crmRequestId, promptSentAt } = payload;

    const row = await supabaseService.getCase(caseId);
    if (!row) {
        console.log(`[CaseAutoClose] skipped caseId=${caseId} sessionId=${sessionId} reason=case_missing`);
        return;
    }
    if (row.status !== 'bot_responded') {
        console.log(`[CaseAutoClose] skipped caseId=${caseId} sessionId=${sessionId} reason=status=${row.status}`);
        return;
    }

    const clientReplied = await supabaseService.hasClientInboundSince(sessionId, promptSentAt);
    if (clientReplied) {
        console.log(`[CaseAutoClose] skipped caseId=${caseId} sessionId=${sessionId} reason=inbound_since=${promptSentAt}`);
        return;
    }

    const resolvedAt = new Date().toISOString();
    await supabaseService.updateCase(caseId, {
        status: 'resolved_by_bot_timeout',
        resolved_at: resolvedAt,
    });
    await supabaseService.setSessionPendingCase(sessionId, null);

    if (crmRequestId) {
        try {
            await dynamicsService.updateRequest(crmRequestId, {
                statecode: REQUEST_STATE.INACTIVE,
                statuscode: REQUEST_STATUSCODE.RESOLVED_TIMEOUT,
                riivo_clientfeedback: CLIENT_FEEDBACK.NO_RESPONSE_TIMEOUT,
                riivo_resolvedon: resolvedAt,
                riivo_resolutionmethod: RESOLUTION_METHOD.TIMEOUT_ASSUMED_RESOLVED,
            });
        } catch (e: any) {
            console.warn(`[CaseAutoClose] dynamics_mirror_failed caseId=${caseId} err=${e?.message || e}`);
        }
    }
    // Fire-and-forget the consultant close summary, same as the other close
    // paths. The summary is gated on the session being noteworthy (doc upload
    // or escalation) and is idempotent per session, so this is safe even if
    // another close path already ran for the same session.
    caseService.triggerCloseSummary(sessionId);

    console.log(`[CaseAutoClose] fired caseId=${caseId} sessionId=${sessionId}`);
}

async function handleMessage(
    rec: ServiceBusReceiver,
    msg: ServiceBusReceivedMessage,
): Promise<void> {
    const payload = msg.body as CaseAutoCloseJobPayload;
    const deliveryCount = (msg.deliveryCount ?? 0) + 1;
    try {
        await messageContextStorage.run({ phoneNumberId: '' }, async () => {
            await processCaseAutoCloseJob(payload);
        });
        await rec.completeMessage(msg);
    } catch (err: any) {
        console.warn(
            `[CaseAutoCloseWorker] msg=${msg.messageId} delivery=${deliveryCount} err=${err?.message || err}`
        );
        await rec.abandonMessage(msg);
    }
}

export function startCaseAutoCloseWorker(): void {
    if (running) return;
    running = true;
    const client = getServiceBusClient();
    receiver = client.createReceiver(CASE_AUTO_CLOSE_QUEUE, { receiveMode: 'peekLock' });

    receiver.subscribe({
        processMessage: async (msg) => {
            if (!receiver) return;
            await handleMessage(receiver, msg);
        },
        processError: async (args: ProcessErrorArgs) => {
            console.error('[CaseAutoCloseWorker]', args.error?.message || args.error);
        },
    }, {
        maxConcurrentCalls: 4,
        autoCompleteMessages: false,
    });

    console.log('[CaseAutoCloseWorker] Started case-auto-close receiver (concurrency=4)');
}

export async function stopCaseAutoCloseWorker(): Promise<void> {
    running = false;
    if (receiver) {
        try {
            await receiver.close();
        } catch (e: any) {
            console.warn('[CaseAutoCloseWorker] receiver.close error:', e?.message || e);
        }
        receiver = null;
    }
}
