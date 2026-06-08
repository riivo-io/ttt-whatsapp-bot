# `riivo_request` lifecycle

How a WhatsApp question becomes a Dynamics `riivo_request`, every state it can move through, and what each conversation actually looks like on the wire.

The Supabase `whatsapp_cases` table is the **source of truth** for case state. Every transition writes Supabase first, then best-effort PATCHes the mirrored `riivo_request` in Dynamics so staff can see status and resolution in CRM. A Dynamics failure never blocks Supabase.

Code references in this doc point at the live implementation in [src/services/case.service.ts](../src/services/case.service.ts), [src/services/dynamics.service.ts](../src/services/dynamics.service.ts), and [src/workers/whatsappProcessor.ts](../src/workers/whatsappProcessor.ts).

---

## 1. State model

### Dynamics `statecode` (built-in)

| Value | Name |
|---|---|
| `0` | Active |
| `1` | Inactive |

### Dynamics `statuscode` ([dynamics.service.ts:52-65](../src/services/dynamics.service.ts#L52-L65))

| Code | Name | `statecode` | Meaning |
|---|---|---|---|
| `1` | `NEW` | Active | Request created; classifier hasn't run |
| `463630004` | `CLASSIFIED` | Active | Classifier done — `riivo_classificationlevel` + `riivo_classificationtopic` populated |
| `463630005` | `BOT_ANSWERED` | Active | Bot's answer has been sent to the client |
| `463630001` | `AWAITING_FEEDBACK` | Active | Yes/No buttons sent; waiting on client |
| `463630006` | `ESCALATED` | Active | Needs a human — consultant must work it |
| `2` | `RESOLVED_BY_BOT` | Inactive | Confirmed by feedback, implicit topic shift, or lead-event resolution |
| `463630007` | `RESOLVED_TIMEOUT` | Inactive | No feedback within window — assumed resolved |
| `463630008` | `RESOLVED_BY_STAFF` | Inactive | Staff-only terminal state |
| `463630003` | `CLOSED` | Inactive | Staff-only terminal state |

> `IN_PROGRESS` (`463630002`) exists in the enum but isn't written by any current code path.
>
> **Escalated stays Active.** A consultant still has to work it; flipping to Inactive would drop it out of active-work views.

### Companion option sets

