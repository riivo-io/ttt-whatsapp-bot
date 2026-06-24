# RALPH Handoff — document-collection journey

> ⚠️ **This handoff MUST be updated at the end of every iteration.** Before you
> finish, record what you did, move the completed issue out of "Next issues",
> and re-point the "Next issues" list at whatever remains. Leaving this doc
> stale breaks the next agent's pickup. This requirement is itself part of the
> definition of done for every issue.

## Done this iteration: Issue 24 — Remove greeting IRP5 ask; make doc collection client-initiated
PRD: `.scratch/document-journey/PRD.md` (§Entry, §Step 1) · ADR `docs/adr/0002-document-collection-journey.md`

### What changed
- **NEW `src/domain/clientRoleContext.ts`** — pure builder
  `buildClientRoleContext({ firstName, isFirstMessage })` owns the CLIENT
  role-context block (matches the `decideCaseRouting` / `decideFeedbackReply`
  pure-module seam). Exports `IRP5_ASK_COPY` (the verbatim protective +
  multi-employer + "already sent to consultant" ask). Adds journey guidance:
  launch on commitment / unprompted IRP5 upload; *offer* (not launch) on fuzzy
  signals; no-IRP5 branch (explain why, fall back to `get_required_documents`);
  season-timing branch (explain, prior-year proceeds normally). Greeting format
  block unchanged in shape, now explicitly forbids asking for any doc.
- **`src/services/claude.service.ts`** — deleted the first-message `irp5Hint`
  lookup (the `isFirstMessage && contactId` block, 1-April gate, and
  `getIrp5RecordsForClient` call) and the inline client `roleContext` literal;
  replaced with one `buildClientRoleContext(...)` call. Added the import.
  `getCurrentSaTaxYear` import stays (still used elsewhere, L1802).
- **NEW `test/unit/clientRoleContext.test.ts`** — 6 characterisation tests:
  greeting shape preserved, greeting carries NO IRP5/doc demand (no `IRP5
  STATUS` hint), greeting omitted when not first message, launch-on-commitment /
  offer-on-fuzzy, ask copy framings, no-IRP5 + season-timing explain-not-demand.

### Verification
- `./node_modules/.bin/tsc --noEmit` → clean
- `npm test` → 58/58 pass (52 prior + 6 new)

### Working-tree note (unchanged from prior iterations)
`claude.service.ts` still carries **pre-existing, unrelated bad-debt + classifier
hunks** (BadDebtDetail import, `CLASSIFIER_MODEL`, `badDebt?` param, etc.). This
commit staged **only the Issue 24 hunks** (the import + the roleContext swap) via
a filtered `git apply --cached`. The bad-debt hunks remain unstaged. Stage
selectively.

## Done this iteration: Issue 21 — Replace processor routing block with verdict + applier switch

Commit: (this iteration) on branch `hotfix/topic-shift-relaxation`
PRD: `.scratch/case-routing/PRD.md`

### What changed
- **`src/workers/whatsappProcessor.ts`** — the ~80-line inline routing conditional
  (`qualifies` / `looksLikeFeedbackOrAck` / `withinContinuationWindow` / the
  `if/else if` chain) is gone. The processor now:
  - imports `decideCaseRouting` from `../domain/caseRouting`,
  - calls it once: `decideCaseRouting(latestCase, { text: effectiveText, interactiveId, pendingCaseId: (session as any).pending_case_id ?? null }, Date.now())`,
  - `switch (verdict.kind)` applies the I/O and sets the existing downstream locals.
- The inline `TOPIC_SHIFT_MIN_GAP_MS` const and `withinContinuationWindow` calc
  are deleted (now owned by the domain module).
- The client/lead entity-type guard stays in the processor — `decideCaseRouting`
  is only called for client/lead, never staff/unknown.

