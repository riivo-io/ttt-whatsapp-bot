# PRD — Encode the consultants' document-requirements guide into the recommendation kernel

**Owner:** Luc
**Status:** Approved for implementation
**Primary seam:** `buildDocRecommendation()` (`src/domain/docRecommendation.ts`) — the existing pure kernel from ADR 0002. No new seam.
**Feature flag:** none (data/content change to an existing pure module; rides the existing `get_required_documents` + `upload_irp5` flows)
**Related:** ADR 0002 (document-collection journey), PRD — Tax Forms (fillable templates)

---

## Problem Statement

When a client asks Tina what documents to send, or uploads their IRP5 and gets a tailored "what else helps" list back, the advice Tina gives is hand-encoded in the recommendation kernel and has **drifted from the authoritative guide the consultants actually use**. TTT maintains a document-requirements guide in SharePoint that spells out, scenario by scenario, exactly which documents (and fillable templates) a client needs for commission expenses, a company car, travel allowance, foreign income, rental income, and the plain salary-earner case. Tina doesn't reference that guide at all.

The consequences:

- For codes Tina already handles (3606 commission, 3701 travel), the documents she lists **don't match the guide** — she asks for "12 payslips / till slips" where the consultants' guide asks for purchase agreements, service records, finance statements, and the insurance schedule. Clients then get a second, different list from their consultant.
- Company car (source code **3802**) isn't handled at all — a whole class of clients gets the generic baseline.
- Foreign income and rental income have weak or no coverage, so when a client raises them Tina has nothing authoritative to draw on and risks either silence or paraphrased, possibly-wrong guidance.

The user (TTT, via the consultants and Luc) wants one source of truth for document direction: **what Tina tells a client should be what the guide says.**

## Solution

Translate the SharePoint guide into the existing pure recommendation kernel (`docRecommendation.ts`) as data, so the same deterministic, self-healing, reason-annotated flow Tina already uses now speaks the guide's language. The guide becomes the authoritative source; wherever the kernel's current lists disagree with it, the guide wins and the kernel is rewritten to match.

Specifically:

- **Code-triggered scenarios** (3606, 3701, 3802, and the no-code baseline) are encoded into the kernel's source-code / form / baseline tables and ride the IRP5-upload flow automatically.
- **Non-code scenarios** that can't be read off an IRP5 — **rental income** and **foreign income** — are surfaced on client disclosure: rental through the existing industry trigger (list upgraded to the guide's), foreign through a new optional `topic` argument on `get_required_documents`.
- A **verbatim snapshot of the guide is committed to the repo** as the human-readable source of truth, with code-comment pointers from the kernel tables and a manual-sync note in ADR 0002.

From the client's perspective: when they ask what to send, or upload their IRP5, Tina's list now matches exactly what their consultant would have told them — precise to the line item, framed "send whatever applies to you," with the *why* on every item.

## User Stories

