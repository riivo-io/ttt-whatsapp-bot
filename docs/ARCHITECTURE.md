# TTT WhatsApp Tax Bot — Architecture

_Last reviewed: 2026-06-26_

This document describes the runtime architecture of the TTT WhatsApp Tax Bot end-to-end: the HTTP surface, the queue/worker split, identity resolution, AI orchestration (now a Tool registry + a pure `decide*`/`build*` domain layer), the knowledge-base RAG layer, the stateless document-collection journey, data stores, CRM mirroring, the Microsoft Graph integrations (mail relay + SharePoint), and the supporting background jobs. It is written for engineers who need to change the system; it is not a product pitch.

> **What changed since 2026-06-05** (see [docs/adr/](./adr/)):
> - **Tool dispatch is now a registry** (`src/services/tools/`, ADR 0003): one `runTool` site, 40 tools each defined once, dependencies injected through narrow Ports, and the Anthropic `TOOLS` array derived from the registry. The old ~2,000-line `if/else` dispatch in `claude.service.ts` is gone.
> - **Per-turn decisions are pure modules** (`src/domain/`, ADR 0001): `decideCaseRouting`, `decideConversationCap`, `decideFeedbackReply`, and `buildDocRecommendation` are pure kernels the processor applies.
> - **Document guidance is advice-only** (ADR 0004, superseding parts of ADR 0002): the old greeting-driven IRP5 ask is gone and Tina no longer reads a client's upload records or reports received / outstanding status — TTT's upload data is unreliable. She personalises *which* documents are associated with a return from the client's profile (SARS source codes + industry) and relays that as advice on what to gather; uploads still work, they're just never read back to the client.
> - **Staff (internal "user") mode is gated behind `STAFF_MODE_ENABLED`** (default off): with it off the bot is client/lead-only and skips all `systemusers` lookups.
> - New flows: **bad-debt** overdue-invoice nudge, **"Meet Tina" campaign** stateless button routing.

---

## 1. System overview

The bot is split into **two long-lived Node processes** that share a Supabase (Postgres) datastore and an **Azure Service Bus** queue. A thin Express **web ingester** ACKs Meta and enqueues; a separate **worker** process drains the queues and does all the Claude/Dynamics/Supabase work. It sits between Meta's WhatsApp Cloud API, Anthropic Claude, Microsoft Dynamics 365, Microsoft Graph (mail + SharePoint), Mistral OCR, and OpenAI embeddings.

```
                                  ┌──────────────────────────────┐
┌────────────┐  Webhook POST      │  WEB INGESTER  (server.ts)   │
│  WhatsApp  │ ─────────────────▶ │  - verify + ACK 200          │
│  (Meta)    │                    │  - idempotency claim         │
└────────────┘ ◀───────────────  │  - enqueue                   │
        ▲      Send msg (worker)  └───────────────┬──────────────┘
        │                                         │ enqueue
        │                                         ▼
        │                              ┌──────────────────────┐
        │                              │  Azure Service Bus    │
        │                              │  whatsapp-inbound     │
        │                              │  feedback-prompt      │
        │                              │  case-auto-close      │
        │                              └───────────┬───────────┘
        │                                          │ consume
        │                          ┌───────────────▼────────────────────┐  runTool()  ┌──────────────────┐
        └──────────────────────────│  WORKER  (worker.ts)               │ ───────────▶│  Anthropic       │
                                    │  processMessage()                  │ ◀───────────│  opus-4-7 (main) │
                                    │  ├─ domain/  pure decide*/build*   │             │  haiku-4-5 (aux) │
                                    │  └─ services/tools/  REGISTRY      │             └──────────────────┘
                                    └───┬──────┬──────┬──────┬───────────┘
                                        │      │      │      │     (handlers reach services via ctx.deps Ports)
                            Supabase ◀──┘      │      │      └──▶ Microsoft Graph (mail + SharePoint)
                            (Postgres+pgvector)│      │
                                               │      └──▶ Mistral OCR (LOE/IRP5 PDFs)
                                               └──▶ Dynamics 365 (Web API v9.2)
                                  OpenAI text-embedding-3-small ──▶ pgvector KB retrieval
```

**Runtime shape**

- Node 20+, TypeScript, Express 4.
- **Two processes**: `src/server.ts` (web ingester, `npm start`) and `src/worker.ts` (queue consumer, `npm run worker`). They do not share memory — the queue is the only handoff.
- The web ingester ACKs Meta with `200` immediately, claims an idempotency row, and enqueues. **No business logic runs in the web process.**
- The worker consumes three Service Bus queues and runs `processMessage` (the old monolith logic, now in `src/workers/whatsappProcessor.ts`).
- **Deployed on Azure App Service** (two App Service apps: web + worker). The legacy `vercel.json` crons in the repo do **not** fire on Azure. (See the `bot_hosting` memory note.)

**Languages and integrations**

- Meta WhatsApp Cloud API (Graph v22.0) — inbound messages, outbound text, interactive buttons/lists, documents, media download, WhatsApp Flows, and approved message templates.
- Azure Service Bus (`@azure/service-bus`) — the inbound work queue plus two delayed-job queues. See `src/queue/connection.ts`.
- Microsoft Dynamics 365 Web API v9.2 — authoritative CRM. Auth via MSAL client credentials.
- Anthropic Claude via `@anthropic-ai/sdk`:
  - `claude-opus-4-7` (`CLAUDE_MODEL` in `claude.service.ts`) — main assistant + tool loop + intent classifier.
  - `claude-haiku-4-5` / `claude-haiku-4-5-20251001` — the case L1/escalation classifier (`CLASSIFIER_MODEL` in `case.service.ts`), the LOE field extractor (`loe-extractor.service.ts`), the IRP5 field extractor (`irp5-extractor.service.ts`), and the consultant close-summary.
- Mistral OCR (`mistral-ocr-latest`) — turns signed LOE / IRP5 PDFs into markdown.
- OpenAI `text-embedding-3-small` (1536-dim) — embeds knowledge-base chunks for pgvector retrieval (`embeddings.service.ts:3`).
- Microsoft Graph — (a) the `tina-bot@ttt-group.co.za` shared mailbox for the email-relay flow and outbound consultant emails, and (b) SharePoint for the knowledge-base corpus and tax-form templates.
- Supabase (Postgres + pgvector) — session state, conversation history, roles/permissions, WhatsApp case lifecycle, pending LOE/IRP5 staging, knowledge-base vectors, webhook idempotency + DLQ, email-relay state, CRM audit log, usage/rate-limit telemetry.

---

## 2. Repository layout

