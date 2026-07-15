# ADR 0002 — Document collection is a stateless, client-initiated journey

Status: accepted · 2026-06-24 · **decisions 2 & 3 superseded by [ADR 0004](0004-advice-only-document-guidance.md) (2026-07-15)**

> **Superseded in part.** ADR 0004 removes the received-doc *diff* entirely: Tina no longer reads
> a client's `riivo_taxsubmissionsdocuments` rows and no longer reports received / outstanding /
> "already sent" status. Decision 1 (stateless — no journey state machine) and decision 4 (pure
> recommendation kernel) still hold; the kernel now returns advice only. Decisions 2 and 3, and
> the escape-hatch marker, are withdrawn. Read this ADR for the journey framing, then ADR 0004 for
> the current document-guidance behaviour.

## Context

Tina collected tax documents **greeting-driven**: an IRP5 ask was injected into the system
prompt on every session's first message for clients, gated only on (is client, past 1 April,
no IRP5 on file). Because sessions reset after 30 min of inactivity, "first message" fired
constantly and the ask landed regardless of the client's actual question — it read as
aggressive.

We want document collection to be a **journey** the client initiates ("I want to start my tax
return"), with the IRP5 analysed first and the rest of the doc list derived from it. Two design
questions had to be settled:

1. Do we model the journey as **persisted state** (a per-client-per-tax-year record moving
   through phases) or **re-derive it statelessly** from the documents already on file?
2. How do we behave when the CRM is wrong?

A constraint shaped both: the client may have **already sent documents straight to their
consultant**. Power Automate usually files a `riivo_taxsubmissionsdocuments` row for emailed
docs, but not always — so the CRM realistically **under-reports** (false outstanding), and very
rarely over-reports.

## Decision

**1. Stateless re-derivation, no persisted journey state machine.** "Where the client is" is
always recomputed from Dynamics (`riivo_irp5s` + `riivo_taxsubmissionsdocuments`). There is no
second source of truth.

**2. Never assert completeness.** Tina only ever frames the list as "what I don't yet see on
file," never "we have everything." The design never produces a *false received* (claiming a doc
we don't have). An `false outstanding` is recoverable noise; a `false received` files an
incomplete return, so the asymmetry is encoded as a hard rule.

**3. An "already sent it" escape hatch records an _unverified_ marker.** When a client says they
already sent a doc to their consultant, Tina writes a **distinct, clearly-unverified** record in
Dynamics. It suppresses the re-ask across session resets but is never counted as a verified
receipt; a consultant can confirm or clear it.

**4. The tailored-recommendation logic is a pure module.** Given (source codes, industry,
received docs, forms catalog) it returns the ordered, concise, reason-annotated list with
form-supersedes-doc dedupe applied. I/O (Dynamics reads, sending) stays in the service /
processor, matching the `decideCaseRouting` / `decideFeedbackReply` seam.

## Rationale

- A persisted state machine is just a **copy** derived from the same uploads. If the CRM is
  wrong, the copy is wrong too — plus now it can go stale and tell a client "send your IRP5"
  while it sits in Dynamics. Re-derivation is self-healing: a consultant adding a doc
  out-of-band is reflected on the client's next message with no migration step.
- The dangerous failure (`false received`) is structurally impossible if Tina never claims
  completeness and unverified markers stay visibly distinct from verified receipts. The common
  failure (`false outstanding`) is absorbed by the escape hatch + protective phrasing rather
  than by trusting the CRM.
- The recommendation builder passes the deletion test: it concentrates real branching
  (source-code/industry expansion, received-doc diff, form supersession, reason attachment,
  ordering), so it earns a pure module rather than living inline.

## Consequences

- No schema migration for the journey. The only new persisted thing is the unverified
  "client states provided" marker (Issue 27), which is a `riivo_taxsubmissionsdocuments`-shaped
  row with a distinct status/notes, not a new entity.
- Proactive completion-chasing (reminding clients who abandon mid-journey) is **explicitly out
  of scope** — it is an outbound-messaging product decision and would need an Azure-side
  scheduler (`vercel.json` crons do not fire on Azure). Tina stays purely reactive.
- `BASELINE_DOCS` loses Bank Statements (source-code/industry-driven only); IRP5 stays, ID
  Document stays out.
- A future review should not re-propose a persisted journey state machine unless the journey
  grows branching that genuinely cannot be re-derived from documents on file (e.g. multi-year
  parallel returns with per-year sign-off). Reopen this ADR if so.

## Addendum (2026-06-25) — the consultants' guide is the authoritative source

PRD `docs/PRD-document-requirements-guide.md` encodes the consultants' SharePoint
document-requirements guide into the existing pure kernel (`buildDocRecommendation()`). The
architecture is **unchanged** — pure kernel, stateless re-derivation, never-assert-completeness,
form-supersedes-doc — so this is an addendum, not a new ADR. Three points are recorded here:

- **The guide is authoritative.** A verbatim snapshot lives at
  `docs/document-requirements-guide.md`, dated for the 2026 tax year. Where the guide and the
  kernel disagree, **the guide wins and the kernel is rewritten to match it.** The snapshot keeps
  periods literal; the kernel keeps deriving live periods from the assessment year.

- **New code/topic mappings this work introduces:** source codes **3606** (commission, conditionally
  framed), **3701** (travel, rewritten to the guide list) and **3802** (company-car fringe benefit,
  new — also added to the Vehicle Detail Sheet form trigger); and two client-stated document topics
  **`foreign_income`** and **`rental_income`** surfaced via a new optional `topic` on
  `get_required_documents`. The per-table code-comment pointers back to the snapshot are added by the
  slices that touch each table.

- **Manual sync point.** Keeping the kernel in step with the SharePoint guide is **manual** — the
  same posture as the manually-applied Supabase migrations: there is no automated drift check. A
  SharePoint guide edit obliges an engineer to re-sync the kernel (and refresh
  `docs/document-requirements-guide.md`) before the change is reflected to clients.