1. As a commission earner (source code 3606) who uploads their IRP5, I want Tina's "what else helps" list to match the commission-expenses guide my consultant uses, so that I gather the right documents the first time.
2. As a commission earner who uses my own car for work, I want Tina to ask for the Vehicle Detail Sheet, vehicle purchase agreement, finance statements and insurance schedule, so that I can claim my vehicle expenses against my commission.
3. As a commission earner who does **not** drive for work, I want the vehicle-expense documents framed as "only if you want to claim commission/vehicle expenses," so that I'm not chased for a vehicle purchase agreement I'll never produce.
4. As a client with a travel allowance (3701), I want Tina to ask for the items the guide lists (Vehicle Detail Sheet template, purchase agreement, service records, leave dates), so that my travel claim is supported correctly.
5. As a client with a company car (source code 3802), I want Tina to recognise that code and ask for the Vehicle Detail Sheet and a fringe-benefit letter, so that my company-car situation is handled instead of falling back to the generic list.
6. As a plain salary earner with no 3606/3701/3802, I want Tina to ask for IRP5, investment tax certificates, RA certificate and medical aid certificate, so that I send exactly what a simple return needs and nothing I don't.
7. As a client earning rental income, I want Tina — when she knows I'm a landlord or when I tell her — to ask for the full rental document set (lease, bank statement showing rent, bond statement, rates & levies, maintenance receipts, insurance, agency commission), so that all my rental deductions are captured.
8. As a client who earned foreign income, I want to tell Tina "I worked overseas" and get the right document list (proof of income for the tax year, passport with exit/entry stamps), so that I can be assessed for the foreign-income exemption.
9. As a client asking about foreign income, I want Tina to explain *why* she needs the passport stamps and proof of income (the 183-day / 60-consecutive-day test, the R1.25m exemption) as the reason for the document, so that I understand the ask — without her giving me a tax ruling on whether I qualify.
10. As a client, I want every document Tina asks for to carry a short reason, so that I can self-select the ones that apply to me.
11. As a client who has already uploaded a form or document, I want Tina to keep treating it as received and not re-ask, so that the guide change doesn't reintroduce nagging.
12. As a client filing in a later tax year, I want the document periods Tina quotes to track my assessment year automatically, so that she never asks me for last year's date range.
13. As a consultant, I want the documents Tina requests to be identical to my SharePoint guide, so that I stop fielding "but Tina asked for something different" confusion.
14. As a consultant who updates the SharePoint guide, I want a clear, documented place where the code mirrors the guide, so that I know an engineer must re-sync the kernel when I change it.
15. As an engineer, I want the guide encoded as data in the existing pure kernel rather than paraphrased by the model, so that document direction stays deterministic, testable and self-healing.
16. As an engineer, I want a verbatim copy of the guide in the repo, so that I can diff future guide changes against what the kernel currently encodes.
17. As a client who uploads an IRP5 carrying a code we encode (3606/3701/3802), I want the tailored list returned in one message, so that I'm not dripped one document at a time (preserving the existing IRP5-ack behaviour).
18. As a client whose IRP5 carries code 3802, I want the extractor to capture 3802 in my source codes even though it has no dedicated CRM column, so that the company-car list actually fires.
19. As a client whose situation matches multiple scenarios (e.g. commission + travel), I want the combined list de-duplicated with forms leading, so that I don't see the same document twice.
20. As a client on a medical aid / RA, I want those certificates asked for once via the baseline, so that the company-car or commission scenarios don't duplicate them.

## Implementation Decisions

**Mechanism — encode as kernel data (not KB, not paraphrase).** All guide content is added to the pure module `docRecommendation.ts` as entries in `BASELINE_DOCS`, `SOURCE_CODE_DOCS`, `INDUSTRY_DOCS`, `SOURCE_CODE_FORMS`, and a new topic table (below). The recommendation flow, ordering, form-supersession and three-way received/client-stated/outstanding diff are unchanged — only the data they operate on changes. This keeps the ADR 0002 posture: stateless re-derivation, deterministic, self-healing, never asserts completeness.

**Guide is authoritative.** Where the guide and the current kernel disagree, the kernel is rewritten to match the guide. Encoding is at the guide's line-item granularity (each guide line → one `DocSpec` with a `label` and a client-facing `reason`), except where a fillable form supersedes the loose docs (see below).

**Triggering split.** Code-triggered scenarios (3606, 3701, 3802, baseline) are encoded now and ride the IRP5 source-code path. Non-code scenarios are surfaced on disclosure: rental via the existing `INDUSTRY_DOCS` industry match, foreign via a new client-stated `topic`.

**3606 (commission) — reconciled to the guide, conditionally framed.** The 3606 entry is rewritten so the kernel emits:
  - the **Vehicle Detail Sheet** form (which already supersedes logbook / fuel / service records / leave dates the form itself captures),
  - the **Commission Earner Expenses List** form (supersedes till slips / entertainment),
  - and loose docs **not** captured by either form: vehicle purchase agreement, vehicle finance statements, vehicle insurance policy schedule, bank statements (cheque / savings / credit card).
  Every commission-expense / vehicle item carries a **conditional reason** ("only if you want to claim commission/vehicle expenses against your own car"), so the client self-selects. The single-message IRP5 ack is preserved. This means code `3606` is added to the Vehicle Detail Sheet form trigger in `SOURCE_CODE_FORMS` (currently only 3701/3702/3703/4015), framed conditionally.

**3701 (travel) — rewritten to the guide list.** Vehicle Detail Sheet template (form, already triggered by 3701), plus purchase agreement, service records, leave dates — with service records and leave dates folded into the form via supersession where the form captures them; purchase agreement remains a loose doc.

