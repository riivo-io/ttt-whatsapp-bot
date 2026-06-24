/**
 * Unit tests for the Tool registry spine + the three migrated read-only client
 * Tools (slice 1 of the Tool-registry migration; PRD `docs/PRD-tool-registry.md`,
 * ADR 0003). Modelled on `test/unit/invoiceMappers.test.ts` — Node built-in
 * runner, no Anthropic client, the Dynamics dependency supplied as a fake Port.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    runTool,
    deriveOfferedTools,
    makeClientResolvers,
    DENIED,
    type ToolContext,
    type DynamicsPort,
    type EntityType,
} from '../../src/services/tools';

// ---------------------------------------------------------------------------
// Fake DynamicsPort — returns staged data, records calls.
// ---------------------------------------------------------------------------

type FakeOverrides = Partial<DynamicsPort>;

function fakeDynamics(overrides: FakeOverrides = {}): DynamicsPort {
    return {
        getContactDetails: async () => null,
        getClientInvoices: async () => [],
        getContactTaxNumber: async () => null,
        getContactByPhone: async () => null,
        searchContactByName: async () => [],
        ...overrides,
    };
}

function buildCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    const dynamics = overrides.deps?.dynamics ?? fakeDynamics();
    const ownerFilter = overrides.ownerFilter;
    const resolvers = makeClientResolvers({ dynamics }, ownerFilter);
    return {
        contactId: 'contact-1',
        phoneNumber: '+27820000000',
        sessionId: 'sess-1',
        entityType: 'client',
        ownerFilter,
        permittedToolKeys: [],
        resolveClientId: resolvers.resolveClientId,
        resolveClientDetailed: resolvers.resolveClientDetailed,
        deps: { dynamics },
        legacyDispatch: async () => 'LEGACY',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// deriveOfferedTools — per role
// ---------------------------------------------------------------------------

test('deriveOfferedTools: client gets all three read-only client tools', () => {
    const offered = deriveOfferedTools('client', []);
    assert.deepStrictEqual(
        [...offered].sort(),
        ['get_client_invoices', 'get_my_details', 'get_tax_number'],
    );
});

test('deriveOfferedTools: staff gets get_client_invoices only with the matching permission', () => {
    assert.deepStrictEqual(deriveOfferedTools('user', []), []);
    assert.deepStrictEqual(deriveOfferedTools('user', ['view_outstanding_invoices']), ['get_client_invoices']);
});

test('deriveOfferedTools: leads and unknown callers get none of the migrated tools', () => {
    assert.deepStrictEqual(deriveOfferedTools('lead', []), []);
    assert.deepStrictEqual(deriveOfferedTools(undefined, ['view_outstanding_invoices']), []);
});

// ---------------------------------------------------------------------------
// runTool — dispatch / denial / legacy fallback
// ---------------------------------------------------------------------------

test('runTool: dispatches a migrated tool to its registry handler', async () => {
    const ctx = buildCtx({
        deps: { dynamics: fakeDynamics({ getContactTaxNumber: async () => '1234567890' }) },
    });
    const out = await runTool('get_tax_number', {}, ctx);
    assert.equal(out, 'Your Tax Number is: 1234567890');
});

test('runTool: denies a staff caller lacking the required permission', async () => {
    const ctx = buildCtx({ entityType: 'user', ownerFilter: 'staff-1', permittedToolKeys: [] });
    const out = await runTool('get_client_invoices', { client: 'Jules' }, ctx);
    assert.equal(out, DENIED);
});

test('runTool: denies a tool not offered to the caller role', async () => {
    // get_my_details is client-only; a staff caller is denied.
    const ctx = buildCtx({ entityType: 'user', ownerFilter: 'staff-1' });
    const out = await runTool('get_my_details', {}, ctx);
    assert.equal(out, DENIED);
});

test('runTool: falls back to legacy dispatch for an unknown tool name', async () => {
    let seen: { name: string; args: unknown } | null = null;
    const ctx = buildCtx({
        legacyDispatch: async (name, args) => {
            seen = { name, args };
            return 'LEGACY-RESULT';
        },
    });
    const out = await runTool('some_unmigrated_tool', { a: 1 }, ctx);
    assert.equal(out, 'LEGACY-RESULT');
    assert.deepStrictEqual(seen, { name: 'some_unmigrated_tool', args: { a: 1 } });
});

// ---------------------------------------------------------------------------
// get_my_details handler
// ---------------------------------------------------------------------------

test('get_my_details: returns the contact details JSON on success', async () => {
    const details = { contactid: 'contact-1', fullname: 'Jules Customer' };
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactDetails: async () => details }) } });
    const out = await runTool('get_my_details', {}, ctx);
    assert.equal(out, JSON.stringify(details));
});

test('get_my_details: returns the canned message when no details are found', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactDetails: async () => null }) } });
    const out = await runTool('get_my_details', {}, ctx);
    assert.equal(out, "I couldn't retrieve your details at this time.");
});

// ---------------------------------------------------------------------------
// get_tax_number handler
// ---------------------------------------------------------------------------

test('get_tax_number: returns the number when present', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactTaxNumber: async () => '9876543210' }) } });
    assert.equal(await runTool('get_tax_number', {}, ctx), 'Your Tax Number is: 9876543210');
});

test('get_tax_number: returns the not-found message when absent', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactTaxNumber: async () => null }) } });
    assert.equal(await runTool('get_tax_number', {}, ctx), 'I could not find a tax number on your profile.');
});

// ---------------------------------------------------------------------------
// get_client_invoices handler — client path
// ---------------------------------------------------------------------------

test('get_client_invoices: client gets their own invoices as a bare JSON array', async () => {
    const invoices = [{ new_name: 'INV1' }, { new_name: 'INV2' }];
    let askedFor: string | undefined;
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getClientInvoices: async (id: string) => {
                    askedFor = id;
                    return invoices;
                },
            }),
        },
    });
    const out = await runTool('get_client_invoices', {}, ctx);
    assert.equal(out, JSON.stringify(invoices));
    assert.equal(askedFor, 'contact-1'); // resolved off ctx identity, not args
});

// ---------------------------------------------------------------------------
// get_client_invoices handler — staff paths (success / ambiguous / not-found / error)
// ---------------------------------------------------------------------------

function staffCtx(overrides: FakeOverrides = {}, ctxOverrides: Partial<ToolContext> = {}): ToolContext {
    return buildCtx({
        entityType: 'user',
        ownerFilter: 'staff-1',
        permittedToolKeys: ['view_outstanding_invoices'],
        deps: { dynamics: fakeDynamics(overrides) },
        ...ctxOverrides,
    });
}

test('get_client_invoices: staff with no client name is asked for one', async () => {
    const ctx = staffCtx();
    const out = await runTool('get_client_invoices', {}, ctx);
    assert.equal(out, 'I need a client name or phone number to look up their invoices. Which client?');
});

test('get_client_invoices: staff success resolves the named client and wraps the result', async () => {
    const invoices = [{ new_name: 'INV9' }];
    const ctx = staffCtx({
        searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules Customer', mobilephone: '+27' }],
        getClientInvoices: async () => invoices,
    });
    const out = await runTool('get_client_invoices', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({ client_id: 'c-9', client_name: 'Jules Customer', invoices }));
});

test('get_client_invoices: staff ambiguous match returns the candidate list', async () => {
    const ctx = staffCtx({
        searchContactByName: async () => [
            { contactid: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { contactid: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    });
    const out = await runTool('get_client_invoices', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'multiple_matches',
        message: 'Multiple clients match "Jules". Ask the user which one they mean.',
        candidates: [
            { id: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { id: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    }));
});

test('get_client_invoices: staff not-found returns the not_found error string', async () => {
    const ctx = staffCtx({ searchContactByName: async () => [] });
    const out = await runTool('get_client_invoices', { client: 'Ghost' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'not_found',
        message: 'No client found matching "Ghost". Ask the user to provide the full name, or a phone number, or call get_my_clients to see the full list of their clients.',
    }));
});

test('get_client_invoices: staff lookup error surfaces as lookup_failed', async () => {
    const ctx = staffCtx({
        getContactByPhone: async () => { throw new Error('CRM down'); },
    });
    const out = await runTool('get_client_invoices', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'lookup_failed',
        message: 'Client lookup failed: CRM down. Tell the user the CRM had an error.',
    }));
});
