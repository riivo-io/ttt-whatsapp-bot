# PRD: External Template → Conversation Continuity

**Author:** Luc Duval
**Date:** 2026-06-01
**Status:** Draft, pending review
**Related:** [docs/PRD-post-loe-activation.md](./PRD-post-loe-activation.md), [docs/PRD-first-contact-templates.md](./PRD-first-contact-templates.md)

---

## 1. Problem Statement

WhatsApp templates are being sent to clients and leads by systems other than Tina herself. The two confirmed sources today:

1. **Campaign sender** — a separate Next.js + Convex web app that fires marketing/referral templates in bulk.
2. **Power Automate flows** — Dynamics-triggered sends (e.g. invoice PDFs, case-status updates, LoE-stage prompts) running outside this repo.

When the client replies to one of those templates, Tina has no record that the outbound ever happened:

- The Supabase `sessions` row may not exist (cold phone), or exists with no recent history.
- The `messages` table has no assistant entry corresponding to the template.
- Tina's prompt context starts from "stranger or returning client says X" with no idea X is a reply to "your invoice for May is attached" or "want to refer a friend?"

Result: the bot's first response feels disconnected ("how can I help?" when the client is responding to a specific prompt), and in some cases Tina re-asks for information the client just received or contradicts the template's call to action.