```
src/
├── server.ts                          # WEB process: Express ingester (verify + ACK + enqueue)
├── worker.ts                          # WORKER process: starts the three queue consumers
├── domain/                            # PURE per-turn decision modules (no I/O, no clock) — ADR 0001/0002
│   ├── caseRouting.ts                 # decideCaseRouting() verdict
│   ├── conversationCap.ts             # decideConversationCap() — blocked|hit|ok
│   ├── feedbackReply.ts               # decideFeedbackReply() — Yes/No tap + history gate
│   ├── docRecommendation.ts           # buildDocRecommendation() + BASELINE_DOCS (stateless doc journey)
│   ├── clientRoleContext.ts           # buildClientRoleContext() prompt fragment
│   ├── irp5Reply.ts                   # IRP5 received-ack + associated-docs advice rendering
│   └── invoice.ts                     # mapInvoiceToInvoiceData (shared PDF mapper)
├── controllers/
│   ├── webhook.controller.ts          # Meta webhook verify + thin inbound dispatch (enqueue only)
│   └── emailRelay.controller.ts       # tina-bot mailbox → WhatsApp relay (consent flow)
├── queue/
│   ├── connection.ts                  # Shared Azure Service Bus client
│   ├── whatsappQueue.ts               # whatsapp-inbound producer (session = phone)
│   ├── feedbackPromptQueue.ts         # delayed L1 feedback-prompt producer
│   └── caseAutoCloseQueue.ts          # delayed case-auto-close producer
├── workers/
│   ├── whatsappWorker.ts              # whatsapp-inbound consumer (session-FIFO, rate-limit retry, DLQ)
│   ├── whatsappProcessor.ts           # processMessage() — the main inbound business logic
│   ├── feedbackPromptWorker.ts        # sends Yes/No feedback buttons after a delay
│   └── caseAutoCloseWorker.ts         # closes silent L1 cases after a delay
├── routes/
│   ├── pdf.route.ts                   # GET /api/pdf/invoice/:invoiceNumber
│   ├── cron.route.ts                  # GET /api/cron/* (case-timeout, graph subscription renew)
│   ├── email.route.ts                 # POST /webhook/email (Graph change notifications)
│   ├── loeSigned.route.ts             # POST /webhook/loe-signed (HMAC) — post-LOE activation
│   ├── outboundNotify.route.ts        # POST /webhook/outbound-notify (HMAC) — seed outbound templates
│   └── admin.route.ts                 # POST /admin/* (template cache refresh; CRON_SECRET auth)
├── services/
│   ├── tools/                         # Tool REGISTRY — one entry per Claude tool (ADR 0003)
│   │   ├── registry.ts               # ToolEntry type, REGISTRY map, runTool(), deriveOfferedTools(), entryAllowed(), Ports
│   │   ├── clientTools.ts            # client/lead-facing read + action tools
│   │   ├── staffTools.ts             # staff write/read tools (role 'user', requiredPerm gates)
│   │   ├── leadTools.ts              # verify_identity (role 'unknown') + lead-only tools
│   │   └── index.ts                  # assembles REGISTRY from the three modules
│   ├── meta.service.ts                # Meta Cloud API client
│   ├── claude.service.ts              # LLM orchestration: builds ToolContext, single runTool dispatch, RAG injection, intent classifier (TOOLS derived from REGISTRY)
│   ├── dynamics.service.ts            # Dynamics Web API client + all CRM writes/reads
│   ├── supabase.service.ts            # Sessions, messages, cases, pending LOE/IRP5, audit, staff lookup, session signals
│   ├── case.service.ts               # Case lifecycle + classifier + consultant close-summary
│   ├── idempotency.service.ts         # Webhook dedup claim + DLQ writes + LOE-activation mutex
│   ├── pendingUpload.service.ts       # In-memory staged WhatsApp uploads (10-min TTL)
│   ├── requiredDocuments.service.ts   # Per-client required-docs computation (SARS codes + industry)
│   ├── taxFaq.service.ts              # Refund / submission / audit status + required-docs advice (Dynamics-backed)
│   ├── taxForms.service.ts            # Tax-form catalog + latest-version resolution
│   ├── sharepoint.service.ts          # Microsoft Graph SharePoint client (KB corpus + forms + client docs)
│   ├── knowledgeBase.service.ts       # KB ingest + pgvector retrieval (match_kb_chunks)
│   ├── embeddings.service.ts          # OpenAI embeddings + markdown-aware chunker
│   ├── docExtractor.service.ts        # PDF/Word → markdown (pdf-parse / mammoth)
│   ├── loe-extractor.service.ts       # Claude extractor — LOE markdown → structured fields
│   ├── irp5-extractor.service.ts      # Claude extractor — IRP5 markdown → SARS-code fields
│   ├── pendingIrp5.service.ts         # IRP5 staging + drain-to-contact on conversion
│   ├── loeActivation.service.ts       # Post-LOE-signature activation (WhatsApp + taxcrew email + sentinel)
│   ├── graphMail.service.ts           # Microsoft Graph mail (read mailbox, send/reply, subscription lifecycle)
│   ├── forwardedEmail.service.ts      # Parse forwarded-email markers → original sender/body
│   ├── whatsappTemplateRegistry.service.ts  # Cache approved Meta templates + compose seeded history
│   ├── whatsappSignupNotifier.ts      # Notify external LOE app of new signups
│   ├── mistral.service.ts             # Mistral OCR client (PDF → markdown)
│   ├── pdf.service.ts                 # PDFKit invoice renderer + Dynamics→InvoiceData mapper
│   └── claudePricing.service.ts       # Per-model USD pricing + cost computation for claude_usage
├── utils/
│   ├── anthropicRateLimit.ts          # callAnthropicMessages wrapper, RateLimitError, 429 telemetry
│   ├── firstContactRouting.ts         # Referral-code/keyword → first-contact template routing
│   ├── autoReply.ts                   # Out-of-office / auto-reply detection
│   ├── greeting.ts                    # Greeting-only detection
│   ├── loeMagicLink.ts                # HMAC LOE magic-link mint/build
│   ├── hmac.ts                        # verifyHmacSha256 for inbound webhooks
│   └── (workingDays, docTypeMapping, preseasonDocTypes, messageContext, jobIdRetry, …)
├── scripts/
│   ├── sync-users-from-dynamics.ts    # `npm run sync:users`
│   ├── sync-knowledge-base.ts         # `npm run sync:kb` — SharePoint → pgvector
│   ├── create-graph-subscription.ts   # `npm run graph:bootstrap`
│   ├── list-graph-subscriptions.ts / sharepoint-bootstrap.ts / ingest-test-doc.ts
└── types/                             # crm.types.ts, meta.types.ts

supabase/migrations/                   # SQL migrations (see §13)
docs/                                  # Feature docs, PRDs, runbooks (this file + many)
test/                                  # Manual tsx scripts (simulate-webhook, test-case-lifecycle)
```

---

## 3. HTTP surface

The **web process** (`src/server.ts`) serves these routes. The **worker process** (`src/worker.ts`) exposes only a trivial `/` liveness endpoint on `$PORT` (default 8080) to satisfy the App Service readiness probe — it has no HTTP role otherwise.

