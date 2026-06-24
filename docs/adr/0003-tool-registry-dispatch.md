# ADR 0003 — Claude tool dispatch is a Tool registry

Status: accepted · 2026-06-24

## Context

The 45 Tools the bot can invoke during a Claude turn were dispatched by a hand-written
`if/else` chain in `claude.service.ts` — written **twice** (the first Claude round and,
partially, the follow-up tool-call loop). For any one Tool, four facts lived in four
disconnected places: its Anthropic `input_schema` (top of the file), its handler (~2,000 lines
away), the offered-tools-per-role list, and the staff permission re-check. Adding or changing a
Tool meant editing several sites and hoping they stayed in sync.

None of it was unit-testable: `claude.service.ts` has no unit tests because there was no seam
below the Anthropic client — Tool behaviour was only ever exercised end-to-end through the
webhook against live Dynamics + Supabase.

See `docs/PRD-tool-registry.md` for the full problem statement and user stories.

## Decision

**Every Tool is one entry in a Tool registry** under `src/services/tools/`. An entry carries
`{ name, description, input_schema, roles, requiredPerm?, handle }` — description, schema, role
visibility, permission gate, and implementation are one thing in one place.

1. **Single dispatch site.** `runTool(name, args, ctx)` is called identically in the first
   round and the follow-up loop. There is no second, partially-duplicated dispatch.

2. **The registry is the single source of truth.** The offered-tools list (`deriveOfferedTools`,
   a pure function) and the staff defense-in-depth permission check (`entryAllowed`) are both
   *derived* from each entry's `roles` / `requiredPerm`. No second list is maintained.

3. **Dependencies are injected, not imported.** Handlers reach services only through `ctx.deps`
   — narrow **Ports** (`DynamicsPort`, …) exposing only the methods Tools actually call. The
   real service singletons satisfy a Port structurally (a typed assignment, no adapter class); a
   test passes a fake implementing only the subset under exercise. That seam is what makes a Tool
   testable with no Anthropic client mocked.

4. **ToolContext** is built once per turn in `claude.service.ts` and carries per-turn identity
   (`contactId`, `phoneNumber`, `sessionId`, `entityType`, `ownerFilter`), the shared client
   resolvers (`resolveClientId` / `resolveClientDetailed`), the permitted keys, and `deps`.

5. **Strangler migration (now complete).** During the migration `runTool` fell back to the
   legacy dispatch (via `ctx.legacyDispatch`) for any Tool not yet in the registry. Tools moved
   in small slices; the fallback and the legacy chain were deleted in the final slice (Issue 7).
   `runTool` now treats an unknown Tool name as a hard error. No Tool changed its schema, role
   visibility, permission, or output during the migration — this was a deepening, not a feature
   change.

6. **The Anthropic tool definitions are derived from the registry.** `claude.service`'s `TOOLS`
   array (the `{ name, description, input_schema }` list handed to the Anthropic API) is built
   from `REGISTRY`, not hand-maintained. Each entry carries its own `description`, so a Tool's
   schema, description, role visibility, permission gate, and handler are genuinely one thing in
   one place — there is no parallel array to drift out of sync.

## Alternatives considered

- **Keep the `if/else` chain, add tests around the webhook.** Rejected: the duplication and the
  four-places-per-Tool problem remain, and tests would still need live Dynamics/Supabase.
- **A dependency-injection framework / service locator.** Rejected as over-engineering: Ports
  are plain interfaces and `ctx.deps` is a plain object.
- **Migrate all 45 Tools in one pass.** Rejected in favour of strangler slices so each PR is
  small and independently verifiable.

## Consequences

- A new Tool is added by adding one registry entry; the offered list and permission gate update
  automatically.
- Tool behaviour is unit-testable in milliseconds through a fake Port (see
  `test/unit/toolRegistry.test.ts`).
- During migration the `input_schema` was briefly duplicated (registry entry + the `TOOLS` array
  that still supplied the Anthropic tool definitions and descriptions). That duplication is gone:
  the final slice (Issue 7) moved each Tool's `description` onto its registry entry and derives
  `TOOLS` from `REGISTRY`, so the schema + description live in exactly one place.
