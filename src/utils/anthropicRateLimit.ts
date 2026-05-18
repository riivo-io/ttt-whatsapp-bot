import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic rate-limit headers, parsed from a successful response. Made
 * available to logUsage so the persistence layer can record them in the
 * claude_usage row (see Issue 8).
 */
export interface RateLimitHeaders {
    tokensRemaining?: number;
    tokensLimit?: number;
    requestsRemaining?: number;
    requestsLimit?: number;
}

/**
 * Thrown when the SDK surfaces a 429. The worker catches this and re-enqueues
 * the job with delay = retryAfterMs instead of failing it — see Issue 6.
 */
export class RateLimitError extends Error {
    constructor(
        public readonly retryAfterMs: number,
        public readonly attemptNum: number,
        public readonly originalError: unknown,
        public readonly rateLimit: RateLimitHeaders = {},
    ) {
        super(`Anthropic 429 — retry after ${retryAfterMs}ms (attempt ${attemptNum})`);
        this.name = 'RateLimitError';
    }
}

function readHeader(headers: any, key: string): string | null {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(key);
    return headers[key] ?? headers[key.toLowerCase()] ?? null;
}

export function parseRateLimitHeaders(headers: any): RateLimitHeaders {
    const num = (k: string): number | undefined => {
        const v = readHeader(headers, k);
        if (v == null) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };
    return {
        tokensRemaining: num('anthropic-ratelimit-tokens-remaining'),
        tokensLimit: num('anthropic-ratelimit-tokens-limit'),
        requestsRemaining: num('anthropic-ratelimit-requests-remaining'),
        requestsLimit: num('anthropic-ratelimit-requests-limit'),
    };
}

/**
 * Wraps a single Anthropic messages.create call. Returns the message plus
 * the parsed rate-limit headers, and translates a 429 status into a typed
 * RateLimitError that the worker re-enqueue path can recognise.
 *
 * Caller passes `attemptNum` so the throw carries the retry count for the
 * worker's depth cap.
 */
export async function callAnthropicMessages(
    client: Anthropic,
    params: Anthropic.MessageCreateParams,
    attemptNum: number = 1,
): Promise<{ message: Anthropic.Message; rateLimit: RateLimitHeaders }> {
    try {
        const withResp: any = await (client.messages.create(params) as any).withResponse();
        const message = withResp.data as Anthropic.Message;
        const rateLimit = parseRateLimitHeaders(withResp.response?.headers);
        return { message, rateLimit };
    } catch (err: any) {
        const status = err?.status ?? err?.response?.status;
        if (status === 429) {
            const headers = err?.headers ?? err?.response?.headers;
            const retryAfterRaw = readHeader(headers, 'retry-after');
            const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : 60;
            const retryAfterMs = Math.max(1, Math.floor((Number.isFinite(retryAfterSec) ? retryAfterSec : 60) * 1000));
            const rl = parseRateLimitHeaders(headers);
            const ratio = rl.tokensRemaining != null && rl.tokensLimit
                ? (rl.tokensRemaining / rl.tokensLimit).toFixed(3)
                : 'n/a';
            console.warn(`[Anthropic] 429 rate-limit. retryAfter=${retryAfterMs}ms attempt=${attemptNum} tokens-ratio=${ratio}`);
            throw new RateLimitError(retryAfterMs, attemptNum, err, rl);
        }
        throw err;
    }
}