| Method | Path                                | Handler                                      | Purpose                                                                                                          |
| ------ | ----------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                           | inline                                       | Liveness probe.                                                                                                 |
| GET    | `/webhook`                          | `webhook.controller.verifyWebhook`           | Meta subscription verification handshake.                                                                       |
| POST   | `/webhook`                          | `webhook.controller.handleIncomingMessage`   | Meta inbound. ACKs 200, dedupes, enqueues. **No processing here** (see §4).                                     |
| GET    | `/api/pdf/invoice/:invoiceNumber`   | `routes/pdf.route.ts`                        | Fetch invoice from Dynamics, render with PDFKit, stream the PDF.                                                |
| GET    | `/api/cron/case-timeout`            | `routes/cron.route.ts`                       | 12h sweep of stale `bot_responded` cases (fallback to the queued auto-close). Auth: `Bearer $CRON_SECRET`.      |
| GET    | `/api/cron/*` (graph renew)         | `routes/cron.route.ts`                       | Renew the Graph mail subscription + sweep expired email relays. Auth: `Bearer $CRON_SECRET`.                    |
| POST   | `/webhook/email`                    | `routes/email.route.ts` → `emailRelay.*`     | Microsoft Graph change notification when mail lands in the tina-bot mailbox. Validates `clientState`. (§11.1)   |
| POST   | `/webhook/loe-signed`               | `routes/loeSigned.route.ts`                  | External LOE-signing app calls this after a lead signs. HMAC over raw body (`X-LoE-Signature`). (§11.2)         |
| POST   | `/webhook/outbound-notify`          | `routes/outboundNotify.route.ts`             | External senders (Power Automate etc.) notify the bot they sent a template so it seeds session history. HMAC.   |
| POST   | `/admin/templates/refresh`          | `routes/admin.route.ts`                      | Force-refresh the Meta template cache. Auth: `Bearer $CRON_SECRET`.                                             |

`/webhook/loe-signed` and `/webhook/outbound-notify` mount **before** `express.json()` so their raw body is available for HMAC verification.

The web process listens on `PORT` (default `3001`). For local dev the public URL is an ngrok tunnel (see the `test_setup` memory note).

---

## 4. Inbound message flow

### 4.1 Web ingester (`webhook.controller.handleIncomingMessage`)

Deliberately thin:

1. **ACK first.** `res.sendStatus(200)` before any work — Meta retries non-200s aggressively.
2. **Shape guard.** Only `body.object === 'whatsapp_business_account'` is processed.
3. **PID allowlist (optional).** If `WEBHOOK_ALLOWED_PHONE_NUMBER_IDS` is set, inbound on any other `phone_number_id` is dropped at the door (the webhook is shared by every WABA on the Meta App).
4. **Extract + denylist.** `extractIncoming(message)` normalises the payload; phones in `WEBHOOK_BLOCKED_PHONES` are dropped silently.
5. **Idempotency claim.** `idempotencyService.claim(message.id, from)` does an `INSERT … ON CONFLICT DO NOTHING` on `whatsapp_webhook_events`. A duplicate (Meta retry, two ingester replicas) returns false → skip. Survives restarts.
6. **Enqueue.** `enqueueInboundMessage({ metaMessageId, phone, phoneNumberId, receivedAt, rawMessage })` onto the `whatsapp-inbound` Service Bus queue, with the **Service Bus session id set to the phone number** (per-phone FIFO) and the message id set to the Meta id (Service Bus duplicate detection as a second layer).

> Note: code comments in `webhook.controller.ts` still mention "BullMQ"/"Upstash/Redis" from an earlier queue implementation. The live queue is **Azure Service Bus** (`src/queue/connection.ts`). Treat those comments as stale.

### 4.2 Worker — `whatsappWorker` → `processMessage`

`whatsappWorker.ts` accepts the next Service Bus **session** (one phone at a time, FIFO within a phone), pulls its message, and calls `processInboundJob` → `extractIncoming` → `processMessage` (in `whatsappProcessor.ts`). Concurrency is `MAX_CONCURRENT_SESSIONS` (default 8). On `RateLimitError` (Anthropic 429) the message is re-enqueued with a delay (capped at 5 retries, message id namespaced `:retry:N`); on the 5th delivery or after the retry cap it is written to the `whatsapp_queue_dlq` table via `idempotencyService.recordDeadLetter`.

`processMessage` is the descendant of the old in-process monolith. Order still matters (it determines Dynamics threading):

1. **Flow submissions short-circuit.** A WhatsApp Flow sign-up reply creates a Dynamics lead and replies; the signup also notifies the external LOE app (`whatsappSignupNotifier`).
2. **First-contact templating (cold/out-of-session).** For strangers, `firstContactRouting` inspects the text for a referral code/keyword and routes to the `ttt_referral_welcome` or `ttt_welcome_signup` Meta template; falls back to a plain greeting+link if the template send fails.
3. **Auto-reply / greeting guards.** `looksLikeAutoReply` drops out-of-office bounces (one clarification per 24h); `looksLikeGreetingOnly` is used to gate the welcome menu.
4. **Document/image ingestion.** `downloadMedia` → buffer staged via `pendingUploadService` (10-min TTL). IRP5 uploads route to the IRP5 OCR flow (§10.2); other docs are filed to the client/lead record. A successful client doc-file sets the session's `had_doc_upload` flag (§6.7) and marks the doc case answered so the timeout sweep closes it.
5. **Email-relay consent replies.** A `relay_yes`/`relay_no` tap is handled by `emailRelay.handleClientRelayResponse` before the AI path (§11.1).
6. **Menu + campaign canonicalisation.** Client menu taps and the **"Meet Tina" launch-campaign quick-reply buttons** (`campaign:tina-launch:*`) are mapped to canonical questions. Campaign taps are routed **statelessly** on the tap itself (payload id or button title) — no session memory is needed, so a tap that arrives days after the broadcast still routes correctly (`campaignCanonicalText`).
7. **Identity resolution** via `resolveSender(phone)` → `{ crmEntity, staffRoleId, permittedTools }` (cached session → live Dynamics lookup; see §7). **Staff resolution is gated behind `STAFF_MODE_ENABLED`** (default off): when off, the staff table and `systemusers` lookups are skipped entirely and every sender resolves as client / lead / unknown.
8. **Unknown sender → sign-up** (Flow if configured, else plain link).
9. **Session create/resume** (`getOrCreateSession`, 30-min inactivity window; backfills role/permitted_tools on resume).
10. **Bad-debt evaluation (clients only).** On the first turn of a session `evaluateBadDebt` calls `getBadDebtState` (Dynamics), caches the verdict on the session (`bad_debt_evaluated`/`bad_debt`/`bad_debt_detail`), and — claimed atomically via `claimBadDebtInvoiceSend` — sends the overdue invoice PDFs once. Fail-open: any detection error behaves 100% normally.
11. **Knowledge-base retrieval.** For client/lead turns, embed the message and query `match_kb_chunks` (pgvector, cosine ≥ 0.42); pass the top chunks to `claudeService.generateResponse` as `retrievedContext` (§8).
12. **Case threading.** Resolve/create the Dynamics `riivo_request` for the turn (open request for session, or a new one if `qualifyMessage` passes; `decideCaseRouting` in `src/domain/caseRouting.ts` is the pure verdict the processor applies). A topic shift within 30 min continues the open case rather than opening a new one.
13. **Log incoming** to Dynamics (`logMessage`) before saving to Supabase.
14. **Conversation cap check** (non-staff). `decideConversationCap` (`src/domain/conversationCap.ts`) returns `blocked | hit | ok` from session counts + the day count; a fired cap short-circuits to a warm consultant-handoff line. See [usage-tracking-and-caps.md](./usage-tracking-and-caps.md).
15. **AI generation.** `generateResponse(...)` (§5), in parallel with `classifyCase` when a new case was created.
16. **Send & persist.** Save to Supabase, send via Meta, mirror to Dynamics (`logMessage('Outgoing', …)`).
17. **Post-answer case bookkeeping.** `L1` → `recordBotResponse` and **enqueue a delayed feedback-prompt** (§6.4). `escalation` → `markEscalated` (sets the session `had_escalation` flag).
18. **Intent classification (fire-and-forget)** → `sessions.current_intent`, analytics only.
19. **Natural wrap-up close** if `detectWrapUp(text)` matches an open request with no new case this turn.

