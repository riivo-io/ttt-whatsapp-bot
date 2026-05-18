# TTT WhatsApp Tax Bot — Architecture

_Last reviewed: 2026-05-05_

This document describes the runtime architecture of the TTT WhatsApp Tax Bot end-to-end: the HTTP surface, identity resolution, AI orchestration, data stores, CRM mirroring, and the supporting background jobs. It is written for engineers who need to change the system; it is not a product pitch.

---

## 1. System overview

The bot is an Express service that sits between Meta's WhatsApp Cloud API, Anthropic Claude, and Microsoft Dynamics 365, with Supabase (Postgres) as the operational datastore.

```
┌────────────┐   Webhook     ┌────────────────────────┐   Tool calls    ┌──────────────────┐
│  WhatsApp  │ ─────────────▶│  Express bot (Node.ts) │ ───────────────▶│  Anthropic       │
│  (Meta)    │ ◀───────────  │  src/server.ts         │ ◀───────────────│  claude-opus-4-7 │
└────────────┘   Send msg    └────────────────────────┘                 └──────────────────┘
                                       │  ▲
                           Identity /  │  │  Case lifecycle +
                           sessions /  │  │  pending LOE data +
                           cases /     │  │  audit
                           history     ▼  │
                                 ┌──────────────┐
                                 │   Supabase   │  (Postgres)
                                 └──────────────┘
                                       │
                                       │  Mirror writes (Contact / Lead / Request /
                                       │  WhatsApp comms / LOE annotation / Invoice /
                                       ▼  Task / Contact / Systemusers)
                                 ┌──────────────┐
                                 │ Dynamics 365 │  (Web API v9.2)
                                 └──────────────┘
                                       │
                                       │  OCR (LOE PDFs)
                                       ▼
                                 ┌──────────────┐
                                 │ Mistral OCR  │
                                 └──────────────┘
```

**Runtime shape**

- Node 20+, TypeScript, Express 4.
- One long-lived process (`src/server.ts`). No worker pool, no queue.
- All webhook work is done in-process. `handleIncomingMessage` ACKs Meta with `200` immediately and processes asynchronously.
- Deployed on Vercel (see `vercel.json`). The only scheduled job is `/api/cron/case-timeout` at `0 2 * * *`.

**Languages and integrations**

- Meta WhatsApp Cloud API (Graph v22.0) — inbound messages, outbound text, interactive buttons/lists, documents, media download, WhatsApp Flows.
- Microsoft Dynamics 365 Web API v9.2 — authoritative CRM (contacts, leads, systemusers, invoices, cases, requests, tasks, annotations). Auth via MSAL (`@azure/msal-node`) using client credentials.
- Anthropic Claude (`claude-opus-4-7`) via `@anthropic-ai/sdk` for the main assistant, the intent classifier, the case L1/escalation classifier, and the LOE field extractor. The model id is pinned in `CLAUDE_MODEL` at the top of `claude.service.ts` for single-point swap.
- Mistral OCR (`mistral-ocr-latest`) for turning signed LOE PDFs into markdown.
- Supabase — session state, conversation history, roles/permissions, whatsapp case lifecycle, pending LOE staging, CRM audit log.

---

## 2. Repository layout

```
src/
├── server.ts                          # Express bootstrap, route wiring
├── controllers/
│   └── webhook.controller.ts          # Meta webhook verify + inbound dispatch
├── routes/
│   ├── pdf.route.ts                   # GET /api/pdf/invoice/:invoiceNumber
│   └── cron.route.ts                  # GET /api/cron/case-timeout
├── services/
│   ├── meta.service.ts                # Meta Cloud API client (text, list, buttons, flow, document, media download)
│   ├── claude.service.ts              # LLM orchestration (Anthropic SDK), tool registry, tool dispatch, intent classifier
│   ├── dynamics.service.ts            # Dynamics Web API client + all CRM writes/reads
│   ├── supabase.service.ts            # Sessions, messages, cases, pending LOE, audit, staff lookup
│   ├── case.service.ts                # Case lifecycle (qualify/classify/feedback/timeout)
│   ├── pendingUpload.service.ts       # In-memory staged WhatsApp uploads (10-min TTL)
│   ├── requiredDocuments.service.ts   # Per-client required-docs computation from SARS source codes + industry
│   ├── loe-extractor.service.ts       # Claude extractor — LOE markdown → structured fields (forced-tool JSON)
│   ├── mistral.service.ts             # Mistral OCR client (PDF → markdown)
│   ├── pdf.service.ts                 # PDFKit invoice renderer + Dynamics→InvoiceData mapper
│   └── claudePricing.service.ts       # Per-model USD pricing tiers + cost computation for claude_usage
├── scripts/
│   └── sync-users-from-dynamics.ts    # Manual `npm run sync:users` — mirrors systemusers into Supabase
└── types/
    └── crm.types.ts                   # CrmEntity + small shared types

supabase/migrations/                   # SQL migrations (permissions, sessions, cases, LOE staging)
docs/                                  # Feature docs (this file + referral, flows, templates, lifecycle)
test/                                  # Manual ts-node scripts (simulate-webhook, test-case-lifecycle, etc.)
```

