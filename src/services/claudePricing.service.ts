/**
 * Claude API pricing — USD per million tokens, current as of 2026-04.
 * Update when Anthropic changes pricing. Cost is computed at insert time and
 * stored on each claude_usage row, so historical rows stay correct.
 *
 * Source: https://www.anthropic.com/pricing
 */

interface PricingTier {
    input: number;            // standard input
    output: number;
    cacheWrite: number;       // 5-min ephemeral cache write
    cacheRead: number;        // cache hit
}

// Per million tokens, USD.
const PRICING: Record<string, PricingTier> = {
    'claude-opus-4-7':   { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
    'claude-opus-4-6':   { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
    'claude-sonnet-4-6': { input: 3.0,  output: 15.0, cacheWrite: 3.75,  cacheRead: 0.30 },
    'claude-haiku-4-5':  { input: 1.0,  output: 5.0,  cacheWrite: 1.25,  cacheRead: 0.10 },
};

const DEFAULT_TIER: PricingTier = PRICING['claude-opus-4-7'];

export interface ClaudeUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

/**
 * Compute the USD cost of a single messages.create call from its usage block
 * and the model used. Falls back to Opus pricing for unknown models so an
 * unrecognised model logs a (probably-too-high) cost rather than zero.
 */
export function computeCostUsd(model: string, usage: ClaudeUsage | null | undefined): number {
    if (!usage) return 0;
    const tier = PRICING[model] || DEFAULT_TIER;
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cost =
        (input * tier.input) +
        (output * tier.output) +
        (cacheWrite * tier.cacheWrite) +
        (cacheRead * tier.cacheRead);
    return cost / 1_000_000;
}

/**
 * Total billable tokens for cap accounting. We count cache reads at full
 * weight here even though they're cheap — the cap is about conversation
 * length, not pure spend.
 */
export function totalTokens(usage: ClaudeUsage | null | undefined): number {
    if (!usage) return 0;
    return (usage.input_tokens || 0)
        + (usage.output_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
}
