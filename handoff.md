# RALPH Handoff — Tool-registry migration

> ⚠️ **This handoff MUST be updated at the end of every iteration.** Before you
> finish, record what you did, move the completed issue out of "Next issues",
> and re-point the "Next issues" list at whatever remains. Leaving this doc
> stale breaks the next agent's pickup. This requirement is itself part of the
> definition of done for every issue.

## Done this iteration: Issue 1 — Registry spine + read-only client Tools
PRD: `docs/PRD-tool-registry.md` · ADR `docs/adr/0003-tool-registry-dispatch.md` · Glossary in
`CONTEXT.md` (§Tool, §Tool registry, §ToolContext, §Port) · Issue file:
`issues/01-tool-registry-spine-readonly-client-tools.md`.

This is **slice 1** of the strangler migration that collapses the duplicated `if/else` tool
dispatch in `claude.service.ts` into a single registry. It stands up the whole vertical seam and
proves it on the three lowest-risk, read-only client Tools: `get_my_details`, `get_tax_number`,
`get_client_invoices`.

### What changed
- **NEW `src/services/tools/registry.ts`** — the spine. Exports `ToolContext`, the narrow
  `DynamicsPort` (only the 5 methods these Tools + resolvers call), `ToolEntry`, `EntityType`,
  `ClientResolveResult`, the `REGISTRY` table + `register(...)`, `entryAllowed`, `runTool`,
  `makeClientResolvers`, the canned `DENIED` string, and the pure
  `deriveOfferedTools(role, permittedKeys)`. `runTool(name, args, ctx)` gates (roles +
  staff-only `requiredPerm`) then runs the handler; for an unmigrated name it falls back to
  `ctx.legacyDispatch`. The shared client resolvers (`resolveClientId` / `resolveClientDetailed`)
  are lifted here so staff Tools can resolve a named client.
- **NEW `src/services/tools/clientTools.ts`** — the three migrated handlers, each
  `handle(args, ctx) => Promise<string>` reaching Dynamics only through `ctx.deps`. Output
  strings are byte-for-byte the first-round originals. `register(...)` runs on import.
- **NEW `src/services/tools/index.ts`** — barrel; importing it guarantees `clientTools` has
  registered before any `runTool` / `deriveOfferedTools` call.
- **`src/services/claude.service.ts`** —
  - imports the registry; builds a `ToolContext` (`toolCtx`) **once per turn** after
    `ownerFilter`, carrying identity, the resolvers, `deps.dynamics = dynamicsService` (typed
    assignment, no adapter), `permittedToolKeys`, and a `legacyDispatch` bridge.
  - offered-tools list: the 3 migrated Tools are removed from the legacy `clientTools` /
    `staffTools` arrays and re-added via `deriveOfferedTools(...)`, unioned into an
    `offeredNames` set; `availableTools = TOOLS.filter(t => offeredNames.has(t.name))` preserves
    the original declaration order, so the offered surface per role is unchanged.
  - both dispatch sites (first round **and** the follow-up loop) gain `if (REGISTRY[functionName])
    → runTool(...)` at the top of the `if (contactId)` block; the now-dead legacy branches for
    the 3 Tools are deleted.
- **NEW `test/unit/toolRegistry.test.ts`** — 17 tests (Node built-in runner, fake `DynamicsPort`,
  no Anthropic client): `deriveOfferedTools` per role; `runTool` dispatch / denial (wrong role,
  missing perm) / legacy fallback; each handler's success + not-found + (for invoices)
  ambiguous + error paths.
- **`docs/adr/0003-tool-registry-dispatch.md`** (NEW) records the decision. **`CONTEXT.md`**
  defines Tool / Tool registry / ToolContext / Port.

### One intentional unification (NOT a pure no-op)
The follow-up loop's `get_client_invoices` previously used a *simpler* resolver (first-match, no
ambiguous/error disambiguation, and it wrapped a client's own invoices as
`{ client_id, client_name, invoices }`). The registry has **one** handler, so both sites now use
the first-round contract: full `resolveClientDetailed` disambiguation, and a client's own
invoices return as a **bare JSON array**. This converges a pre-existing inconsistency onto the
canonical first-round behaviour (the follow-up path is only reached on a round-2+ tool call).
Recorded in ADR 0003 §Consequences.

### Verification
- `./node_modules/.bin/tsc --noEmit` → clean (full working tree)
- `npm test` → 97/97 pass (80 prior + 17 new)

### Working-tree caution (READ THIS — the tree is heavily entangled)
The working tree carries a large blob of **uncommitted, interdependent** work from the
document-collection journey (Issues 25/26/27) **and** bad-debt collection, spanning
`claude.service.ts`, `pendingUpload.service.ts`, `whatsappProcessor.ts`, `dynamics.service.ts`,
`requiredDocuments.service.ts`, `taxFaq.service.ts`, `case.service.ts`, and more. None of it is
in HEAD. These changes are interdependent (e.g. `pendingUpload` renamed `missingDocs` →
`outstanding`, and `generateResponse` gained an 11th `badDebt` param) — reverting any one file in
isolation breaks `tsc`.

**This commit staged ONLY the Issue-1 hunks** in `claude.service.ts`. The method that worked:
build the Issue-1-only version on top of a clean `git checkout HEAD -- claude.service.ts`,
`git diff > issue1.patch`, restore the full working tree, then `git apply --cached issue1.patch`.
Do NOT `git add` the whole file — you will sweep the journey/bad-debt work into your commit.
`CONTEXT.md`, `docs/adr/0002-*`, `docs/PRD-*`, `issues/*`, and many others are still untracked.

## Next issues — Tool-registry migration (PRD `docs/PRD-tool-registry.md`)
The spine is proven. Remaining strangler slices live as local issue files:

- **`issues/02-tool-registry-remaining-readonly-client-tools.md`** — migrate the rest of the
  read-only client Tools onto the registry (next; unblocked now that slice 1 is in).
- **`issues/03-tool-registry-staff-lookup-tools-permission-gate.md`** — staff lookup Tools +
  exercising the `requiredPerm` gate through `deriveOfferedTools` / `entryAllowed`.

Each slice: move a handful of Tools into an audience-grouped module (`clientTools.ts` is done;
`staffTools.ts` / `leadTools.ts` are still to be created), add their entries to `REGISTRY`,
delete their legacy branches at both dispatch sites, add fake-Port handler tests. The legacy
`if/else` chain and the `ctx.legacyDispatch` fallback are deleted in the **final** slice, once
`REGISTRY` covers every Tool. `TOOLS` still supplies the Anthropic tool definitions + descriptions
during the migration; it is derived from the registry only in that final slice.

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
- **Document-collection journey** (Issues 24–27): stateless, client-initiated, list-once,
  self-healing with an unverified escape hatch. PRD `.scratch/document-journey/PRD.md`, ADR 0002.
  Issue 24 is committed (`c3621d2`); 25/26/27 live in the working tree (see caution above).
- **Case-routing extraction** (Issues 19–21): the routing decision is a pure, tested domain
  module (`src/domain/caseRouting.ts`); the processor is a thin applier. Committed.