**3802 (company car) — new.** Add `'3802'` to the Vehicle Detail Sheet form's `sourceCodes` in `SOURCE_CODE_FORMS`. Add a `SOURCE_CODE_DOCS['3802']` entry whose one genuinely new doc is a **fringe-benefit letter** (with reason). Medical aid / RA / investment certificates for the 3802 case are **not** duplicated here — they come from the baseline.

**Baseline — relabel one item to the guide's wording.** In `BASELINE_DOCS`, relabel `IT3(b) — interest earned` to **"Investment tax certificates (IT3(b)/IT3(c))"** so it matches the guide's "Investment tax certificates" while keeping the IT3(b) hint in parentheses for the received-doc loose-match to keep recognising uploaded IT3(b)s. The other three baseline items (IRP5, Medical aid, RA) already match the guide and are unchanged. No bank statements, no ID document in baseline (unchanged from ADR 0002).

**Rental income — upgrade the existing industry entry.** Replace the `rental|landlord|property` entry in `INDUSTRY_DOCS` with the guide's fuller set: lease agreement(s), bank statement showing rent received, bond statement (incl. bond interest), rates & levies, maintenance & repairs, insurance, agency commission paid — each with a reason. This rides the existing industry trigger; no new wiring.

**Foreign income — new `topic` path.** Add an optional `topic` to the kernel input and a small topic table:

```ts
// docRecommendation.ts — decision shape (prose-precise, not final code)
type DocTopic = 'foreign_income' | 'rental_income';

DocRecommendationInput.topic?: DocTopic; // when set, the topic's specs are unioned
                                         // into the recommendation, deduped like the rest

const TOPIC_DOCS: Record<DocTopic, DocSpec[]> = {
  foreign_income: [
    { label: 'Proof of foreign income for the tax year (payslips / bank statements)',
      reason: 'to confirm what you earned abroad for {taxYear.rangeText}' },
    { label: 'Passport showing exit and entry stamps',
      reason: 'so we can check the days you spent outside South Africa for the foreign-income exemption (183 days out, 60 of them consecutive)' },
  ],
  rental_income: [ /* mirrors the upgraded rental industry set */ ],
};
```

  `get_required_documents` gains an optional `topic` argument; when the client discloses foreign (or rental) income in chat, Claude calls the tool with that topic and the kernel returns the guide-exact list. **Docs only** — the exemption logic (R1.25m cap, day tests) lives inside the `reason` strings, never as standalone tax advice. The tool→kernel wiring is thin; all decision logic stays in the kernel.

**Periods derived from the assessment year, never hardcoded.** Reuse the existing `TaxYear` / `getCurrentSaTaxYear(today)` machinery. Any reason that references a period interpolates `taxYear.rangeText` rather than the guide's literal "01/03/2025 – 28/02/2026". For IRP5-driven calls the year comes from the assessment year; for a bare `get_required_documents` call it falls back to the current tax year from `today`.

**Extractor check (not an assumption).** Confirm during implementation that the IRP5 extractor surfaces `3802` in its `sourceCodes` output. The extractor prompt already instructs "list every visible 4-digit code in `sourceCodes`," so it should — but this is verified, not assumed, because the 3802 scenario depends on it.

**Source of truth & drift control.** Commit the guide verbatim to `docs/document-requirements-guide.md` (dated snapshot). Add code-comment pointers from the `SOURCE_CODE_DOCS` / `INDUSTRY_DOCS` / `SOURCE_CODE_FORMS` / `TOPIC_DOCS` tables back to that file. Record in an ADR 0002 addendum that this is a **manual sync point** (same posture as the manually-applied Supabase migrations), and that a SharePoint guide edit obliges a kernel re-sync.

**Modules touched.** `src/domain/docRecommendation.ts` (all data tables + new `topic` field + `TOPIC_DOCS`), `src/services/requiredDocuments.service.ts` (pass `topic` through), the `get_required_documents` tool definition/handler (new optional `topic` arg). No change to the stateless re-derivation, the unverified-marker escape hatch, ordering, or supersession logic.

## Testing Decisions

**What makes a good test here:** assert the kernel's **external behaviour** — given (`sourceCodes`, `industryName`, `receivedLabels`, `clientStatedLabels`, `topic`, `today`), the returned `outstanding` / `received` / `clientStated` lists and their reasons. Do not assert internal ordering of private helpers or table contents directly; assert the produced recommendation. This matches the existing pure-kernel test style and keeps tests stable against refactors.