### 4.3 Gotchas

- Per-phone serialisation is now guaranteed by **Service Bus sessions** (the session id is the phone number), not just by Meta's ordering. Cross-phone work runs concurrently up to `MAX_CONCURRENT_SESSIONS`.
- `dynamicsService.logMessage` errors are logged and swallowed — a Dynamics outage must not drop the WhatsApp reply.
- The ingester 200s **before** dedup/enqueue. If enqueue throws after the idempotency row lands, a Meta retry is dropped as a duplicate — this is an alert-worthy log line, not auto-recovered.

---

## 5. AI layer (`claude.service.ts`)

`generateResponse` is one `messages.create` per turn plus a follow-up tool-use loop (capped at `MAX_TOOL_ROUNDS = 5`), with two independent lightweight calls for case- and intent-classification. The model is `CLAUDE_MODEL = 'claude-opus-4-7'`, `max_tokens = CLAUDE_MAX_TOKENS = 2048`.

All calls go through `callAnthropicMessages` (`utils/anthropicRateLimit.ts`), which surfaces a typed `RateLimitError` on HTTP 429 (carrying `retryAfterMs` + parsed rate-limit headers) so the worker can re-enqueue. Successful calls and 429s both log telemetry to `claude_usage` (§13.7, §16).

### 5.1 Prompt caching — three breakpoints

Anthropic does not honour a top-level `cache_control`; the service sets **content-block** breakpoints instead:

1. last tool in the `tools` array,
2. the system-prompt block,
3. `messages[N-2]` (the prior assistant turn) so each inbound reuses the previous turn's cache rather than writing a fresh one.

### 5.2 System prompt

- `BASE_SYSTEM_PROMPT` — Tina's persona, tone, WhatsApp formatting (single-asterisk bold, hyphen bullets), SA-English spelling, the **"NO FOLLOW-UP PROMISES"** rule, the **scope guardrail** (SA tax / TTT account / onboarding / referrals only — see [scope-guardrail.md](./scope-guardrail.md)), referral facts, and escalation rules (engage first; escalate only on explicit ask — `request_consultant_callback` by default, `escalate_to_taxcrew` for written forwards).
- Per-turn `roleContext` for `client` / `lead` (with onboarding-state gating; see §7) / `user` (staff capability bullets generated from `permittedToolKeys`) / unknown.
- **Pending LOE review** and **pending WhatsApp upload** contexts spliced in when relevant.
- **Knowledge-base block** appended only when `retrievedContext` has results (formats excerpts with title + heading path, instructs the model to cite or ignore, never fabricate). Most turns don't retrieve, so the cache stays warm.
- `"Current Date: …"` prepended for tax-season reasoning.

### 5.3 Tool registry — 40 tools, one definition each (ADR 0003)

Tool dispatch is a **registry**, not a hand-written `if/else` chain. Each tool is one `ToolEntry` in `src/services/tools/` carrying `{ name, description, input_schema, roles, requiredPerm?, handle }` — its Anthropic schema, description, role visibility, permission gate, and handler are **one thing in one place**. `REGISTRY` is assembled from `clientTools.ts`, `staffTools.ts`, and `leadTools.ts` (`index.ts`); the 40-entry count is `Object.values(REGISTRY).length`.

- **Single dispatch site.** `runTool(name, args, ctx)` is called identically in the first Claude round and the follow-up tool-use loop. An unknown tool name is a hard error (the old `legacyDispatch` fallback is deleted).
- **`TOOLS` is derived from `REGISTRY`** — `Object.values(REGISTRY).map(e => ({ name, description, input_schema }))` — so the Anthropic tool definitions can't drift from the handlers.
- **Dependencies are injected through narrow Ports.** Handlers reach services only via `ctx.deps` (`DynamicsPort`, `MetaPort`, `GraphMailPort`, `SupabasePort`, `FormsPort`, `Irp5Port`, `PdfPort`, `LoeOcrPort`, …) — each exposing only the methods tools actually call. A real service singleton satisfies a Port structurally; a test passes a fake. This is the seam that makes tools unit-testable with no Anthropic client mocked (`test/unit/toolRegistry.test.ts`).
- **`ToolContext`** is built once per turn in `claude.service.ts`: per-turn identity (`contactId`, `phoneNumber`, `sessionId`, `entityType`, `ownerFilter`), the shared client resolvers, the permitted keys, the per-turn staged-upload buffer (`ctx.pendingUpload`) and LoE review row (`ctx.pendingLoe`), and `deps`.

The current tool set spans client reads (`get_my_details`, `get_tax_number`, `get_client_invoices`, `get_refund_status`, `get_submission_status`, `get_audit_status`, **`get_required_documents`** — advice-only, no upload-record read per ADR 0004), client actions (`save_document`, `upload_irp5`, `request_consultant_callback`, `escalate_to_taxcrew`, `opt_out_whatsapp`, `list_tax_forms`, `send_tax_form`, `get_invoice_pdf`, `refer_friend`, `get_my_referral_code`, `get_my_consultant`, `get_office_contact`), staff writes (`create_case`/`_lead`/`_contact`/`_invoice`/`_task`, `send_invoice_pdf`, `search_contact_by_name`, `search_lead_by_name`, `get_my_clients`/`_leads`, …), the LoE flow (`upload_letter_of_engagement`, `update_loe_field`, `confirm_loe_upload`), and `verify_identity` for unknown callers.

### 5.4 Tool filtering — three layers, all derived from the registry

1. **Role filter** — `deriveOfferedTools(role)` is a pure function over each entry's `roles`. Roles are `client`, `lead`, `user` (staff), and `unknown` (a phone not in the system — offered only `verify_identity`). No second hand-maintained per-role list exists.
2. **Staff permission gate** — `entryAllowed` keeps a staff-gated entry only if its `requiredPerm` is in the session's cached `permittedToolKeys`. Enforced once, inside `runTool` (the old duplicate `STAFF_TOOL_PERMISSIONS` re-check is deleted).
3. **Per-turn narrowing** — `claude.service` deletes a few entries that role+permission can't express: a pending file (LOE phase 1) or pending LOE review (phase 2) narrows to that flow; `upload_irp5` is offered to all leads by role then removed for non-State-B leads.

### 5.5 Classifiers

- **Case classifier** (`case.service.classifyCase`) — Haiku, forced-tool JSON (`record_classification`), returns `{ level: 'L1'|'escalation', topic }`; defaults to `escalation` on failure.
- **Intent classifier** (`classifyIntent`) — opus, `max_tokens=20`, one of 11 labels; fire-and-forget to `sessions.current_intent`.

---

## 6. Case lifecycle (`case.service.ts` + `whatsapp_cases`)

### 6.1 States

```
created ─▶ classified ─▶ bot_responded ─┬─▶ resolved_by_bot          (client tapped "Yes" OR natural wrap-up)
                                        ├─▶ resolved_by_bot_timeout  (queued auto-close OR 12h sweep)
                                        └─▶ escalated                (client tapped "No" OR classified escalation)
```

