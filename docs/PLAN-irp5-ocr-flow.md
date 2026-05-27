# Implementation plan: IRP5-first document flow

Companion to [docs/irp5-ocr-field-mapping.md](irp5-ocr-field-mapping.md). This is the step-by-step build plan for the new "ask for IRP5 first, OCR it, advise on what else we need" flow.

## TL;DR

Mirror the existing LoE pattern. Add an IRP5 extractor service alongside [src/services/loe-extractor.service.ts](../src/services/loe-extractor.service.ts), a new `upload_irp5` Claude tool alongside `upload_letter_of_engagement`, and two new Dynamics helpers (`getIrp5RecordsForClient`, `createIrp5Record`). Wire the trigger into the post-LoE message for new clients and into the inbound greeting for returning clients.

## What we're keeping vs. building new

| Component | Reuse / new |
|---|---|
| File ingestion (`extractIncoming` → `stagePendingUpload`) | **Reuse** as-is |
| Mistral OCR ([src/services/mistral.service.ts](../src/services/mistral.service.ts)) | **Reuse** as-is |
| SharePoint upload ([src/services/sharepoint.service.ts:256](../src/services/sharepoint.service.ts#L256)) | **Reuse** `uploadDocumentFile` |
| `riivo_taxsubmissiondocuments` row creation ([src/services/dynamics.service.ts:1516](../src/services/dynamics.service.ts#L1516)) | **Reuse** `createTaxSubmissionDocument` with `canonicalDocType='IRP5'` |
| Claude tool-use extraction pattern | **Reuse** structure from LoE extractor |
| IRP5 extractor service | **New** — `src/services/irp5-extractor.service.ts` |
| `riivo_irp5s` CRUD | **New** — two helpers on `dynamics.service.ts` |
| Source-code → implied-docs advice with dedupe | **New** — helper on `requiredDocuments.service.ts` |
| `upload_irp5` Claude tool | **New** — added to `claude.service.ts` |
| Post-LoE / returning-client IRP5 prompt | **New** wiring in `whatsappProcessor.ts` |

## Architecture sketch

```
WhatsApp inbound (PDF/image)
        │
        ▼
extractIncoming() ───► stagePendingUpload(buffer, mime, filename)
        │
        ▼
Claude system prompt determines it's an IRP5
        │
        ▼
calls tool: upload_irp5
        │
        ├─► sharepoint.uploadDocumentFile()  ─► webUrl
        ├─► dynamics.createTaxSubmissionDocument(canonicalDocType='IRP5', fileRef=webUrl)
        ├─► mistral.ocrDocument(buffer)      ─► markdown
        ├─► irp5Extractor.extract(markdown)  ─► structured fields + sourceCodes[]
        ├─► dynamics.createIrp5Record(extracted, contactId, filename, webUrl)
        └─► requiredDocs.computeMissingDocsForClient(contactId, sourceCodes)
                │
                ▼
        Returns advice text → Tina sends WhatsApp follow-up
```

## Build order

### Phase 1 — Data layer (no user-facing change)

1. **`dynamics.service.ts: getIrp5RecordsForClient(contactId, assessmentYear)`**
   - Query: `riivo_irp5s?$filter=_riivo_client_value eq <contactId> and riivo_assessmentyearint eq <year>`
   - Returns the list (possibly empty) of IRP5 records for that client + year. Used both for skip-logic and for the "client has multiple jobs" union.

2. **`dynamics.service.ts: createIrp5Record(params)`**
   - Params: `contactId`, `assessmentYear`, `filename`, `sharepointUrl`, plus every field from [docs/irp5-ocr-field-mapping.md](irp5-ocr-field-mapping.md).
   - Uses `riivo_Client@odata.bind` per [memory/dynamics_odata_bind](../[[dynamics_odata_bind]]).
   - Returns `{ recordId }`.

3. **`requiredDocuments.service.ts: computeMissingDocsForClient(contactId, sourceCodes)`**
   - Calls existing `computeRequiredDocuments(sourceCodes, industry, today)`.
   - Fetches existing `riivo_taxsubmissiondocuments` rows for this contact + current tax year.
   - Returns the doc list minus anything whose `riivo_taxsubmissionsdocument` matches an already-uploaded canonical type. This is what Tina actually asks for.

### Phase 2 — Extraction service

4. **`src/services/irp5-extractor.service.ts`**
   - Public method: `extractIrp5Fields(ocrMarkdown: string): Promise<Irp5ExtractedFields>`
   - Internally: Claude tool-use call with a single tool whose input schema matches the field mapping doc.
   - Tool schema groups:
     - **Header**: certificateNumber, employerTradingName, idNumber, dob, incomeTaxRefNo, citytown, suburbdistrict, certificateType, reconciliationPeriod, assessmentYear, taxPeriodStart, taxPeriodEnd, periodsWorked, reasonForNonDeduction
     - **Income amounts** (one per priority code listed in the mapping doc): incomePaye, annualPaymentPaye, commissionPaye, taxableTravelRemuneration, reimbursedTravelAllowance, nonTaxableSubsistenceAllowance, otherAllowancesPaye, employeeDebt, generalBenefits, useOfMotorVehiclePaye, medicalAidEmployerContributions, employerPensionContributionPaye, employerProvidentFundContributions, generalFringeBenefitsPaye, payeOnLumpSumBenefit, grossTaxableIncome, grossNonTaxableIncome
     - **Deductions**: totalPensionFundContributions, totalProvidentFundContributions, medicalAidContributions, raContributions, currentArrearProvidentFundContributions, payeAmount, medicalSchemeTaxCredit, uifContribution, sdlContribution, totalTaxSdlAndUif, bargainingCouncilContributionPaye, totalDeductionsContributions
     - **`sourceCodes: string[]`** — every 4-digit code seen on the cert. This drives the advice engine even when there's no dedicated field.
   - Returns an empty object if OCR markdown is blank (same defensive pattern as LoE extractor).

### Phase 3 — Orchestration tool

5. **`claude.service.ts: tool definition `upload_irp5`**
   - Inputs: `confirmedByUser: boolean` (matches the existing LoE pattern — only fires once Tina has confirmed with the client that this is their IRP5).
   - Behaviour:
     1. Pull staged file from `pendingUploads`.
     2. Upload to SharePoint via `uploadDocumentFile`.
     3. Create `riivo_taxsubmissiondocuments` row with `canonicalDocType='IRP5'`.
     4. OCR via Mistral.
     5. Extract via `irp5Extractor`.
     6. Create `riivo_irp5s` row.
     7. Call `computeMissingDocsForClient` with the union of source codes from this IRP5 + any prior IRP5s for the same assessment year.
     8. Return to the model: `{ employerName, assessmentYear, sourceCodesFound, missingDocs[] }`.
   - The model uses that payload to compose the WhatsApp reply naturally — "Got your IRP5 from <employer> for <year>. Looks like next I'll need your logbook..."

### Phase 4 — Trigger wiring

6. **`whatsappProcessor.ts` post-LoE message** (currently [whatsappProcessor.ts:452](../src/workers/whatsappProcessor.ts#L452))
   - After the existing "Awesome, thank you!" message, append: *"While we wait on the SARS OTP step, the next thing I need from you is your latest IRP5 — that's the certificate your employer issues every tax season. Just send through the PDF when you have it."*
   - This makes the IRP5 ask parallel to the OTP wait, as agreed.

7. **Returning-client check on inbound (new)**
   - Hook point: where Tina builds the system prompt for a known contact (the same place that already reads `riivo_loereceived` and `riivo_efilingotpcompleted` per [memory/onboarding_two_gates](../[[onboarding_two_gates]])).
   - Add: lookup `getIrp5RecordsForClient(contactId, currentAssessmentYear)`. If empty AND it's tax season (≥ March of the assessment year), inject a hint into the system prompt: *"Client has no IRP5 on file for the {{year}} tax year. Open with a greeting and ask for their latest IRP5."*
   - Tina then phrases it naturally rather than firing a canned message.

8. **System-prompt updates**
   - Add the "IRP5 first, one doc at a time, don't overwhelm" rule.
   - Add the "if a non-IRP5 doc arrives first, accept and store it, then still ask for the IRP5" rule.
   - Add the "after IRP5 received, use the tool's `missingDocs` list to ask for what's next, one doc at a time" rule.

### Phase 5 — Manual verification (no automated tests in v1)

Following the `verify` skill pattern from [memory/test_setup](../[[test_setup]]):

- Start local server on `:3001`, ngrok tunnel up.
- Send a sample IRP5 PDF to the test number.
- Confirm in Dynamics:
  - New `riivo_taxsubmissiondocuments` row with `riivo_taxsubmissionsdocument='IRP5'` and SharePoint URL
  - New `riivo_irp5s` row linked to the contact, populated per the mapping doc
- Confirm the WhatsApp reply lists the right follow-up docs (commission earner → logbook + till slips).
- Edge cases to manually try: (a) photo of IRP5 not PDF, (b) wrong-year IRP5, (c) non-IRP5 doc sent first, (d) second IRP5 from a different employer.

## Key decisions baked into this plan

- **No automated tests in v1.** Manual verification only. This project doesn't have a test harness for the worker flow; adding one is out of scope.
- **No `riivo_confidence` population in v1.** Per earlier decision.
- **Tax year source of truth.** Use `getCurrentSaTaxYear()` from `requiredDocuments.service.ts` for the "which assessment year do we ask about" question. Ignore the `CURRENT_TAX_SEASON_YEAR` env var for the IRP5 flow — date-based logic is more robust than a manually-set env. (Existing code that uses the env keeps working; we just don't depend on it here.)
- **Multi-employer.** Union approach. Each IRP5 creates its own `riivo_irp5s` row; the advice engine unions all source codes across rows for the current year.
- **Dedupe.** Use `riivo_certificatenumber` as the dedupe key. If a client re-sends the same IRP5, we update the existing row instead of creating a duplicate.

## Risks / things to watch

1. **OCR accuracy on photos.** PDFs are clean; phone-camera photos of paper IRP5s less so. Mistral handles both but field-level extraction will be lossier. Acceptable for v1.
2. **Multi-page IRP5s.** Rare but exist (when there are many source codes). Mistral OCR returns per-page markdown; the extractor concatenates before calling Claude.
3. **`saved_document` tool overlap.** There's an existing generic `save_document` tool. We need clear system-prompt rules so the model picks `upload_irp5` for IRP5s and `save_document` for everything else, rather than double-handling.
4. **Out-of-season IRP5s.** Clients sometimes send last year's IRP5. The extractor returns `assessmentYear`; if it doesn't match `getCurrentSaTaxYear()`, the tool returns a warning in its payload and Tina asks the client to confirm.
5. **The advice map for code 3606 is currently thin.** Logbook + till slips only. Post-v1, the tax team should beef it up to include home-office / comms / stationery for commission earners. Out of scope for this PR.

## What this PR does NOT do

- Doesn't backfill historical IRP5s already in `riivo_taxsubmissiondocuments` into `riivo_irp5s`.
- Doesn't add an admin UI to review extractions before write — they go straight to CRM.
- Doesn't change the LoE flow.
- Doesn't add new SARS source codes to `requiredDocuments.service.ts` beyond what's already there.

## Estimated scope

Roughly 4 source files touched + 1 new file + 1 new method on each of 2 existing services. Probably 300–500 lines of TS, dominated by the extractor service's tool-schema definition.
