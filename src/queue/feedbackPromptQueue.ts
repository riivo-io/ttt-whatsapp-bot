import { Queue, JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createRedisConnection } from './connection';

// Delayed-job queue for the L1 feedback prompt.
//
// After the bot answers an L1 query we don't ping the client with buttons
// immediately. Instead we schedule a 2.5-minute delayed job here, and the
// worker checks at fire time whether the client has gone idle (no inbound
// since the bot's answer, no superseding case in the session). If the checks
// pass, the buttons go out; otherwise the prompt is silently skipped.
//
// Single queue (no sharding) — the rate of L1 answers is low enough that one
// BullMQ worker comfortably handles it. The state-check is idempotent so
// retries are safe.

export const FEEDBACK_PROMPT_QUEUE = 'feedback-prompt';
export const FEEDBACK_PROMPT_JOB = 'send-feedback-prompt';

export const FEEDBACK_PROMPT_DELAY_MS = 150_000; // 2.5 minutes

export interface FeedbackPromptJobPayload {
    caseId: string;              // whatsapp_cases.id (uuid)
    sessionId: string;           // sessions.id
    phoneNumber: string;         // E.164, recipient
    crmRequestId: string | null; // riivo_request guid for Dynamics patch
    botAnswerSentAt: string;     // ISO 8601 timestamp of the bot's answer outbound
}

let producerQueue: Queue<FeedbackPromptJobPayload> | null = null;
let producerConnection: Redis | null = null;

function getQueue(): Queue<FeedbackPromptJobPayload> {
    if (producerQueue) return producerQueue;
    producerConnection = createRedisConnection();
    producerQueue = new Queue<FeedbackPromptJobPayload>(FEEDBACK_PROMPT_QUEUE, {
        connection: producerConnection,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86_400 },
        },
    });
    return producerQueue;
}

export async function enqueueFeedbackPrompt(payload: FeedbackPromptJobPayload): Promise<void> {
    const queue = getQueue();
    const opts: JobsOptions = {
        delay: FEEDBACK_PROMPT_DELAY_MS,
        // jobId = caseId guarantees at most one delayed prompt per case even
        // if the enqueue site is ever retried.
        jobId: `prompt-${payload.caseId}`,
    };
    await queue.add(FEEDBACK_PROMPT_JOB, payload, opts);
}

export async function closeFeedbackPromptQueue(): Promise<void> {
    if (producerQueue) {
        await producerQueue.close();
        producerQueue = null;
    }
    if (producerConnection) {
        await producerConnection.quit();
        producerConnection = null;
    }
}
