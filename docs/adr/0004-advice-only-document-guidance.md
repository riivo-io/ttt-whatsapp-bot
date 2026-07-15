# ADR 0004 — Document guidance is advice-only; Tina never reports upload status

Status: accepted · 2026-07-15

Supersedes [ADR 0002](0002-document-collection-journey.md) decisions 2 (never assert
completeness) and 3 (unverified "already sent it" escape-hatch marker). ADR 0002 decision 1
(stateless — no journey state machine) and decision 4 (pure recommendation kernel) still hold.

## Context

ADR 0002 built document collection on a **received-doc diff**: Tina read the client's
`riivo_taxsubmissionsdocuments` rows each turn, matched them against the tailored expected list,
and told the client what was *received*, *outstanding*, or *client-stated-but-unverified*. That
design assumed the CRM under-reports in a bounded, recoverable way (a missing row → a harmless
re-ask).

In practice the upload data across TTT is **all over the place** — rows are missing, mislabelled,
duplicated, attached to the wrong contact, or filed under stale tax years by inconsistent
Power Automate and manual processes. The diff therefore produced **confidently wrong** messages:
telling clients they hadn't sent things they had, or implying we held things we didn't. A wrong
status claim erodes trust faster than no status claim, and the underlying data cannot be relied on
to fix per-client.

## Decision

**1. Tina gives document _advice_, never a _status report_.** When a client asks what they need,
or uploads an IRP5, Tina relays the list of documents *associated with their return* — "here's
what typically helps" — as guidance on what to gather. She never tells a client what they have or
haven't uploaded, what TTT has "received", or what is "still outstanding / missing".

**2. No reads of the client's upload records for guidance.** The document-guidance paths do **not**
call `getTaxSubmissionDocsByClient` and do **not** diff against on-file rows. Personalisation still
reads the client's **profile** (SARS source codes + industry) to decide *which* documents are
associated — that data is authored by consultants and is not the unreliable surface.

**3. The pure kernel returns one list, no diff.** `buildDocRecommendation()` drops its
`receivedLabels` / `clientStatedLabels` inputs and its `received` / `clientStated` / `outstanding`
buckets. It returns a single ordered, reason-annotated, form-superseded `documents` list. Uploads
still work (files are still stored and tagged); we simply never read them back to the client.

**4. Retire the status tools and the escape hatch.** `get_received_documents`
("what have you got from me?") and `mark_document_already_sent` (the ADR 0002 decision-3 unverified
marker), plus the Dynamics `markDocumentClientStated` write and its `CLIENT_STATED_DOC_NOTE` /
`isClientStatedMarkerRow` helpers, are removed. If a client says they already sent something, Tina
takes them at their word, doesn't re-ask, and writes nothing.

## Rationale

- The dangerous failure ADR 0002 guarded against (a *false received* filing an incomplete return)
  is now structurally impossible in the bot: Tina makes **no** receipt claims at all.
- The common failure (*false outstanding* — nagging for a doc already on file) is likewise gone,
  because Tina never asserts a doc is outstanding. Advice framing ("send whatever applies to you")
  is true regardless of what's actually on file.
- Reading the profile (source codes / industry) is safe and additive: at worst the list is generic,
  never wrong-about-the-client. Reading the upload rows was the sole source of confidently-wrong
  claims, so only that read is removed.
- The IRP5 upload flow still confirms receipt of **the file the client just sent this turn** —
  that is local knowledge from the upload itself, not a record lookup, so it stays.

## Consequences

- `computeMissingDocsForClient` → `computeAssociatedDocsForClient`; `MissingDocsResult` →
  `AssociatedDocsResult` (`documents`, no `outstanding` / `received` / `clientStated`).
  `renderOutstandingDocsList` → `renderAssociatedDocsList`; `Irp5ReceivedAckInput.outstanding` →
  `.associatedDocs`.
- The IRP5-received acknowledgement no longer says "that's everything we need" (a completeness
  claim); it closes with "your consultant will be in touch if anything else is needed".
- `getTaxSubmissionDocsByClient` remains defined on the Dynamics service as a generic read
  primitive but is no longer called by any Tina guidance path.
- The consultants' document-requirements guide (ADR 0002 addendum) is unchanged and still
  authoritative for *which* documents map to each source code / industry — the manual kernel↔guide
  sync point still applies.
- A future change must not reintroduce upload-status reporting to clients until the underlying
  `riivo_taxsubmissionsdocuments` data is trustworthy enough to diff against. Reopen this ADR if the
  data quality is fixed and per-client status becomes valuable again.