Removed artefacts that still appear in `git status`: `convex/*` (old Convex backend, pre-Express), `src/services/clickatell.service.ts` (old SMS channel), and `src/services/dynamics.service 2.ts` (accidental Finder duplicate). These should be removed in the next cleanup commit.

---

## 3. HTTP surface

Defined in `src/server.ts`.

| Method | Path                                | Handler                                      | Purpose                                                                                                                                                  |
| ------ | ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                         | inline                                       | Liveness probe.                                                                                                                                          |
| GET    | `/webhook`                        | `webhook.controller.verifyWebhook`         | Meta subscription verification handshake (`hub.mode`/`hub.verify_token`).                                                                            |
| POST   | `/webhook`                        | `webhook.controller.handleIncomingMessage` | Meta delivers inbound messages here. Always returns 200 before processing.                                                                               |
| GET    | `/api/pdf/invoice/:invoiceNumber` | `routes/pdf.route.ts`                      | Fetches the invoice from Dynamics, renders with PDFKit, streams the PDF.                                                                                 |
| GET    | `/api/cron/case-timeout`          | `routes/cron.route.ts`                     | Sweep `bot_responded` cases older than 12h into `resolved_by_bot_timeout`. Auth: `Authorization: Bearer $CRON_SECRET` or `x-cron-secret` header. |

Bot process listens on `PORT` (default `3001`). For local dev the public URL is an ngrok tunnel pointed at `:3001` (see the brand-memory note on `sufferable-gracelynn-polytrophic.ngrok-free.dev`).

---

## 4. Inbound message flow

`handleIncomingMessage` (in `webhook.controller.ts`) is the single entry point.

1. **ACK first.** `res.sendStatus(200)` happens before any work — Meta retries non-200s aggressively.
2. **Shape guard.** Only `body.object === 'whatsapp_business_account'` is processed. Anything else is logged and ignored.
3. **Iterate** `entry[].changes[].value.messages[]`.
4. **Extract** each Meta message via `extractIncoming()` into a normalised `IncomingMessage` with the fields:
   - `from` — raw phone number string from Meta (`27…` format).
   - `text` — plain text body, button title, or list-item title.
   - `interactiveId` — stable id of the button/list row the user tapped (if any).
   - `document` — `{ id, filename, mimeType }` for `document` or `image` types; the bot does not distinguish images from PDFs at ingest.
   - `flowResponse` — parsed JSON returned by a WhatsApp Flow submission (`nfm_reply.response_json`).
5. **Dispatch** to `processMessage()`. Fatal errors inside `processMessage` are caught and a generic apology is sent back; the outer try/catch additionally guards against Meta payload parsing failures.

### 4.1 `processMessage` — step-by-step

Order matters. Rearranging these steps will break the Dynamics threading of WhatsApp comms.

1. **Flow submissions short-circuit first.** If `flowResponse` is set, call `handleSignUpFlowSubmission` and return. This creates a Dynamics lead (`createLead`) with the submitted fields and replies with a welcome or a failure fallback message.
2. **Document/image ingestion.** `metaWhatsAppService.downloadMedia(mediaId)` fetches bytes; the buffer is staged in-memory via `pendingUploadService.stagePendingUpload(from, …)` keyed on phone number with a 10-minute TTL. The user-facing text is synthesised to `"I just sent you a document."` if they sent the file with no caption.
3. **Client menu canonicalisation.** If `interactiveId` matches a row in `CLIENT_MENU_CANONICAL_TEXT`, rewrite `effectiveText` to the canonical question (e.g. `menu:client:invoices` → `"Please show me my invoices and outstanding balance."`). This lets the existing AI + tools path handle the tap without bespoke dispatch. `menu:client:other` is handled separately after identity resolution.
4. **Identity resolution** via `resolveSender(phoneNumber)`. Returns `{ crmEntity, staffRoleId, permittedTools }`. Priority:
   1. `supabaseService.findStaffByPhone` (staff table, authoritative). If matched, staff path wins.
   2. `supabaseService.findPreviousSession` **for non-`user` rows** (cached client/lead from a prior session). A stale `user`-typed session row is deliberately ignored here so a revoked staff mapping does not keep routing someone through the staff path — but Dynamics is not re-queried for lookup in this branch.
   3. `dynamicsService.getContactByPhone(phoneNumber)` — last-resort live lookup, queries Contacts + Leads + Systemusers in parallel and picks the best match.
5. **Unknown sender → sign-up.** If no `crmEntity`: if `WHATSAPP_SIGNUP_FLOW_ID` is configured, send the sign-up Flow; otherwise fall back to two plain-text messages (greeting + `ttt-tax.co.za/client-onboarding`). Return.
6. **Session create/resume.** `supabaseService.getOrCreateSession` — resumes an active session if the last message was under 30 minutes ago, otherwise expires the old one and inserts a new row. Backfills `role_id` / `permitted_tools` onto a resumed staff session if those columns were previously empty.
7. **Zero-access staff.** Staff with an empty `permitted_tools` array get a canned decline message and the turn ends.
8. **Opt-in nudge.** For clients with `optIn !== true`, call `dynamicsService.updateWhatsAppOptIn(id, true)`. Best-effort, errors are logged.
9. **Menu "Something else" ack.** Client tap on `menu:client:other` → short ack (`"Sure — what's on your mind?"`), logs the exchange, returns. Next inbound uses the full AI path.
10. **Client welcome menu.** If this is the client's first-ever message in a fresh session (no prior messages) _and_ the inbound is a plain text (no document, no interactiveId), send the interactive list menu via `sendClientWelcomeMenu` (greeting body + two sections of rows), log both sides, return.
11. **Case threading.** For clients/leads, resolve the Dynamics `riivo_requestid` to thread the incoming WhatsApp comms record under:
    - `findOpenRequestForSession(session.id)` — existing open request for this session, or
    - a freshly created request via `caseService.createCase` if `qualifyMessage(text)` returns true, or
    - `null` — `logMessage` will bind to the contact/lead instead.
