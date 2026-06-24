/**
 * The Tool registry — single source of truth for what a Tool is.
 *
 * A **Tool** is a capability the bot can invoke during a Claude turn. Each Tool
 * lives as one entry in the `REGISTRY` table: its Anthropic `input_schema`, the
 * roles allowed to be offered it, its optional staff permission gate, and its
 * handler are all one thing in one place.
 *
 * Dispatch collapses to a single `runTool(name, args, ctx)` call used identically
 * at both Claude dispatch sites (first round + follow-up loop). For a Tool not yet
 * migrated into the registry, `runTool` falls back to the legacy `if/else` chain
 * via `ctx.legacyDispatch` (strangler migration — the fallback shrinks to zero one
 * slice at a time).
 *
 * Handlers reach services only through `ctx.deps` (narrow **Ports**), never via a
 * direct singleton import. That seam is what makes a Tool testable with a fake Port
 * and no Anthropic client. See `docs/PRD-tool-registry.md` and ADR 0003.
 */

// Which entity types may be offered a Tool. Matches claude.service's entityType
// space ('client' | 'lead' | 'user'); 'unknown' callers map to undefined and
// match no roles.
export type EntityType = 'client' | 'lead' | 'user';

/**
 * Narrow Port over the Dynamics service — only the methods the migrated Tools
 * (and the shared client resolvers) actually call. The real `dynamicsService`
 * singleton satisfies this structurally, so production wiring is a typed
 * assignment with no adapter class; a test supplies a fake implementing only the
 * subset under exercise.
 */
export interface DynamicsPort {
    getContactDetails(contactId: string): Promise<any | null>;
    getClientInvoices(contactId: string): Promise<any[]>;
    getContactTaxNumber(contactId: string): Promise<string | null>;
    getContactByPhone(phoneNumber: string): Promise<any | null>;
    searchContactByName(name: string, ownerId?: string): Promise<any[]>;
}

/**
 * The result of resolving a staff member's free-text client reference (a name,
 * phone number, or GUID) to a Contact. Carried so a Tool can disambiguate with
 * the user ("did you mean X?") or ask for more detail.
 */
export type ClientResolveResult =
    | { status: 'found'; id: string; fullname: string }
    | { status: 'ambiguous'; candidates: { id: string; fullname: string; mobilephone: string | null }[] }
    | { status: 'not_found'; tried: string }
    | { status: 'error'; message: string };

/**
 * Built once per turn inside `claude.service.ts`. Carries per-turn identity, the
 * shared client resolvers, the injected Ports, and the legacy-dispatch bridge.
 */
export interface ToolContext {
    contactId: string | null;
    phoneNumber: string | null;
    sessionId: string | null;
    entityType: EntityType | undefined;
    /** Restricts staff contact lookups to clients they own; undefined for clients/leads. */
    ownerFilter: string | undefined;
    /** Staff permission keys loaded from the session (role_tools). */
    permittedToolKeys: string[];
    /** Resolve a name/phone/GUID to a Contact GUID, or null. */
    resolveClientId(clientInput?: string): Promise<string | null>;
    /** Resolve with disambiguation status + candidates. */
    resolveClientDetailed(clientInput?: string): Promise<ClientResolveResult>;
    deps: { dynamics: DynamicsPort };
    /** Strangler fallback for Tools not yet in the registry. */
    legacyDispatch(name: string, args: unknown): Promise<string>;
}

export interface ToolEntry {
    name: string;
    input_schema: object;           // the Anthropic schema, co-located with the handler
    roles: EntityType[];            // which entity types may be offered this Tool
    requiredPerm?: string;          // staff defense-in-depth gate, derived into the re-check
    handle(args: unknown, ctx: ToolContext): Promise<string>;
}

// The canned denial returned when a caller is offered a Tool it isn't allowed —
// byte-for-byte the string the inline defense-in-depth check has always returned.
export const DENIED =
    'You do not have access to this feature. Please contact your administrator if you believe this is incorrect.';

