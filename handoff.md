# RALPH Handoff — Document-requirements guide (current) / Tool-registry migration (complete)

> ⚠️ **This handoff MUST be updated at the end of every iteration.** Before you
> finish, record what you did, move the completed issue out of "Next issues",
> and re-point the "Next issues" list at whatever remains. Leaving this doc
> stale breaks the next agent's pickup. This requirement is itself part of the
> definition of done for every issue.

## Done this iteration: Doc-guide Issue 01 — guide verbatim snapshot + ADR 0002 addendum

PRD: `docs/PRD-document-requirements-guide.md` · ADR `docs/adr/0002-document-collection-journey.md`
Issue file: `.scratch/doc-requirements-guide/issues/01-guide-snapshot-and-adr-addendum.md`
(now `Status: done`). Committed `9eb35f2` (local only — not pushed).

Foundation slice of the doc-requirements-guide PRD. **Docs only — no behaviour change** to
`buildDocRecommendation()` or its tests. Establishes the consultants' SharePoint
document-requirements guide as the in-repo source of truth the kernel data slices (Issues 02-04)
encode against.

### What changed (Issue 01)

- **`docs/document-requirements-guide.md`** (new) — the guide as a **dated 2026-tax-year snapshot**
  (assessment period `01/03/2025 – 28/02/2026`, left **literal** per the PRD; the kernel derives
  live periods itself). Scenario sections: baseline (everyone), commission 3606, travel 3701,
  company-car 3802, rental income, foreign income — each with line-item docs + reasons, honouring
  the guide's "if applicable / if you want to claim" framing.
- **`docs/adr/0002-document-collection-journey.md`** — addendum: guide is authoritative (guide
  wins on disagreement, kernel rewritten to match); new code/topic mappings listed (3606/3701/3802,
  `foreign_income`/`rental_income` topics); **manual-sync-point** note (same posture as the manually
  applied Supabase migrations). No new ADR — architecture is unchanged.

### Source-of-truth caveat (READ before trusting byte-for-byte fidelity)

