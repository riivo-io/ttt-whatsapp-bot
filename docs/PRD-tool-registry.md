# PRD — Collapse the Claude tool dispatch into a Tool registry

Status: ready-for-agent · local · 2026-06-24

## Problem Statement

As a maintainer of the WhatsApp tax bot, every change to a **Tool** is slow and risky. The 45
Tools the bot can invoke during a Claude turn are dispatched by a hand-written `if/else` chain in
`claude.service.ts` — and that chain is written **twice**: once for the first Claude round and
again, partially, for the follow-up tool-call loop. A Tool's Anthropic `input_schema` sits ~2,000
lines away from the handler that implements it, the offered-tools-per-role list is a third
separate place, and the staff permission re-check is a fourth. Adding or changing a Tool means
editing several disconnected sites and hoping they stay in sync.

Worse, none of it is unit-testable. `claude.service.ts` has no unit tests — Tool behavior is only
ever exercised end-to-end through the webhook against live Dynamics + Supabase, because there is
no seam below the Anthropic client. To check "does `get_client_invoices` resolve a staff member's
named client correctly?" you must run the whole stack.

## Solution

As a maintainer, I want every Tool to live as a single entry in one **Tool registry**, so that a
Tool's schema, the roles allowed to use it, its permission gate, and its implementation are all
one thing in one place — and so that I can test a Tool's behavior through a small interface
without mocking the Anthropic client.

The registry becomes the **single source of truth**: the offered-tools list per role and the
defense-in-depth permission check are *derived* from it, never maintained separately. Dispatch
collapses to a single `runTool(name, args, ctx)` call used identically in the first round and the
follow-up loop. Tool handlers receive their service dependencies through a **ToolContext** built
once per turn, whose `deps` are narrow **Ports** — satisfied by the real service singletons in
production and by fakes in tests. That two-adapter seam is what makes a Tool testable through its
interface.

Migration is incremental (strangler): `runTool` falls back to the existing `if/else` chain for
Tools not yet moved, so the chain shrinks to zero one slice at a time and is deleted last. No Tool
changes its observable behavior, schema, or output during the migration — this is a deepening, not
a feature change.

## User Stories

1. As a maintainer, I want each Tool defined as one registry entry (`name`, `input_schema`,
   `roles`, optional `requiredPerm`, `handle`), so that everything a caller must know about a Tool
   is in one place.
2. As a maintainer, I want the offered-tools list for a role derived from the registry via
   `deriveOfferedTools(role, permittedKeys)`, so that I never maintain a second list that can
   drift from the handlers.
3. As a maintainer, I want the staff defense-in-depth permission check derived from each entry's
   `requiredPerm`, so that the gate lives next to the Tool it guards rather than inline in the
   dispatch loop.
4. As a maintainer, I want a single `runTool(name, args, ctx)` entry point called identically in
   the first Claude round and the follow-up loop, so that there is exactly one dispatch site
   instead of two partially-duplicated ones.
5. As a maintainer, I want Tool handlers to take `(args, ctx)` where `ctx` carries per-turn
   identity and injected Ports, so that a handler is a function of its inputs rather than of
   captured enclosing-scope variables.
6. As a maintainer, I want narrow Ports (`DynamicsPort`, `SupabasePort`, `MetaPort`) exposing only
   the methods Tools actually call, so that the seam is an honest contract and a test fake only
   implements the subset under exercise.
7. As a maintainer, I want the real service singletons to satisfy the Ports structurally, so that
   production wiring needs no adapter classes — only a typed assignment.
8. As a maintainer, I want to unit-test a Tool handler with a fake Port and no Anthropic client,
   so that I can verify Tool behavior in milliseconds instead of through a live webhook.
9. As a maintainer, I want `deriveOfferedTools` to be a pure function, so that role-to-tools
   mapping is testable directly with no I/O.
10. As a maintainer, I want `runTool` to reject a disallowed Tool (wrong role or missing
    `requiredPerm`) with the canned denial response, so that the permission invariant is enforced
    in one place and testable.
11. As a maintainer, I want `runTool` to fall back to the legacy `if/else` dispatch for any Tool
    not yet in the registry, so that I can migrate Tools a few at a time without breaking the
    others.
12. As a maintainer, I want the legacy dispatch chain and its duplicate in the follow-up loop both
    deleted once the registry is complete, so that the duplication is gone, not merely shadowed.
