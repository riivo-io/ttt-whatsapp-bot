# TTT WhatsApp Bot — Implementation Status

_Last reconciled against the codebase: 2026-04-17._

**Deep-dive docs:**
- [docs/leads-and-contacts.md](docs/leads-and-contacts.md) — what's live vs missing for leads & contacts
- [docs/meta-templates.md](docs/meta-templates.md) — Meta template inventory & submission tracker

Status legend: ✅ done · 🟡 partial · ❌ not started · ⏭️ out of scope

---

## Summary

| Phase | Scope | Status |
|---|---|---|
| 1 (Luc) | Vercel deploy, Meta migration, Claude SDK swap | ⏭️ out of scope here |
| A | Case lifecycle (Q2 metrics) | 🟡 functionally complete; metrics endpoint + Claude swap pending |
| B | Lead onboarding + staff intent gap-fill | 🟡 core tools live; drafts, workload, onboarding checklist missing |
| C | BSUID support | ❌ not started |
| D | Compliance (templates, STOP, POPIA) | 🟡 template inventory ready; submissions + code paths pending |
| E | Guardrails & security | ❌ not started (deliberately late) |
| F | E2E testing & go-live | 🟡 one test script in place |
| Cleanup | Remove dead code | ✅ done |

---

## Phase A — Case Lifecycle  🟡