### 6.2 Qualification / classification

Unchanged in shape: rule-based `qualifyMessage` (free), then the Haiku forced-tool classifier (§5.5). L1 topics cover invoices, case status, tax-number lookup, account details, season dates, home-office requirements, document guidance, basic structuring, referrals, general tax questions.

### 6.3 Dynamics mirror

Every Supabase transition mirrors onto the `riivo_request` via `updateRequest` (`statecode`/`statuscode`/`riivo_classificationlevel`/`riivo_classificationtopic`/`riivo_resolutionmethod`/`riivo_clientfeedback`/`riivo_resolvedon`/`riivo_escalationreason`/`riivo_escalatedon`/`riivo_botanswers`). Best-effort — Supabase stays the metrics source of truth.

### 6.4 Delayed feedback prompt (queue-based)

The old inline "send Yes/No buttons immediately" was replaced by a **two-stage delayed-job pipeline** so the bot doesn't interrupt a still-typing client:

- When an `L1` answer is sent, the worker **enqueues a feedback-prompt job** (delay ~2.5 min) onto the `feedback-prompt` Service Bus queue.
- `feedbackPromptWorker` fires only if the case is still `bot_responded` and the client hasn't replied: it sends the Yes/No buttons, sets `session.pending_case_id`, PATCHes Dynamics to `AWAITING_FEEDBACK`, and **enqueues a case-auto-close job** (delay ~10 min).
- `caseAutoCloseWorker` closes the case as `resolved_by_bot_timeout` if still silent after the delay.
- A client reply tapping Yes/No still short-circuits into `handleFeedback` on the next inbound (bypasses the AI).

See [PRD-delayed-feedback-prompt.md](./PRD-delayed-feedback-prompt.md).

### 6.5 Timeout handling

- `caseAutoCloseWorker` is the primary short-tail close.
- `sweepTimedOutCases(12h)` (the `/api/cron/case-timeout` cron) is the fallback for cases that slip through. It now also returns `session_id`/`contact_id` so it can trigger the close-summary (§6.7).

### 6.6 Natural wrap-up

`detectWrapUp` catches short closers ("thanks", "perfect", "sorted", "lekker"), rejecting messages with `?` or pivot words.

### 6.7 Consultant close-summary (new — currently on the working branch)

When a **noteworthy** session closes, Tina emails the client's owning consultant a short summary. "Noteworthy" = the session had a client document upload **or** an escalation. Quiet/ghost closes send nothing.

- Two session flags drive the gate, set the moment the event happens (`supabase.service` `flagSessionDocUpload` / `flagSessionEscalation`): `had_doc_upload`, `had_escalation`.
- `close_summary_sent_at` is **claimed atomically** (`claimCloseSummary` — update only if NULL, returns true to exactly one caller) so a fan-out close (one "Yes" resolving several sibling cases) or the timeout sweep can't double-send.
- `triggerCloseSummary(sessionId)` is fire-and-forget from every close path (`recordBotResponse`-driven resolve, `markEscalated`, `handleFeedback`, `resolveOpenCasesForLead`, the timeout sweep). It resolves the owning consultant (`getContactOwnerId`/`getLeadOwnerId` → `getSystemUserById`, falling back to `taxcrew@ttt-tax.co.za`), summarises the transcript with Haiku, and sends via `graphMailService.sendMail`.
- Backed by migration `20260604120000_session_close_summary.sql` (adds the three `sessions` columns).

---

## 7. Identity and permissions

Key additions since the last review: **staff mode is gated behind a flag**, plus **lead onboarding state** and the **owner-inheritance** of requests.

### 7.0 Staff mode is gated behind `STAFF_MODE_ENABLED` (default off)

The staff (internal "user") experience is currently **dormant in production**. With `STAFF_MODE_ENABLED` unset/`false`, `getContactByPhone` / the email resolver **skip the `systemusers` lookup entirely** and `processMessage` never enters the colleague/CRM-tools path — every sender resolves as `client`, `lead`, or `unknown`. Flip `STAFF_MODE_ENABLED=true` to restore staff resolution and the staff tool surface. The registry still carries the staff tools (§5.3); they're simply never offered while the flag is off.

### 7.1 Identity classes

| `crmEntity.type` | Source                                          | Effect                                                                 |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `client`         | Dynamics `contacts` or cached session           | Full Tina client experience; interactive welcome menu on first message |
| `lead`           | Dynamics `new_leads`                            | Onboarding-only; gated by LOE + OTP state (below)                      |
| `user` (staff)   | Supabase `users` (synced from `systemuser`)     | Staff experience; tool surface filtered by role. **Only when `STAFF_MODE_ENABLED=true`.** |
| `unknown`        | phone not found in any of the above             | Offered only `verify_identity`; otherwise pushed to sign-up            |

### 7.2 Lead onboarding gates

Tax leads have two gates read fresh on each inbound: `riivo_loereceived` and `riivo_efilingotpcompleted`. The `lead` roleContext routes by state (pre-LOE: no tax advice, push LOE signing; post-LOE pre-OTP "State B": general tax Q&A allowed + `upload_irp5` unlocked; post-OTP: converting to contact). See the `onboarding_two_gates` memory note and [onboarding-loe-and-otp.md](./onboarding-loe-and-otp.md).

### 7.3 Role-based access (Supabase)

`roles` / `users` / `role_tools` as before. Permission keys: `create_lead, create_contact, create_task, create_case, create_invoice, lookup_client, lookup_lead, view_open_cases, view_outstanding_invoices, send_invoice_pdf, upload_letter_of_engagement`. The tool→key map is no longer a separate `STAFF_TOOL_PERMISSIONS` table — each tool's `requiredPerm` lives on its registry entry (§5.3/§5.4) and `entryAllowed` is the single enforcement point.

### 7.4 Session caching, phone variants, staff source-of-truth

`sessions.role_id`/`permitted_tools` cached at create; `phoneVariants` expands `0xx`/`+27xx`/`27xx`; `findStaffByPhone` is authoritative (a stale `user`-typed session is ignored if it returns null). Dynamics edits don't propagate until `npm run sync:users` (see the `architecture_supabase_cache` memory note).

### 7.5 Request owner inheritance

A newly created `riivo_request` inherits its owner from the linked client/lead (recent commit) so the case lands with the right consultant — which is also what the close-summary owner lookup relies on.

---

## 8. Knowledge base & RAG

A retrieval layer grounds client/lead answers in TTT's own documentation.

- **Corpus** lives in a SharePoint KB folder. `sync-knowledge-base.ts` (`npm run sync:kb`) walks it recursively, extracts each PDF/Word doc to markdown (`docExtractor.service`), chunks it (markdown-aware, ~500-token chunks split on H2/H3 with paragraph overlap — `embeddings.service`), embeds with OpenAI `text-embedding-3-small`, and upserts into `kb_documents` + `kb_chunks`. Etag-based skip means unchanged docs aren't re-embedded; docs removed at source are reconciled away (cascading delete).
- **Retrieval** (`knowledgeBase.service.retrieveContext`) embeds the inbound message and calls the `match_kb_chunks` RPC (pgvector, cosine similarity, default threshold 0.42), returning top chunks with `heading_path` + `source_url`.
- **Injection**: the worker passes results to `generateResponse` as `retrievedContext`; the system prompt appends them only when non-empty (§5.2). Failures are caught — an empty result just falls back to base-prompt knowledge.
- Backed by migration `20260508120000_knowledge_base.sql` (`kb_documents`, `kb_chunks`, `match_kb_chunks`). See [l1-knowledge-base.md](./l1-knowledge-base.md).