- **One pre-existing inconsistency was unified, not preserved.** The follow-up loop's
  `get_client_invoices` used a simpler first-match resolver (no ambiguous/error disambiguation,
  and it wrapped the client's own invoices in `{ client_id, client_name, invoices }`). The
  registry has one handler, so both sites now use the first-round behaviour (full
  `resolveClientDetailed` disambiguation; a client's own invoices return as a bare array). This
  is the canonical first-round contract; the follow-up path is reached only on a round-2+ tool
  call.
- **Slice 4 unified two more follow-up-loop inconsistencies.** (a) `get_invoice_pdf` had two
  divergent strings — the first round returned `Here's your invoice:` (and logged a `[PDF]` line),
  the follow-up loop returned `Here's the invoice:` (no log). The single registry handler uses the
  first-round version at both sites. (b) `request_consultant_callback`, `escalate_to_taxcrew`,
  `opt_out_whatsapp`, and `save_document` had **no** follow-up-loop branch at all — a round-2+ call
  to any of them fell through to the generic `Tool <name> executed.` stub instead of running. They
  now dispatch through `runTool` identically at both sites, so a follow-up-round call actually
  executes. Both are the canonical first-round contract; the follow-up path is reached only on a
  round-2+ tool call.

- **Slice 5 unified one more follow-up-loop inconsistency.** `create_case` had two
  divergent failure strings: the first round returned `Could not find a matching client.
  Please provide the client's full name.` / `Failed to create the case in CRM. Please try
  again.`, while the follow-up loop returned the terser `Could not find a matching client.`
  / `Failed to create the case in CRM.`. The single registry handler uses the first-round
  version at both sites. (The other six write Tools shared one handler closure across both
  sites already, so they had no divergence.) Canonical first-round contract, as above.

- **Slice 6 introduced the `'unknown'` entity role and unified the last
  follow-up-loop gap.** Previously a caller whose phone wasn't in the system had no
  `entityType` (it was `undefined`, matching no registry role), so `verify_identity`
  was offered + dispatched by a hand-written `else if` outside the `if (contactId)`
  block, and it only ran in the *first* round — a round-2+ `verify_identity` call fell
  through to the generic `No data found.` because the whole follow-up dispatch was gated
  on `contactId`. `EntityType` now includes `'unknown'`; the context maps a phone-not-found
  caller to that role, `verify_identity` carries `roles: ['unknown']`, and dispatch is a
  single `runTool` at both sites with no `contactId` gate — so it runs identically in any
  round. The vestigial offering of `escalate_to_taxcrew` to unknown callers (it was listed
  in the old inline `unknownTools` array but always returned `Error: User context (contactId)
  is missing.` because its handler needs a caller) is dropped: it keeps `roles: ['client',
  'lead']` and is simply no longer offered to unknown callers, matching the UNKNOWN role
  prompt, which only ever mentions `verify_identity`.

## First slice

The read-only client Tools `get_my_details`, `get_tax_number`, `get_client_invoices` — proving
the whole spine (registry → `runTool` → fallback → ToolContext → `DynamicsPort` → fake-Port
test) on the lowest-risk Tools before any write-Tool or multi-Port handler moves.

## Fourth slice (this change)

The client document & action Tools — `get_invoice_pdf`, `request_consultant_callback`,
`escalate_to_taxcrew`, `list_tax_forms`, `send_tax_form`, `opt_out_whatsapp`, `save_document`,
`upload_irp5`, `mark_document_already_sent` — the first slice to grow the seam beyond Dynamics +
the FAQ handlers. Five new narrow Ports join `ctx.deps`: `MetaPort` (`sendDocument`),
`GraphMailPort` (`sendMail`), `SupabasePort` (the per-session flags), `FormsPort`
(`resolveLatestFormFile`, the only SharePoint-touching forms call), and `Irp5Port`
(`processClientIrp5Upload` + `processStateBLeadIrp5Upload`, the OCR/extraction pipeline, both now
free functions in `pendingUpload.service`). The per-turn staged-upload buffer
(`has`/`peek`/`clear`/`save`) is lifted onto `ctx.pendingUpload`, bound to the turn's phone, so the
upload handlers stop capturing `phoneNumber` from enclosing scope. `upload_irp5`'s State-B-lead
restriction can't be expressed by role alone (it's a per-turn onboarding-state condition), so the
registry offers it to all leads by role and `claude.service` deletes it again for non-State-B
leads; the handler reads the precomputed `ctx.isStateBLeadUpload`.

## Fifth slice

The staff write Tools — `create_case`, `create_lead`, `create_contact`, `create_invoice`,
`create_task`, `send_invoice_pdf`, `refer_friend` — into `staffTools.ts`. Each carries
`roles: ['user']` and the matching `requiredPerm` (`create_case`, `create_lead`,
`create_contact`, `create_invoice`, `create_task`, `send_invoice_pdf`); `refer_friend` stays
ungated, exactly as it was in the legacy dispatch. One new narrow Port joins `ctx.deps`:
`PdfPort` (`generateInvoicePdf`), used only by `send_invoice_pdf`. The wiring closure maps the
raw Dynamics invoice row to `InvoiceData` then renders it, so neither `pdfkit` nor the pure
mapper enters the tool module graph — the same seam discipline as `FormsPort`/`Irp5Port`.
`DynamicsPort` gains the six write/lookup methods these handlers call (`createCase`,
`createLead`, `createContact`, `createInvoice`, `createTask`, `getContactByPhoneAndType`,
`logInvoiceSentToContact`). With this slice every `STAFF_TOOL_PERMISSIONS` entry except the LoE
trio (`upload_letter_of_engagement`, `confirm_loe_upload`, `update_loe_field`) and the
`get_*`/`get_case_by_name` read gates is gone — the inline re-check is now nearly empty, and
the legacy `staffTools` offered array is down to `get_case_by_name` + the LoE flow.

## Sixth slice

The last functional Tools on the legacy chain — the staff read `get_case_by_name`, the LoE
flow (`upload_letter_of_engagement`, `confirm_loe_upload`, `update_loe_field`), and the
unknown-caller `verify_identity`. `get_case_by_name` + the LoE trio go into `staffTools.ts`
(gated `view_open_cases` / `upload_letter_of_engagement`); `verify_identity` goes into the new
`leadTools.ts` under the new `'unknown'` role. Two new seams join `ctx`: `LoeOcrPort`
(`isConfigured` + `ocrDocument` from `mistral.service`, `extractBankingDetails` from
`loe-extractor.service`, composed into one Port by the wiring) and `ctx.pendingLoe` — the
per-turn staged Supabase LoE review row (`get`/`save`/`confirm`/`delete`/`updateField`), lifted
off the enclosing scope and bound to the turn's session, mirroring `ctx.pendingUpload`.
`DynamicsPort` gains the six methods the LoE/identity handlers call (`searchCaseByName`,
`searchContactByIdNumber`, `linkPhoneToContact`, `checkLoeAlreadyReceived`, `uploadLoeFileToCrm`,
`writeLoeFieldsToLead`). With this slice **every** Tool is a registry entry: the offered list is
produced solely by `deriveOfferedTools` per role (the inline `clientTools`/`staffTools`/`unknownTools`
arrays are gone) and both dispatch sites are a single `runTool` call. All that remained for the
final slice (Issue 7) was deleting the now-dead `STAFF_TOOL_PERMISSIONS` inline re-check and the
`legacyDispatch` fallback, and deriving `TOOLS` from the registry.

## Final slice (Issue 7) — the legacy scaffolding is deleted

With every Tool a registry entry, the strangler scaffolding is gone, not merely shadowed:

- **`STAFF_TOOL_PERMISSIONS` map + its first-round defense-in-depth re-check loop deleted.** Every
  gate it listed (`get_client_cases` → `view_open_cases`, `get_client_invoices` /
  `get_outstanding_balance` → `view_outstanding_invoices`) is already enforced by `runTool`'s
  `entryAllowed` via each entry's `requiredPerm` — so the inline re-check was pure duplication. The
  denial string is unchanged (the shared `DENIED` constant is byte-for-byte the old inline message).
- **`legacyDispatch` removed** from `ToolContext`, from the `toolCtx` wiring, and as the `runTool`
  fallback. `runTool` now rejects with `Unknown tool: <name>` instead of silently returning
  `'No data found.'`. The residual `else if (!contactId)` arm at the first dispatch site (already
  absent at the follow-up site) is deleted — both sites are now an unconditional `runTool` call.
- **`TOOLS` is derived from `REGISTRY`.** Each Tool's `description` moved onto its `ToolEntry`
  (a new required field) and `claude.service`'s `TOOLS` is now
  `Object.values(REGISTRY).map(e => ({ name, description, input_schema }))`. The derived array was
  verified equal — name + description + schema, all 40 Tools — to the prior hand-maintained array.
  Tool order is now the registry build order (clientTools, staffTools, leadTools) rather than the
  old hand-curated order; the per-turn offered list and the cache breakpoint are both order-stable,
  so this is not observable behaviour.

The registry tests are the backstop (212 now: the prior 211 minus the deleted legacy-fallback test,
plus a hard-error test and a description/schema-invariant test). No Tool changed its schema,
description, role visibility, permission, or output.