12. **Log incoming.** `dynamicsService.logMessage(entity, text, 'Incoming', phone, crmRequestId)` writes a `riivo_whatsappcommunicationses` record. Always called before `supabaseService.saveMessage` so the ordering matches on both sides.
13. **Timeout sweep (fire-and-forget).** On every client inbound, invoke `caseService.handleTimeout()` and ignore errors. Cheap idempotent UPDATE; safety-net between daily cron runs.
14. **Feedback routing.** If `session.pending_case_id` is set and the client's text parses as yes/no via `caseService.detectFeedback`, short-circuit into `caseService.handleFeedback` + ack message; clear `pending_case_id`. Bypasses the AI entirely. If the reply isn't feedback-shaped, clear the pending pointer and fall through.
15. **Conversation cap check (non-staff only).** Before the Claude call, the controller checks `sessions.cap_blocked_at` and the per-session/per-phone counters (`message_count`, `token_count`, plus a 24h count across the phone's sessions). If a cap fires, reply with the warm consultant-handoff line and return without calling Claude. Staff are exempt. Constants live near the top of `webhook.controller.ts`. See [usage-tracking-and-caps.md](./usage-tracking-and-caps.md).
16. **AI generation.** In parallel:
    - `claudeService.generateResponse(...)` — the main assistant turn (see §5).
    - `caseService.classifyCase(newCaseId, text)` when a new case was created this turn. Classification runs in parallel so users don't wait for two model calls.
17. **Send & persist.** Save the assistant message to Supabase, send it via `metaWhatsAppService.sendMessage`, mirror to Dynamics via `logMessage('Outgoing', …)`.
18. **Post-answer case bookkeeping.** Using the classifier outcome:
    - `L1` → `recordBotResponse(caseId, 'direct_answer', responseText)` + send yes/no feedback reply buttons + set `session.pending_case_id = newCaseId` + PATCH Dynamics request to `AWAITING_FEEDBACK`.
    - `escalation` → `markEscalated(caseId, 'Bot classified as escalation')`.
19. **Intent classification (fire-and-forget).** `claudeService.classifyIntent` → `supabase.updateSessionState` (writes `current_intent`). Used for analytics only.
20. **Natural wrap-up close.** If there's an open request for this session, no new case this turn, and `caseService.detectWrapUp(text)` matches (e.g. "thanks"/"perfect"/"sorted"), resolve the open case as `confirmed`. Catches conversations that drifted past the explicit feedback window.

### 4.2 Attack surfaces / gotchas

- `processMessage` assumes ordered, single-producer dispatch. Concurrent messages from the same phone would race on `pendingUpload` and `session.pending_case_id`. Today that's rare because Meta serialises per-phone-number, but tool-level code should not assume serialisation beyond that.
- `dynamicsService.logMessage` errors are logged and swallowed. Do _not_ change this — a Dynamics outage must not drop the WhatsApp reply.
- `res.sendStatus(200)` happens BEFORE any logging. If the outer handler throws before that line, Meta will retry the webhook. This ordering is intentional and load-bearing.

---

## 5. AI layer (`claude.service.ts`)

One Anthropic `messages.create` call per turn by default, a follow-up loop for tool-use rounds (capped at 5), plus two independent calls for case-classification and intent-classification.

All calls go through the Anthropic TypeScript SDK (`@anthropic-ai/sdk`). The system prompt is passed as Claude's dedicated `system` parameter (not as a message), and `cache_control: {type: 'ephemeral'}` is set at the top level so repeated turns within a session reuse the cached tools+system prefix at ~0.1× input cost.

### 5.1 System prompt

- `BASE_SYSTEM_PROMPT` — Tina's persona, tone rules, WhatsApp formatting rules (single-asterisk bold, hyphen bullets, no Unicode bullets), SA-English spelling, and the referral programme facts. Also carries the critical **"NO FOLLOW-UP PROMISES"** rule (the bot must never say "let me check" — every message is final) and the **scope guardrail** block ("you only answer SA tax / TTT account / onboarding / referrals" + a one-line warm redirect for anything else, including jailbreak-style instructions inside user messages). See [scope-guardrail.md](./scope-guardrail.md).
- Per-turn `roleContext` is appended for the caller's `entityType`:
  - `client` — full client behaviour, including the first-message greeting template, document-upload guidance, and a redirect to `get_required_documents` for docs queries.
  - `lead` — no tax advice. Encourage completion of onboarding. Upload docs allowed.
  - `user` (staff) — capability bullets are **generated dynamically from `permittedToolKeys`**, so the advertised capabilities match the actual tool filter. Task-creation instructions appended only if `create_task` is permitted.
  - Unknown — ask for the SA ID number and use `verify_identity`.
- Two additional contexts are spliced in when relevant:
  - **Pending LOE review** (`pending_loe_data` has a `pending_review` row) — tells the model to show the extracted fields and only use `confirm_loe_upload` / `update_loe_field` / `upload_letter_of_engagement` (restart).
  - **Pending WhatsApp upload** (file staged in memory) — staff path forks between LOE-for-a-lead vs generic doc-for-a-client; client path asks for the doc type.
- `"Current Date: {dateString}"` is prepended so the model can reason about tax seasons.

### 5.2 Tool registry

There are **31 tool definitions** registered in `TOOLS`:

| #  | Name                            | Who                 |
| -- | ------------------------------- | ------------------- |
| 1  | `get_my_details`              | client              |
| 2  | `get_client_invoices`         | client, staff       |
| 3  | `get_client_cases`            | client, staff       |
| 4  | `get_invoice_pdf`             | client, staff       |
| 5  | `send_invoice_pdf`            | staff               |
| 6  | `get_tax_number`              | client              |
| 7  | `request_consultant_callback` | client              |
| 8  | `get_required_documents`      | client              |
| 9  | `get_my_consultant`           | client              |
| 10 | `opt_out_whatsapp`            | client              |
| 11 | `create_case`                 | staff               |
| 12 | `get_my_clients`              | staff               |
| 13 | `get_my_leads`                | staff               |
| 14 | `search_contact_by_name`      | staff               |
| 15 | `get_client_details`          | staff               |
| 16 | `get_case_by_name`            | staff               |
| 17 | `get_outstanding_balance`     | client, staff       |
| 18 | `create_lead`                 | staff               |
| 19 | `refer_friend`                | client              |
| 20 | `get_my_referral_code`        | client              |
| 21 | `verify_identity`             | unknown             |
| 22 | `create_task`                 | staff               |
| 23 | `get_task_types`              | staff               |
| 24 | `search_lead_by_name`         | staff               |
| 25 | `save_document`               | client, lead, staff |
| 26 | `get_industries`              | staff               |
| 27 | `create_contact`              | staff               |
| 28 | `create_invoice`              | staff               |
| 29 | `upload_letter_of_engagement` | staff               |
| 30 | `confirm_loe_upload`          | staff               |
| 31 | `update_loe_field`            | staff               |

### 5.3 Tool filtering — three layers

`generateResponse` passes only a subset of `TOOLS` to Claude per turn:

1. **Role filter** — hard-coded per `entityType`:
   - `client` → `clientTools` whitelist (13 tools).
   - `user` (staff) → `staffTools` whitelist (22 tools).
   - `lead` → `['save_document']`.
   - Unknown → `['verify_identity']`.
2. **Staff permission filter** — for staff only. `STAFF_TOOL_PERMISSIONS` maps each staff-gated tool to a permission key (e.g. `create_lead → create_lead`, `search_contact_by_name → lookup_client`, `get_invoice_pdf → send_invoice_pdf`). The tool is kept only if its permission is in `permittedToolKeys` (the session's cached list). Tools _not_ in this map are considered unrestricted within the role (e.g. `get_industries`).
3. **Flow restriction** — when the staff session has a pending file (phase 1) or pending LOE review (phase 2), the tool list is narrowed further to only the tools relevant to that flow. This is how we prevent the model from wandering off mid-upload.

### 5.4 Completion loop

`client.messages.create` is called with `model=CLAUDE_MODEL` (`claude-opus-4-7`), `max_tokens=CLAUDE_MAX_TOKENS` (2048), `tool_choice={type:'auto'}`, plus `cache_control:{type:'ephemeral'}` at the top level for auto prompt caching. The response's `content` array is scanned for `tool_use` blocks. Each block is adapted to an internal `AdaptedToolCall` object (see §5.6) so the large block of per-tool handler bodies — preserved verbatim from the pre-migration codebase — keeps working unchanged. Tool results are collected into a `ToolResultBlockParam[]` and pushed as a **single** user message (Claude requires all tool_results for an assistant turn to arrive together). The loop is capped at 5 follow-up rounds; if it exceeds the bound, the fallback message is `"I completed the requested actions but ran into too many steps. Please try again."`

### 5.6 Internal tool-call adapter

The handler bodies were originally written against a tool_call with the shape `{ id, function: { name, arguments: JSON-string } }`. To keep those ~1,600 lines of per-tool business logic stable across the SDK migration, `adaptToolUse(block)` wraps each Anthropic `ToolUseBlock` into that legacy shape. `AdaptedToolCall` is an internal adapter type only — there is no runtime dependency on any other vendor's SDK.

### 5.5 Intent classifier (`classifyIntent`)

Separate lightweight Claude call (`max_tokens=20`) that returns one of 11 intent labels. Fire-and-forget from the webhook; result is only stored on `sessions.current_intent` for analytics.

---

## 6. Case lifecycle (`case.service.ts` + `whatsapp_cases` table)

This drives the Q2 metrics (WhatsApp adoption and L1 auto-resolution). Every qualifying client query produces one row in `whatsapp_cases`.

### 6.1 States

```
created ─▶ classified ─▶ bot_responded ─┬─▶ resolved_by_bot            (client tapped "Yes, thanks" OR natural wrap-up)
                                        ├─▶ resolved_by_bot_timeout    (12h without feedback)
                                        └─▶ escalated                  (client tapped "No, still need help" OR classified as escalation)
```

### 6.2 Qualification (`qualifyMessage`)

Rule-based, free. Skips messages shorter than 3 chars, emoji-only messages, and single-word noise (`thanks`, `ok`, `hi`, yes/no, etc.). No model call.

### 6.3 Classification (`classifyCase`)

Claude call using the **forced-tool JSON pattern** — a single tool `record_classification` is declared and `tool_choice: {type: 'tool', name: 'record_classification'}` forces the model to produce its answer as schema-validated tool input. Returns `{ level: 'L1' | 'escalation', topic: one of L1_TOPICS | null }`. L1 topics include `invoice_query`, `case_status`, `tax_number_lookup`, `account_details`, `tax_season_dates`, `home_office_requirements`, `document_guidance`, `basic_tax_structuring`, `referral_enquiries`, `general_tax_question`. On classifier failure, defaults to `escalation` (safer than a false L1).

### 6.4 Dynamics mirror

Every Supabase state transition is mirrored onto the corresponding Dynamics `riivo_request` via `dynamicsService.updateRequest`. `statecode`/`statuscode`/`riivo_classificationlevel`/`riivo_classificationtopic`/`riivo_resolutionmethod`/`riivo_clientfeedback`/`riivo_resolvedon`/`riivo_escalationreason`/`riivo_escalatedon`/`riivo_botanswers` are the relevant fields. The enum integers live in `dynamics.service.ts` (`REQUEST_STATE`, `REQUEST_STATUSCODE`, `RESOLUTION_METHOD`, `CLIENT_FEEDBACK`, `CLASSIFICATION_LEVEL`).

If the Dynamics PATCH fails, the Supabase row is still the source of truth for metrics — the PATCH is best-effort.

### 6.5 Timeout handling

- `sweepTimedOutCases(12h)` — moves `bot_responded` rows older than 12h to `resolved_by_bot_timeout` with `feedback_received='timeout'`.
- Triggered both by the daily Vercel cron (`/api/cron/case-timeout`) _and_ fire-and-forget on every client inbound (cheap idempotent UPDATE).

### 6.6 Natural wrap-up

`detectWrapUp` catches short closers like `"thanks"`, `"perfect"`, `"sorted"`, `"lekker"`, rejecting messages that contain `?` or pivot words (`but`, `actually`, `also`, `wait`). Used only when there's an open request for the session but no case was newly created this turn.

---

## 7. Identity and permissions

### 7.1 Three identity classes

| `crmEntity.type` | Where it comes from                                                 | Effect                                                                                              |
| ------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `client`         | Dynamics `contacts` (via `getContactByPhone`) or cached session | Full Tina client experience. Gets the interactive welcome menu on first message of a fresh session. |
| `lead`           | Dynamics `new_leads`                                              | Onboarding-only experience. No tax answers. Can upload docs.                                        |
| `user`           | Supabase `users` table (synced from Dynamics `systemuser`)      | Staff experience. Tool surface filtered by role.                                                    |

### 7.2 Role-based access (Supabase)

Three tables in `supabase/migrations/20260401120000_create_permissions_tables.sql`:

- **`roles`** — three seeded: `No Access`, `Some Access`, `Full Access`.
- **`users`** — mirrors Dynamics `systemuser`. `role_id` is managed in Supabase only; the sync script never overwrites it. Populated via `npm run sync:users`.
- **`role_tools`** — one row per `(role, tool_name)` with an `enabled` boolean. `Full Access` → all true; the other two default to false. Adding a new gated tool = insert rows, no schema change.

The current permission keys (seeded in the migrations):

```
create_lead, create_contact, create_task, create_case, create_invoice,
lookup_client, lookup_lead, view_open_cases, view_outstanding_invoices,
send_invoice_pdf, upload_letter_of_engagement
```

`claude.service.STAFF_TOOL_PERMISSIONS` is the authoritative mapping from _tool name_ → _permission key_.

### 7.3 Session caching

`sessions.role_id` and `sessions.permitted_tools` are written at session creation so per-turn requests don't pay the `role_tools` join. Staff role edits in Supabase are therefore not immediate — a running session must expire (30 min inactivity) or the session row's cached fields will keep the old permissions. The `getOrCreateSession` method backfills these fields on a resumed session if they're empty, but does not refresh them if they already have values.

### 7.4 Phone-number variants

`supabaseService.phoneVariants` expands a single phone string into `0xx…` / `+27xx…` / `27xx…` variants so however Meta / Dynamics / a staff member typed the number, lookups still match. Used by both `findStaffByPhone` and `findPreviousSession`.

### 7.5 Staff source of truth

Staff identity is authoritative via `findStaffByPhone`. If that returns null, the sender is NOT staff and any prior session row with `crm_type='user'` is ignored. This is the specific fix for a stale Supabase cache routing a phone through the staff path after the Dynamics mapping was revoked — but note the memory caveat: **Dynamics edits don't propagate until `npm run sync:users` is run.**

---

## 8. CRM integration (`dynamics.service.ts`)

Single class, ~1600 lines, wraps everything. Important patterns:

### 8.1 Auth

`msal.ConfidentialClientApplication` + client credentials. Tokens cached in-memory, refreshed when `tokenExpiry` passes. 55-minute fallback if the response omits an expiry.

### 8.2 `crmPost` / `crmPatch` with audit-field auto-retry

Every write attempt appends three audit fields (`ttt_ai_triggered_by`, `ttt_ai_model`, `ttt_ai_generated_at`). Some entities don't have these columns declared; the code detects the Dynamics "undeclared property" error, removes them, retries, and caches the entity name in `entitiesWithoutAudit` for the lifetime of the process so future writes skip them directly. Pre-seeded cache: `riivo_whatsappcommunicationses`, `new_leads`, `new_cases`.

### 8.3 Entities touched

- **`contacts`** — clients. Read via `getContactByPhone`, `getContactDetails`, `searchContactByName`, `getContactTaxProfile`, `getContactReferralCode`. Write via `createContact`, `updateWhatsAppOptIn`, `uploadDocument` (annotation).
- **`new_leads`** — prospects. Read via `getContactByPhone` (paralleled), `getMyLeads`, `searchLeadByName`, `searchContactByIdNumber`, `checkLoeAlreadyReceived`. Write via `createLead`, `writeLoeFieldsToLead`, `uploadLoeFileToCrm`.
- **`systemusers`** — staff. `getSystemUsers` (sync script), `getSystemUserById`, `getContactByPhone` (paralleled).
- **`new_invoiceses`** — invoices. `getClientInvoices`, `getInvoiceByNumber`, `getOpenInvoiceTotal`, `createInvoice`, `logInvoiceSentToContact`.
- **`new_cases`** — cases (not to be confused with WhatsApp cases!). `getClientCases`, `getStaffCases`, `searchCaseByName`, `createCase`.
- **`riivo_requests`** — the WhatsApp-case-mirror entity. `createRequest`, `updateRequest`, `createCallbackRequest`.
- **`riivo_whatsappcommunicationses`** — every inbound/outbound message gets one row, threaded under the `riivo_request` if open, else bound to the contact/lead. `logMessage`.
- **`riivo_tasktypes`** — cached task type reference data. `getTaskTypes`.
- **`riivo_industries`** — industry lookup. `getIndustries`.
- **Tasks** — `createTask` writes to the tasks entity with primary representative = staff.
- **Annotations** — `uploadDocument` attaches file bytes as `annotation`s on the contact/lead.

### 8.4 Request threading

`logMessage(entity, content, direction, phone, requestId?)`:

- If `requestId` is provided: `regardingobjectid_riivo_request@odata.bind = /riivo_requests({id})`. Staff see the whole conversation on the request record.
- Else if entity is a client: bind to `/contacts(...)`.
- Else if entity is a lead: bind to `/new_leads(...)`.

The webhook resolves `requestId` _before_ calling `logMessage`, so ordering is deterministic.

### 8.5 Option-set enums

Power Apps "Choice" fields are stored as integer values. The relevant maps live at the top of the service:

- `REQUEST_STATE`, `REQUEST_STATUSCODE` — case state/status.
- `RESOLUTION_METHOD` — how a case was resolved.
- `CLIENT_FEEDBACK` — the feedback reply.
- `CLASSIFICATION_LEVEL` — L1/L2/L3/Escalation.
- In `claude.service.ts`: `CLIENT_TYPE_VALUES`, `LEAD_TYPE_VALUES`, `INVOICE_TYPE_VALUES` — all translated at the tool-call boundary before writing to Dynamics.

---

## 9. Media and file flows

### 9.1 Inbound documents / images

1. Meta delivers a `type:'document'` or `type:'image'` webhook message with a `media.id`.
2. `metaWhatsAppService.downloadMedia(id)` does two GETs: `/media/{id}` → signed URL, then the signed URL → bytes. Returns `{ buffer, mimeType }`.
3. `pendingUploadService.stagePendingUpload(phone, filename, mimeType, buffer)` stores it in a process-local `Map` keyed by phone. Janitor interval clears entries older than 10 minutes.
4. The model is told there's a pending upload (via roleContext injection) and is expected to call `save_document` (client/lead path) or the LOE tools (staff path).

### 9.2 LOE upload (staff flow)

Two-phase flow with Supabase staging so OCR mistakes never silently overwrite CRM:

**Phase 1 — Upload + OCR.**

- Staff sends a PDF, then types "LOE for {lead name}".
- Model resolves the lead via `search_lead_by_name`.
- Model calls `upload_letter_of_engagement(lead_id)`.
- Handler calls `mistralService.ocrDocument(file)` → markdown.
- `loeExtractorService.extractBankingDetails(markdown)` → structured fields (via Claude with a single forced tool — Anthropic's native pattern for reliable JSON output).
- `supabaseService.savePendingLoeData(...)` inserts a `pending_review` row (bytes, markdown, all 15 extracted fields).

**Phase 2 — Review + confirm.**

- Next turn, `roleContext` injects the extracted values and instructs the model to show them and ask for confirmation.
- Tool surface is restricted to `{confirm_loe_upload, update_loe_field, upload_letter_of_engagement}`.
- Staff says "bank name should be Capitec" → `update_loe_field('bank_name', 'Capitec')`.
- Staff says "yes" → `confirm_loe_upload`:
  1. `supabaseService.confirmPendingLoe(session)` flips status to `confirmed`, returns the full row.
  2. `dynamicsService.writeLoeFieldsToLead(lead, fields)` PATCHes the `new_lead` record.
  3. `dynamicsService.uploadLoeFileToCrm(lead, fileName, buffer, staff)` writes the PDF to `riivo_SignedLetterofEngagement` and creates a timeline annotation, and flips `riivo_loereceived = true`.
  4. `supabaseService.deletePendingLoe(session)` — cleanup.

Allowed field names for `update_loe_field` are enforced at the DB layer (`updatePendingLoeField` hard-whitelists them). Anything outside the whitelist is rejected.

### 9.3 Outbound documents

`metaWhatsAppService.sendDocument(to, buffer, filename, caption?)`:

1. POST multipart to `/{phoneNumberId}/media` → `media_id`.
2. POST JSON to `/{phoneNumberId}/messages` with `type=document` + `media_id` + optional `caption`.

DRY-RUN mode kicks in when Meta creds are empty — logs the "would have sent" line and returns `{ delivered: false, dryRun: true }` so tool handlers, audit writes, and staff acks still execute.

### 9.4 Invoice PDF generation

`pdfService.generateInvoicePDF(InvoiceData)` uses `pdfkit` to draw an A4 invoice with TTT branding (blue `#0077B6`). The `mapInvoiceToInvoiceData(dynamicsInvoice)` helper is shared between the `/api/pdf/invoice/:n` route and the Claude tool handlers so there's a single place to update when fields change.

---

## 10. WhatsApp Flow (sign-up)

- A published WhatsApp Flow (id in `WHATSAPP_SIGNUP_FLOW_ID`) presents a form with first_name, last_name, email, client_type, service_needed, notes, terms_agreement, offers_acceptance. The published version is documented in [whatsapp-flow-signup.md](./whatsapp-flow-signup.md).
- When a stranger messages the bot, `processMessage` calls `metaWhatsAppService.sendFlow(...)` with `flow_action='navigate'` and the first screen id `SIGN_UP`. If `sendFlow` fails, fall back to the plain-link greeting.
- The client's submission arrives as a webhook message of `type='interactive'` + `interactive.type='nfm_reply'`. `extractIncoming` parses `response_json` into a `SignUpFlowResponse`.
- `handleSignUpFlowSubmission` validates required fields + terms agreement, calls `dynamicsService.createLead`, and sends a confirmation.

---

## 11. Data model — Supabase

### 11.1 `sessions`

Per-phone conversational state.

| Column                    | Type                         | Notes                                                                               |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `id`                    | uuid PK                      |                                                                                     |
| `phone_number`          | text                         | Raw `from` from Meta. Phone variants are matched on lookup, not stored.           |
| `crm_id` / `crm_type` | text / text                  | `client`/`lead`/`user`.                                                       |
| `status`                | text                         | `active` / `expired`. 30-min inactivity timeout.                                |
| `current_intent`        | text                         | Latest intent label. Analytics only.                                                |
| `current_step`          | text                         | Reserved for multi-step flows — unused at time of writing.                         |
| `last_active`           | timestamptz                  | Touched on every inbound in-window.                                                 |
| `role_id`               | uuid →`roles.id`          | NULL for non-staff. Cached at create time.                                          |
| `permitted_tools`       | text[]                       | Cached permission list. Empty = no tools.                                           |
| `pending_case_id`       | uuid →`whatsapp_cases.id` | Set when feedback buttons are sent; next inbound routed through `handleFeedback`. |
| `created_at`            | timestamptz                  |                                                                                     |

### 11.2 `messages`

Append-only conversation log. `(session_id, role: 'user' | 'assistant', content, timestamp)`. Fetched oldest-first for Claude context.

### 11.3 `whatsapp_cases`

See §6.1. Backed by a trigger that keeps `updated_at` fresh; used by `sweepTimedOutCases` as the `< cutoff` filter.

### 11.4 `pending_loe_data`

Staging table for LOE uploads. One `pending_review` row per session at a time (new upload expires the previous one). Holds the file bytes, OCR markdown, page count, 15 extracted fields, and status. See the migration for field names.

### 11.5 `users` / `roles` / `role_tools`

Permissions infrastructure. Users row = one TTT staff member; `dynamics_user_id` is the unique key. `role_tools(role_id, tool_name, enabled)` is the permission matrix.

### 11.6 `crm_audit_log`

Per CRM write: entity, record id, action, payload, triggered_by, model, timestamp. Populated by `supabaseService.logCrmWrite`. Useful when reconciling "who did that?" on a Dynamics record.

### 11.7 `claude_usage` + session cap counters

Migration `20260428100000_claude_usage_tracking.sql`. One row per Anthropic `messages.create` call (main turn, tool-loop iteration, intent classifier — distinguished by `call_purpose`): session_id, phone_number, role, model, input/output/cache-creation/cache-read tokens, and `cost_usd` computed at insert time from [claudePricing.service.ts](../src/services/claudePricing.service.ts) so historical rows survive future Anthropic price changes. The `claude_usage_daily` view rolls these up by day × phone × role × model for dashboards.

The same migration adds three columns to `sessions` — `message_count`, `token_count`, `cap_blocked_at` — bumped atomically by the `increment_session_usage(uuid, integer)` Postgres function. These let the cap check in §4.1 step 15 short-circuit without a `sum()` over `claude_usage` per turn. Logging is fire-and-forget; a Supabase outage will not break a live conversation. Full design + queries in [usage-tracking-and-caps.md](./usage-tracking-and-caps.md).

---

## 12. Background jobs and scripts

### 12.1 Daily case-timeout cron

- `vercel.json` → `0 2 * * *` UTC → GET `/api/cron/case-timeout`.
- Auth: `Authorization: Bearer $CRON_SECRET` (or `x-cron-secret` header). In dev (no secret set and `NODE_ENV !== production`), requests are allowed.
- Body: `caseService.handleTimeout()` — sweeps in Supabase and mirrors the terminal state onto the corresponding `riivo_requests`.

### 12.2 Manual scripts

- `npm run sync:users` — pulls `systemuser` rows from Dynamics and upserts them into Supabase `users`. Never overwrites `role_id`. See `src/scripts/sync-users-from-dynamics.ts`.
- `npm run test:webhook` — `test/simulate-webhook.ts`, fires a fake inbound message at the local server.
- `npm run test:case` — `test/test-case-lifecycle.ts`, exercises create/classify/confirm/timeout.

### 12.3 In-process timers

- `pendingUpload.service.ts` — `setInterval` every 60s deletes entries older than 10 min.

---

## 13. Configuration

All env vars live in `.env` (see `.env.example`). Required for a real deployment:

- **Dynamics:** `DYNAMICS_URL`, `DYNAMICS_TENANT_ID`, `DYNAMICS_CLIENT_ID`, `DYNAMICS_CLIENT_SECRET`.
- **Meta WhatsApp:** `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, optional `WHATSAPP_SIGNUP_FLOW_ID`. When blank, outbound messages log but don't send (DRY-RUN).
- **Anthropic Claude:** `ANTHROPIC_API_KEY`. Missing key → the bot returns a "Demo Mode" canned response. Model pinned via `CLAUDE_MODEL` constant in [src/services/claude.service.ts](../src/services/claude.service.ts) — currently `claude-opus-4-7`.
- **Mistral OCR:** `MISTRAL_API_KEY`, `MISTRAL_OCR_MODEL` (default `mistral-ocr-latest`). Missing key → LOE flow throws at the OCR step.
- **Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Hard requirement — service throws on import if missing.
- **Cron:** `CRON_SECRET`. Blank in dev is fine.
- **Bot:** `SIGNUP_URL` (lead-path onboarding URL), `PORT`.

---

## 14. Observability

- Every request, tool call, CRM read/write, and state transition logs to `console.*`. Structured-ish prefixes (`[Webhook]`, `[Claude]`, `[Dynamics CRM]`, `[Supabase]`, `[Meta WhatsApp]`, `[CaseService]`, `[LoeExtractor]`, `[PendingUpload]`, `[Cron]`).
- `crm_audit_log` — the durable record of every write that hit Dynamics. Joins to `messages` / `sessions` by `triggered_by`.
- `whatsapp_cases` table is the source-of-truth for Q2 metrics (adoption, L1 auto-resolution rate).

No external APM or error tracker is wired up.

---

## 15. Known rough edges

1. **`claude.service.ts` is a ~2,200-line god-file.** Tool handlers, tool definitions, prompt construction, and the completion loop all live in one class. Extracting one tool-per-file is pending.
2. **The classifier runs separately from the main completion.** Doubles the billable tokens on every new case turn. Merging it into the main call (or moving it to a cheaper model / rules) is a candidate optimisation.
3. **Stale `user`-typed sessions** — see §7.5. After revoking a staff mapping, existing active sessions keep their cached permissions until they expire (30 min) or the user sends a message that bypasses the staff-return branch. A future change could re-read `findStaffByPhone` on every staff turn, but that adds a hit per message.
4. **Cleanup still pending** — `convex/`, `src/services/clickatell.service.ts`, and `src/services/dynamics.service 2.ts` are tracked-but-deleted on the current branch. Ready to drop in the next commit.
5. **No retries on Meta outbound failures.** A 4xx/5xx from Meta is logged but not retried; the assistant message is already saved to Supabase so on the next inbound we won't re-send.
6. **`claude.service.generateResponse` has an implicit tool-call loop bound.** If a tool chain really does need 10+ steps, users see the generic "too many steps" fallback. Tune inside the method if a legitimate flow needs more.

---

## 16. Related documents

- [bot-personality.md](./bot-personality.md) — Tina's tone reference.
- [leads-and-contacts.md](./leads-and-contacts.md) — Lead vs Contact modelling.
- [meta-templates.md](./meta-templates.md) — the approved WhatsApp message templates.
- [whatsapp-template-designs.md](./whatsapp-template-designs.md) — visual specs for the templates.
- [whatsapp-flow-signup.md](./whatsapp-flow-signup.md) — the sign-up Flow JSON + screens.
- [interactive-first-message-menus.md](./interactive-first-message-menus.md) — the client welcome list menu spec.
- [referral-code.md](./referral-code.md) — referral programme facts and tool behaviour.
- [request-lifecycle.md](./request-lifecycle.md) — the `riivo_request` state machine.
