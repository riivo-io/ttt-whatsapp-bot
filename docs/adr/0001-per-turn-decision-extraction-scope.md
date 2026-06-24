# ADR 0001 — Which per-turn decisions get a pure `decide*` module

Status: accepted · 2026-06-23

## Context

`whatsappProcessor.ts` makes several per-turn decisions inline. One — Case routing — was
already lifted into a pure `decideCaseRouting` verdict (`src/domain/caseRouting.ts`) with the
processor applying it via a `switch`. An architecture review proposed extending that pattern
to four more inline sites: conversation caps, bad-debt, feedback detection, and wrap-up
detection.

The deepening test is the deletion test: a pure `decide*` module earns its place only if it
**concentrates** complexity, not if it merely **moves** it into a ceremonial wrapper.

## Decision

Only **conversation caps** and **feedback reply** are lifted into pure `decide*` modules
(`src/domain/conversationCap.ts`, `src/domain/feedbackReply.ts`). Bad-debt and wrap-up stay as
inline I/O orchestration in the processor.

## Rationale

- **Caps** has a real pure kernel: given session counts + a fetched `dailyCount` + threshold
  constants, the `blocked | hit | ok` verdict is fully determined with no I/O and no clock.
- **Feedback** has a real pure kernel: the whole gate (button-tap bypass, backward history
  scan, `startsWith(CASE_FEEDBACK_PROMPT_TEXT)`, `detectFeedback`) is a deterministic function
  of history + message + pending-case pointer.
- **Bad-debt** (`evaluateBadDebt`, ~L660–695) is almost entirely I/O: a `type === 'client'`
  guard plus `getBadDebtState`, `setSessionBadDebt`, the atomic `claimBadDebtInvoiceSend`, and
  `sendBadDebtInvoices`. There is no branching logic of substance to concentrate; a verdict
  wrapper would move the trivial guard out and leave the I/O behind.
- **Wrap-up** (~L1313–1355) already has its pure kernel extracted as the `detectWrapUp`
  predicate in the domain module. The branch that matters — whether to send the wrap-up
  notification — depends on `closed > 0`, a value known only *after* `reclassifyCase` and
  `resolveAllOpenCasesAsConfirmed` run. The decision is genuinely entangled with the I/O
  result, so a pre-I/O verdict cannot express it.

## Consequences

- A future architecture review should **not** re-suggest extracting bad-debt or wrap-up into
  `decide*` modules. If their logic grows real branching (e.g. bad-debt gains payment-plan
  states, or wrap-up gains pre-I/O routing), reopen this ADR.
- The verdicts carry no presentation copy: canned replies, ack strings and notifications stay
  in the processor's apply step, matching `decideCaseRouting`.
