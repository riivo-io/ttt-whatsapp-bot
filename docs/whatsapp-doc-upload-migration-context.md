# WhatsApp doc-upload migration — handoff context

Read this before starting work. Self-contained — you don't need the prior chat.

## The goal

Migrate WhatsApp doc uploads from the current annotation-only path to a **dual-write** path that produces real, structured doc rows visible to the rest of TTT's pipeline.

**Today (broken):** Client sends a doc via WhatsApp → bot stages it → on classify, [pendingUpload.service.ts](src/services/pendingUpload.service.ts) calls `dynamicsService.uploadDocument()` → writes an `annotations` (Note) row on the contact. The file is buried in the contact's timeline. Consultants can't find it. The `riivo_taxsubmissionsdocuments` entity never sees it. The bot's own Q4 "have you received my docs?" answer can't surface it.

**Target:** Each WhatsApp upload writes to **three** places:
1. **SharePoint** — file lands in the same per-client/per-year folder structure the email→Power Automate flow uses
2. **`riivo_taxsubmissionsdocuments`** — one row with: case lookup, preseason lookup (the new field — see CRM spec), client lookup, document type lookup (from OCR classification), `riivo_filereference` pointing at the SharePoint location, doc notes
3. **Annotations** — kept as a safety net during migration so legacy consultant workflows still work. Drop later once dual-write is proven.

## What already shipped (do not redo)

See [docs/tax-season-faq-crm-spec.md](docs/tax-season-faq-crm-spec.md) for the CRM side. On the bot side, the **5 tax-season FAQ tools** are wired and shipping:

- `get_refund_status`, `get_submission_status`, `get_required_documents`, `get_received_documents`, `get_audit_status` — all defined in [claude.service.ts](src/services/claude.service.ts), handlers in [taxFaq.service.ts](src/services/taxFaq.service.ts), gated by per-question env flags (`ENABLE_REFUND_ANSWERS`, etc).
- `get_received_documents` (Q4) currently reads `riivo_taxsubmissionsdocuments` rows for active cases. Once this migration lands, WhatsApp uploads will also show up there — Q4 becomes the test bed for whether the migration works end-to-end.

The 13 preseason doc-type triplets (per-type Bool + status + filename) are catalogued in [preseasonDocTypes.ts](src/utils/preseasonDocTypes.ts). `riivo_documenttype` is a lookup entity in CRM (not an OptionSet) — its values map to the same logical doc types.

## Decisions already locked

From a prior grill-me session — **do not re-litigate**:

| | Decision |
|---|---|
| A | Add explicit `_riivo_preseasondoc_value` lookup on `riivo_taxsubmissionsdocuments` (parent ↔ child). CRM admin task, already in spec. |
| B | Refund-nudge email via tina-bot ships in v1 (already done). |
| C | **Dual-write: annotation + SharePoint + `riivo_taxsubmissionsdocuments` row.** The "annotation only" option was rejected — kept as safety net only. |
| D | List all active cases when client doesn't specify year. |

Lifecycle: `riivo_preseasondocumentation` is the pre-case container. `new_case` is created only when ready to submit. `riivo_taxsubmissionsdocuments` rows can hang off **either** a preseason record (pre-case) or a case (post-case via `_riivo_case_value`, already on the entity).

OCR already classifies every doc; quality is decent but not 100%.

## Why this is hard

SharePoint folder structure is messy: **one folder per client per upload-year, not per case-year**. So a client could submit docs for 2024, 2025, and 2026 tax years all into the "2026" folder if they uploaded them in 2026. The new bot upload needs to follow whatever convention the email→Power Automate flow uses so consultants find the files in the same place. **Reverse-engineer that convention from the existing flow before writing the upload path.**

## Files you'll touch

**Read first to understand the current state:**
- [src/services/pendingUpload.service.ts](src/services/pendingUpload.service.ts) — the in-memory upload stager + current annotation write
- [src/services/dynamics.service.ts](src/services/dynamics.service.ts) `uploadDocument()` (~line 1315) — current annotation creator
- [src/services/sharepoint.service.ts](src/services/sharepoint.service.ts) — Graph-based SharePoint client; **has `listKbFiles` and `downloadFile` but NO `uploadFile` method yet**. You'll need to add one.
- [src/services/docExtractor.service.ts](src/services/docExtractor.service.ts) — current doc-text extractor; verify whether it already produces a doc-type classification or just text
- [src/services/taxFaq.service.ts](src/services/taxFaq.service.ts) `handleGetReceivedDocuments` — the consumer that needs to see new rows
- [src/workers/whatsappProcessor.ts](src/workers/whatsappProcessor.ts) — entry point; find where `savePendingUpload` is called

**Where the `save_document` tool dispatches:**
- [claude.service.ts](src/services/claude.service.ts) — search for `save_document` (~line 375 def, plus two dispatch sites). The flow is: client uploads file → bot detects `hasPendingUpload(phone)` → bot asks "what type?" → Claude calls `save_document` → handler calls `savePendingUpload()` which currently only writes annotations.

## Implementation plan (suggested ordering)