Today's working pattern for Tina's *own* template sends, established in [src/controllers/emailRelay.controller.ts:235-254](../src/controllers/emailRelay.controller.ts#L235-L254), is to upsert the session and pre-seed the assistant message into history before calling `sendTemplate`. We need that same behavior available to external senders.

A related gap exists today inside this repo: the LoE thank-you sent at [src/services/loeActivation.service.ts:107](../src/services/loeActivation.service.ts#L107) does not seed history. Same bug class, same fix.

---

## 2. Goals

1. Provide a single signed webhook external systems can call after they send a WhatsApp template, so Tina records the outbound in her session history.
2. Make Meta the source of truth for template wording — Tina fetches body text from the WhatsApp Business Management API, no hand-copied strings.
3. Make the webhook idempotent at the per-message level so Power Automate retries and at-least-once delivery semantics don't double-write history.
4. Retrofit Tina's own LoE thank-you path to use the same mechanism so all "outbound that happens outside the inbound flow" goes through one code path.
5. Keep the contract trivial enough that the campaign sender and PA flows can adopt it in an afternoon.

## 3. Non-Goals

- Tina does **not** initiate template sends through this webhook. This is a notification-only path — the sender still talks to Meta directly.
- No changes to Meta's send API, no changes to which system owns which template.
- No `current_intent` stamping on the session. History alone steers Tina's next response (per design decision 2026-06-01).
- No retroactive backfill of historical sends already made before this rolls out.
- No new analytics dashboards. Logging is enough for v1.
- No template-approval workflow in this repo. Templates are still created and approved inside Meta's Business Manager UI.

---

## 4. Success Metrics

| Metric | Baseline | Target |
|---|---|---|
| Time from external template send to Tina's session/history reflecting it | Indefinite (never, today) | < 5 seconds (synchronous webhook) |
| External template sends that successfully seed history | 0% | ≥ 99% (excluding sends to non-existent phones) |
| Duplicate assistant messages from PA retries | N/A | 0 (enforced by unique index on `messages.external_id`) |
| LoE thank-you sends that seed history | 0% | 100% (post-retrofit) |
| Inbound replies to external templates where Tina's first response references the template content | 0% (no history) | Manual spot-check on first 30 — qualitative target |

---

## 5. Solution Overview

```
External sender (campaign app / PA flow)
│
├─ Calls Meta: POST /messages with template_name + variables
│  └─ Meta returns { messages: [{ id: "wamid.ABC..." }] }
│
└─ Calls Tina: POST /webhook/outbound-notify
   {
     phone,
     template_name,
     template_language: "en",
     template_variables: ["John", "May 2026"],
     template_header_variable: "Q1 2026",   // optional, only for text headers with a variable
     sender_message_id: "wamid.ABC...",     // Meta's wamid, or sender UUID
     sent_at: "2026-06-01T10:00:00Z",
     sender: "campaign_app" | "power_automate" | ...   // optional metadata
   }

Tina webhook handler:
│
├─ Verify HMAC-SHA256 of raw body against OUTBOUND_NOTIFY_SECRET
├─ Resolve sender identity via existing chain:
│   findStaffByPhone → findPreviousSession → getContactByPhone
├─ getOrCreateSession(phone, crmId, crmType)
├─ Fetch template components (header/body/footer) from Meta cache (refresh if miss)
├─ Compose seeded content: rendered header + rendered body + footer
├─ INSERT into messages { session_id, role: 'assistant', content: composed, external_id: sender_message_id }
│   └─ ON CONFLICT (external_id) DO NOTHING  ←── idempotency
└─ Return 200 { ok: true, seeded: true | false, reason? }

Template cache (process-local, in-memory):
│
├─ On first use after process start: GET {WABA_ID}/message_templates
├─ Cache by (name, language) → { headerType, headerText, bodyText, footerText, variableCount }
├─ 1-hour TTL; refetch on miss after expiry
└─ POST /admin/templates/refresh for manual flush (Bearer auth)
```

---

## 6. Detailed Specifications

### 6.1 Webhook: `POST /webhook/outbound-notify`

**Request**:
```http
POST /webhook/outbound-notify
Content-Type: application/json
X-Outbound-Signature: <HMAC-SHA256 of raw body, hex-encoded>

{
  "phone": "+27821234567",
  "template_name": "referral_invite_v2",
  "template_language": "en",
  "template_variables": ["John"],
  "template_header_variable": "Q1 2026",
  "sender_message_id": "wamid.HBgLMjc4MjEyMzQ1NjcVAg...",
  "sent_at": "2026-06-01T10:00:00Z",
  "sender": "campaign_app"
}
```

**Field rules**:
- `phone` — required. Any SA format; normalized via existing `phoneVariants()` at lookup.
- `template_name` — required. Must match a name returned by Meta's `message_templates` endpoint.
- `template_language` — optional, defaults to `"en"`. Used to disambiguate when a template is approved in multiple languages.
- `template_variables` — optional array of strings. Ordered, matching `{{1}}`, `{{2}}`, ... in the template body. Empty array if the template has no body variables.
- `template_header_variable` — optional string. Only used when the template's header is a text component with a single `{{1}}` placeholder (Meta caps text-header variables at one). Ignored for media headers (image / video / document / location) and for headers without variables.
- `sender_message_id` — required. Used as the unique idempotency key. Recommended value: Meta's `wamid` from the send response. Senders that don't have a wamid (e.g. failures before Meta-side confirmation) may pass any UUID, with the understanding that retries must reuse the same value.
- `sent_at` — required ISO 8601. Recorded on the inserted `messages` row for ordering.
- `sender` — optional free-text tag for logging/debugging. Not load-bearing.

**Responses**:
- `200 { "ok": true, "seeded": true }` — session upserted and message inserted.
- `200 { "ok": true, "seeded": false, "reason": "duplicate" }` — `external_id` already exists; no-op.
- `400 { "error": "missing_field", "field": "<name>" }` — required field absent or malformed.
- `401 { "error": "bad_signature" }` — HMAC mismatch.
- `404 { "error": "template_not_found", "template_name": "..." }` — template not in Meta cache after one forced refresh.
- `503 { "error": "meta_unavailable" }` — template cache empty and Meta API call failed; sender should retry.

**File**: new `src/routes/outboundNotify.route.ts`, registered in `src/server.ts`.

### 6.2 Auth: HMAC-SHA256

**Header**: `X-Outbound-Signature`.

**Algorithm**: HMAC-SHA256 over the raw request body bytes (not parsed JSON), using `OUTBOUND_NOTIFY_SECRET`, hex-encoded. Constant-time compare. Mirrors [src/routes/loeSigned.route.ts](../src/routes/loeSigned.route.ts) — extract the verification into a small shared helper in `src/utils/hmac.ts` so both routes use the same constant-time compare.

### 6.3 Template cache and renderer

**File**: new `src/services/whatsappTemplateRegistry.service.ts`.

**Behavior**:

1. On first call, fetch `GET https://graph.facebook.com/v21.0/${WABA_ID}/message_templates?fields=name,language,components,status&limit=200` using the existing `WHATSAPP_ACCESS_TOKEN`. Paginate via `paging.next` if the WABA has > 200 templates.
2. Filter to `status === "APPROVED"`.
3. Build an in-memory `Map<string, TemplateEntry>` keyed by `${name}::${language}`. Each entry holds:
   ```ts
   {
     headerType: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION" | null,
     headerText: string | null,        // only populated when headerType === "TEXT"
     headerVariableCount: 0 | 1,       // Meta caps text-header variables at 1
     bodyText: string,
     bodyVariableCount: number,
     footerText: string | null
   }
   ```
   All fields derived from the template's `components` array. All in-scope templates have a BODY component (confirmed 2026-06-01), so `bodyText` is always non-null.
4. Cache TTL: 1 hour. On lookup miss after TTL, refetch.
5. Expose `getEntry(name, language) → TemplateEntry | null`, `composeHistoryContent(entry, bodyVars, headerVar)`, and `forceRefresh() → Promise<void>`.

**Composing the history content**: `composeHistoryContent` assembles the seeded assistant message in display order:

1. **Header section**:
   - `headerType === "TEXT"`: render the header text (substituting `{{1}}` with `headerVar` if `headerVariableCount === 1`). Missing `headerVar` when one is required → fall back to empty substitution and log a warning.
   - `headerType` in `{ IMAGE, VIDEO, DOCUMENT, LOCATION }`: prepend a single-line marker — `[image]`, `[video]`, `[document]`, `[location]` — so Tina has a hint that visual content was attached.
   - `headerType === null`: omit.
2. **Body section**: render `bodyText`, substituting `{{1}}`, `{{2}}`, ... with `bodyVars[0]`, `bodyVars[1]`, ... Missing body variables fall back to empty and log; extras are ignored.
3. **Footer section**: append `footerText` verbatim (Meta footers have no variables) when present.

Sections are joined with `\n\n`. The resulting string is what gets inserted into `messages.content`.

**Edge cases**:
- Template has no body variables → `bodyVariableCount = 0`. Webhook accepts empty/missing `template_variables`.
- Template has buttons → button labels are not included in the seeded history. The client's reply (button tap or free text) comes through the inbound path normally and Tina can interpret it from context.
- Template has a text header with a variable but the webhook caller omits `template_header_variable` → render with empty substitution and log a warning. Not a fatal error.

### 6.4 Idempotency: `messages.external_id`

**File**: new migration `supabase/migrations/<timestamp>_messages_external_id.sql`.

```sql
ALTER TABLE messages
    ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX messages_external_id_unique_idx
    ON messages (external_id)
    WHERE external_id IS NOT NULL;
```

**Insert path**: the outbound-notify handler inserts with `ON CONFLICT (external_id) DO NOTHING`. If the insert affects zero rows, the handler returns `{ ok: true, seeded: false, reason: "duplicate" }`.

**Existing inserts**: leave `external_id` NULL. The partial unique index (`WHERE external_id IS NOT NULL`) ensures no constraint on existing rows.

### 6.5 Session upsert and message insert

**File**: extends `src/services/supabase.service.ts` with `insertAssistantMessage(sessionId, content, opts: { externalId?: string, createdAt?: string })`. The function uses `ON CONFLICT (external_id) DO NOTHING` and returns whether a row was actually inserted.

**Sender resolution**: the handler reuses the chain from [src/workers/whatsappProcessor.ts:219-259](../src/workers/whatsappProcessor.ts#L219-L259). For v1, export the existing worker-local function (or call its underlying primitives `findStaffByPhone`, `findPreviousSession`, `getContactByPhone` directly from the webhook). A clean refactor into a dedicated `senderResolution.service.ts` is deferred — call it out as follow-up tech debt if the inline reuse gets awkward.

**Session call**: `getOrCreateSession(phone, crmId, crmType)` as today. No new parameters.

**Handler order**:
1. Verify HMAC.
2. Parse + validate body.
3. Look up template entry (refresh cache once on miss).
4. `composeHistoryContent(entry, template_variables, template_header_variable)` per §6.3 → seeded content string.
5. Resolve sender → `{ crmId, crmType } | { unresolved }`.
6. `getOrCreateSession(phone, crmId, crmType)` — `unresolved` is allowed; the session row exists with null CRM fields, matching today's behavior for cold inbound.
7. `insertAssistantMessage(sessionId, seededContent, { externalId: sender_message_id, createdAt: sent_at })`.
8. Return per §6.1.

### 6.6 LoE thank-you retrofit

**File**: [src/services/loeActivation.service.ts:107](../src/services/loeActivation.service.ts#L107).

**Today**: calls `metaWhatsAppService.sendMessage(phone, body)` (plain text), no session/history write.

**Change**: after the send succeeds, call the same session-upsert + history-insert logic used by the webhook handler. Two paths are acceptable:

- **Preferred**: Tina is the sender here, so call the internal helpers directly (`getOrCreateSession` + `insertAssistantMessage`). No need to call her own webhook over HTTP. Use the Meta message ID returned by `sendMessage` as `external_id`.
- **Alternative**: re-route this send through a real template (instead of plain text), then call the same webhook. Higher consistency but adds a template-approval step. Defer to v2.

For v1, take the preferred path. The webhook is the contract for *external* senders; internal sends use the shared helpers directly.

### 6.7 Manual cache refresh: `POST /admin/templates/refresh`

**Auth**: `Authorization: Bearer ${CRON_SECRET}` (reuses existing pattern from [src/routes/cron.route.ts:19](../src/routes/cron.route.ts#L19)).

**Response**: `200 { ok: true, templates_loaded: <count>, fetched_at: <iso> }`.

**Purpose**: lets us flush the cache without restarting the bot when a template wording changes in Meta. Not on a schedule — manual trigger only. The 1-hour TTL covers the lazy case.

### 6.8 Env vars

| Variable | Required where | Description |
|---|---|---|
| `OUTBOUND_NOTIFY_SECRET` | Bot + campaign sender (Convex env) + Power Automate connection | HMAC-SHA256 shared secret. Generate with `openssl rand -hex 32`. Rotate across all three in the same deploy window. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Bot | WABA ID for the `message_templates` fetch. May already exist; confirm during implementation. |

The bot already has `WHATSAPP_ACCESS_TOKEN` for sending; the templates endpoint uses the same token.

---

## 7. Sender Adoption Notes

These are not deliverables in this repo, but spec'd here so the campaign-sender and PA owners can implement against them.

### 7.1 Campaign sender (Next.js + Convex)

After every successful Meta `POST /messages` call, fire-and-forget a `POST` to `https://<bot-host>/webhook/outbound-notify` with the body shape in §6.1. Compute HMAC-SHA256 using `OUTBOUND_NOTIFY_SECRET` (new env var in Convex). Convex actions can use Node's `crypto.createHmac`. The webhook call should NOT block the campaign's send loop — log failures and move on; the next inbound from that phone simply loses history-context for that one send.

### 7.2 Power Automate flows

After the "Send WhatsApp template" action in each flow, add an HTTP action:
- Method: `POST`
- URI: `https://<bot-host>/webhook/outbound-notify`
- Headers:
  - `Content-Type: application/json`
  - `X-Outbound-Signature: @{outputs('Compose_HMAC')}`
- Body: JSON per §6.1

The HMAC is computed in a preceding step using the `compose` + HMAC connector pattern. Document the exact PA expression in the flow's notes (PA owners can lift it from any existing signed-webhook flow).

PA retries (built-in) reuse the same `sender_message_id` so the dedup index catches them.

### 7.3 Templates to seed history for (initial scope)

These four families are confirmed in-scope. Names below are placeholders — owners should map to the actual approved template names in Meta:

- Referral campaign templates (campaign sender)
- Invoice PDF / billing templates (PA flow)
- Status updates — case progress, document received, etc. (PA flow)
- LoE / onboarding-stage prompts that don't already go through Tina (PA flow)

The webhook does not care which family a template belongs to. The list is for sender owners to scope adoption.

---

## 8. Tasks & Deliverables

### Task 1 — `messages.external_id` migration

**Files**: new `supabase/migrations/<timestamp>_messages_external_id.sql`.

**Deliverable**: §6.4 SQL applied locally and pushed to prod via the standard migration flow.

**Acceptance**:
- `supabase db reset` succeeds.
- Inserting two rows with the same non-null `external_id` raises a unique-violation.
- Inserting two rows with NULL `external_id` succeeds (partial index respected).

### Task 2 — Template registry service

**Files**: new `src/services/whatsappTemplateRegistry.service.ts`.

**Deliverable**: §6.3 service — fetch + cache + compose. Exports `getEntry`, `composeHistoryContent`, `forceRefresh`.

**Acceptance**:
- Unit tests: cache hit, cache miss → refetch, TTL expiry → refetch, template-not-found returns null.
- Compose tests covering: body-only template, text-header + body, text-header-with-variable + body, media-header + body + footer, body + footer, missing body variable falls back + logs, extra body variable ignored, missing header variable falls back + logs.
- Integration smoke: call `getEntry("hello_world", "en")` against the live WABA (test account) and assert the cached fields match what Meta returned.

### Task 3 — Outbound-notify webhook route

**Files**: new `src/routes/outboundNotify.route.ts`, `src/server.ts` (registration), `.env.example`.

**Deliverable**:
- `POST /webhook/outbound-notify` per §6.1.
- HMAC verification per §6.2.
- Handler order per §6.5.
- Maps every outcome to the documented response shape.

**Acceptance**:
- `curl` test: valid HMAC + valid payload → 200 `seeded: true`, row appears in `messages` with `role='assistant'`, `external_id` set, `content` composed from header + body + footer.
- A template with a media header → seeded content prefixed with the `[image]` / `[video]` / `[document]` marker.
- A template with a footer → seeded content ends with the footer text after a blank line.
- Same request a second time → 200 `seeded: false, reason: "duplicate"`, no new row.
- Wrong HMAC → 401.
- Unknown template_name → 404 after one cache refresh.

### Task 4 — Shared HMAC helper

**Files**: new `src/utils/hmac.ts`, refactor [src/routes/loeSigned.route.ts](../src/routes/loeSigned.route.ts).

**Deliverable**: extract the constant-time HMAC compare used in `loeSigned.route.ts` into a shared helper. Both routes call it.

**Acceptance**: `loeSigned.route.ts` still passes its existing manual test against the LoE Next.js app; the new helper has unit tests for valid/invalid signatures.

### Task 5 — `insertAssistantMessage` in supabase service

**Files**: [src/services/supabase.service.ts](../src/services/supabase.service.ts).

**Deliverable**: new function `insertAssistantMessage(sessionId, content, { externalId?, createdAt? })`. Returns `{ inserted: boolean }`. Uses `ON CONFLICT (external_id) DO NOTHING`.

**Acceptance**: unit test for first insert, duplicate insert, and null-externalId insert.

### Task 6 — Manual refresh endpoint

**Files**: [src/routes/cron.route.ts](../src/routes/cron.route.ts) (or new admin route file).

**Deliverable**: `POST /admin/templates/refresh` per §6.7. Bearer-auth with `CRON_SECRET`.

**Acceptance**: authenticated call returns 200 with `templates_loaded` count; unauthenticated → 401.

### Task 7 — Retrofit LoE thank-you

**Files**: [src/services/loeActivation.service.ts:107](../src/services/loeActivation.service.ts#L107).

**Deliverable**: after `sendMessage` succeeds, call `getOrCreateSession` + `insertAssistantMessage` with the Meta-returned message ID as `external_id`. Plain-text content (the thank-you body) is what gets seeded.

**Acceptance**: end-to-end LoE test (existing `/webhook/loe-signed` flow) — after activation, query `messages` for the lead's session and confirm the thank-you body is present with the wamid as `external_id`. Next inbound from that lead pulls the thank-you into Claude's history.

### Task 8 — Sender adoption docs

**Files**: new `docs/outbound-notify-integration.md`.

**Deliverable**: short integration doc covering §7.1 and §7.2 with copy-pasteable HMAC snippets for Convex (TypeScript) and Power Automate (Compose expression). Link from this PRD and from `docs/onboarding-flow.md` if relevant.

**Acceptance**: the doc is detailed enough that the campaign-sender and PA owners do not need to ask follow-up questions.

### Task 9 — Smoke test against staging

**Files**: none in repo. Manual test plan documented in this PRD.

**Deliverable**: with the bot deployed and `OUTBOUND_NOTIFY_SECRET` set in staging, run:
1. `curl` an outbound-notify call for a known phone with a real approved template name.
2. Confirm `messages` row appears.
3. Send an inbound from the same phone.
4. Confirm Tina's prompt includes the seeded assistant message in her history.

**Acceptance**: Tina's first response references the template content sensibly.

---

## 9. Rollout Plan

1. **Bot side**: land Tasks 1–7 in this repo. Deploy. The webhook accepts traffic but isn't called yet.
2. **Smoke test** (Task 9) using `curl` from a developer machine to verify the end-to-end seeding works without involving the external senders.
3. **LoE retrofit** is live as soon as Task 7 ships — no external dependency. Monitor the next few activations to confirm history-seeding works.
4. **Campaign sender** (per §7.1): owner adds the webhook call behind a Convex env-flag. Roll to a small batch (e.g. 10 referrals), verify, then full traffic.
5. **Power Automate flows** (per §7.2): owner adds the HTTP action to each flow one at a time. Start with the lowest-volume flow (likely status updates) to validate the HMAC pattern, then roll the rest.
6. **Monitor for 1 week**:
   - Outbound-notify success rate (4xx + 5xx tracking via existing log infra).
   - Duplicate-rate (count of `seeded: false, reason: "duplicate"`) — should be low single digits driven by PA retries.
   - Any `template_not_found` 404s — indicates a sender is using a stale template name; alert the sender owner.

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Sender forgets to call the webhook for a new template | History gap for that send only. Bot falls back to today's behavior (no context). Monitor `template_not_found` 404 and missing-seed reports; nothing breaks. |
| Meta API rate limit during cache refresh | 1-hour TTL + lazy refetch keeps requests sparse. Templates endpoint has a generous limit; not a realistic concern at TTT's template count. |
| Template wording changes in Meta without a manual refresh | 1-hour TTL bounds drift to at most an hour. Owner can hit `/admin/templates/refresh` for instant flush. Worst case: one hour of slightly stale history-seeding text; client-visible message was correct. |
| HMAC secret leaks | Rotate `OUTBOUND_NOTIFY_SECRET` across bot + Convex + PA connection. Old signatures stop validating immediately; safety net is that no real damage can be done — the webhook only writes assistant-side history, no outbound sends. |
| `external_id` collisions across senders | wamid is globally unique within the WABA. UUIDs from senders are unique by construction. No realistic collision path. |
| Session row created for unresolved phones (spam / wrong-number sends) | Same as today's cold-inbound behavior — Supabase row with null CRM fields, cleaned by existing session-housekeeping if any. Not a new concern. |
| Power Automate retry storm during outage | Each retry uses the same `sender_message_id`; dedup index absorbs them as 200 `duplicate`. No history pollution. |

## 11. Open Questions

Resolved during 2026-06-01 design review:

1. ~~**Header/footer variables**~~ — Resolved: header and footer are included in seeded content per §6.3. Headers and footers aren't critical for Tina's continuity context, but the registry handles them anyway since the cost is small and it future-proofs against templates that lean on header/footer copy.
2. ~~**Media-only templates**~~ — Resolved: all in-scope templates include a BODY component. The `no_template_body` response path was dropped. If a future template lacks a body, the handler will treat it as an unexpected case and surface a 500 — acceptable.
3. ~~**`resolveSender` extraction**~~ — Resolved: v1 calls the worker-local function as-is. Refactor deferred.
4. **Webhook for inbound-side messages** (external system echoing a client-sent message into WhatsApp) — Out of scope for v1. Flagged for future PRD if the need surfaces.