**Done**
- ✅ Migration [supabase/migrations/20260417100000_case_lifecycle.sql](supabase/migrations/20260417100000_case_lifecycle.sql) — `whatsapp_cases` table + `sessions.pending_case_id`
- ✅ [src/services/case.service.ts](src/services/case.service.ts) — `qualifyMessage`, `createCase`, `classifyCase`, `recordBotResponse`, `handleFeedback`, `detectFeedback`, `handleTimeout`
- ✅ Dynamics mirror writes a **`riivo_request`** record (not legacy `new_cases`) via [dynamicsService.createRequest](src/services/dynamics.service.ts#L1089) — channel=WhatsApp, category=Tax, priority=Medium, linked via `riivo_Client@odata.bind`. `riivo_requestid` stored in `whatsapp_cases.crm_case_id`.
- ✅ Webhook integration in [src/controllers/webhook.controller.ts](src/controllers/webhook.controller.ts)
  - Timeout sweep fire-and-forget on every client inbound ([webhook.controller.ts:207-209](src/controllers/webhook.controller.ts#L207-L209))
  - Feedback routing via `pending_case_id` ([webhook.controller.ts:213-235](src/controllers/webhook.controller.ts#L213-L235))
  - Case create + classify fired in parallel with AI call ([webhook.controller.ts:244-260](src/controllers/webhook.controller.ts#L244-L260))
  - Interactive reply buttons on L1 answer ([webhook.controller.ts:286-294](src/controllers/webhook.controller.ts#L286-L294))
  - Escalation cases marked `escalated` ([webhook.controller.ts:298-300](src/controllers/webhook.controller.ts#L298-L300))
- ✅ [src/routes/cron.route.ts](src/routes/cron.route.ts) — `/api/cron/case-timeout` with `CRON_SECRET` auth
- ✅ [vercel.json](vercel.json) — daily cron at 02:00 UTC
- ✅ Meta interactive reply buttons in [src/services/meta.service.ts:54](src/services/meta.service.ts#L54)
- ✅ [test/test-case-lifecycle.ts](test/test-case-lifecycle.ts) seeded

**Pending**
- ✅ Classifier migrated to Claude (`claude-opus-4-7`) via forced-tool JSON — see [case.service.ts](src/services/case.service.ts). Revisit swapping to `claude-haiku-4-5` for cost once quality baseline is established.
- ❌ `getWeeklyMetrics({weekStart})` (story NEW-7) — not yet in `case.service.ts`
- ❌ `/api/metrics` endpoint or CSV export

---

## Phase B — Lead Onboarding + Staff Intent Gap-Fill  🟡

**Done**
- ✅ `create_task` / `create_contact` / `create_invoice` tools ([claude.service.ts:886, 920](src/services/claude.service.ts))
- ✅ `send_invoice_pdf` ([claude.service.ts:964](src/services/claude.service.ts#L964))
- ✅ `upload_letter_of_engagement` — 3-phase flow via [src/services/loe-extractor.service.ts](src/services/loe-extractor.service.ts) + [src/services/mistral.service.ts](src/services/mistral.service.ts) + [pending_loe_data migration](supabase/migrations/20260414100000_pending_loe_data.sql)
- ✅ `getStaffCases(userId)` in [src/services/dynamics.service.ts:314](src/services/dynamics.service.ts#L314)
- ✅ Role-based tool filtering ([claude.service.ts:738-763](src/services/claude.service.ts#L738-L763))
- ✅ `riivo_requestedservice` read by Dynamics (confirmed via grep)

**Pending**
- ❌ **Draft → confirm → write** pattern for `create_task` / `create_contact` / `create_invoice` — no `session.pending_create_payload` wiring
- ❌ `getStaffInvoices(userId)` in `dynamics.service.ts`
- ❌ `view_my_workload` tool (composes `getStaffCases` + `getStaffInvoices`)
- ❌ Supabase `lead_onboarding_checklist` table + seed per department
- ❌ `get_onboarding_status(lead_id)` tool
- ❌ `dynamicsService.convertLeadToContact(leadId)` — auto-conversion trigger (TTTFG-3191)
- ❌ Per-department welcome-message variant in `BASE_SYSTEM_PROMPT` ([claude.service.ts:47](src/services/claude.service.ts#L47))

---

## Phase C — BSUID Support  ❌

**All pending**
- ❌ Migration `supabase/migrations/20260425100000_bsuid_mapping.sql` — `user_identifiers` table
- ❌ Flag to Luc: add `riivo_whatsapp_bsuid` field to Dynamics Contact entity (no code-side schema change)
- ❌ Webhook `extractIncoming` to parse `user_id` (BSUID) alongside `wa_id` (phone)
- ❌ `resolveSender` ordering: BSUID → phone → Dynamics
- ❌ `requestPhoneForBsuid(bsuid)` first-time onboarding flow
- ❌ Session merge when BSUID + CRM match an existing phone-keyed session
- ❌ [test/test-bsuid.ts](test/test-bsuid.ts)

---

## Phase D — Compliance  🟡

**Done**
- ✅ Template inventory — [docs/meta-templates.md](docs/meta-templates.md) catalogues 9 active + 3 deferred templates with bodies, variables, and categories

**Pending**
- ❌ Submit templates to Meta Business Manager (TTTFG-3220) — **long-pole, start ASAP; inventory doc is ready to drive submissions**
- ❌ `metaWhatsAppService.sendTemplate(to, templateName, variables[])` (TTTFG-3224)
- ❌ 24-hour window detection — requires new `sessions.last_inbound_at` column
- ❌ **STOP keyword webhook intercept** (TTTFG-3229). Currently opt-out only goes through the AI tool [claude.service.ts:1552](src/services/claude.service.ts#L1552); need hard intercept at top of `processMessage` before Claude runs
- ❌ POPIA one-time notice on first-ever inbound — requires `sessions.popia_notified_at` column
- ❌ Extend `crm_audit_log` to cover every opt-in / opt-out event

---

## Phase E — Guardrails & Security  ❌

_Deliberately deferred until just before go-live._

**All pending**
- ❌ `src/services/logger.service.ts` — redaction wrapper (phone, SA ID, email, tax number) + mechanical `console.*` replacement
- ❌ `src/services/guardrails.service.ts`
  - `checkRateLimit` — session cap 25, daily cap 50, rapid-fire throttle
  - `maskOutput` — SA ID / tax / bank-account masking on outbound
  - `appendAdviceDisclaimer`
- ❌ Supabase `daily_message_counts(phone_number, day, count)` table
- ❌ Wire guardrails into `processMessage` (top-of-function rate check + pre-send output mask)
- ❌ [test/test-guardrails.ts](test/test-guardrails.ts)

---

## Phase F — Testing & Go-Live  🟡

**Done**
- ✅ [test/test-case-lifecycle.ts](test/test-case-lifecycle.ts)
- ✅ [test/simulate-webhook.ts](test/simulate-webhook.ts), [test/test-dynamics.ts](test/test-dynamics.ts), [test/get-metadata.ts](test/get-metadata.ts)

**Pending**
- ❌ `test/e2e-client-flows.ts` — all client tools
- ❌ `test/e2e-staff-flows.ts` — lead/contact/task/invoice/LOE
- ❌ `test/e2e-errors.ts` — blocked numbers, Meta/Claude/Dynamics failure paths
- ❌ Local load test (20 concurrent sessions)
- ❌ `docs/runbook.md` — common failures + on-call notes
- ❌ Metrics dashboard / `/api/metrics` endpoint
- ❌ Production smoke test with Luc + 1–2 staff

---

## Cross-cutting: Claude Migration (Phase 1d)  ✅

- ✅ [src/services/claude.service.ts](src/services/claude.service.ts) — main assistant + intent classifier now on Claude.
- ✅ `@anthropic-ai/sdk` replaces the previous LLM SDK in [package.json](package.json).
- ✅ `ANTHROPIC_API_KEY` in [.env.example](.env.example).
- ✅ [case.service.ts](src/services/case.service.ts) classifier — forced-tool JSON pattern.
- ✅ [loe-extractor.service.ts](src/services/loe-extractor.service.ts) — forced-tool JSON pattern.

---

## Cleanup (any phase)  ✅

- ✅ Deleted `src/services/clickatell.service.ts`
- ✅ Deleted `src/services/dynamics.service 2.ts` (accidental duplicate)
- ✅ Deleted `/convex/` folder
- ✅ Removed `convex` from [package.json](package.json) dependencies
- ✅ Updated `package.json` description
- ✅ Removed legacy `CLICKATELL_*` vars from `.env.example`

---

## Decisions already locked

- Feedback timeout: **12 hours** (see [case.service.ts:24](src/services/case.service.ts#L24))
- Timeout runner: **Vercel Cron daily + per-inbound fallback** (both live)
- Target models: `claude-sonnet-4-6` (chat/tools) + `claude-haiku-4-5` (classifier)
- Case granularity: **every qualifying inbound client message creates a case**
- Feedback delivery: **Meta interactive reply buttons** (live)

---

## Recommended next action

Start **Phase D template submissions now** (days/weeks to approve) in parallel with finishing Phase A metrics and beginning Phase B drafts-and-workload. Phase E stays last.