1. **Add `uploadFile()` to [sharepoint.service.ts](src/services/sharepoint.service.ts)**. Graph API: PUT to `/sites/{siteId}/drive/items/root:/{path}:/content`. Pattern follows the existing token-acquire / `authedHeaders` / `resolveSiteId` setup. Return the `webUrl` of the uploaded item — that's what goes into `riivo_filereference`.

2. **Find the email-flow folder convention.** Look at a real `riivo_taxsubmissionsdocuments` row that came from email + Power Automate (the user shared one earlier — `riivo_filereference: null` was in that sample which is interesting — verify the field actually carries the SharePoint URL in production rows). Check whether the folder is keyed by client name, contact GUID, tax year, etc. **Ask the user if unclear — don't guess.**

3. **Extend doc-type classification.** Find or add code that maps OCR output → a `riivo_documenttype` lookup GUID. This lookup probably has an entity called `riivo_documenttypes` — query it once at startup, cache the name → GUID map. The bot's existing `save_document` tool has an enum of doc types (IRP5, IT3(a), IT3(b), Payslip, Medical Certificate, Till Slip / Receipt, Logbook, ID Document, Bank Statement, Tax Certificate, Other) — these are the labels you need to resolve to GUIDs.

4. **Add `dynamicsService.createTaxSubmissionDocument(params)`** in [dynamics.service.ts](src/services/dynamics.service.ts) alongside the existing `uploadDocument()`. Payload:
   - `_riivo_client_value@odata.bind` → contact
   - `_riivo_case_value@odata.bind` → active case (if one exists for the tax year)
   - `_riivo_preseasondoc_value@odata.bind` → preseason record (the NEW lookup; only after admin adds it)
   - `_riivo_documenttype_value@odata.bind` → doc type GUID
   - `riivo_taxyear` → option-set int (the case OptionSet uses `ttt_taxyear` with `100000000 + (year - 2020)` scheme; for taxsubmissionsdocuments it's `riivo_taxyear` — verify the option-set values)
   - `riivo_filereference` → SharePoint webUrl
   - `riivo_documentnotes` → OCR confidence / extracted summary if useful

5. **Refactor `savePendingUpload()`** in [pendingUpload.service.ts](src/services/pendingUpload.service.ts) to call: SharePoint upload → doc-type classify → create taxsubmissionsdocuments row → THEN write annotation (unchanged as safety net). All three writes inside one try/catch; failures of the new path should not block the annotation fallback.

6. **Update Q4 handler** in [taxFaq.service.ts](src/services/taxFaq.service.ts) to no longer warn "WhatsApp uploads aren't visible to Q4 until v2" — they will be visible now.

7. **Bench-test:** upload an IRP5 via WhatsApp; verify (a) file lands in SharePoint, (b) row appears in `riivo_taxsubmissionsdocuments` with the right links, (c) `get_received_documents` lists it within a minute.

## Open questions to resolve before coding

1. **SharePoint folder structure** — the user said folders are per-client/per-upload-year, not per-case-year. Need exact path template the email flow uses. Example: `/{client-fullname}/{upload-year}/{filename}`? `/{contact-id}/{tax-year}/`? Ask the user or inspect existing files.
2. **`riivo_filereference` format** — full Graph webUrl, sharing link, relative drive path, or something else? Inspect an existing populated row.
3. **`riivo_taxyear` OptionSet** on `riivo_taxsubmissionsdocuments` — what's the int↔year mapping? Sample row had it null, so worth confirming what production rows look like.
4. **Which `_riivo_case_value` to use when multiple active cases exist?** If the client uploads a generic IRP5 and has both a 2024 and 2025 active case, which one do you link? Options: (a) leave null and let consultant attach, (b) link to most recent, (c) infer from doc content if OCR captures a year. Default suggestion: leave null + populate `_riivo_preseasondoc_value` only.
5. **Doc-type entity name** — confirm whether it's `riivo_documenttype` (singular) or `riivo_documenttypes` (plural) for the collection. The lookup field `_riivo_documenttype_value` suggests entity logical name `riivo_documenttype`, collection name typically `riivo_documenttypes`.

## What to AVOID

- Don't replace the annotation write — it's a safety net during migration. Keep it.
- Don't introduce a new shared types file. Use existing `dynamicsService` patterns (private helpers calling `crmPost` / `searchEntity` / `getList`).
- Don't try to fix the SharePoint folder messiness as part of this work. Match whatever the email flow does, even if ugly. Folder refactor is a separate project.
- Don't add prompt engineering or change the `save_document` tool's schema. The bot already knows how to invoke it; we're just changing what happens after.

## Reading order on day one

1. This file
2. [docs/tax-season-faq-crm-spec.md](docs/tax-season-faq-crm-spec.md) — §2.3 explains the `_riivo_preseasondoc_value` lookup that needs to exist
3. [src/services/pendingUpload.service.ts](src/services/pendingUpload.service.ts) — start here, it's tiny
4. [src/services/sharepoint.service.ts](src/services/sharepoint.service.ts) — see what's missing (upload method)
5. The `save_document` handler in [claude.service.ts](src/services/claude.service.ts) (search the file)
6. An existing `riivo_taxsubmissionsdocuments` row in production (ask user to share another sample if one of those email-uploaded rows is needed for reference)
