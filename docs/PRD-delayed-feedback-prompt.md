# PRD — Delayed Feedback Prompt

**Owner:** Luc
**Status:** Approved for implementation
**Target file paths:** `src/workers/whatsappProcessor.ts`, `src/services/case.service.ts`, `src/services/supabase.service.ts`, `src/queue/whatsappQueue.ts`, `src/workers/`
**Feature flag:** `FEEDBACK_PROMPT_MODE` (`immediate` | `idle`, default `immediate` until cutover)

---

## 1. Problem Statement

After every L1 query the bot answers, [src/workers/whatsappProcessor.ts:642-667](../src/workers/whatsappProcessor.ts#L642-L667) sends an interactive feedback prompt (`Did that answer your question? [Yes, thanks] [Still need help]`) **immediately**. This interrupts conversations that are still in flow:

- A client reading the bot's answer and composing a follow-up gets buttons mid-thought.
- Multi-question sessions become noisy — one prompt after every answer.
- Most prompts are ignored, so cases close as `resolved_by_bot_timeout` rather than `confirmed`, weakening the Q2 L1 auto-resolution metric.

**Who experiences it:** every WhatsApp client whose query the bot resolves at L1.

The prompt should fire only when a meaningful signal exists that the conversation has reached a natural stop:

1. **Explicit:** the client sends a "thanks"-style message (`detectWrapUp` already matches this — currently used for a silent close).
2. **Implicit:** the client has gone silent for **2.5 minutes** after the bot's answer.

---

## 2. Success Metrics

**Primary:** Increase share of L1 cases that close with an explicit positive signal.

- **Metric:** `confirmed / (confirmed + resolved_by_bot_timeout)` within a 30-day rolling window.
- **Baseline (pre-launch):** measure for 14 days before cutover.
- **Target:** ≥ 40% explicit-positive share within 30 days post-cutover.

**Guardrail (non-numeric):** No increase in client complaints about prompt friction (track via `[Processor] Bot →` logs and Tina-bot mailbox forwards mentioning the prompt).

**Engineering health checks (must hold from day 1):**

- `feedback_prompt_fired / feedback_prompt_scheduled` ≥ 30% (sanity: most clients shouldn't be silent across the 2.5-min window every time; if they are, our state check is broken).
- Zero cases close with `status='escalated' AND feedback_received='confirmed'` (no un-escalation via wrap-up).

---

## 3. Solution & File Plan

### 3.1 Trigger A — Wrap-up "thanks" (silent close + notification)

When [`case.service.ts:detectWrapUp`](../src/services/case.service.ts#L337) matches on an inbound message:

1. Call a new `resolveAllOpenCasesAsConfirmed(sessionId)` (plural) that closes **every** open case in the session as `confirmed`. Today's `resolveOpenCaseAsConfirmed` closes only the most recent — replace it.
2. Update [`supabase.service.ts:findOpenCaseForSession`](../src/services/supabase.service.ts#L810) → new method `findOpenCasesForSession` (plural) that returns **all** rows whose `status NOT IN ('resolved_by_bot', 'resolved_by_bot_timeout', 'escalated')`. The `escalated` exclusion is critical: a "thanks" after an escalation message must not un-escalate the case.
3. In [`whatsappProcessor.ts:687`](../src/workers/whatsappProcessor.ts#L687), when wrap-up fires AND ≥1 open case was closed, **short-circuit Claude generation** and send this single message instead:

   > Glad I could help! 🙌 I've marked this as resolved. Message me any time if anything else comes up.

   If no open case was closed (no open cases existed), fall through to the normal Claude generation path.

### 3.2 Trigger B — 2.5-min idle prompt (delayed buttons)

**Schedule on bot answer:**

In [`whatsappProcessor.ts:642-667`](../src/workers/whatsappProcessor.ts#L642-L667), replace the inline `sendReplyButtons` + `setSessionPendingCase` block with:

- Call `recordBotResponse` as today.
- If `process.env.FEEDBACK_PROMPT_MODE === 'idle'`:
  - Enqueue a BullMQ delayed job on a new `feedback-prompt` queue with `delay: 150_000` and payload `{ caseId, sessionId, phoneNumber, crmRequestId, botAnswerSentAt }`.
- Else (`immediate` or unset): existing behavior (send buttons now).

**Fire-time state check:**

New worker handler `processFeedbackPromptJob(payload)`:

1. Load case row; abort if `status !== 'bot_responded'` (case was already closed / superseded / escalated).
2. Query `messages` for `session_id = payload.sessionId AND role = 'user' AND created_at > payload.botAnswerSentAt`. If any row exists, abort (client replied within the window).
3. Load session row; if `pending_case_id IS NOT NULL`, abort (another prompt is already in flight for this session).
4. All checks passed → call `metaWhatsAppService.sendReplyButtons(...)`, `setSessionPendingCase(sessionId, caseId)`, `dynamicsService.updateRequest(crmRequestId, { statuscode: AWAITING_FEEDBACK })`.
5. Log structured counter (see §6).

**No active cancellation.** The state check is the only mechanism — robust to restarts, races, and missed cancellations.

### 3.3 Button reply handling (multi-case aware)

In [`case.service.ts:handleFeedback`](../src/services/case.service.ts#L283):

- **`confirmed` (Yes)** → close **all** open session cases as `confirmed`. Mirror to Dynamics per case.
- **`rejected` (Still need help)** → escalate **only the case identified by `pending_case_id`** (status quo for negative signal).

Fix the em dash on the explicit-Yes ack at [`whatsappProcessor.ts:559`](../src/workers/whatsappProcessor.ts#L559):

- Before: `"Great — glad that helped. 🙌 Message me again any time."`
- After: `"Great, glad that helped. 🙌 Message me again any time."`

### 3.4 Escalation path — unchanged

[`whatsappProcessor.ts:664-666`](../src/workers/whatsappProcessor.ts#L664-L666) keeps firing `markEscalated` immediately. **Never enqueue a delayed job for escalation-classified cases** — the bot didn't attempt resolution, asking "did that answer your question?" 2.5 min later would lie to the client.

### 3.5 12h timeout sweep — unchanged

[`case.service.ts:handleTimeout`](../src/services/case.service.ts#L383) stays. It remains the backstop for: (a) cases whose buttons fired but no tap came; (b) cases whose buttons were skipped because the client kept chatting and no wrap-up ever fired.

### 3.6 Feature flag

- New env var: `FEEDBACK_PROMPT_MODE` (`immediate` | `idle`).
- Add to `.env.example` with default `immediate`.
- Single check at the enqueue site (§3.2). When `immediate`, behavior is byte-identical to today.
- Cutover plan: deploy with `immediate`, run for 7 days to confirm no regressions in the new code paths (which are dormant), then flip to `idle`.

---

## 4. Out of Scope

The following are explicitly **not** part of this change:

- **No new case status values.** `bot_responded` continues to cover both "answer sent" and "buttons sent, awaiting tap". Pending state is signalled by `sessions.pending_case_id` only.
- **No change to the 12h timeout duration.** Stays at `FEEDBACK_TIMEOUT_HOURS = 12`.
- **No change to button labels or copy** beyond the em-dash fix on the Yes ack (§3.3).
- **No new classifier topics, no Claude prompt changes, no Dynamics schema changes.** Existing `REQUEST_STATUSCODE.AWAITING_FEEDBACK` and `CLIENT_FEEDBACK.*` values are reused as-is.
- **No A/B test infrastructure.** Feature flag is a kill-switch, not a split-test.
- **No dashboard build-out.** Observability is structured log lines only (§6).
- **No retroactive close** of pre-launch open cases. Existing `bot_responded` cases ride out their 12h sweep as today.
- **No escalation-path feedback prompts.** Escalation never gets buttons.
- **No support for non-L1 cases getting buttons.** Only `level === 'L1'` cases schedule the delayed job.
- **No multi-prompt-per-case retry.** If the state check skips, that case never gets buttons; it closes via wrap-up or timeout.

---

## 5. AI / Engineering Contracts

### 5.1 BullMQ job

**Queue name:** `feedback-prompt`

**Job name:** `send-feedback-prompt`

**Payload shape:**

```ts
interface FeedbackPromptJobPayload {
  caseId: string;          // whatsapp_cases.id (uuid)
  sessionId: string;       // sessions.id
  phoneNumber: string;     // E.164, recipient
  crmRequestId: string | null;  // riivo_request guid for Dynamics patch
  botAnswerSentAt: string; // ISO 8601 timestamp of the bot's answer outbound
}
```

**Enqueue options:**

```ts
{
  delay: 150_000,      // 2.5 minutes
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 },
}
```

### 5.2 New service methods

**`supabaseService.findOpenCasesForSession(sessionId: string): Promise<WhatsAppCaseRow[]>`**

Returns all rows where:

- `session_id = $sessionId`
- `status NOT IN ('resolved_by_bot', 'resolved_by_bot_timeout', 'escalated')`

Ordered by `created_at ASC` (so the caller can iterate in chronological order if needed).

**`supabaseService.hasClientInboundSince(sessionId: string, since: string): Promise<boolean>`**

Returns `true` if any `messages` row exists with `session_id = $sessionId AND role = 'user' AND created_at > $since`.

**`caseService.resolveAllOpenCasesAsConfirmed(sessionId: string): Promise<number>`**

Replaces `resolveOpenCaseAsConfirmed`. Returns the count of cases closed (so the caller knows whether to short-circuit Claude).

For each open case from `findOpenCasesForSession`:

- Call `handleFeedback(case.id, 'confirmed')` (which already mirrors to Dynamics).

### 5.3 Modified service methods

**`caseService.handleFeedback(caseId, feedback)`** — when `feedback === 'confirmed'`:

- Locate the case's session.
- Apply the `confirmed` transition to **all** sibling cases in `findOpenCasesForSession(sessionId)`, not just `caseId`.
- When `feedback === 'rejected'`: unchanged (scoped to `caseId` only).

### 5.4 Outbound message contract — wrap-up notification

Single text message (no buttons, no template):

```
Glad I could help! 🙌 I've marked this as resolved. Message me any time if anything else comes up.
```

Sent via `metaWhatsAppService.sendMessage(phoneNumber, text)`. Logged to `messages` table as `role='assistant'` and to Dynamics via `logMessage`.

### 5.5 Feature flag contract

```ts
const FEEDBACK_PROMPT_MODE = (process.env.FEEDBACK_PROMPT_MODE || 'immediate') as 'immediate' | 'idle';
```

Read once per request at the enqueue site. No hot-reload.

---

## 6. Observability

All counters emitted as structured log lines, prefix `[FeedbackPrompt]`. Format: `[FeedbackPrompt] <event> caseId=<id> sessionId=<id> reason=<reason>`.

**Events:**

| Event                            | When                                                                       |
|----------------------------------|----------------------------------------------------------------------------|
| `scheduled`                      | Delayed job successfully enqueued.                                         |
| `fired`                          | Job fired, all state checks passed, buttons sent.                          |
| `skipped_case_resolved`          | At fire time, case was no longer `bot_responded`.                          |
| `skipped_client_replied`         | At fire time, client had sent an inbound after the bot's answer.           |
| `skipped_session_superseded`     | At fire time, `sessions.pending_case_id` was already set.                  |
| `wrap_up_close`                  | `resolveAllOpenCasesAsConfirmed` fired; include `cases_closed_count`.      |
| `enqueue_failed`                 | BullMQ enqueue threw; falls back to no prompt (case rides 12h sweep).      |

Queryable in Vercel logs without additional infra.

---

## 7. Rollout Plan

1. **Land code with `FEEDBACK_PROMPT_MODE=immediate`** (default). Behavior is unchanged in prod; new code paths are dormant. Verify the dormant paths compile and pass tests.
2. **Run 14 days** in this mode to collect baseline metrics (`confirmed / (confirmed + timeout)` ratio).
3. **Flip to `idle`** via env var update. No redeploy needed if env is hot-readable per request.
4. **Monitor 7 days post-flip:**
   - Engineering health checks (§2) must hold.
   - If `fired/scheduled` < 30%, investigate state-check bug.
   - If complaints surface or escalation/confirmed contamination appears, flip back to `immediate`.
5. **30 days post-flip:** confirm primary metric ≥ 40%. If not, iterate on duration (e.g., try 90s) or reconsider trigger logic.

---

## 8. Open Questions

None at design lock. All branches resolved during grilling:

- "Thanks" trigger semantics: silent close + dedicated notification (not buttons).
- Idle window duration: 2.5 min.
- Cancellation: idempotent state check, no active job cancellation.
- Multi-case: positive signals close all open session cases; negative scoped to most recent.
- Implementation: BullMQ delayed job.
- Escalation: untouched, no buttons.
- Wording: locked.

If any assumption breaks during implementation (e.g., the `messages` table query is slower than expected on hot sessions), re-open here.
