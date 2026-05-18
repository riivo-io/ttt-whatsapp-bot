import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { createRedisConnection } from '../queue/connection';
import {
    getNumShards,
    shardQueueName,
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

// One Worker per shard. concurrency=1 guarantees strict in-order processing
// within a shard, which (combined with hash-routing in whatsappQueue.ts)
// gives strict FIFO per phone number. Across shards runs in parallel.

type StartedWorker = Worker<WhatsAppJobPayload>;

let workers: StartedWorker[] | null = null;
let workerConnections: Redis[] | null = null;

export function startWhatsAppWorkers(): StartedWorker[] {
    if (workers) return workers;

    // One ioredis connection per Worker — sharing a single connection across
    // all shards breaks on Upstash with mid-stream ECONNRESET.
    workerConnections = Array.from({ length: getNumShards() }, () => createRedisConnection());
    workers = workerConnections.map((connection, shardIndex) => {
        const name = shardQueueName(shardIndex);
        const worker = new Worker<WhatsAppJobPayload>(
            name,
            async (job: Job<WhatsAppJobPayload>) => {
                const queuedFor = Date.now() - job.data.receivedAt;
                console.log(
                    `[Worker:${shardIndex}] job=${job.id} phone=${job.data.phone} queuedMs=${queuedFor} attempt=${job.attemptsMade + 1}`
                );
                try {
                    await processInboundJob(job.data);
                } catch (err) {
                    // RateLimitError MUST be checked before the generic handler
                    // (per breakdown §5.1) so we re-enqueue with delay instead
                    // of letting BullMQ's exponential backoff run — that would
                    // block the entire shard for tens of seconds.
                    if (err instanceof RateLimitError) {
                        const currentAttempt = parseRetryAttempt(job.id);
                        const nextAttempt = currentAttempt + 1;
                        if (currentAttempt >= MAX_RATE_LIMIT_RETRIES) {
                            console.error(
                                `[Worker:${shardIndex}] rate-limit retry cap reached for job=${job.id} phone=${job.data.phone} — DLQ`
                            );
                            await idempotencyService.recordDeadLetter({
                                jobId: job.id,
                                queueName: name,
                                metaMessageId: job.data?.metaMessageId ?? null,
                                phoneNumber: job.data?.phone ?? null,
                                payload: job.data,
                                failedReason: 'rate_limit_exceeded_after_5_retries',
                                attemptsMade: currentAttempt,
                                stackTrace: err.stack ?? null,
                            });
                            // Returning normally marks the original job complete —
                            // no BullMQ retry storm, no shard blocking.
                            return;
                        }
                        console.warn(
                            `[Worker:${shardIndex}] 429 — re-enqueue job=${job.id} as retry:${nextAttempt} delayMs=${err.retryAfterMs}`
                        );
                        await enqueueRetryAfterRateLimit(job.data, nextAttempt, err.retryAfterMs);
                        return;
                    }
                    throw err;
                }
            },
            {
                connection,
                concurrency: 1,
            }
        );

        worker.on('completed', (job, _result, prev) => {
            console.log(
                `[Worker:${shardIndex}] completed job=${job.id} prev=${prev} totalMs=${Date.now() - job.data.receivedAt}`
            );
        });

        worker.on('failed', async (job, err) => {
            if (!job) {
                console.error(`[Worker:${shardIndex}] failed with no job:`, err.message);
                return;
            }
            const attemptsMade = job.attemptsMade;
            const maxAttempts = job.opts.attempts ?? 1;
            console.warn(
                `[Worker:${shardIndex}] failed job=${job.id} phone=${job.data?.phone} attempt=${attemptsMade}/${maxAttempts} err=${err.message}`
            );

            // Only DLQ once we've exhausted retries. Intermediate failures stay
            // in BullMQ's normal retry loop with exponential backoff.
            if (attemptsMade >= maxAttempts) {
                try {
                    await idempotencyService.recordDeadLetter({
                        jobId: job.id,
                        queueName: name,
                        metaMessageId: job.data?.metaMessageId ?? null,
                        phoneNumber: job.data?.phone ?? null,
                        payload: job.data,
                        failedReason: err.message,
                        attemptsMade,
                        stackTrace: err.stack ?? null,
                    });
                    console.error(
                        `[Worker:${shardIndex}] DLQ landed job=${job.id} phone=${job.data?.phone}`
                    );
                } catch (dlqErr: any) {
                    console.error(
                        `[Worker:${shardIndex}] DLQ write failed for job=${job.id}:`,
                        dlqErr?.message || dlqErr
                    );
                }
            }
        });

        worker.on('error', (err) => {
            console.error(`[Worker:${shardIndex}] worker error:`, err.message);
        });

        return worker;
    });

    console.log(`[Worker] Started ${getNumShards()} shard workers (concurrency=1 each)`);
    return workers;
}

export async function stopWhatsAppWorkers(): Promise<void> {
    if (!workers && !workerConnections) return;
    console.log('[Worker] Stopping workers...');
    if (workers) {
        await Promise.all(workers.map(w => w.close()));
        workers = null;
    }
    if (workerConnections) {
        await Promise.all(workerConnections.map(c => c.quit()));
        workerConnections = null;
    }
    console.log('[Worker] Workers stopped.');
}
