import { Queue, JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createRedisConnection } from './connection';

// Sharded queue design for per-conversation FIFO:
//
//   shard(phone) = hash(phone) % NUM_SHARDS
//
// Every message from the same phone lands in the same shard queue. Each
// shard runs with worker concurrency = 1, giving strict in-order processing
// per phone. Across shards runs in parallel.
//
// Tune NUM_SHARDS up for more parallel throughput at the cost of more Redis
// connections (each shard owns one blocking BLPOP connection on the worker
// side). 16 shards is a reasonable default for ~5000 concurrent users —
// each shard handles ~300 users serially.

// NUM_SHARDS is resolved lazily — evaluating at module-import time runs
// before server.ts's dotenv.config(), so process.env.WORKER_NUM_SHARDS
// wouldn't be set yet.
let cachedNumShards: number | null = null;
export function getNumShards(): number {
    if (cachedNumShards !== null) return cachedNumShards;
    cachedNumShards = Math.max(
        1,
        parseInt(process.env.WORKER_NUM_SHARDS || '16', 10)
    );
    return cachedNumShards;
}

export const SHARD_QUEUE_PREFIX = 'whatsapp-inbound';

export function shardQueueName(shardIndex: number): string {
    return `${SHARD_QUEUE_PREFIX}-${shardIndex}`;
}

// FNV-1a-ish 32-bit hash. Cheap, well-distributed, doesn't pull in a crypto
// dep. Used only for shard routing — not security-sensitive.
export function shardFor(phone: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < phone.length; i++) {
        h ^= phone.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h % getNumShards();
}

// The exact shape passed from the webhook ingester to the worker. Keep this
// minimal — it gets serialized to Redis and stored until the worker picks it
// up. Anything reconstructible from `phone` + `metaMessageId` should be
// fetched inside the worker, not stashed in the payload.
export type WhatsAppJobPayload = {
    metaMessageId: string;          // wamid.xxx — also used as BullMQ jobId
    phone: string;                  // sender E.164 sans `+`
    phoneNumberId: string | null;   // metadata.phone_number_id (for multi-number routing)
    receivedAt: number;             // Date.now() at ingest — for end-to-end latency
    rawMessage: any;                // Meta's `messages[i]` object, unmodified
};

let producerQueues: Queue<WhatsAppJobPayload>[] | null = null;
let producerConnections: Redis[] | null = null;

function getProducerQueues(): Queue<WhatsAppJobPayload>[] {
    if (producerQueues) return producerQueues;
    // One ioredis connection per Queue — sharing breaks under load on Upstash.
    producerConnections = Array.from({ length: getNumShards() }, () => createRedisConnection());
    producerQueues = producerConnections.map((connection, i) =>
        new Queue<WhatsAppJobPayload>(shardQueueName(i), {
            connection,
            defaultJobOptions: {
                // Up to 4 retries on transient failures with exponential backoff.
                // After that the job lands in the DLQ via the worker's failed
                // handler in whatsappWorker.ts.
                attempts: 4,
                backoff: { type: 'exponential', delay: 2000 },
                // Keep recent completed jobs briefly for observability, but bound
                // both lists so Redis memory stays predictable.
                removeOnComplete: { age: 3600, count: 1000 },
                removeOnFail: { age: 24 * 3600, count: 5000 },
            },
        })
    );
    return producerQueues;
}

/**
 * Enqueue an inbound WhatsApp message for worker processing.
 *
 * The `metaMessageId` doubles as the BullMQ jobId — BullMQ silently no-ops
 * if a job with the same id is already in the queue, giving us a second line
 * of dedupe defense on top of the Supabase idempotency table. (Belt and
 * braces: Supabase covers the durable case, jobId dedupe covers the rare
 * race where two ingester replicas fire the insert concurrently.)
 */
export async function enqueueInboundMessage(payload: WhatsAppJobPayload): Promise<void> {
    const queues = getProducerQueues();
    const queue = queues[shardFor(payload.phone)];
    const opts: JobsOptions = { jobId: payload.metaMessageId };
    await queue.add('inbound', payload, opts);
}

/**
 * Re-enqueue a job that hit an Anthropic 429. With concurrency=1 per shard,
 * a sleeping worker would block every other phone hashed to that shard, so
 * we mark the original job complete and add a fresh delayed one instead.
 *
 * The jobId is namespaced as `${wamid}:retry:${attemptNum}` so:
 *   - it doesn't collide with the original wamid job
 *   - Meta redelivering the bare wamid is still rejected by the idempotency
 *     table (claim() returns false → ingester drops)
 *   - successive retries don't collide with each other
 */
export async function enqueueRetryAfterRateLimit(
    payload: WhatsAppJobPayload,
    attemptNum: number,
    delayMs: number,
): Promise<void> {
    const queues = getProducerQueues();
    const queue = queues[shardFor(payload.phone)];
    const opts: JobsOptions = {
        jobId: `${payload.metaMessageId}:retry:${attemptNum}`,
        delay: Math.max(1, Math.floor(delayMs)),
    };
    await queue.add('inbound', payload, opts);
}

// Pure helper lives in src/utils/jobIdRetry so smoke tests can import it
// without pulling in BullMQ + ioredis transitively.
export { parseRetryAttempt } from '../utils/jobIdRetry';

export async function closeProducerQueues(): Promise<void> {
    if (producerQueues) {
        await Promise.all(producerQueues.map(q => q.close()));
        producerQueues = null;
    }
    if (producerConnections) {
        await Promise.all(producerConnections.map(c => c.quit()));
        producerConnections = null;
    }
}