/**
 * Build the shared client resolvers over a Port + owner scope. Lifted out of the
 * inline first-round closures so they can be attached to `ctx` and reused by every
 * Tool that needs to resolve a staff member's named client.
 */
export function makeClientResolvers(deps: { dynamics: DynamicsPort }, ownerFilter: string | undefined) {
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const resolveClientId = async (clientInput?: string): Promise<string | null> => {
        if (!clientInput) return null;
        const input = clientInput.trim();
        if (guidRegex.test(input)) return input;
        const byPhone = await deps.dynamics.getContactByPhone(input);
        if (byPhone?.type === 'client') return byPhone.id;
        const byName = await deps.dynamics.searchContactByName(input, ownerFilter);
        if (byName.length > 0) return byName[0].contactid;
        return null;
    };

    const resolveClientDetailed = async (clientInput?: string): Promise<ClientResolveResult> => {
        if (!clientInput?.trim()) return { status: 'not_found', tried: '' };
        const input = clientInput.trim();
        if (guidRegex.test(input)) return { status: 'found', id: input, fullname: '' };
        try {
            const byPhone = await deps.dynamics.getContactByPhone(input);
            if (byPhone?.type === 'client') {
                return { status: 'found', id: byPhone.id, fullname: byPhone.fullname || '' };
            }
            const matches = await deps.dynamics.searchContactByName(input, ownerFilter);
            if (matches.length === 0) return { status: 'not_found', tried: input };
            if (matches.length === 1) {
                return { status: 'found', id: matches[0].contactid, fullname: matches[0].fullname };
            }
            return {
                status: 'ambiguous',
                candidates: matches.map((m: any) => ({ id: m.contactid, fullname: m.fullname, mobilephone: m.mobilephone })),
            };
        } catch (e: any) {
            return { status: 'error', message: e?.message || 'Lookup failed' };
        }
    };

    return { resolveClientId, resolveClientDetailed };
}

// The registry table is populated by the audience-grouped modules (clientTools,
// staffTools, leadTools) calling `register`. Slice 1 wires only clientTools.
export const REGISTRY: Record<string, ToolEntry> = {};

export function register(entries: ToolEntry[]): void {
    for (const entry of entries) {
        REGISTRY[entry.name] = entry;
    }
}

/**
 * A Tool is allowed when the caller's role is in its `roles`, and — for staff —
 * its `requiredPerm` (if any) is in the caller's permitted keys. The permission
 * gate is staff-only: clients/leads are filtered by role alone, exactly as the
 * legacy dispatch did.
 */
export function entryAllowed(entry: ToolEntry, ctx: ToolContext): boolean {
    if (!ctx.entityType || !entry.roles.includes(ctx.entityType)) return false;
    if (ctx.entityType === 'user' && entry.requiredPerm && !ctx.permittedToolKeys.includes(entry.requiredPerm)) {
        return false;
    }
    return true;
}

/**
 * The single dispatch entry point. For a migrated Tool it gates then runs the
 * handler; for any other name it falls back to the legacy chain (strangler).
 */
export function runTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const entry = REGISTRY[name];
    if (!entry) return ctx.legacyDispatch(name, args);
    if (!entryAllowed(entry, ctx)) return Promise.resolve(DENIED);
    return entry.handle(args, ctx);
}

/**
 * Pure: the offered-Tool names from the registry for a role + permitted keys. The
 * offered-tools list for migrated Tools is derived from here, never maintained as
 * a separate list. Staff permission gating applies only to the 'user' role.
 */
export function deriveOfferedTools(role: EntityType | undefined, permittedKeys: string[]): string[] {
    if (!role) return [];
    return Object.values(REGISTRY)
        .filter(entry => {
            if (!entry.roles.includes(role)) return false;
            if (role === 'user' && entry.requiredPerm && !permittedKeys.includes(entry.requiredPerm)) return false;
            return true;
        })
        .map(entry => entry.name);
}