### Verdict → applier mapping (locked)
| verdict | action | locals set |
|---|---|---|
| `topic-shift` | `markResolvedByBot(prior,'topic_shift')` in the existing try/catch **before** `createCase` | `newCaseId`, `respondingCaseId`, `crmRequestId` from new Case |
| `fresh` | `createCase` | `newCaseId`, `respondingCaseId`, `crmRequestId` from new Case |
| `continue` | none | `respondingCaseId = verdict.caseId`, `crmRequestId = verdict.crmRequestId` |
| `reclassify` | none here (post-response block promotes to `respondingCaseId` on recovery) | `reclassifyCaseId = verdict.caseId`, `crmRequestId = verdict.crmRequestId` |
| `none` | none | `crmRequestId = verdict.crmRequestId` (may be null) |

Ordering preserved exactly: `topic-shift` resolves the prior Case (in the
existing try/catch) before creating the new one.

### Verification
- `./node_modules/.bin/tsc --noEmit` → clean
- `npm test` → 22/22 pass (unchanged — the rewrite is behaviour-preserving)

## Issue 20 — Characterization table (confirmed done, not just unblocked)
`test/unit/caseRouting.test.ts` covers every row in the Issue 20 coverage list:
fresh / none(null) for emoji+noise+short / topic-shift outside window / continue
inside window / continue on button tap / continue on wrap-up / continue on
drafting-status ack / continue on pending-id free-text feedback / reclassify on
escalated+qualify / reclassify on escalated+wrap-up / none-with-request-id on
escalated+neither / window boundary.

The issue text's "still-drafting (`open`) status" is informal naming — the actual
DB status default is **`created`** (see `supabase/migrations/20260417100000_case_lifecycle.sql`:
`created | classified | bot_responded | resolved_by_bot | resolved_by_bot_timeout | escalated`).
There is no literal `open` status. The test covers the drafting case via both
`created` and `classified`, so no extension was needed. Issue 20 is **closed**.

## Previously done: Issue 19 — Extract `decideCaseRouting` pure domain module
Commit: `9a1a11b`. New `src/domain/caseRouting.ts` (pure, no I/O) exports
`TOPIC_SHIFT_MIN_GAP_MS`, the `CaseRouting` discriminated union, `RoutingCase`,
`decideCaseRouting`, and the three predicates + button-id consts (re-exported by
`case.service.ts` so existing importers compile unchanged).

## Environment note (read before running anything)
This machine uses **pnpm with a shared global store**. If `node_modules` is
missing:

```
pnpm install --shamefully-hoist
```

`--shamefully-hoist` is **required**: without it, transitive `@types` aren't
hoisted and `tsc --noEmit` fails with `TS2688 Cannot find type definition file`.

Typecheck command (no `typecheck` npm script exists): `./node_modules/.bin/tsc --noEmit`
Tests: `npm test`

## Working-tree caution (still applies)
The working tree carries **pre-existing, unrelated bad-debt changes** across
several files (`src/workers/whatsappProcessor.ts` has bad-debt import + handler
hunks; `src/services/case.service.ts`, `dynamics.service.ts`, `supabase.service.ts`,
`pdf.service.ts`, etc.). This iteration's commit contains **only the Issue 21
routing hunks** in `whatsappProcessor.ts` — the bad-debt hunks were deliberately
left unstaged (staged via a filtered `git apply --cached`). Do not assume the
dirty diff is all yours; stage selectively.

## Next issues — document-collection journey (PRD `.scratch/document-journey/PRD.md`)
Issue 24 is done (greeting + trigger). Remaining, in dependency order:
- **Issue 25 — doc-recommendation pure module** (`issues/25-doc-recommendation-pure-module.md`):
  the tailored, reason-annotated, form-supersedes-doc list builder. Until it
  lands, the journey falls back to existing `get_required_documents`. Also drops
  Bank Statements from `BASELINE_DOCS` (IRP5 stays, ID Document stays out).
- **Issue 26 — IRP5 tailored single message** (`issues/26-irp5-tailored-single-message.md`):
  present the tailored list once (not one-at-a-time drip). Depends on 25.
- **Issue 27 — already-sent escape hatch** (`issues/27-already-sent-escape-hatch.md`):
  unverified "client states provided" marker in Dynamics that suppresses re-ask
  but is excluded from verified-received counts.

### Prior context: case-routing extraction (Issues 19, 20, 21 — all done)
The routing decision is a pure, tested domain module (`src/domain/caseRouting.ts`)
and the processor is a thin applier. Scope complete.