`riivo_clientfeedback` ([dynamics.service.ts:77-83](../src/services/dynamics.service.ts#L77-L83)):

| Code | Name | Set when |
|---|---|---|
| `463630000` | `CONFIRMED` | Client tapped "Yes, thanks" (or said "thanks" as wrap-up) |
| `463630001` | `REJECTED` | Client tapped "Still need help" |
| `463630002` | `NO_RESPONSE_TIMEOUT` | 12h sweep, 10-min auto-close, or lead-event resolution |
| `463630003` | `NOT_ASKED` | Implicit topic-shift resolution (no buttons shown) |

`riivo_resolutionmethod` ([dynamics.service.ts:67-75](../src/services/dynamics.service.ts#L67-L75)):

| Code | Name | Set by |
|---|---|---|
| `463630000` | `AUTO_DIRECT_ANSWER` | `recordBotResponse` and topic-shift `markResolvedByBot` |
| `463630001` | `AUTO_TOOL_CALL` | `resolveByLeadId` (LoE / OTP / post-LoE activation) |
| `463630002` | `FEEDBACK_CONFIRMED` | Client tapped "Yes, thanks" |
| `463630003` | `TIMEOUT_ASSUMED_RESOLVED` | 12h sweep + 10-min auto-close |
| `463630004` | `STAFF_RESOLVED` | Staff-only (no code path writes this today) |
| `463630005` | `NOT_RESOLVED_ESCALATED` | Reserved for staff-side use |

`riivo_classificationlevel` ([dynamics.service.ts:86-91](../src/services/dynamics.service.ts#L86-L91)): `L1`, `L2`, `L3`, `ESCALATION`. Only `L1` and `ESCALATION` are written today.

`riivo_classificationtopic`: free text, one of [L1_TOPICS](../src/services/case.service.ts#L40-L60) (`invoice_query`, `case_status`, `refund_status`, `tax_form_request`, `general_tax_question`, …) or `null` for escalation. Special non-L1 topics also used: `otp_signup`, `otp_help`, `post_loe_activation`.

---

## 2. Lifecycle diagram

```
                            inbound WhatsApp message
                                       │
                                       ▼
                              qualifyMessage()? ──── no ──▶ no case created
                                       │                    (logged under contact/lead)
                                      yes
                                       ▼
                          ┌─────────────────────────┐
                          │     NEW (Active)        │
                          └────────────┬────────────┘
                                       │ classifyCase
                       ┌───────────────┴────────────────┐
                       ▼                                ▼
              CLASSIFIED (L1)                   CLASSIFIED (Escalation)
                       │                                │
                       │ recordBotResponse              │ markEscalated
                       ▼                                ▼
              BOT_ANSWERED                      ESCALATED ─── reclassifyCase
                       │                          (Active)   if next turn = L1
                       │ feedbackPromptWorker       │    │
                       │  fires (~2.5 min idle)     │    └──▶ back to CLASSIFIED (L1)
                       ▼                            │
              AWAITING_FEEDBACK                     │
                       │                            │
       ┌───────────────┼────────────────┐           │
       │               │                │           │
   "Yes,thanks"   "Still need     no reply,         │
       │           help"          10-min            │
       │               │          auto-close        │
       ▼               ▼          or 12h sweep      │
  RESOLVED_BY_BOT  ESCALATED   RESOLVED_TIMEOUT     │
   (Inactive)      (Active) ────────┐ (Inactive)    │
                                    └───────────────┘
                                  consultant works it
```

Out-of-band paths into terminal states:

- **Topic shift** (`markResolvedByBot('topic_shift')`): previous `BOT_ANSWERED` case → `RESOLVED_BY_BOT` when the next message is clearly a new question.
- **Natural wrap-up** (`resolveAllOpenCasesAsConfirmed`): "thanks" / "perfect" / "sorted" → every open case in the session → `RESOLVED_BY_BOT` with `FEEDBACK_CONFIRMED`.
- **Lead event** (`resolveByLeadId`): LoE signed, OTP completed, post-LoE activation → every open case for the lead → `RESOLVED_BY_BOT` with `AUTO_TOOL_CALL`.
- **Rate-limit / token-cap** during the inference: case → `ESCALATED` so the conversation isn't dropped silently ([whatsappProcessor.ts:850-864](../src/workers/whatsappProcessor.ts#L850-L864)).

---

## 3. The qualification gate

`qualifyMessage()` ([case.service.ts:145-154](../src/services/case.service.ts#L145-L154)) decides whether an inbound creates a case at all. It rejects:

- messages shorter than 3 chars,
- emoji-only messages,
- single-word noise (`thanks`, `ok`, `cool`, `hi`, `yes`, `no`, `test`, …).

Messages that fail qualification are still logged as `riivo_whatsappcommunicationses` against the contact or the open request, but they don't open a new case.

---

## 4. Conversation examples

Every example shows the WhatsApp transcript on the left, and the resulting Supabase row + Dynamics `riivo_request` state on the right.

### 4.1 L1 happy path — bot answers, client confirms

```
[Client] How much is my outstanding invoice?
                                  ┌─ Supabase ─────────────────┬─ Dynamics ─────────────────────────┐
                                  │ status='created'           │ statecode=Active                   │
                                  │                            │ statuscode=NEW                     │
                                  └────────────────────────────┴────────────────────────────────────┘
                                  ┌─ after classifyCase ─────────────────────────────────────────────┐
                                  │ status='classified'        │ statuscode=CLASSIFIED              │
                                  │ level='L1'                 │ riivo_classificationlevel=L1       │
                                  │ level_topic='invoice_query'│ riivo_classificationtopic='invoice_query' │
                                  └─────────────────────────────────────────────────────────────────┘
[Bot]   Your outstanding balance is R 1,250 for invoice #2026-0341.
                                  ┌─ after recordBotResponse ────────────────────────────────────────┐
                                  │ status='bot_responded'     │ statuscode=BOT_ANSWERED            │
                                  │ resolution_method='direct_answer' │ riivo_resolutionmethod=AUTO_DIRECT_ANSWER │
                                  │                            │ riivo_botanswers='Your outstanding…'│
                                  └──────────────────────────────────────────────────────────────────┘

   …2.5 minutes idle…  feedbackPromptWorker fires
[Bot]   Did that answer your question?   [Yes, thanks] [Still need help]
                                  ┌─ Supabase unchanged ────────┬─ Dynamics ───────────────────────┐
                                  │ pending_case_id=<this case>│ statuscode=AWAITING_FEEDBACK     │
                                  └─────────────────────────────┴──────────────────────────────────┘

[Client] (taps) Yes, thanks
                                  ┌─ handleFeedback('confirmed') ────────────────────────────────────┐
                                  │ status='resolved_by_bot'   │ statecode=Inactive                 │
                                  │ feedback_received='confirmed'│ statuscode=RESOLVED_BY_BOT       │
                                  │ resolved_at=<now>          │ riivo_clientfeedback=CONFIRMED     │
                                  │                            │ riivo_resolvedon=<now>             │
                                  │                            │ riivo_resolutionmethod=FEEDBACK_CONFIRMED │
                                  └──────────────────────────────────────────────────────────────────┘
```

### 4.2 L1 timeout — client never responds to the feedback prompt

Two windows fire; whichever wins flips the case Inactive. The 10-minute window is the [caseAutoCloseWorker](../src/workers/caseAutoCloseWorker.ts) enqueued by `feedbackPromptWorker`; the 12-hour sweep is the safety-net cron in [routes/cron.route.ts](../src/routes/cron.route.ts).

```
[Client] When does the 2026 tax season end?
[Bot]   Tax season for non-provisional individuals closes 23 Oct 2026.

   …feedback prompt fires at ~2.5 min…
[Bot]   Did that answer your question?   [Yes, thanks] [Still need help]

   …10 minutes later, client never replied…  caseAutoCloseWorker fires
                                  ┌─ Supabase ─────────────────┬─ Dynamics ─────────────────────────┐
                                  │ status='resolved_by_bot_timeout' │ statecode=Inactive          │
                                  │ feedback_received='timeout' │ statuscode=RESOLVED_TIMEOUT      │
                                  │ resolved_at=<now>          │ riivo_clientfeedback=NO_RESPONSE_TIMEOUT │
                                  │                            │ riivo_resolutionmethod=TIMEOUT_ASSUMED_RESOLVED │
                                  └────────────────────────────┴────────────────────────────────────┘
```

If the 10-minute worker misses (queue lag, server restart), the 12h `handleTimeout()` cron sweeps the same case with the same terminal state.

### 4.3 Client rejects the bot answer → escalation

```
[Client] Has my refund been paid?
[Bot]   Your refund of R 8,400 was issued by SARS on 14 May 2026.
        Did that answer your question?   [Yes, thanks] [Still need help]

[Client] (taps) Still need help
                                  ┌─ handleFeedback('rejected') ─────────────────────────────────────┐
                                  │ status='escalated'         │ statecode=Active (stays Active)    │
                                  │ feedback_received='rejected'│ statuscode=ESCALATED              │
                                  │                            │ riivo_clientfeedback=REJECTED      │
                                  │                            │ riivo_escalationreason='Client rejected bot answer' │
                                  │                            │ riivo_escalatedon=<now>            │
                                  └──────────────────────────────────────────────────────────────────┘
```

A consultant picks the request up from Active-work views. Resolution to `RESOLVED_BY_STAFF` happens in CRM, not via the bot.

### 4.4 Direct escalation — explicit human request

The classifier ([case.service.ts:72-108](../src/services/case.service.ts#L72-L108)) only marks `escalation` when the client explicitly asks for a person. Frustration alone stays L1.

```
[Client] Can a consultant call me back about my submission?

                                  ┌─ classifyCase ────────────────────────────────────────────────────┐
                                  │ status='classified'        │ statuscode=CLASSIFIED              │
                                  │ level='escalation'         │ riivo_classificationlevel=ESCALATION│
                                  │ level_topic=null           │ riivo_classificationtopic=null     │
                                  └───────────────────────────────────────────────────────────────────┘

                                  ┌─ markEscalated ──────────────────────────────────────────────────┐
                                  │ status='escalated'         │ statuscode=ESCALATED               │
                                  │                            │ riivo_escalationreason='Bot classified as escalation' │
                                  │                            │ riivo_escalatedon=<now>            │
                                  └──────────────────────────────────────────────────────────────────┘
```

The bot still acknowledges the client in the same turn ("I've logged this for a consultant…") but no feedback prompt is fired and no bot answer is recorded.

### 4.5 Escalation recovery — vague first turn becomes clearly L1

`reclassifyCase` ([case.service.ts:336-381](../src/services/case.service.ts#L336-L381)) only flips escalation → L1, never the other way. On a flip, `recoverFromEscalation` clears `riivo_escalatedon` and `riivo_escalationreason` so reporting sees a clean L1 case rather than "escalated then recovered".

```
[Client] To do my tax
                                  ┌─ First turn classifies as ESCALATION (vague) ───────────────────┐
                                  │ level='escalation'          │ statuscode=ESCALATED              │
                                  └──────────────────────────────────────────────────────────────────┘

[Bot]   What would you like help with? An invoice, your refund, an audit…?

[Client] I need to know my refund status
                                  ┌─ reclassifyCase runs on full transcript ─────────────────────────┐
                                  │ Sees full conversation, decides this is clearly L1 / refund_status│
                                  └───────────────────────────────────────────────────────────────────┘

                                  ┌─ recoverFromEscalation ──────────────────────────────────────────┐
                                  │ status='classified'         │ statuscode=CLASSIFIED              │
                                  │ level='L1'                  │ riivo_classificationlevel=L1       │
                                  │ level_topic='refund_status' │ riivo_classificationtopic='refund_status'│
                                  │                             │ riivo_escalatedon=null             │
                                  │                             │ riivo_escalationreason=null        │
                                  └───────────────────────────────────────────────────────────────────┘

[Bot]   Your refund of R 8,400 was issued by SARS on 14 May 2026. …
```

The same recovery path fires when a previously-escalated case is followed up later in the session with either a qualifying message or a wrap-up phrase ([whatsappProcessor.ts:920-933](../src/workers/whatsappProcessor.ts#L920-L933)).

### 4.6 Topic shift — old case closes silently, new case opens

When a client moves on to a new question instead of tapping a feedback button, the previous `BOT_ANSWERED` case is closed implicitly. No "Yes" was tapped, so `riivo_clientfeedback` is `NOT_ASKED` and the resolution method is `AUTO_DIRECT_ANSWER`.

```
[Client] What's my outstanding balance?     ─── Case A
[Bot]   You owe R 1,250 on invoice #2026-0341.
   (feedback prompt fires; client doesn't respond)

[Client] What documents do you need for my home office claim?
                                  ┌─ Case A: markResolvedByBot('topic_shift') ───────────────────────┐
                                  │ status='resolved_by_bot'    │ statecode=Inactive                 │
                                  │ resolution_method='topic_shift'│ statuscode=RESOLVED_BY_BOT      │
                                  │ resolved_at=<now>           │ riivo_clientfeedback=NOT_ASKED     │
                                  │                             │ riivo_resolutionmethod=AUTO_DIRECT_ANSWER│
                                  └───────────────────────────────────────────────────────────────────┘
                                  ┌─ Case B: NEW request created for the new question ──────────────┐
                                  │ status='created' → 'classified' (level_topic='home_office_requirements')│
                                  └───────────────────────────────────────────────────────────────────┘
[Bot]   For a home office claim you'll need …
```

### 4.7 Session-wide wrap-up — one "thanks" closes everything

`detectWrapUp` ([case.service.ts:523-529](../src/services/case.service.ts#L523-L529)) catches `thanks`, `perfect`, `sorted`, `got it`, `lekker`, etc. — short closing acks that aren't covered by the feedback button window. When it fires, `resolveAllOpenCasesAsConfirmed` closes **every** open case in the session, not just the most recent one. That's also how `handleFeedback('confirmed')` behaves when a Yes-tap arrives ([case.service.ts:414-446](../src/services/case.service.ts#L414-L446)).

```
[Client] What's my outstanding balance?            ─── Case A
[Bot]   You owe R 1,250 on invoice #2026-0341.

[Client] And am I on audit?                        ─── Case B (topic shift closes Case A)
[Bot]   No, your 2026 return isn't on review.

[Client] Perfect, thanks!
                                  ┌─ resolveAllOpenCasesAsConfirmed ─────────────────────────────────┐
                                  │ Case B (still open):                                              │
                                  │   status='resolved_by_bot' │ statecode=Inactive                  │
                                  │   feedback_received='confirmed' │ statuscode=RESOLVED_BY_BOT     │
                                  │                            │ riivo_clientfeedback=CONFIRMED      │
                                  │                            │ riivo_resolutionmethod=FEEDBACK_CONFIRMED │
                                  └──────────────────────────────────────────────────────────────────┘
```

`detectWrapUp` is deliberately conservative: skips long messages, anything with `?`, and anything containing `but`/`however`/`actually`/`also`/`wait`/`another`/`one more`.

### 4.8 Lead-event resolution — LoE / OTP completion closes the case

When a lead completes a milestone outside the chat (LoE signed via the onboarding app, OTP entered, post-LoE activation sweep), `resolveByLeadId` ([case.service.ts:472-503](../src/services/case.service.ts#L472-L503)) closes any open cases for that lead without firing the feedback prompt — the milestone itself is the resolution.

```
[Client / Lead] Need help with the OTP for SARS
                                  ┌─ otp_help case created ──────────────────────────────────────────┐
                                  │ riivo_classificationtopic='otp_help'│ statuscode=NEW           │
                                  └───────────────────────────────────────────────────────────────────┘
[Bot]   Sure — when SARS sends the OTP, paste it here and I'll check it.

   …client completes OTP via SARS eFiling, Dynamics flag flips
   to riivo_efilingotpcompleted=true …

   …next inbound (or post-LoE activation sweep) triggers resolveByLeadId…
                                  ┌─ resolveByLeadId(leadId, reason='resolved_by_lead_event') ───────┐
                                  │ status='resolved_by_bot'   │ statecode=Inactive                  │
                                  │ resolution_method='resolved_by_lead_event' │ statuscode=RESOLVED_BY_BOT │
                                  │ resolved_at=<now>          │ riivo_clientfeedback=NO_RESPONSE_TIMEOUT │
                                  │                            │ riivo_resolutionmethod=AUTO_TOOL_CALL│
                                  └──────────────────────────────────────────────────────────────────┘
```

### 4.9 Rate-limit hit during inference → escalation

If Claude returns a 429 the worker can't recover from in time, the in-flight case escalates so the conversation isn't silently dropped ([whatsappProcessor.ts:850-864](../src/workers/whatsappProcessor.ts#L850-L864)).

```
[Client] Can you summarise everything I've sent in this year?
   …Claude returns 429 (token cap on session)…
                                  ┌─ markEscalated(caseId, reason) ──────────────────────────────────┐
                                  │ status='escalated'         │ statuscode=ESCALATED                │
                                  │                            │ riivo_escalationreason='<rate-limit reason>' │
                                  │                            │ riivo_escalatedon=<now>             │
                                  └──────────────────────────────────────────────────────────────────┘
[Bot]   I'm going to hand this over to one of our consultants who'll come back to you shortly.
```

### 4.10 Classifier failure — fail safe to escalation

If the classifier itself errors (network blip, non-429 failure), `classifyCase` ([case.service.ts:240-261](../src/services/case.service.ts#L240-L261)) defaults the case to escalation rather than wrongly marking it L1. Safer to send a human than to ship a wrong auto-answer.

```
[Client] My bank rejected the refund EFT, how do I update my account?

   …classifier throws / returns malformed tool call…
                                  ┌─ classifyCase catch branch ─────────────────────────────────────┐
                                  │ status='classified'        │ statuscode=CLASSIFIED              │
                                  │ level='escalation'         │ riivo_classificationlevel=ESCALATION│
                                  │ level_topic=null           │ riivo_classificationtopic=null     │
                                  └──────────────────────────────────────────────────────────────────┘
                                  (the calling code then issues markEscalated)
```

### 4.11 Non-qualifying inbound — no case created

```
[Client] 👍

   qualifyMessage rejects (emoji-only). No riivo_request created.
   The inbound is still logged as riivo_whatsappcommunicationses,
   regardingobjectid set to the open request if any (continuation
   threading) — otherwise to the contact/lead.
```

Same outcome for `ok`, `thanks` (when no open case exists to wrap up), `hi`, `test`, or any single-noise-word reply.

---

## 5. State-transition cheat sheet

| Event | Method | Supabase write | Dynamics PATCH |
|---|---|---|---|
| Qualifying inbound | `createCase` ([case.service.ts:161](../src/services/case.service.ts#L161)) | INSERT `status='created'` | CREATE `statecode=ACTIVE`, `statuscode=NEW`, client/lead binding |
| Classifier runs | `classifyCase` ([case.service.ts:208](../src/services/case.service.ts#L208)) | `status='classified'`, `level`, `level_topic` | `statuscode=CLASSIFIED`, `riivo_classificationlevel`, `riivo_classificationtopic` |
| Bot answers | `recordBotResponse` ([case.service.ts:268](../src/services/case.service.ts#L268)) | `status='bot_responded'`, `resolution_method='direct_answer'` | `statuscode=BOT_ANSWERED`, `riivo_botanswers`, `riivo_resolutionmethod=AUTO_DIRECT_ANSWER` |
| Feedback prompt fires | `feedbackPromptWorker` ([feedbackPromptWorker.ts:85](../src/workers/feedbackPromptWorker.ts#L85)) | `pending_case_id` set | `statuscode=AWAITING_FEEDBACK` |
| Client taps "Yes" | `handleFeedback('confirmed')` ([case.service.ts:414](../src/services/case.service.ts#L414)) | every open case in session: `status='resolved_by_bot'`, `feedback_received='confirmed'`, `resolved_at` | `statecode=INACTIVE`, `statuscode=RESOLVED_BY_BOT`, `riivo_clientfeedback=CONFIRMED`, `riivo_resolvedon`, `riivo_resolutionmethod=FEEDBACK_CONFIRMED` |
| Client taps "No" | `handleFeedback('rejected')` | `status='escalated'`, `feedback_received='rejected'` | `statuscode=ESCALATED` (stays Active), `riivo_clientfeedback=REJECTED`, `riivo_escalationreason='Client rejected bot answer'`, `riivo_escalatedon` |
| 10-min auto-close | `caseAutoCloseWorker` ([caseAutoCloseWorker.ts](../src/workers/caseAutoCloseWorker.ts)) | `status='resolved_by_bot_timeout'`, `feedback_received='timeout'`, `resolved_at` | `statecode=INACTIVE`, `statuscode=RESOLVED_TIMEOUT`, `riivo_clientfeedback=NO_RESPONSE_TIMEOUT`, `riivo_resolutionmethod=TIMEOUT_ASSUMED_RESOLVED` |
| 12h sweep | `handleTimeout` ([case.service.ts:572](../src/services/case.service.ts#L572)) | same as above | same as above |
| Topic shift | `markResolvedByBot('topic_shift')` ([case.service.ts:292](../src/services/case.service.ts#L292)) | `status='resolved_by_bot'`, `resolution_method='topic_shift'`, `resolved_at` | `statecode=INACTIVE`, `statuscode=RESOLVED_BY_BOT`, `riivo_clientfeedback=NOT_ASKED`, `riivo_resolutionmethod=AUTO_DIRECT_ANSWER` |
| Natural wrap-up | `resolveAllOpenCasesAsConfirmed` ([case.service.ts:538](../src/services/case.service.ts#L538)) | identical to "Yes" | identical to "Yes" |
| Direct escalation (classifier) | `markEscalated` ([case.service.ts:316](../src/services/case.service.ts#L316)) | `status='escalated'` | `statuscode=ESCALATED`, `riivo_escalationreason='Bot classified as escalation'`, `riivo_escalatedon` |
| Rate-limit / inference fail | `markEscalated` (other reason string) | `status='escalated'` | `statuscode=ESCALATED`, `riivo_escalationreason=<reason>`, `riivo_escalatedon` |
| Escalation recovery | `recoverFromEscalation` ([case.service.ts:388](../src/services/case.service.ts#L388)) | `status='classified'`, `level='L1'`, `level_topic` | `statuscode=CLASSIFIED`, `riivo_classificationlevel=L1`, `riivo_classificationtopic`, `riivo_escalatedon=null`, `riivo_escalationreason=null` |
| Lead-event resolution | `resolveByLeadId` ([case.service.ts:472](../src/services/case.service.ts#L472)) | `status='resolved_by_bot'`, `resolution_method=<reason>`, `resolved_at` | `statecode=INACTIVE`, `statuscode=RESOLVED_BY_BOT`, `riivo_clientfeedback=NO_RESPONSE_TIMEOUT`, `riivo_resolutionmethod=AUTO_TOOL_CALL` |

---

## 6. Invariants worth remembering

- **Supabase writes first.** Every transition lands in Supabase before the Dynamics PATCH. If Dynamics is down, the case still progresses; CRM just lags.
- **Dynamics PATCHes are best-effort.** Failures log a warning and continue. They do not roll back the Supabase write.
- **Session scope on positive signals.** A single confirmation (button tap or wrap-up phrase) closes every open case in the session. Negative signals (rejection) only escalate the single anchor case.
- **Escalation only flows one way except via recovery.** `markEscalated` never flips Active → Inactive. The only way back from `ESCALATED` is `recoverFromEscalation`, which is only reached when the classifier rerun on the full transcript returns `L1`.
- **Lead and client cases use the same lifecycle.** The only difference is which Dynamics binding is set on creation: `riivo_Lead@odata.bind` vs `riivo_Client@odata.bind`.
- **`riivo_botanswers` only writes on `recordBotResponse`.** Topic-shift and timeout closures don't update it — the answer recorded is whatever the bot last sent on that case.