13. As a maintainer, I want handlers grouped by audience (`clientTools.ts`, `staffTools.ts`,
    `leadTools.ts`), so that each file stays readable and the table wires names to handlers.
14. As a maintainer, I want the shared client resolvers (resolve a name/phone to a Contact GUID,
    with disambiguation) available on `ctx`, so that the many staff Tools that need them stop
    re-declaring them inline.
15. As a maintainer, I want per-turn staged state (e.g. pending LoE / pending upload data)
    available on `ctx`, so that handlers like the LoE upload Tool no longer capture it from
    enclosing scope.
16. As a maintainer of the domain language, I want "Tool", "Tool registry", "ToolContext" and
    "Port" recorded in CONTEXT.md, so that future reviews and contributors use the same vocabulary.
17. As Tina (the bot), I want the same Tools to behave exactly as before the migration, so that no
    client, lead, or staff interaction changes.
18. As a TTT staff member, I want my permitted Tools to be offered and unpermitted ones blocked
    exactly as today, so that the registry's role/permission derivation is behavior-preserving.
19. As a client, I want document-upload, invoice-lookup and case Tools to keep returning the same
    results, so that the refactor is invisible to me.
20. As a lead, I want the onboarding Tools (IRP5 upload, LoE upload/confirm) to keep working
    across the migration, so that onboarding is uninterrupted.
21. As a reviewer, I want each strangler slice to be a small PR that moves a handful of Tools and
    adds their tests, so that I can verify correctness incrementally rather than in one 1,000-line
    diff.
22. As a maintainer, I want the first slice to cover the read-only client Tools (`get_my_details`,
    `get_tax_number`, `get_client_invoices`), so that the whole spine (registry → runTool →
    fallback → ToolContext → DynamicsPort → fake-Port test) is proven on the lowest-risk Tools
    before any write-Tool or multi-Port handler moves.
23. As a maintainer, I want a Tool's `handle` to keep returning the same `string` tool-result
    shape Claude already consumes, so that the Anthropic call loop and prompt-caching are
    untouched.
24. As a maintainer, I want to add a new Tool by adding one registry entry, so that the change is
    localized and the offered list and permission gate update automatically.

## Implementation Decisions

- **New module: the Tool registry**, under `src/services/tools/`. Layout grouped by audience:
  `registry.ts` (the `ToolContext` type, the Ports, the `REGISTRY` table, `runTool`,
  `deriveOfferedTools`) plus `clientTools.ts`, `staffTools.ts`, `leadTools.ts` for the handlers.
  Confirmed during grilling.
- **The registry is the single source of truth.** Both the offered-tools list (formerly the
  filtering logic in `claude.service.ts`) and the staff permission re-check (formerly inline in
  the dispatch loop) are derived from the `roles` and `requiredPerm` fields on each entry. No
  second list is maintained.
- **Tool entry shape** (came from the design grilling; encodes the decision more precisely than
  prose):
  ```ts
  type ToolEntry = {
    name: string;
    input_schema: object;          // the Anthropic schema, co-located with the handler
    roles: EntityType[];           // which entity types may be offered this Tool
    requiredPerm?: string;         // staff defense-in-depth gate, derived into the re-check
    handle(args: unknown, ctx: ToolContext): Promise<string>;
  };

  function runTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const entry = REGISTRY[name];
    if (!entry) return legacyDispatch(name, args, ctx);   // strangler fallback; shrinks to 0
    if (!entryAllowed(entry, ctx)) return DENIED;          // roles + requiredPerm, one gate
    return entry.handle(args, ctx);
  }
  ```
- **Dependencies are injected, not imported.** Handlers reach services only through `ctx.deps`.
  Direct singleton imports inside handlers are not allowed — that is what makes the test seam real
  rather than cosmetic.
- **Ports are narrow** — one interface per service exposing only the union of methods Tools
  actually call (`DynamicsPort` ~20 methods, `SupabasePort` ~4, `MetaPort` ~2), not the full
  service surface. The real `dynamicsService` / `supabaseService` / `metaWhatsAppService`
  singletons satisfy them structurally; production wiring is a typed assignment into
  `ctx.deps`, no adapter classes.