---

## 9. CRM integration (`dynamics.service.ts`)

Single class wrapping the Web API. Patterns unchanged (MSAL client-credentials with in-memory token cache + 55-min fallback; `crmPost`/`crmPatch` audit-field auto-retry caching `entitiesWithoutAudit`). Entities touched now also include:

- **`contacts`** / **`new_leads`** / **`systemusers`** as before, plus owner-id reads (`getContactOwnerId`, `getLeadOwnerId`) for the close-summary.
- **`riivo_irp5s`** — IRP5 certificate records (`createIrp5Record`, cert-number dedupe).
- **`riivo_taxsubmissionsdocuments`** — per-submission document rows; written by the IRP5 drain and uploads. No longer read back to clients (ADR 0004 — Tina never reports upload status).
- **Tax-status reads** (`taxFaq.service`): `riivo_potentialrefund`, `icon_casestage`, `riivo_dateplacedonaudit` feed the refund/submission/audit-status tools.
- **`riivo_requests`** / **`riivo_whatsappcommunicationses`** / **`new_invoiceses`** / **`new_cases`** / tasks / annotations as before.

Option-set enum maps (`REQUEST_STATE`, `REQUEST_STATUSCODE`, `RESOLUTION_METHOD`, `CLIENT_FEEDBACK`, `CLASSIFICATION_LEVEL`, and the type maps in `claude.service.ts`) still live at the top of the services. Note `@odata.bind` uses the nav-property name (e.g. `riivo_Client@odata.bind`) — see the `dynamics_odata_bind` memory note.

---

## 10. Media and document flows

### 10.0 Document-collection journey — stateless, client-initiated (ADR 0002)

Document collection used to be **greeting-driven**: an IRP5 ask was injected into the system prompt on every session's first message. Because sessions reset after 30 min, "first message" fired constantly and the ask landed regardless of the client's actual question. That is gone.

It is now a **journey the client initiates** ("I want to start my tax return"), and "where the client is" is **re-derived statelessly** from Dynamics (`riivo_irp5s` + `riivo_taxsubmissionsdocuments`) on every turn — there is **no persisted journey state machine**.

- **The recommendation is a pure kernel (advice-only, ADR 0004).** `buildDocRecommendation(input)` (`src/domain/docRecommendation.ts`) takes `(source codes, industry, optional topic, forms catalog)` and returns a single ordered, reason-annotated `documents` list with form-supersedes-doc dedupe applied — no received/outstanding diff. `requiredDocuments.service` does the Dynamics **profile** I/O around it (source codes + industry only, never upload rows); the `get_required_documents` tool exposes it (with an optional `topic` for `foreign_income` / `rental_income`).
- **Never report upload status (ADR 0004).** Tina frames the list purely as advice ("here's what typically helps"), never "you've sent X / you still owe Y / we have everything". She does not read `riivo_taxsubmissionsdocuments` for guidance because that data is unreliable across TTT; making no status claim is safer than a confidently-wrong one. The IRP5 upload flow still confirms receipt of the file the client just sent — local knowledge from the upload itself, not a record lookup.
- **Baseline list.** `BASELINE_DOCS` keeps IRP5, drops Bank Statements (now source-code/industry-driven only); ID Document stays out. The consultants' SharePoint guide is authoritative — a verbatim snapshot lives at [document-requirements-guide.md](./document-requirements-guide.md), and the kernel is **manually** kept in step with it (new code mappings: source codes 3606/3701/3802). See [PRD-document-requirements-guide.md](./PRD-document-requirements-guide.md).
- Proactive completion-chasing (reminding clients who abandon mid-journey) is **out of scope** — it would need an Azure-side scheduler. Tina stays reactive.

### 10.1 Inbound documents / images

`downloadMedia` → buffer staged in `pendingUploadService` (process-local `Map`, 10-min janitor). The model is told a file is pending and routes via `save_document` (client/lead) or the LOE/IRP5 flows.

### 10.2 IRP5 OCR flow (two-phase)

Lets a lead send an IRP5 before they've converted to a contact, staging the extracted data until conversion.

- **Phase 1 (lead stage):** `mistralService.ocrDocument` → markdown; `irp5ExtractorService.extractIrp5Fields` (Haiku forced-tool, mapping 4-digit SARS codes to columns per [irp5-ocr-field-mapping.md](./irp5-ocr-field-mapping.md)); the file is uploaded to SharePoint under `leads/{leadId}/{year}/`; a `pending_irp5s` row is inserted (extracted fields, cert number, year, employer, source codes).
- **Phase 2 (contact drain):** when the lead converts (Power Automate on OTP completion), `pendingIrp5Service.drainForPhone/drainForLead` writes a `riivo_irp5s` record and a `riivo_taxsubmissionsdocuments` row per pending IRP5, marking each `applied_to_contact_id` (idempotent retry on failure).
- Backed by migration `20260528100000_pending_irp5s.sql`. See [PLAN-irp5-ocr-flow.md](./PLAN-irp5-ocr-flow.md).

### 10.3 LOE upload (staff flow)

Unchanged two-phase staging via `pending_loe_data`: OCR + Haiku extract → `pending_review` row → staff review (`update_loe_field` whitelisted at the DB layer) → `confirm_loe_upload` writes fields to the lead, uploads the PDF to `riivo_SignedLetterofEngagement`, flips `riivo_loereceived`, deletes the staging row.

### 10.4 Tax forms (outbound templates)

`taxForms.service` holds a catalog of fillable forms (vehicle detail sheets, commission-earner expense lists). `list_tax_forms` advertises them; `send_tax_form` calls `resolveLatestFormFile` to pick the highest-year file from the SharePoint forms library (`sharepoint.service`) and sends it via `sendDocument`. See [PRD-tax-forms.md](./PRD-tax-forms.md).

### 10.5 Outbound documents & invoice PDF

`sendDocument` (multipart upload → message with `media_id`) with DRY-RUN when Meta creds are empty. `pdfService.generateInvoicePDF` renders A4 TTT-branded invoices; `mapInvoiceToInvoiceData` is shared by the PDF route and the Claude tool handlers.

---

## 11. External integrations (Microsoft Graph + webhooks)

### 11.1 Email relay (tina-bot mailbox → WhatsApp)

Lets a consultant forward a client email to `tina-bot@ttt-group.co.za` and have Tina pick up the conversation on WhatsApp, **with the client's consent**:

