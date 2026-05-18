# Issue Breakdown — Webhook Idempotency TTL + Claude Scaling

Source PRD: [PRD-scaling-idempotency-and-claude.md](PRD-scaling-idempotency-and-claude.md)
Rollout shape: **one bundled PR**, target ship week of 2026-05-18.
Issues are listed in the merge-ready order from §6 of the PRD. Each is independently reviewable inside the bundled PR.

---

## Backend Tasks

### 1. [DB] Add Claude rate-limit telemetry columns to `claude_usage`

**Description:**

- **Context:** PRD §3.5. We need persisted rate-limit telemetry to (a) decide whether the deferred proactive slow-mode in §4 is worth building, and (b) measure success metric §2.2 (429 rate). Additive only — no backfill.
- **Acceptance Criteria:**
  - [ ] Given the migration runs, When I `\d claude_usage` in Supabase, Then the following nullable columns exist: `ratelimit_tokens_remaining bigint`, `ratelimit_tokens_limit bigint`, `ratelimit_requests_remaining bigint`, `ratelimit_requests_limit bigint`, `retry_after_ms integer`.
  - [ ] Given the migration runs, When I query existing rows, Then `was_429` is `false` (NOT NULL default) and the other new columns are `NULL`.
  - [ ] Given the migration is run twice, When the second run executes, Then it is a no-op (`add column if not exists`).
- **Technical Notes:**
  - New file: `supabase/migrations/<timestamp>_claude_ratelimit_telemetry.sql`
  - Exact DDL is in PRD §3.5 (lines 125–133). Idempotent additive — see §5.4.
  - No drops, no renames. Existing rows untouched.

---

### 2. [Backend] Set `maxRetries: 0` on every Anthropic client

**Description:**

- **Context:** PRD §5.5. Prerequisite for the explicit BullMQ re-enqueue path in §3.4 — we must disable the SDK's built-in retry to avoid double-retry once the worker handles 429 itself.
- **Acceptance Criteria:**
  - [ ] Given any Anthropic client constructor in the repo, When inspected, Then `maxRetries: 0` is set.
  - [ ] Given a 429 from Anthropic, When the SDK receives it, Then it raises the error to the caller without retrying internally.
- **Technical Notes:**
  - Touch all three callers: [claude.service.ts](../src/services/claude.service.ts), [loe-extractor.service.ts](../src/services/loe-extractor.service.ts), [case.service.ts](../src/services/case.service.ts).
  - Exact constructor shape in PRD §5.5 (lines 229–233).
  - Single-line change per call site — keep this issue tightly scoped; no other refactors.

---

### 3. [Backend] Swap LoE extractor from Opus to Haiku

**Description:**

- **Context:** PRD §3.2. The LoE extractor uses a single forced-tool with a fixed schema and no reasoning chain — a textbook Haiku job. Drives the cost-per-message metric in §2.1.
- **Acceptance Criteria:**
  - [ ] Given the extractor runs against a sample LoE PDF, When the model is invoked, Then the request model is `claude-haiku-4-5-20251001`.
  - [ ] Given the swap is deployed, When extractions run for one day, Then output schema and acceptance rates match the prior Opus baseline within evaluation tolerance.
  - [ ] Given the call site, When grepping the file, Then no `claude-opus-4-7` constant remains for this caller.
