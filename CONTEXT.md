# Domain glossary — ttt-whatsapp-bot

The ubiquitous language for the WhatsApp tax bot. Use these terms in code, tests, and reviews.

## Case

A unit of client intent the bot is accountable for answering. Mirrored across two systems: a
`whatsapp_cases` row in Supabase (the bot's conversation-scoped source of truth) and a
`riivo_requests` record in Dynamics (the consultant's view). A Case moves through a state
machine: `open` → `classified` → `bot_responded` → `resolved_by_bot` / `escalated` /
`resolved_timeout`. Owned operationally by `case.service.ts`.

## Case routing

The per-turn decision of how an inbound message relates to the session's open Case, made before
the bot answers. Five outcomes, expressed as the `CaseRouting` discriminated union in
`src/domain/caseRouting.ts`:

- **fresh** — no open Case and the message qualifies → open the first Case.
- **continue** — an open Case exists and this message belongs to it (a follow-up within the
  continuation window, a short ack, or any reply while it is still being drafted) → reuse it.
- **topic-shift** — the open Case is already `bot_responded` and this is a *new* qualifying
  question landing outside the continuation window → resolve the prior Case and open a new one.
- **reclassify** — the open Case is `escalated` but the client has now clarified or wrapped up
  → attempt L1 recovery on it.
- **none** — no Case action this turn (message didn't qualify, or an escalated Case is just
  being threaded without a new action).

The decision is **pure**: `decideCaseRouting(latestCase, message, now)`. Applying it (closing,
creating, recording) is I/O the processor performs. The **continuation window**
(`TOPIC_SHIFT_MIN_GAP_MS`, 30 min) is what separates `continue` from `topic-shift`; see
`docs/topic-shift-relaxation.md`.

## Conversation cap

The per-turn decision of whether a non-staff sender has exhausted their allowance and the
bot should refuse to invoke Claude. Three outcomes, expressed as the `ConversationCap`
discriminated union in `src/domain/conversationCap.ts`:

- **blocked** — the session is already `cap_blocked_at` → send the canned blocked reply.
- **hit** — this turn crosses a limit (per-session messages/tokens, or per-day messages;
  daily wins ties) → send the canned hit reply, mark the session blocked, escalate the open
  Case.
- **ok** — under all limits → proceed.

The decision is **pure**: `decideConversationCap(counts, dailyCount)`. It needs no clock
(`cap_blocked_at` is a truthy check) and reads its thresholds (`CAP_MESSAGES_PER_SESSION`,
`CAP_TOKENS_PER_SESSION`, `CAP_MESSAGES_PER_DAY`) as exported module constants. Fetching the
daily count, sending replies, marking blocked and escalating are I/O the processor performs.
The staff guard (`type !== 'user'`) stays in the processor.

## Feedback reply

The per-turn decision of whether a client's inbound is answering the Case-resolution prompt
("Did that answer your question?"). Expressed as the `FeedbackReply` discriminated union in
`src/domain/feedbackReply.ts`:

- **feedback** — carries `verdict: 'confirmed' | 'rejected'` → close the Case via feedback,
  clear the pending pointer, send the matching ack.
- **clear-pending** — a pending Case exists but this isn't feedback → clear the pending
  pointer and fall through to the normal answer path.
- **none** — no pending Case this turn.

The decision is **pure**: `decideFeedbackReply(history, msg, pendingCaseId)`. It owns the full
gate — explicit button-tap bypass, the backward scan for the last assistant turn, the
`startsWith(CASE_FEEDBACK_PROMPT_TEXT)` check, and the `detectFeedback` heuristic. Applying it
(closing, acking, clearing) is I/O the processor performs. The client guard
(`type === 'client'`) stays in the processor.

## Qualifying message

A message substantial enough to warrant a Case — not an emoji, single noise word, or sub-3-char
fragment. Decided by the pure predicate `qualifyMessage`.

## Continuation window

The 30-minute grace period after a Case's last activity within which a further qualifying
message is treated as the same thread (`continue`) rather than a new topic (`topic-shift`).

## Document recommendation

The tailored, **reason-annotated, form-deduped** list of documents the bot doesn't yet see on
file for a client's tax return. Built by the pure kernel `buildDocRecommendation(input)` in
`src/domain/docRecommendation.ts`, mirroring the `decideCaseRouting` / `decideFeedbackReply`
seam: it owns the decision logic (source-code / industry expansion, received-doc diff, form
supersession, reason attachment, ordering); the Dynamics reads and sending stay in
`requiredDocuments.service.ts` / the processor.

- **DocSpec** — one document need: a `label` and a non-empty client-facing `reason` ("why you'd
  need this"). Lives in the source-code / industry / baseline tables. Every spec carries a
  reason so the client can self-select.
- **Baseline docs** — what every client needs regardless of signals. **IRP5 is baseline; Bank
  Statements and ID Document are not** (ADR 0002 baseline correction). Bank statements are
  source-code / industry driven only.
- **Form supersedes doc** — when a fillable form (`list_tax_forms` catalog) covers a need, the
  builder emits the **form** and suppresses the duplicate raw-doc ask (never "send your logbook"
  *and* "fill the vehicle form"). The client may still send their own version. Driven by
  `SOURCE_CODE_FORMS` (source code → `formKey` + the doc labels it supersedes).
- **No-IRP5 fallback** — with no matching source codes the builder still returns the safe generic
  list from industry + baseline, reason-annotated, never a dead end.

Each output item is a `DocRecommendationItem` (`kind: 'doc' | 'form'`, `label`, `reason`,
optional `formKey`), split into `outstanding` / `received` against the labels already on file.
The design **never asserts completeness** — only "what I don't yet see on file" (ADR 0002).

## Tool

A capability the bot can invoke during a Claude turn (`get_client_invoices`, `create_invoice`,
`upload_irp5`, …). A Tool is a single entry in the **Tool registry** (`src/services/tools/`)
carrying everything the caller must know: its `name`, Anthropic `input_schema`, the `roles` that
may be offered it, an optional `requiredPerm` (staff permission gate), and a
`handle(args, ctx)` implementation. The registry is the **single source of truth** — the
offered-tools list per role and the defense-in-depth permission check are both *derived* from
it, never maintained as a second list.

- **Tool registry** — the table mapping tool name → entry, plus `runTool(name, args, ctx)` and
  `deriveOfferedTools(role, permittedKeys)`. `runTool` is called identically in the first Claude
  round and in the follow-up loop; there is no second dispatch site. Lives in
  `src/services/tools/`, with handlers grouped by audience (`clientTools.ts`, `staffTools.ts`,
  `leadTools.ts`).
- **ToolContext** — everything a handler needs for one turn, passed as the second argument:
  per-turn identity (`contactId`, `phoneNumber`, `sessionId`, `entityType`, `ownerFilter`), the
  shared client resolvers, staged upload state, and `deps` — the injected service **Ports**.
- **Port** — a narrow interface per service exposing only the methods Tools actually call
  (`DynamicsPort`, `SupabasePort`, `MetaPort`). The real service singletons satisfy a Port
  structurally in production; a test passes a fake implementing only the subset under exercise.
  Two adapters justify the seam: real services in prod, fakes in tests — so a Tool is tested
  through its interface with no Anthropic client mocked.

The registry replaces the duplicated 45-branch `if/else` dispatch in `claude.service.ts`. It is
**not pure** (handlers do I/O), so it lives under `services/`, not `domain/` — but the decision
of *which* Tool runs, and whether it is allowed, is concentrated in one place.
