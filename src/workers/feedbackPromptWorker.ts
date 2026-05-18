import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { createRedisConnection } from '../queue/connection';
import {
    FEEDBACK_PROMPT_QUEUE,
    FeedbackPromptJobPayload,
} from '../queue/feedbackPromptQueue';
import { supabaseService } from '../services/supabase.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService, REQUEST_STATUSCODE } from '../services/dynamics.service';
import {
    CASE_FEEDBACK_BUTTON_YES,
    CASE_FEEDBACK_BUTTON_NO,
} from '../services/case.service';
import { messageContextStorage } from '../utils/messageContext';

// Idle-window feedback prompt.
//
// Job fires 2.5 minutes after the bot answered an L1 query. We don't actively
// cancel jobs when state changes — instead the handler re-reads case + session
// + messages and decides whether the prompt is still appropriate. This is
// robust to restarts and missed cancellations.
//
// Skip reasons are emitted as structured `[FeedbackPrompt]` log lines so we
// can watch fire/skip ratios in Vercel logs without extra infra.

let worker: Worker<FeedbackPromptJobPayload> | null = null;
let workerConnection: Redis | null = null;

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

    // 3. Session must not have another pending prompt in flight.
    const session = await supabaseService.getSession(sessionId);
    if (!session) {
        console.log(`[FeedbackPrompt] skipped_session_superseded caseId=${caseId} sessionId=${sessionId} reason=session_missing`);
        return;
    }
    if (session.pending_case_id && session.pending_case_id !== caseId) {
        console.log(`[FeedbackPrompt] skipped_session_superseded caseId=${caseId} sessionId=${sessionId} reason=pending=${session.pending_case_id}`);
        return;
    }

    // All checks passed — fire the prompt.
    try {
        await metaWhatsAppService.sendReplyButtons(
            phoneNumber,
            'Did that answer your question?',
            [
                { id: CASE_FEEDBACK_BUTTON_YES, title: 'Yes, thanks' },
                { id: CASE_FEEDBACK_BUTTON_NO, title: 'Still need help' },
            ]
        );
        await supabaseService.setSessionPendingCase(sessionId, caseId);
        if (crmRequestId) {
            await dynamicsService.updateRequest(crmRequestId, {
                statuscode: REQUEST_STATUSCODE.AWAITING_FEEDBACK,
            });
        }
        console.log(`[FeedbackPrompt] fired caseId=${caseId} sessionId=${sessionId}`);
    } catch (e: any) {
        console.warn(`[FeedbackPrompt] send_failed caseId=${caseId} sessionId=${sessionId} err=${e?.message || e}`);
        throw e;
    }
}

export function startFeedbackPromptWorker(): Worker<FeedbackPromptJobPayload> {
    if (worker) return worker;

    workerConnection = createRedisConnection();
    worker = new Worker<FeedbackPromptJobPayload>(
        FEEDBACK_PROMPT_QUEUE,
        async (job: Job<FeedbackPromptJobPayload>) => {
            // sendMessage requires phoneNumberId in AsyncLocalStorage scope for
            // the multi-number routing path; for now we don't have it on the
            // payload, so we run with an empty ctx (single-number prod setup).
            await messageContextStorage.run({ phoneNumberId: '' }, async () => {
                await processFeedbackPromptJob(job.data);
            });
        },
        {
            connection: workerConnection,
            concurrency: 4,
        }
    );

    worker.on('error', (err) => {
        console.error('[FeedbackPromptWorker] worker error:', err.message);
    });

    worker.on('failed', (job, err) => {
        const attempts = job?.attemptsMade ?? 0;
        const max = job?.opts.attempts ?? 1;
        console.warn(`[FeedbackPromptWorker] job=${job?.id} attempt=${attempts}/${max} err=${err.message}`);
    });

    console.log('[FeedbackPromptWorker] Started feedback-prompt worker (concurrency=4)');
    return worker;
}

export async function stopFeedbackPromptWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
    if (workerConnection) {
        await workerConnection.quit();
        workerConnection = null;
    }
}