1. A Graph change-subscription on the shared-mailbox Inbox pushes a notification to `POST /webhook/email`. The route validates `clientState` and dedupes (5-min TTL).
2. `emailRelay.controller.processInboundEmail` fetches the message (`graphMailService.getMessage`, plain-text), parses the forward (`forwardedEmail.service` — handles Outlook/Gmail/Apple Mail markers, strips quotes/HTML) to recover the original sender + body.
3. Looks the sender up in Dynamics by email; if no match or no mobile, it replies to the forwarder explaining why. Otherwise it writes an `email_relay_pending` row (`awaiting_consent`, 48h expiry) and sends the `client_email_relay_consent` Meta template (Yes/No buttons) to the client.
4. The client's `relay_yes`/`relay_no` tap is handled in `processMessage` (§4.2 step 5): accepted → the conversation proceeds through the normal AI path and the forwarder is emailed "accepted"; declined/expired → the forwarder is emailed accordingly.
5. An hourly cron (`sweepExpiredRelays`, alongside the Graph subscription renewal) expires stale rows.

Auth uses a Graph app registration with client credentials; `graphMailService` also handles subscription create/renew/delete (3-day lifetime). Backed by migration `20260507120000_email_relay_pending.sql`. See [email-relay-consent.md](./email-relay-consent.md).

### 11.2 Post-LOE activation

When a Tax lead signs their LOE on the external Next.js app (`ttt-financial-forms.vercel.app`), that app calls `POST /webhook/loe-signed` (HMAC over raw body, `LOE_ACTIVATION_WEBHOOK_SECRET`) with `{ leadId }`. `loeActivation.service`:

1. Claims an in-flight mutex (`loe_activation_inflight` table) and checks a Dynamics `post_loe_activation` sentinel — both make it idempotent.
2. Sends the lead a WhatsApp thank-you, then emails `taxcrew@ttt-tax.co.za` with the lead link + the eFiling-OTP walkthrough.
3. Creates the Dynamics sentinel and resolves any open cases for the lead.

The HMAC magic-link the onboarding app verifies is minted by `utils/loeMagicLink.ts` (`LOE_SIGNING_SECRET`, host `LOE_ONBOARDING_HOST`). Backed by migration `20260601200000_loe_activation_inflight.sql`. See [PRD-post-loe-activation.md](./PRD-post-loe-activation.md) and the `loe_magic_link_shared_secret` / `loe_app_host` memory notes.

### 11.3 Outbound-notify

External senders (Power Automate, campaign tooling, the Convex outbound-notify path) call `POST /webhook/outbound-notify` (HMAC, `OUTBOUND_NOTIFY_SECRET`) after sending a Meta template to a client, so the bot **seeds the outbound into session history** and the next inbound has context. The route resolves identity, looks the template up in `whatsappTemplateRegistry`, composes the rendered body, upserts the session, and inserts a message keyed on `externalId = sender_message_id` (idempotent — duplicates return `seeded:false`). Backed by migration `20260601100000_messages_external_id.sql`. See [outbound-notify-integration.md](./outbound-notify-integration.md).

### 11.4 Template registry & admin

`whatsappTemplateRegistry` caches approved Meta templates (1h TTL, in-flight coalescing, paginated fetch, `status=APPROVED` only) and composes seeded history from a template + variables. `POST /admin/templates/refresh` (`CRON_SECRET` auth) force-flushes the cache after editing wording in Meta Business Manager.

---

## 12. WhatsApp Flow (sign-up)

Unchanged: a published Flow (`WHATSAPP_SIGNUP_FLOW_ID`) collects name/email/client_type/service/terms; the submission arrives as an `nfm_reply` interactive message; `handleSignUpFlowSubmission` validates, calls `createLead`, notifies the external LOE app (`whatsappSignupNotifier`), and confirms. See [whatsapp-flow-signup.md](./whatsapp-flow-signup.md).

---

## 13. Data model — Supabase

### 13.1 `sessions`

Per-phone state. Columns as before (`id`, `phone_number`, `crm_id`/`crm_type`, `status`, `current_intent`, `current_step`, `last_active`, `role_id`, `permitted_tools`, `pending_case_id`, `message_count`, `token_count`, `cap_blocked_at`, `created_at`) **plus**:

| Column                    | Type        | Notes                                                        |
| ------------------------- | ----------- | ------------------------------------------------------------ |
| `had_doc_upload`          | boolean     | Client filed a document this session (close-summary gate).   |
| `had_escalation`          | boolean     | An escalation fired this session (close-summary gate).       |
| `close_summary_sent_at`   | timestamptz | Atomic claim — set once by the first close (dedup).          |
| `bad_debt_evaluated`      | boolean     | First-inbound bad-debt detection has run this session.       |
| `bad_debt`                | boolean     | Detection result: client is in bad debt.                     |
| `bad_debt_detail`         | jsonb       | Cached overdue-invoice summary (prompt guidance + send).     |
| `bad_debt_invoices_sent_at` | timestamptz | Atomic claim — overdue invoice PDFs sent once (§4.2 step 10). |

(close-summary columns: migration `20260604120000`; bad-debt columns: `20260611120000_session_bad_debt.sql`.)

### 13.2 `messages`

Append-only `(session_id, role, content, timestamp)`, **plus** `external_id` (unique) so outbound-notify seeds are idempotent (migration `20260601100000`).

### 13.3 `whatsapp_cases`

See §6. `sweepTimedOutCases` now also selects `session_id`/`contact_id`.

### 13.4 Staging tables

- `pending_loe_data` — one `pending_review` row/session; bytes, OCR markdown, 15 extracted fields.
- `pending_irp5s` — staged IRP5 extractions awaiting lead→contact drain (migration `20260528100000`).

### 13.5 Knowledge base

`kb_documents` (source metadata + etag) and `kb_chunks` (1536-dim pgvector embeddings, cascading delete) + the `match_kb_chunks` RPC (migration `20260508120000`).

### 13.6 Queue/webhook infra

- `whatsapp_webhook_events` — idempotency claims keyed on Meta `messages[].id`.
- `whatsapp_queue_dlq` — dead-lettered inbound jobs (payload, reason, attempts, stack).
- `loe_activation_inflight` — post-LOE activation mutex.
- `email_relay_pending` — email-relay consent state (one active per phone, 48h expiry).

(Migrations `20260513120000`, `20260601200000`, `20260507120000`.)

### 13.7 Permissions, audit, usage

- `users` / `roles` / `role_tools` — permission matrix.
- `crm_audit_log` — per CRM write.
- `claude_usage` (+ `claude_usage_daily` view) — one row per Anthropic call with token counts and `cost_usd` computed at insert (`claudePricing.service`). Migration `20260518100000` added rate-limit telemetry columns (`ratelimit_*`, `retry_after_ms`, `was_429`). The `increment_session_usage` function bumps the session cap counters. See [usage-tracking-and-caps.md](./usage-tracking-and-caps.md).

---

## 14. Background jobs and scripts

### 14.1 Queues (the runtime "jobs")

Three Azure Service Bus queues consumed by the worker process:

- **`whatsapp-inbound`** — the main work queue (session = phone, FIFO, `MAX_CONCURRENT_SESSIONS` concurrency, rate-limit retry, DLQ on exhaustion).
- **`feedback-prompt`** — delayed Yes/No prompt (§6.4).
- **`case-auto-close`** — delayed silent-case close (§6.4).

### 14.2 Cron (App Service / external scheduler hitting the web process)

- `GET /api/cron/case-timeout` — 12h fallback sweep (`Bearer $CRON_SECRET`).
- Graph subscription renewal + expired-relay sweep (hourly).

> The `vercel.json` crons in the repo are dead on Azure — schedule these via Azure (or an external pinger). See the `bot_hosting` memory note.

