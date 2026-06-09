# Topic-shift relaxation (interim fix)

_Shipped: 2026-06-08. Author: lifecycle audit follow-up. Scope: one-line guard in
[whatsappProcessor.ts](../src/workers/whatsappProcessor.ts). No schema change. Reversible._

## Why

A `whatsapp_cases` row is opened per "new topic". The old rule treated **every** qualifying
client message (anything that isn't a Yes/No/thanks ack) as a new topic while the open case was
`bot_responded` — so it closed the open case as `topic_shift` and opened a fresh case + Dynamics
REQ. In a normal back-and-forth about one issue, that fragments a single conversation into many
REQs. Live data showed one client intent splitting into **6 cases**, and during a **client
campaign** (many clients replying in bursts to one outreach) this fans out REQs hard.

This is the low-stakes interim fix: **stop treating a rapid follow-up as a new topic.** It does
not touch the data model (the per-query-vs-thread question is tracked separately in
[case-model-options.md](case-model-options.md)).

## The change

In the case-routing block of `handleClientOrLeadMessage`, the topic-shift branch gains a
time-gap guard:

```ts
const TOPIC_SHIFT_MIN_GAP_MS = 30 * 60 * 1000; // 30 min
const withinContinuationWindow = !!latestCase &&
    (Date.now() - new Date(latestCase.updated_at).getTime()) < TOPIC_SHIFT_MIN_GAP_MS;

// was: if (latestCase && status === 'bot_responded' && qualifies && !looksLikeFeedbackOrAck)
if (latestCase && latestCase.status === 'bot_responded' && qualifies
        && !looksLikeFeedbackOrAck && !withinContinuationWindow) {
    // topic shift: close old case, open new one
}
```

When `withinContinuationWindow` is true, the message falls through to the **existing
continuation branch** (`else if (latestCase)`), which reuses the open case and answers on it.

- **Window:** 30 minutes since the open case's last activity (`updated_at`). Chosen to match the
  existing 30-min `SESSION_TIMEOUT_MINUTES` grain in `supabase.service.ts`.
- **Anchor:** `latestCase.updated_at` ≈ when the bot last answered (the `bot_responded` write +
  the `updated_at` trigger). So the gate measures "time since the bot last engaged this case".

## Why this is low-stakes

- **No new code path.** Within-window messages route into the `else if (latestCase)` continuation
  branch that already exists and is already exercised by every non-qualifying follow-up. We're
  sending *more* traffic down a tested path, not adding behaviour.
- **No schema change**, no migration, no Dynamics change.
- **One-line revert.** Delete `&& !withinContinuationWindow` to restore the old behaviour.
- **Failure mode is benign.** Worst case, two genuinely different questions asked <30 min apart
  merge into one case instead of two. That is the *safe* direction (merge, not fragment) and is
  recoverable; the previous behaviour's failure mode (spurious REQ per message) is the one
  hurting consultants now.

## What this does NOT change

- **Escalation.** Explicit "call me / speak to a human" still escalates via its own path; the
  topic-shift branch only ever fired on `bot_responded` cases.
- **Explicit feedback.** "Yes/No" button taps and wrap-up acks are still handled by the
  `looksLikeFeedbackOrAck` guard and the feedback flow.
- **Document uploads.** Client doc uploads already reuse the open case
  ([whatsappProcessor.ts](../src/workers/whatsappProcessor.ts)) — untouched.
- **Fresh cases.** The first qualifying message in a session still opens a case as before.
- **The 12h timeout sweep.** Still closes idle `bot_responded` cases.

## Behaviour change, concretely

| Scenario | Before | After |
|---|---|---|
| Client asks Q2 five minutes after the bot answered Q1 | new case + new REQ (`topic_shift`) | **continues the open case**, bot answers on it |
| Client replies in a burst to a campaign outreach | a case per message | one case for the burst |
| Client returns next day with a new question (>30 min) | new case | new case (unchanged) |
| Client asks two unrelated things 5 min apart | two cases | one case (merged — accepted trade-off) |

## Trade-off to be aware of

Because a within-window follow-up reuses the open case, the **case keeps the first question's
`query_text`, `level`, and `level_topic`.** A second, different question merged into it is *not*
separately classified — its topic is not recorded on the case (the full text is still saved in
`messages`). This is the known per-query-metrics cost and is exactly what the
[case-model-options.md](case-model-options.md) child-entity work addresses properly. For this
interim fix it is accepted.

## Metrics note (Q2)

Expect **fewer total cases** and a **sharp drop in the `topic_shift` resolution method** after
this ships — much of the prior `topic_shift` volume was the fragmentation artefact, not real
topic changes. When reading L1 auto-resolution / adoption after 2026-06-08, account for the
grain shift: a case now spans a short conversation rather than a single message.

## Rollback

Revert the single guard:

```ts
if (latestCase && latestCase.status === 'bot_responded' && qualifies && !looksLikeFeedbackOrAck) {
```

No data cleanup needed — cases created under either behaviour are valid rows.

## Open question

- **Window length (30 min):** matches the session-timeout grain. If campaign reply patterns show
  clients commonly continuing one issue across a longer gap, widen to 60 min — it's a one-constant
  change. Flag if 30 min looks too tight in the first campaign batch.