- **Technical Notes:**
  - Single constant change at [loe-extractor.service.ts:107](../src/services/loe-extractor.service.ts#L107).
  - SDK call shape is identical — no other code changes per PRD §3.2.
  - Verify the prompt is < 2048 tokens (per §3.3 it is); confirms no caching wiring is needed here.

---

### 4. [Backend] Swap case-service intent classifier from Opus to Haiku

**Description:**

- **Context:** PRD §3.2. The classifier hits every inbound message with a single forced-tool over a fixed taxonomy — Haiku-shaped. High-volume caller, biggest contributor to §2.1 cost savings.
- **Acceptance Criteria:**
  - [ ] Given the classifier runs against a representative inbound, When the model is invoked, Then the request model is `claude-haiku-4-5-20251001`.
  - [ ] Given the swap is deployed, When the next day's classifications run, Then category distribution matches the prior Opus baseline within evaluation tolerance.
  - [ ] Given the call site, When grepping the file, Then no `claude-opus-4-7` constant remains for this caller.
- **Technical Notes:**
  - Single constant change at [case.service.ts:197](../src/services/case.service.ts#L197).
  - SDK call shape identical — no other code changes per PRD §3.2.

---

### 5. [Backend] Define `RateLimitError` and parse Anthropic rate-limit headers in Claude service

**Description:**

- **Context:** PRD §3.4 (steps 1–2) and §5.1. Translates Anthropic 429 responses into a typed error the worker can recognise, and pulls rate-limit headers off every Claude response for telemetry (§3.5).
- **Acceptance Criteria:**
  - [ ] Given a 429 from any Anthropic call site (main, extractor, classifier), When the service catches it, Then it throws `RateLimitError` with `retryAfterMs` (parsed from `retry-after` header, integer seconds → ms), `attemptNum`, and `originalError` populated.
  - [ ] Given a non-429 Anthropic error, When the service catches it, Then the existing error flow is unchanged (no `RateLimitError` thrown).
  - [ ] Given a successful Anthropic response, When `logUsage()` is invoked, Then `anthropic-ratelimit-tokens-remaining`, `anthropic-ratelimit-tokens-limit`, `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-requests-limit` are read from response headers and made available to the persistence layer.
  - [ ] Given `RateLimitError` is thrown, When a Sentry breadcrumb is recorded, Then it carries `retry-after` and the `tokens-remaining / tokens-limit` ratio per §3.5.
- **Technical Notes:**
  - Export `RateLimitError` from [src/services/claude.service.ts](../src/services/claude.service.ts) — exact class shape in PRD §5.1 (lines 159–168).
  - Wrap all three SDK call sites (main `messages.create`, LoE, classifier) — same logic, same risk per §3.4 step 1.
  - Use `.withResponse()` if the installed SDK supports it; otherwise catch `Anthropic.APIError` with `status === 429`.
  - Depends on **Issue 2** (`maxRetries: 0`) so the SDK doesn't swallow the 429 internally.
  - Touches `logUsage()` at [claude.service.ts:524-548](../src/services/claude.service.ts#L524-L548) — header extraction only; persistence wiring lives in Issue 9.

---

### 6. [Backend/Worker] Re-enqueue on `RateLimitError` with retry cap

**Description:**

- **Context:** PRD §3.4 (steps 3–5) and §5.2. With concurrency=1 per shard, a sleeping worker blocks every other phone hashed to that shard. Re-enqueue with delay so the shard stays available.
- **Acceptance Criteria:**
  - [ ] Given a job throws `RateLimitError`, When the worker catches it, Then it marks the original job **complete** (not failed) and enqueues a fresh job with `jobId = "${wamid}:retry:${attemptNum + 1}"` and `delay = retryAfterMs`.
  - [ ] Given Meta redelivers a bare `${wamid}` while a `:retry:N` job is pending, When BullMQ receives the add, Then it rejects the duplicate `${wamid}` (dedup preserved per §5.2 table).
  - [ ] Given a job reaches `attemptNum >= 5`, When the next 429 fires, Then instead of re-enqueueing, `idempotencyService.recordDeadLetter()` is called with `failed_reason = 'rate_limit_exceeded_after_5_retries'`.
  - [ ] Given any non-`RateLimitError` error in the worker, When caught, Then the existing 4-attempt exponential BullMQ backoff applies unchanged.
  - [ ] Given the catch block ordering, When inspected, Then `err instanceof RateLimitError` is checked **before** the generic error handler per §5.1.
- **Technical Notes:**
  - Wire in [src/workers/](../src/workers/) and the queue at [src/queue/](../src/queue/).
  - JobId namespacing rules in PRD §5.2 table (lines 175–180) — do not deviate.
  - Re-enqueue API per PRD §3.4 step 3 (lines 111–115).
  - Depends on **Issue 5** (`RateLimitError` must exist and be throwable).
  - Retry depth cap = 5 (PRD §3.4 step 4). 5 × ~60s ≈ 5 minutes — the WhatsApp client has moved on past that.

---

### 7. [Backend] Wire three real `cache_control` breakpoints on the main assistant

**Description:**

- **Context:** PRD §3.3 and §5.3. The current top-level `cache_control: { type: 'ephemeral' }` param at [claude.service.ts:842](../src/services/claude.service.ts#L842) is not a valid Anthropic parameter — caching is effectively a no-op today. Replace with three correct breakpoints (tools, system, messages N-2). Drives the cost-per-message metric in §2.1 alongside model routing.
- **Acceptance Criteria:**
  - [ ] Given the main assistant call, When the request is constructed, Then the **last** tool in `availableTools[]` has `cache_control: { type: 'ephemeral' }` on its object and earlier tools do not.
  - [ ] Given the main assistant call, When the request is constructed, Then `system` is an array of one content block `{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }` (not a bare string).
  - [ ] Given a conversation with `messages.length >= 2`, When the request is constructed, Then `cache_control: { type: 'ephemeral' }` is set on the **last content block** of `messages[messages.length - 2]`, and string-form content is first converted to a content-block array per §5.3.
  - [ ] Given `messages.length < 2`, When the request is constructed, Then no message-history cache_control is added (no out-of-bounds index).
  - [ ] Given the request body, When inspected, Then the top-level `cache_control` parameter at [claude.service.ts:842](../src/services/claude.service.ts#L842) is **removed**.
  - [ ] Given a 2nd+ turn in a session post-deploy, When the `claude_usage` row is written, Then `cache_read_input_tokens > 0`.
- **Technical Notes:**
  - Code shapes are in PRD §5.3 (lines 185–217) — copy them verbatim.
  - N-2 (not N-1) per PRD §3.3 rationale (line 96) — caching N-1 would write a new entry every inbound at 1.25× input cost.
  - Last in the merge order per §6 — verification needs production traffic so this lands last.
  - **Do NOT** add `cache_control` to LoE/classifier — both prompts are below Haiku's 2048-token cache minimum per §3.3 line 88.

---

### 8. [Backend] Persist rate-limit telemetry in `logUsage()`

**Description:**

- **Context:** PRD §3.5 persistence half. Issue 5 surfaces header values and 429 metadata; this issue writes them to the new columns from Issue 1.
- **Acceptance Criteria:**
  - [ ] Given a successful Claude call, When `logUsage()` writes the row, Then `ratelimit_tokens_remaining`, `ratelimit_tokens_limit`, `ratelimit_requests_remaining`, `ratelimit_requests_limit` are populated from response headers; `was_429 = false`; `retry_after_ms = NULL`.
  - [ ] Given a 429 response, When the error path logs usage, Then `was_429 = true` and `retry_after_ms` is populated; rate-limit header columns are populated if the headers were present.
  - [ ] Given an `claude_usage` row from before the migration, When queried after deploy, Then schema reads succeed (`NULL` for the new nullable columns).
- **Technical Notes:**
  - Update `logUsage()` at [claude.service.ts:524-548](../src/services/claude.service.ts#L524-L548).
  - Depends on **Issue 1** (columns must exist) and **Issue 5** (header values must be plumbed through).
  - Header names per PRD §3.5 line 135.

---

## Infrastructure Tasks

### 9. [Infra/Cron] `whatsapp_webhook_events` 7-day cleanup cron

**Description:**

- **Context:** PRD §3.1. Meta's at-least-once retry window is 7 days; any idempotency row older than that is dead weight. Backs reliability metric §2.3 Metric B (table row count bounded).
- **Acceptance Criteria:**
  - [ ] Given the cron route is hit manually, When the handler runs, Then it executes `DELETE FROM whatsapp_webhook_events WHERE received_at < now() - interval '7 days'` and logs the affected row count via the existing logger.
  - [ ] Given `vercel.json` is inspected, When the schedule block is read, Then `/api/cron/cleanup-webhook-events` runs daily.
  - [ ] Given a test fixture of rows with `received_at` backdated > 7 days mixed with rows < 7 days, When the cron runs, Then only the old rows are deleted.
  - [ ] Given the delete fails, When the handler errors, Then it surfaces to the same Sentry path the other cron routes in [cron.route.ts](../src/routes/cron.route.ts) use.
- **Technical Notes:**
  - New route in [src/routes/cron.route.ts](../src/routes/cron.route.ts), mirror the existing cron handler pattern.
  - No row-cap, no metrics emission per PRD §3.1 line 73 — three columns per row, sub-second delete via existing `received_at` index.
  - Independent of every other issue — can ship first if convenient.

---

## Testing Tasks

### 10. [Testing] Pre-merge smoke tests for 429 re-enqueue, cache hits, idempotency cleanup

**Description:**

- **Context:** PRD §6 "Smoke tests pre-merge". These three checks gate the bundled PR.
- **Acceptance Criteria:**
  - [ ] **429 re-enqueue:** Given a one-off test script that mocks the Anthropic SDK to return 429 with a fixed `retry-after`, When a job runs through the worker, Then the original job is marked complete, a fresh job with `jobId` matching `${wamid}:retry:1` appears, and its `delay` equals the mocked `retry-after` in ms.
  - [ ] **Prompt cache hit:** Given two consecutive WhatsApp inbounds to the same dev phone, When `claude_usage` is queried, Then the 2nd row has `cache_read_input_tokens > 0`.
  - [ ] **Idempotency cleanup:** Given the cleanup endpoint is hit manually with a fixture of backdated rows in `whatsapp_webhook_events`, When the response returns, Then only rows older than 7 days were deleted and rows within 7 days remain.
- **Technical Notes:**
  - Place new test scripts alongside existing [test/test-case-lifecycle.ts](../test/test-case-lifecycle.ts) pattern.
  - Depends on Issues 1, 5, 6, 7, 8, 9.
  - Post-deploy verification checklist (week 1) is **not** in scope here — that's an ops checklist per PRD §6, not a code task.

---

## Out of scope (per PRD §4 — do NOT add to this PR)

- Proactive slow-mode at `tokens-remaining < 20%`
- Three-tier dynamic routing on the main assistant (Opus → Sonnet → Haiku)
- DLQ retention policy for `whatsapp_queue_dlq`
- Caching on Haiku call sites (prompts below 2048-token minimum)
- Anthropic SDK `maxRetries` tuning beyond `0`

---

## Dependency graph

```
Issue 1 (migration) ──────────────┐
                                  ├─→ Issue 8 (logUsage persist)
Issue 5 (RateLimitError + headers)┘         ↑
       ↑                                    │
Issue 2 (maxRetries: 0) ─────────────┐      │
                                     ↓      │
                              Issue 6 (worker re-enqueue)
                                     ↓
                              Issue 10 (smoke tests)
                                     ↑
Issue 3 (Haiku — extractor)  ────────┤
Issue 4 (Haiku — classifier) ────────┤
Issue 7 (cache breakpoints)  ────────┤
Issue 9 (cleanup cron)       ────────┘  (independent)
```

Ship order from §6: **1 → 9 → 3, 4 → 2 → 5 → 6 → 7 → 10**.