### 14.3 Manual scripts

- `npm run sync:users` — mirror Dynamics `systemuser` into Supabase (never overwrites `role_id`).
- `npm run sync:kb` — SharePoint KB → pgvector (§8).
- `npm run graph:bootstrap` — create the Graph mail subscription.
- `npm run test:webhook` / `npm run test:case` — manual harnesses.

### 14.4 In-process timers

- `pendingUpload.service` — 60s janitor clearing >10-min staged uploads (worker process).

---

## 15. Configuration

Env vars in `.env` (see `.env.example`). Required for a real deployment:

- **Dynamics:** `DYNAMICS_URL`, `DYNAMICS_TENANT_ID`, `DYNAMICS_CLIENT_ID`, `DYNAMICS_CLIENT_SECRET`.
- **Meta WhatsApp:** `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `WHATSAPP_SIGNUP_FLOW_ID`, `WABA_ID` (template registry). Blank Meta creds ⇒ DRY-RUN outbound.
- **Queue:** `SERVICE_BUS_CONNECTION_STRING`, `MAX_CONCURRENT_SESSIONS` (default 8). Optional ingester gating: `WEBHOOK_ALLOWED_PHONE_NUMBER_IDS`, `WEBHOOK_BLOCKED_PHONES`.
- **Anthropic:** `ANTHROPIC_API_KEY`. Missing ⇒ "Demo Mode" canned reply. Models pinned in code (§1).
- **Mistral OCR:** `MISTRAL_API_KEY`, `MISTRAL_OCR_MODEL` (default `mistral-ocr-latest`).
- **OpenAI (embeddings):** `OPENAI_API_KEY`.
- **Microsoft Graph:** `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_TENANT_ID`, `GRAPH_SHARED_MAILBOX`, `GRAPH_WEBHOOK_BASE_URL`, `GRAPH_WEBHOOK_CLIENT_STATE`.
- **SharePoint:** `SHAREPOINT_HOSTNAME`, `SHAREPOINT_SITE_PATH`, `SHAREPOINT_KB_FOLDER`, `SHAREPOINT_FORMS_LIBRARY`/`SHAREPOINT_FORMS_FOLDER`, `SHAREPOINT_DOCS_SITE_PATH` (reuses the Graph app reg).
- **LOE / onboarding:** `LOE_ACTIVATION_WEBHOOK_SECRET`, `LOE_SIGNING_SECRET`, `LOE_ONBOARDING_HOST`, `WHATSAPP_SIGNUP_HOST`, `WHATSAPP_SIGNUP_TOKEN`.
- **Outbound-notify / email relay:** `OUTBOUND_NOTIFY_SECRET`, `WHATSAPP_RELAY_TEMPLATE_NAME`/`_LANG`.
- **Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (hard requirement).
- **Cron / bot:** `CRON_SECRET`, `SIGNUP_URL`, `PORT`.

---

## 16. Observability

- Structured-ish `console.*` prefixes (`[Webhook]`, `[Processor]`, `[Claude]`, `[Dynamics CRM]`, `[Supabase]`, `[Meta WhatsApp]`, `[CaseService]`, `[Worker]`, `[LoeExtractor]`, `[PendingUpload]`, `[Cron]`).
- `claude_usage` — per-call tokens + cost + rate-limit headers + `was_429` (§13.7).
- `whatsapp_queue_dlq` — durable record of inbound jobs that exhausted retries.
- `crm_audit_log` — every Dynamics write.
- `whatsapp_cases` — Q2 metrics source-of-truth.

No external APM/error tracker is wired up.

---

## 17. Known rough edges

1. **`claude.service.ts` is still large** (~1,800 lines: prompt assembly, the completion/tool loop, `ToolContext` wiring, classifiers). Tool **dispatch** is no longer in it — that's the registry (§5.3, ADR 0003) — but prompt assembly and the loop still warrant extraction.
2. **Stale BullMQ/Redis references.** `webhook.controller.ts` comments and `docs/queue-and-worker.md` still describe the old Redis/BullMQ queue; the live implementation is Azure Service Bus. Clean up to avoid confusion.
3. **Classifiers run separately from the main completion**, doubling billable calls on new-case turns (now cheaper since they use Haiku).
4. **Dead Vercel crons.** `vercel.json` crons don't fire on Azure — the case-timeout sweep and Graph subscription renewal must be scheduled externally.
5. **Ingester enqueue-after-200 gap.** If enqueue fails after the idempotency row lands, a Meta retry is dropped as a duplicate (§4.3) — alert-worthy, not auto-recovered.
6. **No retries on Meta outbound failures** — a 4xx/5xx is logged, not retried.
7. **Stale `user`-typed sessions** — revoked staff keep cached permissions until the session expires (30 min) or `npm run sync:users` is re-run. (Moot while `STAFF_MODE_ENABLED` is off — §7.0.)
8. **Doc-kernel ↔ SharePoint guide drift is manual** — there's no automated check that `buildDocRecommendation` matches the consultants' guide; a guide edit obliges a manual kernel re-sync (§10.0).

---

## 18. Related documents

- **Architecture decision records:** [adr/0001-per-turn-decision-extraction-scope.md](./adr/0001-per-turn-decision-extraction-scope.md), [adr/0002-document-collection-journey.md](./adr/0002-document-collection-journey.md), [adr/0003-tool-registry-dispatch.md](./adr/0003-tool-registry-dispatch.md).
- **Tool registry / doc journey PRDs:** [PRD-tool-registry.md](./PRD-tool-registry.md), [PRD-document-requirements-guide.md](./PRD-document-requirements-guide.md), [document-requirements-guide.md](./document-requirements-guide.md).
- [bot-personality.md](./bot-personality.md), [bot-overview.md](./bot-overview.md), [bot-capabilities-spec.md](./bot-capabilities-spec.md)
- [queue-and-worker.md](./queue-and-worker.md) — queue/worker design (note: references the older Redis impl).
- [usage-tracking-and-caps.md](./usage-tracking-and-caps.md), [scope-guardrail.md](./scope-guardrail.md)
- [l1-knowledge-base.md](./l1-knowledge-base.md), [tax-season-faq-crm-spec.md](./tax-season-faq-crm-spec.md), [PRD-tax-forms.md](./PRD-tax-forms.md)
- [PLAN-irp5-ocr-flow.md](./PLAN-irp5-ocr-flow.md), [irp5-ocr-field-mapping.md](./irp5-ocr-field-mapping.md)
- [email-relay-consent.md](./email-relay-consent.md), [PRD-post-loe-activation.md](./PRD-post-loe-activation.md), [outbound-notify-integration.md](./outbound-notify-integration.md)
- [PRD-delayed-feedback-prompt.md](./PRD-delayed-feedback-prompt.md), [PRD-first-contact-templates.md](./PRD-first-contact-templates.md)
- [onboarding-loe-and-otp.md](./onboarding-loe-and-otp.md), [leads-and-contacts.md](./leads-and-contacts.md)
- [meta-templates.md](./meta-templates.md), [whatsapp-flow-signup.md](./whatsapp-flow-signup.md), [request-lifecycle.md](./request-lifecycle.md)
- [azure-migration.md](./azure-migration.md) — the Vercel → Azure move.
