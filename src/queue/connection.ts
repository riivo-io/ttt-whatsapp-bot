import IORedis, { Redis, RedisOptions } from 'ioredis';

// Factory pattern for BullMQ Redis connections.
//
// Sharing one ioredis instance across many Queue/Worker objects causes
// mid-stream ECONNRESET on Upstash (BullMQ pipelines setup commands across
// all queues onto the shared socket, which Upstash drops). The canonical
// fix per BullMQ docs is to let each Queue/Worker own its own connection
// — call `createRedisConnection()` per consumer.
//
// Upstash works fine when the URL uses `rediss://` (TLS); do NOT pass an
// explicit `tls` option, as a partial tls config overrides the scheme-
// derived defaults and breaks the handshake.

function getBaseOptions(): RedisOptions {
    return {
        // BullMQ requirements for blocking ops:
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        // Force IPv4. Upstash hostnames resolve to both A and AAAA; when Node
        // picks the AAAA record and the egress network has flaky IPv6 (most
        // home/ISP networks), TLS reads hang and get reset.
        family: 4,
        connectTimeout: 30_000,
    };
}

export function createRedisConnection(): Redis {
    const url = process.env.REDIS_URL;
    if (!url) {
        throw new Error('REDIS_URL is not set — the queue cannot connect to Redis.');
    }
    const conn = new IORedis(url, getBaseOptions());
    conn.on('error', (err) => {
        console.error('[Redis] connection error:', err.message);
    });
    return conn;
}
