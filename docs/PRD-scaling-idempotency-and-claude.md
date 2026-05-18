# PRD — Webhook Idempotency TTL + Claude Scaling

**Owner:** Luc
**Status:** Approved for implementation (design grilled & locked 2026-05-18)
**Rollout shape:** One bundled PR, target ship this week
**Target file paths:**
- `src/routes/cron.route.ts` (new cleanup endpoint)
- `src/services/claude.service.ts` (caching fix + 429 handling)
- `src/services/loe-extractor.service.ts` (model swap)
- `src/services/case.service.ts` (model swap)
- `src/queue/whatsappQueue.ts`, `src/workers/` (re-enqueue path)
- `supabase/migrations/` (new migration for telemetry columns)

---

## 1. Problem Statement

The bot has three scaling cliffs we want to clear before traffic grows:

1. **`whatsapp_webhook_events` grows unbounded.** The idempotency table added in [supabase/migrations/20260513120000_webhook_idempotency_and_dlq.sql](../supabase/migrations/20260513120000_webhook_idempotency_and_dlq.sql) has no TTL. Meta's at-least-once retry window is 7 days, so any row older than that is dead weight.

2. **Claude spend is all-Opus + likely-broken caching.** All three call sites — main assistant, LoE extractor, intent classifier — use `claude-opus-4-7`. The classifier and extractor are textbook Haiku jobs (single forced-tool, no reasoning chain). The main assistant has a `cache_control: { type: 'ephemeral' }` line at [src/services/claude.service.ts:842](../src/services/claude.service.ts#L842) that is passed as a top-level request param — the Anthropic API requires `cache_control` blocks **inside** content blocks, so it is almost certainly a no-op.

3. **No back-pressure on Anthropic 429s.** The Anthropic SDK isn't told to retry, and the BullMQ worker treats a 429 like any other error: 4-attempt exponential backoff that doesn't respect `retry-after`. At 16 shards × ~5k uncached input tokens per Opus call, a Tier 1 ITPM cap is reachable in a single inbound burst.

**Who experiences it:**
- (1) shows up as Supabase storage growth and slower idempotency lookups over time.
- (2) shows up on the Anthropic invoice — the high-volume callers (every inbound message hits the classifier) run on the most expensive model.
- (3) shows up to clients as silent message drops (BullMQ exhausts retries) or long delays during marketing-driven spikes.

---

## 2. Success Metrics

All three weighted equally — measure all post-launch.

### 2.1 Cost per inbound message

- **Metric:** `claude_usage.total_cost_zar / count(distinct meta_message_id)` over rolling 7-day window
- **Baseline:** measure 7 days before cutover
- **Target:** ≥ 50% reduction within 30 days of ship
- **Carried by:** model routing (3.2) + prompt caching (3.3)

### 2.2 429-related customer delay

- **Metric:** `count(claude_usage.was_429=true) / count(*)` over rolling 7-day window
- **Target:** < 1% of Claude calls return 429; among those that do, p99 end-to-end inbound→outbound latency stays under 90 seconds (one `retry-after` cycle of typical length)
- **Guardrail:** zero messages land in `whatsapp_queue_dlq` with `failed_reason LIKE '%rate_limit%'` and `attempts_made = 5` (retry cap hit on a sustained outage is allowed; everything below cap must succeed eventually)
- **Carried by:** back-pressure (3.4) + telemetry (3.5)

### 2.3 Reliability

- **Metric A:** duplicate-reply rate = 0. Verify via spot-check of `claude_usage` rows grouped by `meta_message_id`; no wamid should produce more than one assistant turn.
- **Metric B:** `whatsapp_webhook_events` row count stays bounded under 7 days of inbound volume × 1.5 (sanity check on the cleanup cron).
- **Carried by:** idempotency TTL (3.1) + existing dedup at [src/services/idempotency.service.ts:36-58](../src/services/idempotency.service.ts#L36-L58)

---

## 3. Solution & File Plan

### 3.1 Idempotency 7-day TTL

**New Vercel cron route** at `/api/cron/cleanup-webhook-events`, following the pattern in [src/routes/cron.route.ts](../src/routes/cron.route.ts). Schedule daily via `vercel.json`.

Execution:

```sql
DELETE FROM whatsapp_webhook_events
WHERE received_at < now() - interval '7 days';
```

Log row count via existing logger. No row-cap, no metrics emission. Errors surface to whatever Sentry path the existing cron routes use.

**Why no guardrails:** the table holds one row per inbound WhatsApp message with three columns (no payload). 7 days at expected volume is tens of thousands of rows max — the index on `received_at` makes the delete sub-second. Add guardrails only if the table proves big enough to matter.

### 3.2 Model routing

| Call site | Today | New model | Why |
|---|---|---|---|
| [loe-extractor.service.ts:107](../src/services/loe-extractor.service.ts#L107) | `claude-opus-4-7` | `claude-haiku-4-5-20251001` | Single forced-tool, schema-bounded, no reasoning. |
| [case.service.ts:197](../src/services/case.service.ts#L197) | `claude-opus-4-7` | `claude-haiku-4-5-20251001` | Single forced-tool, fixed taxonomy, no reasoning. |
| [claude.service.ts:836](../src/services/claude.service.ts#L836) | `claude-opus-4-7` | **keep** `claude-opus-4-7` | Multi-turn agentic loop. Downgrade risk too high to bundle here. |

No code changes beyond the model constant — the SDK call shape is identical.

### 3.3 Prompt caching (main assistant only)

The Haiku call sites cannot benefit: classifier total prompt < 1000 tokens, extractor static portion ~600 tokens; both below Haiku's 2048-token cache minimum.

For the main assistant at [src/services/claude.service.ts:835-843](../src/services/claude.service.ts#L835-L843), replace the bogus top-level `cache_control: { type: 'ephemeral' }` parameter with **three real cache breakpoints**:

1. **Tools:** mark the **last** entry in `availableTools[]` with `cache_control: { type: 'ephemeral' }`. Caches the entire tool definitions block.
2. **System:** convert `system: systemPrompt` (string) → `system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]`. Caches the system prompt.
3. **Messages history:** on each call, mark `messages[messages.length - 2]` with `cache_control: { type: 'ephemeral' }`. This skips the brand-new user input and caches everything up to and including the previous turn. The cache lookup finds the longest matching prefix, so subsequent turns hit on the cached prefix automatically.

**Why N-2 (not N-1):** caching `messages[length-1]` (the new user input) means every fresh inbound writes a new cache entry at 1.25× input cost. N-2 means cache writes only happen when older history shifts — amortized, not per-message.

**Verification:** after deploy, query `claude_usage` and confirm `cache_read_input_tokens > 0` on the 2nd+ turn of any session. Pre-deploy this column should be ~0 across the board.

### 3.4 Back-pressure: re-enqueue on 429

**Goal:** when Anthropic returns 429, the worker shard must not block on `retry-after` (concurrency=1 per shard means a sleeping worker blocks every other phone hashed to that shard). Re-enqueue the job with a delay instead.

**Wiring:**

1. **In [src/services/claude.service.ts](../src/services/claude.service.ts)**, wrap the `messages.create` call (and the LoE/classifier calls — same logic, same risk) to read response headers. Use `.withResponse()` if SDK version supports it, otherwise catch `Anthropic.APIError` with `status === 429`.
2. On 429, parse `retry-after` header (seconds, integer per Anthropic spec) and current attempt count, then **throw** a typed `RateLimitError(retryAfterMs, attemptNum)`.
3. **In the BullMQ worker**, catch `RateLimitError` specifically:
   - **Mark the original job as complete, not failed** (defer-not-fail semantics — a rate-limit is not a job failure, it's a deferral).
   - Schedule a fresh job:
     ```ts
     queue.add(jobName, jobData, {
       jobId: `${originalWamid}:retry:${attemptNum + 1}`,
       delay: retryAfterMs,
     });
     ```
   - **JobId namespacing rule:** retry jobs are named `${wamid}:retry:${n}`. This preserves dedup against Meta redeliveries (the bare `wamid` is still protected against Meta's at-least-once retry storm) while allowing our own retry chain.
4. **Retry depth cap = 5.** On the 6th attempt, instead of re-enqueueing, call `idempotencyService.recordDeadLetter()` with `failed_reason = 'rate_limit_exceeded_after_5_retries'`. 5 × typical 60s `retry-after` ≈ 5 minutes — beyond that the WhatsApp client has moved on anyway.
5. **Non-429 errors are unchanged** — still use the existing 4-attempt BullMQ exponential backoff. Keep these paths separate.

### 3.5 Rate-limit telemetry

New migration `supabase/migrations/<timestamp>_claude_ratelimit_telemetry.sql`:

```sql
alter table claude_usage
  add column if not exists ratelimit_tokens_remaining bigint,
  add column if not exists ratelimit_tokens_limit bigint,
  add column if not exists ratelimit_requests_remaining bigint,
  add column if not exists ratelimit_requests_limit bigint,
  add column if not exists was_429 boolean not null default false,
  add column if not exists retry_after_ms integer;
```

Update `logUsage()` at [src/services/claude.service.ts:524-548](../src/services/claude.service.ts#L524-L548) to read these from the response headers (`anthropic-ratelimit-tokens-*`, `anthropic-ratelimit-requests-*`) and persist alongside existing usage data. For 429s logged via the new error path, populate `was_429=true` and `retry_after_ms`.

Add one Sentry breadcrumb per 429 carrying `retry-after` and `tokens-remaining / tokens-limit` ratio. No new dashboard — query the table when revisiting the proactive-slow-mode decision (see Out of Scope).

---

## 4. Out of Scope

Explicitly not building in this PR. Listed so they don't reappear as scope creep:

- **Proactive slow-mode** at `anthropic-ratelimit-tokens-remaining < 20%`. Deferred until 7+ days of telemetry from 3.5 shows whether 429s actually cluster at the cliff. With 3.4 in place, hitting a 429 is non-catastrophic, so preemptive throttling is an optimization not a correctness fix.
- **Three-tier dynamic routing on the main assistant.** Routing Opus → Sonnet → Haiku within the main assistant based on turn complexity is a separate, eval-gated change. This PR does not touch the main assistant's model.
- **DLQ retention policy** for `whatsapp_queue_dlq`. That table holds full payloads (unlike `whatsapp_webhook_events`) so any cleanup decision is a separate retention conversation.
- **Caching on Haiku call sites.** Extractor and classifier prompts are below Haiku's 2048-token cache minimum. Will not change with this PR; revisit only if those prompts grow significantly.
- **Anthropic SDK `maxRetries` tuning.** The SDK's built-in retry is disabled in favor of explicit BullMQ re-enqueue (see 3.4). Set `maxRetries: 0` on the Anthropic client to prevent double-retry.

---

## 5. Engineering Contracts

### 5.1 `RateLimitError` shape

```ts
// src/services/claude.service.ts (new export)
export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    public readonly attemptNum: number,
    public readonly originalError: unknown,
  ) {
    super(`Anthropic rate limit hit; retry-after=${retryAfterMs}ms attempt=${attemptNum}`);
    this.name = 'RateLimitError';
  }
}
```

Worker contract: any catch block that may receive a `RateLimitError` MUST check `err instanceof RateLimitError` BEFORE generic error handling and short-circuit to the re-enqueue path. Do not let it fall into the DLQ-on-failure path until `attemptNum >= 5`.

### 5.2 BullMQ jobId rules

| Source | `jobId` format | Dedup behavior |
|---|---|---|
| First inbound from Meta | `${wamid}` | Meta retries of same wamid → BullMQ rejects duplicate add, idempotency.claim() returns false. |
| 429 re-enqueue (attempt N) | `${wamid}:retry:${N}` | Distinct namespace; Meta redelivery of bare wamid still protected. Retry N+1 also distinct. |
| DLQ landing (attempt > 5) | n/a — moves to `whatsapp_queue_dlq` table, not re-enqueued | Manual replay only. |

### 5.3 `cache_control` block shapes (Anthropic SDK)

**Tools (mark last entry only):**

```ts
const tools = availableTools.map((t, i) =>
  i === availableTools.length - 1
    ? { ...t, cache_control: { type: 'ephemeral' as const } }
    : t
);
```

**System (convert to content-block array):**

```ts
const systemBlocks = [{
  type: 'text' as const,
  text: systemPrompt,
  cache_control: { type: 'ephemeral' as const },
}];
```

**Messages history (mark N-2):**

```ts
const cacheIdx = messages.length - 2;
if (cacheIdx >= 0) {
  // Mark the last content block of the message at cacheIdx.
  // Per Anthropic: cache_control on a content block caches all preceding blocks too.
  const msg = messages[cacheIdx];
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    const lastBlock = msg.content[msg.content.length - 1];
    (lastBlock as any).cache_control = { type: 'ephemeral' };
  }
}
```

**The top-level `cache_control: { type: 'ephemeral' }` line at [claude.service.ts:842](../src/services/claude.service.ts#L842) MUST be removed** — it is not a valid Anthropic API parameter and was masking the fact that caching wasn't actually wired.

### 5.4 Migration shape (Section 3.5)

Idempotent additive migration only — no drops, no renames. Existing rows in `claude_usage` get `NULL` for the new nullable columns and `false` for `was_429`. No backfill needed; new rows populate going forward.

### 5.5 Anthropic client config

```ts
new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 0,  // we handle 429 explicitly via BullMQ re-enqueue
});
```

Set on all three callers (main, extractor, classifier) for consistent behavior.

---

## 6. Rollout

**One bundled PR.** Order of work within the PR:

1. Migration (3.5 telemetry columns) — additive, safe to deploy ahead.
2. Cron route (3.1) — independent of everything else.
3. Model swaps (3.2) — two-line changes, low risk.
4. Anthropic client `maxRetries: 0` (5.5) — single-line change, prerequisite for 3.4.
5. `RateLimitError` class + header parsing in Claude service (3.4 step 1-2).
6. Worker re-enqueue path (3.4 step 3-5) — wire `RateLimitError` handler before existing failure path.
7. Cache breakpoint conversion in main assistant (3.3) — last because verification needs production traffic.

**Smoke tests pre-merge:**
- Trigger a `429` from the Claude service (mock the SDK response in a one-off test script) and confirm: original job completes, retry job appears with `jobId` matching the `:retry:1` pattern, `delay` matches `retry-after`.
- Send 2+ consecutive WhatsApp messages to the same phone in dev; confirm `claude_usage.cache_read_input_tokens > 0` on the 2nd row.
- Hit the idempotency cleanup endpoint manually with `received_at` backdated rows; confirm only old rows deleted.

**Post-deploy verification (week 1):**
- Daily check on cost-per-message metric (target -50%).
- 429 log review — any cluster at one timestamp indicates a real rate-limit event worth analysing for the deferred slow-mode decision.
- `claude_usage` query: percentage of calls with `cache_read_input_tokens > 0` should be ≥ 80% for main-assistant rows beyond the first turn of a session.

**Rollback plan:** revert the PR. The migration is additive only — leaving the new columns in place after a revert is harmless. The cron route is independently deletable from `vercel.json`. The idempotency table itself is unchanged.
