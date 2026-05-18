/**
 * Pre-merge smoke test for the 429 re-enqueue path (Issue 6) and the
 * RateLimitError translation (Issue 5).
 *
 * Pure unit-style — mocks the Anthropic SDK at the client interface. Does
 * NOT touch Redis or Supabase. The full end-to-end worker → BullMQ path
 * is exercised manually post-deploy (see PRD §6 verification checklist).
 *
 * Run: tsx test/test-rate-limit-reenqueue.ts
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';

import {
    RateLimitError,
    callAnthropicMessages,
} from '../src/utils/anthropicRateLimit';
import { parseRetryAttempt } from '../src/utils/jobIdRetry';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
    if (condition) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.error(`  ✗ ${label}`);
    }
}

// ---------------------------------------------------------------------------
// parseRetryAttempt: jobId → attempt-number extraction
// ---------------------------------------------------------------------------
console.log('\nparseRetryAttempt');
assert(parseRetryAttempt('wamid.HBgN1234') === 0, 'bare wamid → 0 (first try)');
assert(parseRetryAttempt('wamid.HBgN1234:retry:1') === 1, 'retry:1 → 1');
assert(parseRetryAttempt('wamid.HBgN1234:retry:5') === 5, 'retry:5 → 5 (cap)');
assert(parseRetryAttempt(undefined) === 0, 'undefined jobId → 0');
assert(parseRetryAttempt('') === 0, 'empty jobId → 0');
assert(parseRetryAttempt('wamid.HBgN1234:retry:abc') === 0, 'non-numeric suffix → 0');

// ---------------------------------------------------------------------------
// callAnthropicMessages: 429 → RateLimitError translation
// ---------------------------------------------------------------------------
console.log('\ncallAnthropicMessages — 429 translation');

function mockClient429(retryAfter: string | null, tokensRemaining?: string, tokensLimit?: string): any {
    const headers: Record<string, string> = {};
    if (retryAfter !== null) headers['retry-after'] = retryAfter;
    if (tokensRemaining) headers['anthropic-ratelimit-tokens-remaining'] = tokensRemaining;
    if (tokensLimit) headers['anthropic-ratelimit-tokens-limit'] = tokensLimit;
    const err: any = new Error('rate_limit_error');
    err.status = 429;
    err.headers = headers;
    return {
        messages: {
            create: (_params: any) => ({
                withResponse: () => Promise.reject(err),
            }),
        },
    };
}

(async () => {
    // 1. retry-after present → ms conversion
    try {
        await callAnthropicMessages(mockClient429('30'), { model: 'x', max_tokens: 1, messages: [] } as any, 2);
        assert(false, '429 with retry-after should throw');
    } catch (e: any) {
        assert(e instanceof RateLimitError, '429 throws RateLimitError');
        assert(e.retryAfterMs === 30_000, 'retry-after "30" → 30000ms');
        assert(e.attemptNum === 2, 'attemptNum propagated from caller');
    }

    // 2. retry-after missing → default 60s
    try {
        await callAnthropicMessages(mockClient429(null), { model: 'x', max_tokens: 1, messages: [] } as any);
        assert(false, '429 without retry-after should still throw');
    } catch (e: any) {
        assert(e instanceof RateLimitError, '429 throws RateLimitError with missing retry-after');
        assert(e.retryAfterMs === 60_000, 'missing retry-after defaults to 60000ms');
    }

    // 3. Rate-limit headers parsed onto the error
    try {
        await callAnthropicMessages(mockClient429('15', '1234', '5000'), { model: 'x', max_tokens: 1, messages: [] } as any);
        assert(false, '429 with headers should throw');
    } catch (e: any) {
        assert(e instanceof RateLimitError, '429 with headers throws RateLimitError');
        assert(e.rateLimit?.tokensRemaining === 1234, 'tokens-remaining parsed onto error');
        assert(e.rateLimit?.tokensLimit === 5000, 'tokens-limit parsed onto error');
    }

    // 4. Non-429 propagates unchanged
    const non429Client: any = {
        messages: {
            create: () => ({
                withResponse: () => {
                    const err: any = new Error('boom');
                    err.status = 500;
                    return Promise.reject(err);
                },
            }),
        },
    };
    try {
        await callAnthropicMessages(non429Client, { model: 'x', max_tokens: 1, messages: [] } as any);
        assert(false, 'non-429 should still throw');
    } catch (e: any) {
        assert(!(e instanceof RateLimitError), 'non-429 NOT wrapped in RateLimitError');
        assert(e.status === 500, 'original error propagates with status');
    }

    // 5. Success path: returns message + headers
    const okClient: any = {
        messages: {
            create: () => ({
                withResponse: () => Promise.resolve({
                    data: { id: 'msg_1', content: [], usage: {} },
                    response: {
                        headers: {
                            get: (k: string) => ({
                                'anthropic-ratelimit-tokens-remaining': '900',
                                'anthropic-ratelimit-tokens-limit': '1000',
                            } as any)[k] || null,
                        },
                    },
                }),
            }),
        },
    };
    const ok = await callAnthropicMessages(okClient, { model: 'x', max_tokens: 1, messages: [] } as any);
    assert(ok.message.id === 'msg_1', 'success returns the Anthropic Message');
    assert(ok.rateLimit.tokensRemaining === 900, 'success extracts tokens-remaining header');
    assert(ok.rateLimit.tokensLimit === 1000, 'success extracts tokens-limit header');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(2);
});
