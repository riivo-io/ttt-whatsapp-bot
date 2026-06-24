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
`{ name, input_schema, roles, requiredPerm?, handle }` — schema, role visibility, permission
gate, and implementation are one thing in one place.

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

5. **Strangler migration.** `runTool` falls back to the legacy dispatch (via
   `ctx.legacyDispatch`) for any Tool not yet in the registry. Tools move in small slices; the
   fallback and the legacy chain are deleted in the final slice. No Tool changes its schema,
   role visibility, permission, or output during the migration — this is a deepening, not a
   feature change.

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
- During migration the `input_schema` is briefly duplicated (registry entry + the `TOOLS` array
  that still supplies the Anthropic tool definitions and descriptions). The duplication is
  removed in the final slice when `TOOLS` is derived from the registry.
- **One pre-existing inconsistency was unified, not preserved.** The follow-up loop's
  `get_client_invoices` used a simpler first-match resolver (no ambiguous/error disambiguation,
  and it wrapped the client's own invoices in `{ client_id, client_name, invoices }`). The
  registry has one handler, so both sites now use the first-round behaviour (full
  `resolveClientDetailed` disambiguation; a client's own invoices return as a bare array). This
  is the canonical first-round contract; the follow-up path is reached only on a round-2+ tool
  call.

## First slice (this change)

The read-only client Tools `get_my_details`, `get_tax_number`, `get_client_invoices` — proving
the whole spine (registry → `runTool` → fallback → ToolContext → `DynamicsPort` → fake-Port
test) on the lowest-risk Tools before any write-Tool or multi-Port handler moves.
