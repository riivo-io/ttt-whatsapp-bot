/**
 * Extract the retry attempt number from a BullMQ jobId. Bare `wamid.xxx`
 * returns 0 (the first run, no retries yet). `wamid.xxx:retry:N` returns N.
 *
 * Kept as a tiny pure module so smoke tests can import it without pulling
 * in BullMQ + ioredis as transitive deps.
 */
export function parseRetryAttempt(jobId: string | undefined): number {
    if (!jobId) return 0;
    const match = jobId.match(/:retry:(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
}