The literal SharePoint `.docx` was **not reachable** from this session's account
(`luc@riivo.io` → the M365 search resolves riivo's tenant, not TTT's consultants' guide). The
snapshot was therefore **transcribed faithfully from the approved PRD's scenario-by-scenario
content** plus the live doc vocabulary in `src/utils/preseasonDocTypes.ts`. It is faithful to the
PRD, not verified byte-for-byte against the original SharePoint file. **If a human can pull the
real `.docx`, diff it against `docs/document-requirements-guide.md` and reconcile** before the
kernel slices (02-04) lean on it as gospel. The per-table code-comment pointers back to the
snapshot are deferred to Issues 02-04 (they touch each table).

### Verification (Issue 01)

- `./node_modules/.bin/tsc --noEmit` → clean
- `npm test` → 216/216 pass (unchanged — no code touched)

### Commit hygiene

Staged **only** the two Issue-01 files (`git add docs/document-requirements-guide.md
docs/adr/0002-document-collection-journey.md`). The working tree still carries the large blob of
unrelated uncommitted work (doc-collection journey Issues 25/26/27, bad-debt, the uncommitted
tool-registry slices 2-7, and several untracked `docs/*.md`) — do NOT `git add -A`.

## Done this iteration: Doc-guide Issue 03 — baseline relabel + rental industry upgrade

Issue file: `.scratch/doc-requirements-guide/issues/03-baseline-relabel-and-rental-upgrade.md`
(now `Status: done`). **Not committed** (working tree is shared with the in-flight Issue 02 — see
below). Two small, independent guide-data edits to existing kernel tables in
`src/domain/docRecommendation.ts`, plus tests through `buildDocRecommendation()`.

### What changed (Issue 03)

- **`BASELINE_DOCS`** — relabelled `IT3(b) — interest earned` → **`Investment tax certificates
  (IT3(b)/IT3(c))`** (reason aligned to the guide: "declare the interest and investment income…").
  The `IT3(b)` hint stays in parentheses; verified an uploaded `"IT3(b)"` still loose-matches and
  lands in `received` (normalises to `…it3`, which the label's normalised form `investment tax
  certificates it3` includes). Other three baseline items unchanged. Added a guide-pointer comment
  (→ `docs/document-requirements-guide.md` §Everyone).
- **`INDUSTRY_DOCS` `rental|landlord|property` entry** — replaced the 5-item set with the guide's
  full 7-item set, each with a reason: lease agreement(s), bank statement showing rent received,
  bond statement (incl. bond interest), rates & levies, maintenance & repairs receipts, insurance,
  agency commission paid. Rides the existing industry trigger — no new wiring. Added a guide-pointer
  comment (→ §Rental income).
- **`test/unit/docRecommendation.test.ts`** — appended an "Issue 03" section (3 tests): exact
  no-code baseline list (no bank statements / no ID), `IT3(b)` received loose-match, full rental set
  with reasons. Appended at end-of-file to stay merge-friendly with Issue 02's concurrent edits.

### Verification (Issue 03)

- `./node_modules/.bin/tsc --noEmit` → clean.
- The 3 Issue-03 tests pass (`--test-name-pattern="Issue 03"` → 3/3).
- **Full `npm test` shows 2 failures — both are the 3701 travel tests, owned by Issue 02, not 03.**
  The Issue 02 agent (running concurrently in another window) has already edited the SHARED working
  tree: `SOURCE_CODE_FORMS` now triggers on `3606`/`3802` and has dropped `Vehicle purchase / lease
  agreement` from `supersedesDocLabels` (per the guide it's a loose doc alongside the form), which
  breaks the old `form-supersedes-doc: travel allowance (3701)` and `includeForms:false` tests. Those
  are Issue 02's to update. My changes don't touch any vehicle/source-code/form table.

### Commit hygiene (READ — shared tree with live Issue 02)

This working tree is being edited LIVE by the Issue 02 agent. `docRecommendation.ts` already carries
Issue 02's in-flight `SOURCE_CODE_DOCS`/`SOURCE_CODE_FORMS` changes intermixed with my baseline/rental
edits. **Do not `git add docRecommendation.ts` whole** until Issue 02 has landed and its tests are
green — you'd sweep half-finished Issue-02 work into an Issue-03 commit. The clean Issue-03 hunks are:
the `BASELINE_DOCS` relabel + its comment, the `INDUSTRY_DOCS` rental block + its comment, and the
appended "Issue 03" test section. Stage those surgically (same patch-staging method noted for the
tool-registry slices below), or just let 02 and 03 land together once both are green.

## Done this iteration: Doc-guide Issue 02 — vehicle & commission source codes (3606/3701/3802)

Issue file: `.scratch/doc-requirements-guide/issues/02-vehicle-commission-source-codes.md`
(now `Status: done`). **Not committed** (shared working tree with Issue 03 — see hygiene note above).
Largest behaviour change of the PRD: the three vehicle/commission scenarios in
`src/domain/docRecommendation.ts` now match the guide line for line, all driven through
`buildDocRecommendation()`. The 2 red tests Issue 03 flagged are now rewritten and green.

### What changed (Issue 02)

- **`SOURCE_CODE_FORMS` — Vehicle Detail Sheet** — `sourceCodes` now also triggers on `3606` + `3802`
  (was travel-only). Reason made **generic** (shared across travel / commission-vehicle / company-car
  clients, so it no longer says "you've got a travel allowance"). `supersedesDocLabels` now folds in
  **Service records** + **Leave dates**, and **dropped `Vehicle purchase / lease agreement`** — the
  guide asks for the purchase agreement as a *loose doc alongside* the form, not superseded by it.
  Added a guide-pointer comment (→ §3606/§3701/§3802).
- **`SOURCE_CODE_DOCS['3606']`** (commission) — rewritten: dropped IRP5 (baseline) + logbook/till-slips
  (folded into the two forms). Now only the loose docs neither form captures — **vehicle purchase
  agreement, vehicle finance statements, vehicle insurance policy schedule, bank statements (cheque/
  savings/credit card)** — each carrying a **conditional reason** ("only if you want to claim …"). Both
  forms (Vehicle Detail Sheet + Commission Earner Expenses List) now come from `SOURCE_CODE_FORMS`.
- **`SOURCE_CODE_DOCS['3701']`** (travel) — rewritten to the guide list: **vehicle purchase agreement**
  as a loose doc; **service records** + **leave dates** listed but folded into the form via
  supersession (they resurface only under `includeForms:false`). Dropped IRP5 (baseline) and the old
  logbook/fuel items.
- **`SOURCE_CODE_DOCS['3802']`** (company car) — **new** entry: one genuinely new doc, the
  **fringe-benefit letter from your employer**. Medical/RA/investment are NOT duplicated — baseline
  only. The Vehicle Detail Sheet form leads (via the 3802 trigger added above).
- **`{taxYearRange}` token interpolation** — `buildDocRecommendation()` now computes `taxYear` once and
  interpolates a `{taxYearRange}` token in any form/doc reason with `taxYear.rangeText` (used by the
  3606 bank-statements reason — period stays correct year-on-year, never hardcoded).
- **IRP5 extractor** — confirmed `3802` already surfaces: the forced-tool prompt lists "every visible
  4-digit code" and `3802 → riivo_useofmotorvehiclepaye` is in `CODE_TO_COLUMN`. **No fix needed.**
  Added `test/unit/irp5Extractor.test.ts` asserting the pure round-trip
  (`inferSourceCodesFromIrp5Row` surfaces 3802 from a non-zero use-of-motor-vehicle column, and not
  otherwise).
- **`test/unit/docRecommendation.test.ts`** — rewrote the 2 old 3701 tests (purchase agreement now
  present; `includeForms:false` resurfaces service records/leave dates) and added 3606 (both forms +
  conditional loose docs + interpolated range), 3802 (form + fringe letter + no medical/RA dup),
  combined `[3606,3701]` dedupe, and received/client-stated diversion tests.

### Verification (Issue 02)

- `./node_modules/.bin/tsc --noEmit` → clean.
- `npm test` → **226/226 pass** (includes Issue 03's tests, now both slices green together).

## Done this iteration: Doc-guide Issue 04 — foreign + rental `topic` path

Issue file: `.scratch/doc-requirements-guide/issues/04-foreign-and-rental-topic-path.md`
(now `Status: done`). **Not committed** (shared working tree with Issues 02/03 — same hygiene note;
do NOT `git add docRecommendation.ts` whole). The only real new wiring in this PRD: an optional
`topic` threaded tool → service → kernel, plus a `TOPIC_DOCS` table. Dependencies (Issue 03 rental
upgrade, Issue 02 `{taxYearRange}` interpolation) were already in the tree, so 04 layered cleanly.

### What changed (Issue 04)

- **`src/domain/docRecommendation.ts`** —
  - New `DocTopic = 'foreign_income' | 'rental_income'` + **`TOPIC_DOCS`** table (guide-pointer comment
    → §Foreign income / §Rental income). `foreign_income` = proof-of-income (reason uses the
    `{taxYearRange}` token) + passport-with-stamps (the 183-day / 60-consecutive / R1.25m exemption
    reasoning lives **inside the reason string only** — never a standalone advice item). `rental_income`
    is a **getter that returns the rental `INDUSTRY_DOCS` entry by reference** (resolved via
    `e.match.test('rental')`), so the topic and the industry trigger can never drift — **one list, not
    two**. This is what made 04 robust to Issue 03's concurrent edits: I never copied the rental array.
  - `DocRecommendationInput` gained optional `topic`; `DocRecommendation` gained `matchedTopic`
    (`DocTopic | null`). `buildDocRecommendation` unions `topicDocs` after industry / before baseline,
    deduped by the existing `seen` set (a landlord who also discloses rental income sees the rental docs
    once), and counts a topic toward `hasPersonalisation`.
- **`src/services/requiredDocuments.service.ts`** — `computeRequiredDocuments` gained an optional
  `topic` param + a `byTopic` bucket reading `TOPIC_DOCS`; `RequiredDocumentsResult` gained
  `byTopic` + `matchedTopic`. **Also added `{taxYearRange}` interpolation here** (against the
  `today`-derived year) — the live `get_required_documents` path renders reasons directly, so this both
  surfaces the foreign-income period AND fixes a latent leak of the 3606 token Issue 02 introduced on
  this path. `formatRequiredDocumentsMessage` renders a "*Based on what you told me:*" topic section.
- **`src/services/taxFaq.service.ts`** — `handleGetRequiredDocuments` accepts `topic`, threads it into
  `computeRequiredDocuments`, and includes `byTopic` in `allExpected`. (This is the live path the tool
  actually calls — `get_required_documents` → `taxFaq` → `computeRequiredDocuments`, NOT
  `computeMissingDocsForClient`. The PRD's "service" = `computeRequiredDocuments`.)
- **`src/services/tools/{registry,clientTools}.ts`** — `TaxFaqPort.getRequiredDocuments` param gained
  `topic?: 'foreign_income' | 'rental_income'` (union inlined to keep the registry domain-import-free);
  the `get_required_documents` tool gained a `topic` enum arg + `parseDocTopic`, and its description now
  tells Claude to pass the topic when a client discloses foreign / rental income in chat. No
  `claude.service.ts` change — the Port adapter is `handleGetRequiredDocuments` and the extra param
  threads through automatically.
- **`test/unit/docRecommendation.test.ts`** — appended an "Issue 04" section (6 tests, through
  `buildDocRecommendation()`): foreign docs + exemption reasons + docs-only; rental-without-industry;
  topic-mirrors-industry-exactly; later-year period derivation (no hardcoded 2026, token interpolated);
  received/client-stated diversion for topic calls; no-topic unchanged (`matchedTopic` null).

### Verification (Issue 04)

- `./node_modules/.bin/tsc --noEmit` → clean.
- `npm test` → **232/232 pass** (226 prior + 6 new Issue-04 tests).

## Next issues — Doc-requirements-guide PRD: NONE. All slices (01–04) are done.

The PRD `docs/PRD-document-requirements-guide.md` is fully encoded: the guide's baseline, vehicle /
commission source codes (3606/3701/3802), rental industry set, and the foreign / rental `topic` path
all live in `src/domain/docRecommendation.ts` with guide-pointer comments back to
`docs/document-requirements-guide.md`. Every table now carries its code-comment pointer.

**Commit strategy is the open item.** Issues 02/03/04 are all uncommitted in a shared, entangled
working tree (intermixed with the older doc-collection journey 25/26/27 + bad-debt + tool-registry
slices 2–7 — see the cautions below). `docRecommendation.ts`, `requiredDocuments.service.ts` and
`test/unit/docRecommendation.test.ts` carry hunks from multiple slices at once, so none can be
`git add`ed whole per-slice. Decide a commit strategy (most likely: commit the doc-guide PRD work
02+03+04 together as one coherent change, surgically excluding the unrelated journey/bad-debt/
tool-registry hunks) before layering more on these files.

---

## Prior project: Tool-registry migration — COMPLETE

## Done: Issue 7 — Delete the legacy dispatch chains (FINAL slice)

PRD: `docs/PRD-tool-registry.md` · ADR `docs/adr/0003-tool-registry-dispatch.md` · Issue file:
`issues/07-tool-registry-delete-legacy-dispatch.md` (now `Status: done`). Builds on slices 1–6.

This is the **final teardown slice** of the strangler migration. Slice 6 had already collapsed both
dispatch sites to a single `runTool` call; this slice deletes the now-dead scaffolding around it.
**The Tool-registry migration is complete — there are no remaining issues.**

### What changed (Issue 7)

- **`src/services/tools/registry.ts`** —
  - `ToolEntry` gained a required **`description: string`** field (the Anthropic tool description,
    co-located with the handler).
  - **`legacyDispatch` removed** from `ToolContext`. `runTool` no longer falls back: an unknown tool
    name now `Promise.reject`s with `Unknown tool: <name>` (was `ctx.legacyDispatch(name, args)`).
  - Module + `runTool` docstrings updated to say the migration is complete.
- **`src/services/tools/{clientTools,staffTools,leadTools}.ts`** — every entry (40 Tools) gained its
  `description`, copied **byte-for-byte** from the old hand-maintained `TOOLS` array.
- **`src/services/claude.service.ts`** —
  - **`TOOLS` is now derived from `REGISTRY`**: `Object.values(REGISTRY).map(e => ({ name,
    description, input_schema }))`. The ~425-line hand-maintained array is gone. (Verified the
    derived array equals the old one exactly — name + description + schema, all 40 Tools.)
  - **`STAFF_TOOL_PERMISSIONS` map + its first-round defense-in-depth re-check loop deleted** — every
    gate it listed is already enforced by `runTool`/`entryAllowed` via each entry's `requiredPerm`
    (the `DENIED` constant is the same string the inline check returned).
  - **Both dispatch sites are now an unconditional `runTool(...)`** — the residual `if
    (REGISTRY[name])` guard, the `else if (!contactId)` "User context is missing" arm, and the
    `let functionResponse = "No data found."` seed are gone.
  - `legacyDispatch: async () => 'No data found.'` wiring removed from `toolCtx`.
- **`test/unit/toolRegistry.test.ts`** — replaced the legacy-fallback test with a hard-error test
  (`runTool` rejects on unknown name); added a registry invariant test (every entry has a non-empty
  `description` + an `input_schema` object); dropped the stale `legacyDispatch` from `buildCtx`.
  212 total (was 211).

### Verification (Issue 7)

- `./node_modules/.bin/tsc --noEmit` → clean
- `npm test` → 212/212 pass
- One-off equivalence check: the registry-derived `TOOLS` matched the deleted hand-maintained array
  byte-for-byte across all 40 Tools (name + description + input_schema).

---

## Prior iteration: Issue 6 — Lead onboarding + LoE Tools (final functional slice)

PRD: `docs/PRD-tool-registry.md` · ADR `docs/adr/0003-tool-registry-dispatch.md` · Issue file:
`issues/06-tool-registry-lead-onboarding-loe-tools.md` (`Status: done`). Built on slices 1–5
(see Prior context).

Slice 6 of the strangler migration. It moved the **last functional Tools on the legacy
chain**. The lead-State-B onboarding Tools the issue named (`upload_irp5`, `save_document`,
`escalate_to_taxcrew`) were already migrated in slice 4 (in `clientTools.ts`, carrying the `lead`
role; the State-B IRP5 restriction is `ctx.isStateBLeadUpload`). So the Tools moved that slice were:
`get_case_by_name` + the LoE trio (`upload_letter_of_engagement`, `confirm_loe_upload`,
`update_loe_field`) into `staffTools.ts`, and `verify_identity` into a **new `leadTools.ts`**.

### What changed (Issue 6)

- **`src/services/tools/registry.ts`** —
  - `EntityType` gained **`'unknown'`** (a phone-not-found caller). It's a real role now, not
    `undefined` — that's what lets `verify_identity` be role-derived instead of special-cased.
  - `DynamicsPort` gained six methods: `searchCaseByName`, `searchContactByIdNumber`,
    `linkPhoneToContact`, `checkLoeAlreadyReceived`, `uploadLoeFileToCrm`, `writeLoeFieldsToLead`.
  - **Two new narrow seams**: `LoeOcrPort` (`isConfigured` + `ocrDocument` from `mistral.service`,
    `extractBankingDetails` from `loe-extractor.service` — composed into one Port) on `ctx.deps.loeOcr`;
    and `PendingLoeState` on `ctx.pendingLoe` (`get`/`save`/`confirm`/`delete`/`updateField`) — the
    per-turn staged Supabase LoE review row, bound to the turn's session, mirroring `ctx.pendingUpload`.
    Plus an exported `LoeExtractedFields` type (the 16 OCR fields).
- **`src/services/tools/index.ts`** — imports `./leadTools`; re-exports `LoeOcrPort`,
  `LoeExtractedFields`, `PendingLoeState`.
- **`src/services/tools/staffTools.ts`** — `get_case_by_name` (gated `view_open_cases`) + the LoE trio
  (gated `upload_letter_of_engagement`) appended; module-level pure `formatLoeFields(row)` helper.
  Output strings + schemas byte-for-byte the legacy first-round originals.
- **`src/services/tools/leadTools.ts`** (new) — `verify_identity`, `roles: ['unknown']`, no
  `requiredPerm`; runs without a `contactId`.
- **`src/services/claude.service.ts`** —
  - `toolCtx.entityType` is now `entityType ?? 'unknown'`; added `ctx.pendingLoe` (bound to `sessionId`)
    and `ctx.deps.loeOcr` (composed mistral + loe-extractor closures).
  - removed `get_case_by_name` + the LoE trio from `STAFF_TOOL_PERMISSIONS` (gate now via `requiredPerm`).
  - offered-list logic collapsed: the inline `clientTools`/`staffTools`/`unknownTools` arrays are gone;
    each role branch is just `deriveOfferedTools(role, …)` (the lead branch still deletes `upload_irp5`
    for non-State-B leads; unknown → `deriveOfferedTools('unknown', …)` = `verify_identity`).
  - **both dispatch sites collapsed to a single `if (REGISTRY[functionName]) runTool(...)`**; deleted the
    `get_case_by_name`/LoE legacy branches, the inline `verify_identity` block, the `handleUploadLoe`/
    `handleConfirmLoe`/`handleUpdateLoeField`/`formatLoeFields` closures, and the
    `Tool ${name} executed.` follow-up stub.
- **`test/unit/toolRegistry.test.ts`** — +22 tests (211 total). Extended `fakeDynamics` (six methods);
  added `fakeLoeOcr` + `fakePendingLoe` wired into `buildCtx`; updated the `view_open_cases`
  expectations (now include `get_case_by_name`); added `deriveOfferedTools` for `'unknown'` +
  the LoE-trio perm; per-handler success/error coverage for `get_case_by_name`, `verify_identity`
  (found+link / not_found / runs-without-contactId / denied to known roles), and the LoE flow.

### Follow-up-loop unification + the `'unknown'` role (ADR 0003 Consequences)

`verify_identity` previously ran only in the **first** round (a round-2+ call fell through to
`No data found.` because the whole follow-up dispatch was gated on `contactId`). Now it dispatches
through `runTool` at both sites with no `contactId` gate. The vestigial offering of
`escalate_to_taxcrew` to unknown callers (it was in the old `unknownTools` array but always returned
`Error: User context (contactId) is missing.`) is dropped — it keeps `roles: ['client','lead']` and
is simply no longer offered to unknown callers, matching the UNKNOWN role prompt.

### Verification

- `./node_modules/.bin/tsc --noEmit` → clean
- `npm test` → 211/211 pass (189 prior + 22 new)

### Working-tree caution (READ THIS — the tree is heavily entangled)

The working tree carries a large blob of **uncommitted, interdependent** work from the
document-collection journey (Issues 25/26/27) **and** bad-debt collection, spanning
`claude.service.ts`, `pendingUpload.service.ts`, `whatsappProcessor.ts`, `dynamics.service.ts`,
`requiredDocuments.service.ts`, `taxFaq.service.ts`, `case.service.ts`, and more. None of it is
in HEAD. These changes are interdependent (e.g. `pendingUpload` renamed `missingDocs` →
`outstanding`, and `generateResponse` gained an 11th `badDebt` param) — reverting any one file in
isolation breaks `tsc`.

**Slice 1's commit (`52227ba`) staged ONLY the Issue-1 hunks** in `claude.service.ts`. The method
that worked: build the slice-only version on top of a clean `git checkout HEAD -- claude.service.ts`,
`git diff > slice.patch`, restore the full working tree, then `git apply --cached slice.patch`.
Do NOT `git add` the whole file — you will sweep the journey/bad-debt work into your commit.

**Slices 2–7 are NOT yet committed.** Slice 7 (this iteration) touches `claude.service.ts`
(deleted `STAFF_TOOL_PERMISSIONS` + its re-check loop, derived `TOOLS` from `REGISTRY`, removed
`legacyDispatch` wiring + the residual `else if (!contactId)` arm, both dispatch sites now bare
`runTool`). The clean slice-7 files —
`src/services/tools/{registry,clientTools,staffTools,leadTools}.ts`, `test/unit/toolRegistry.test.ts`,
`docs/adr/0003-*.md`, `issues/07-*.md`, `handoff.md` — can be `git add`ed whole; `claude.service.ts`
needs the surgical patch staging.

## Next issue — NONE. Tool-registry migration is COMPLETE.

Every Tool is a registry entry; both dispatch sites are a single `runTool` call; the offered list,
the permission gate, and the Anthropic `TOOLS` definitions are all derived from `REGISTRY`. There is
no legacy dispatch, no `STAFF_TOOL_PERMISSIONS` map, no hand-maintained `TOOLS` array. The seven
slices (Issues 1–7) of PRD `docs/PRD-tool-registry.md` are all done.

If picking up new work: the working tree still carries the uncommitted document-collection
(Issues 25/26/27) and bad-debt work described in the caution above — none of the tool-registry
slices 2–7 are committed either. Decide a commit strategy before layering more changes on
`claude.service.ts`.

## Environment note (read before running anything)

This machine uses **pnpm with a shared global store**. If `node_modules` is missing:

```
pnpm install --shamefully-hoist
```

`--shamefully-hoist` is **required**: without it, transitive `@types` aren't hoisted and
`tsc --noEmit` fails with `TS2688 Cannot find type definition file`.

Typecheck command (no `typecheck` npm script exists): `./node_modules/.bin/tsc --noEmit`
Tests: `npm test`

## Prior context (all complete)

- **Tool-registry slice 1** (Issue 1, committed `52227ba`): stood up the whole vertical seam —
  `src/services/tools/{registry,clientTools,index}.ts`, `runTool` + `deriveOfferedTools` +
  `DynamicsPort` + `ToolContext` + the strangler `legacyDispatch` fallback — and proved it on the
  three lowest-risk read-only client Tools (`get_my_details`, `get_tax_number`,
  `get_client_invoices`). ADR `docs/adr/0003-tool-registry-dispatch.md`; glossary in `CONTEXT.md`
  (§Tool, §Tool registry, §ToolContext, §Port).
- **Tool-registry slice 2** (Issue 2, NOT yet committed): the remaining nine read-only **client**
  Tools — `get_client_cases`, `get_outstanding_balance`, `get_my_consultant`,
  `get_my_referral_code`, and the five tax-season FAQ Tools (`get_required_documents`,
  `get_refund_status`, `get_submission_status`, `get_received_documents`, `get_audit_status`).
  Added `TaxFaqPort` + `userFullName` to `ToolContext`.
- **Tool-registry slice 3** (Issue 3, NOT yet committed): the seven staff read/lookup Tools
  (`get_my_clients`, `get_my_leads`, `search_contact_by_name`, `get_client_details`,
  `get_task_types`, `search_lead_by_name`, `get_industries`) in `src/services/tools/staffTools.ts`,
  proving the `requiredPerm` gate derivation.
- **Tool-registry slice 4** (Issue 4, NOT yet committed): the nine client document/action Tools
  (`get_invoice_pdf`, `request_consultant_callback`, `escalate_to_taxcrew`, `list_tax_forms`,
  `send_tax_form`, `opt_out_whatsapp`, `save_document`, `upload_irp5`, `mark_document_already_sent`).
  Added the `MetaPort`/`GraphMailPort`/`SupabasePort`/`FormsPort`/`Irp5Port` seam + the
  `ctx.pendingUpload` lift + `isStateBLeadUpload`.
- **Tool-registry slice 5** (Issue 5, NOT yet committed): the seven staff write Tools
  (`create_case`, `create_lead`, `create_contact`, `create_invoice`, `create_task`,
  `send_invoice_pdf`, `refer_friend`) in `staffTools.ts`. Added `PdfPort` + six write/lookup
  `DynamicsPort` methods. Slice 6 (this iteration) builds on all five.
- **Document-collection journey** (Issues 24–27): stateless, client-initiated, list-once,
  self-healing with an unverified escape hatch. PRD `.scratch/document-journey/PRD.md`, ADR 0002.
  Issue 24 is committed (`c3621d2`); 25/26/27 live in the working tree (see caution above).
- **Case-routing extraction** (Issues 19–21): the routing decision is a pure, tested domain
  module (`src/domain/caseRouting.ts`); the processor is a thin applier. Committed.