- **ToolContext** is built once per turn inside `claude.service.ts` and carries: per-turn identity
  (`contactId`, `phoneNumber`, `sessionId`, `entityType`, `ownerFilter`), the shared client
  resolvers, per-turn staged state (pending LoE / upload data), and `deps` (the Ports).
- **Dispatch collapses to one call site.** The first-round loop and the follow-up loop both invoke
  `runTool`. The two existing `if/else` blocks are deleted once their Tools are all migrated.
- **Strangler migration.** `runTool` falls back to the existing dispatch for un-migrated Tools.
  Tools move in small slices; the fallback and the legacy chain are deleted in the final slice.
- **Behavior-preserving.** No Tool's schema, role visibility, permission requirement, or output
  string changes. The migration is observable only to maintainers and tests.
- **First slice:** the read-only client Tools (`get_my_details`, `get_tax_number`,
  `get_client_invoices`) — stands up `registry.ts`, `DynamicsPort`, `ToolContext` construction,
  `runTool` with fallback, and their unit tests.
- **No schema/DB changes, no new API contracts, no DI framework.** The only "contract" is the Port
  interfaces and the `handle(args, ctx) => Promise<string>` signature.

## Testing Decisions

- **Test external behavior through the seam, not implementation details.** A handler test supplies
  `args` and a `ToolContext` whose Ports are fakes returning staged data, then asserts the
  returned tool-result string (its `status` / payload). A handler's contract includes the effect
  it has on its Ports, so asserting "the right Port method was called with the resolved GUID" is
  legitimate external behavior — but tests must not reach into private helpers or assert call
  ordering that isn't part of the contract.
- **Modules tested:**
  - `deriveOfferedTools(role, permittedKeys)` — pure; assert the offered set per role and that
    `requiredPerm`-gated Tools appear only with the matching permitted key.
  - `runTool` — assert it dispatches to the registry entry, returns the canned denial for a
    disallowed role/permission, and falls back to legacy dispatch for an unknown name.
  - Each migrated Tool handler — assert its returned string for the success, not-found,
    ambiguous, and error paths, using fake Ports.
- **Prior art:** the existing pure-decision unit tests are the model —
  `test/unit/caseRouting.test.ts`, `feedbackReply.test.ts`, `conversationCap.test.ts`,
  `docRecommendation.test.ts`. Handler tests differ only in that the Tool is impure: the purity is
  pushed to the Port seam (fakes) rather than the function being pure itself.
- **No live-connection tests are added.** The point of the seam is to remove the need for live
  Dynamics/Supabase to test Tool behavior. The existing webhook integration coverage remains as
  the end-to-end backstop.

## Out of Scope

- **Re-extracting bad-debt or wrap-up into `decide*` modules** — ruled out by ADR 0001; not
  touched here.
- **The role-context / system-prompt builders** (Candidate 2 from the review: pure
  `buildLeadRoleContext` / `buildStaffRoleContext` / `buildBadDebtGuidance`). This PRD only clears
  room for it; it is a separate piece of work.
- **Changing any Tool's schema, behavior, role visibility, permission, or output.** Strictly a
  deepening.
- **The Anthropic call loop, prompt assembly, prompt-caching breakpoints, retries, and
  usage/pricing logging** — untouched.
- **A persisted journey state machine** (ADR 0002) and any other domain decision — unrelated.
- **Migrating all 45 Tools in one pass** — explicitly rejected in favor of strangler slices.
- **Introducing a dependency-injection framework or service locator.** Ports are plain interfaces;
  `ctx.deps` is a plain object.

## Further Notes

- This is Candidate 1 from the 2026-06-24 architecture review; the design forks (inject via
  ToolContext, strangler migration, single-table role+permission, one Port per service,
  audience-grouped layout) were settled in the grilling that followed.
- The vocabulary (Tool, Tool registry, ToolContext, Port) is now recorded in CONTEXT.md.
- Completing this unblocks Candidate 2 (pure role-context builders) by shrinking
  `generateResponse` and giving it a cleaner spine.
- Consider recording an ADR 0003 for the Tool-registry decision, matching the role ADR 0001/0002
  play for the `decide*` and document-journey decisions — so a future review does not re-propose a
  different dispatch shape.
- The headline maintainer win, in the review's terms: **locality** (schema + handler + roles +
  permission concentrate in one entry), **leverage** (one interface, 45 Tools, one dispatch site),
  and the interface becoming the test surface (Tools testable with no Anthropic mock).