**Single seam:** all tests go through `buildDocRecommendation()`. Prior art: the existing `docRecommendation` test suite and the `decideCaseRouting` / `decideFeedbackReply` pure-decision tests follow the same data-in → assert-output shape.

**Cases to cover:**

1. **3606 commission** — outstanding includes both forms (Vehicle Detail Sheet, Commission Earner Expenses List) leading, plus the conditional loose docs (purchase agreement, finance statements, insurance schedule, bank statements); vehicle docs the form supersedes (logbook, service records, leave dates) are absent; conditional reasons present.
2. **3701 travel** — Vehicle Detail Sheet leads; purchase agreement present; superseded docs absent.
3. **3802 company car** — Vehicle Detail Sheet form present; fringe-benefit letter present; medical/RA/investment **not** duplicated (come from baseline only).
4. **No-code baseline** — exactly IRP5, "Investment tax certificates (IT3(b)/IT3(c))", Medical aid, RA; no bank statements, no ID.
5. **Baseline relabel + received match** — an uploaded "IT3(b)" still loose-matches the relabelled "Investment tax certificates (IT3(b)/IT3(c))" item and lands in `received`, not `outstanding`.
6. **Rental industry** — `industryName` matching `landlord` yields the full upgraded rental set with reasons.
7. **`topic: 'foreign_income'`** — outstanding includes proof-of-income and passport-with-stamps, with the 183-day / exemption reasoning in the `reason` strings (and no standalone advice item).
8. **`topic: 'rental_income'`** — yields the rental set even with no rental industry on file.
9. **Year derivation** — with a `today` in a later tax year, period reasons reflect that year's `rangeText`, not a hardcoded 2026 range.
10. **Form supersession + combined scenario** — `sourceCodes` of `['3606','3701']` produces a de-duplicated list (no duplicate Vehicle Detail Sheet, no doc shown twice), forms leading.
11. **Already-received suppression** — items in `receivedLabels` / `clientStatedLabels` are correctly diverted out of `outstanding` for the new scenarios too.

If the extractor 3802 check fails, add a focused extractor test (or fix) so `3802` reaches the kernel — the company-car cases above depend on it.

## Out of Scope

- **No KB / vector-search ingestion of the guide.** Deliberately rejected — would reintroduce non-deterministic paraphrasing of document direction. The guide is data in the kernel, not a retrieved excerpt.
- **No foreign-income or exemption *advice*.** Tina states which documents and why; she does not rule on whether a client qualifies for the R1.25m exemption or compute their day-count.
- **No auto-detection of foreign or rental income.** Neither is read off the IRP5. Foreign surfaces only on the new `topic`; rental on industry or `topic`. No inference from bank flows or anything else.
- **No proactive completion-chasing.** Unchanged from ADR 0002 — Tina stays reactive.
- **No persisted journey state.** Unchanged — re-derived statelessly every turn.
- **No new fillable forms.** The Vehicle Detail Sheet and Commission Earner Expenses List already exist (Tax Forms PRD). The fringe-benefit letter is a doc the client obtains from their employer, not a form Tina sends.
- **No automated drift detection between SharePoint and the kernel.** The sync point is manual and documented; a tooling check is a future enhancement.
- **No change to ordering, supersession, or the escape-hatch mechanics.** Only the data and the new `topic` input change.

## Further Notes

- The guide's pervasive "if applicable / if qualify" framing is honoured through conditional `reason` text rather than by gating items behind a claim signal — chosen to preserve the single-message IRP5 ack and avoid a new client-stated trigger for every expense category.
- The guide references "complete attached template" in several places; those templates are the existing Vehicle Detail Sheet and Commission Earner Expenses List, surfaced via the form path, so this PRD does not add template delivery.
- ADR 0002 gets a short addendum (new code/topic mappings, guide-as-authoritative-source, manual sync point); a new ADR is not warranted because the architecture (pure kernel, stateless re-derivation, never-assert-completeness) is unchanged.
- Snapshot date for `docs/document-requirements-guide.md`: the guide as supplied for the 2026 tax year (periods in the snapshot stay verbatim; the kernel derives live periods from the assessment year).
