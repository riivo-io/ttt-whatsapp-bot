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
    REGISTRY,
    DENIED,
    type ToolContext,
    type DynamicsPort,
    type TaxFaqPort,
    type MetaPort,
    type PdfPort,
    type GraphMailPort,
    type SupabasePort,
    type FormsPort,
    type Irp5Port,
    type LoeOcrPort,
    type PendingUploadState,
    type PendingLoeState,
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
        getClientCases: async () => [],
        getStaffCases: async () => [],
        getContactOwnerId: async () => null,
        getSystemUserById: async () => null,
        getContactLocation: async () => null,
        getOpenInvoiceTotal: async () => ({ total: 0, count: 0 }),
        getContactReferralCode: async () => null,
        getMyClients: async () => [],
        getMyLeads: async () => [],
        searchLeadByName: async () => [],
        getTaskTypes: async () => [],
        getIndustries: async () => [],
        getInvoiceByNumber: async () => null,
        updateWhatsAppOptIn: async () => true,
        createCallbackRequest: async () => true,
        getContactTaxProfile: async () => null,
        logTaxFormSentToContact: async () => ({ success: true }),
        markDocumentClientStated: async () => ({ success: true, taxYear: 2026 }),
        // Staff write methods (slice 5).
        createCase: async () => ({ new_name: 'CASE-1', new_caseid: 'case-1' }),
        createLead: async () => ({ new_leadid: 'lead-1' }),
        createContact: async () => ({ contactid: 'contact-new' }),
        createInvoice: async () => ({ new_invoicesid: 'inv-1' }),
        createTask: async () => ({ success: true }),
        getContactByPhoneAndType: async () => null,
        logInvoiceSentToContact: async () => ({ success: true }),
        // Staff read + lead-onboarding / LoE methods (slice 6).
        searchCaseByName: async () => [],
        searchContactByIdNumber: async () => null,
        linkPhoneToContact: async () => true,
        checkLoeAlreadyReceived: async () => ({ alreadyReceived: false }),
        uploadLoeFileToCrm: async () => ({ success: true }),
        writeLoeFieldsToLead: async () => ({ success: true, flagSet: true }),
        ...overrides,
    };
}

// Fake Ports for the slice-4 document/action Tools. Each returns a benign default;
// individual tests override the one method they exercise.
function fakeMeta(overrides: Partial<MetaPort> = {}): MetaPort {
    return { sendDocument: async () => ({ delivered: true, dryRun: false }), ...overrides };
}
function fakeGraphMail(overrides: Partial<GraphMailPort> = {}): GraphMailPort {
    return { sendMail: async () => true, ...overrides };
}
function fakeSupabase(overrides: Partial<SupabasePort> = {}): SupabasePort {
    return { flagSessionDocUpload: async () => {}, flagSessionEscalation: async () => {}, ...overrides };
}
function fakeForms(overrides: Partial<FormsPort> = {}): FormsPort {
    return { resolveLatestFormFile: async () => null, ...overrides };
}
function fakePdf(overrides: Partial<PdfPort> = {}): PdfPort {
    return { generateInvoicePdf: async () => Buffer.from('pdf'), ...overrides };
}
function fakeIrp5(overrides: Partial<Irp5Port> = {}): Irp5Port {
    return {
        processClientIrp5Upload: async () => ({ status: 'error', error: 'stub', message: 'stub' }),
        processStateBLeadIrp5Upload: async () => JSON.stringify({ status: 'irp5_staged_for_lead' }),
        ...overrides,
    };
}
function fakePendingUpload(overrides: Partial<PendingUploadState> = {}): PendingUploadState {
    return {
        has: () => false,
        peek: () => null,
        clear: () => {},
        save: async () => ({ success: false }),
        ...overrides,
    };
}
function fakeLoeOcr(overrides: Partial<LoeOcrPort> = {}): LoeOcrPort {
    return {
        isConfigured: () => false,
        ocrDocument: async () => ({ fullMarkdown: '', pageCount: 0 }),
        extractBankingDetails: async () => ({}),
        ...overrides,
    };
}
function fakePendingLoe(overrides: Partial<PendingLoeState> = {}): PendingLoeState {
    return {
        get: async () => null,
        save: async () => null,
        confirm: async () => null,
        delete: async () => {},
        updateField: async () => false,
        ...overrides,
    };
}

// Fake TaxFaqPort — each method echoes a tagged JSON string capturing the params
// it received, so a handler test can assert the ctx → params mapping.
function fakeTaxFaq(overrides: Partial<TaxFaqPort> = {}): TaxFaqPort {
    return {
        getRefundStatus: async (p) => JSON.stringify({ tool: 'refund', ...p }),
        getSubmissionStatus: async (p) => JSON.stringify({ tool: 'submission', ...p }),
        getAuditStatus: async (p) => JSON.stringify({ tool: 'audit', ...p }),
        getReceivedDocuments: async (p) => JSON.stringify({ tool: 'received', ...p }),
        getRequiredDocuments: async (p) => JSON.stringify({ tool: 'required', ...p }),
        ...overrides,
    };
}

// A test may override any top-level ToolContext field and supply only the
// subset of Ports it exercises (e.g. `deps: { dynamics }`); buildCtx fills the
// rest with fakes.
type CtxOverrides = Partial<Omit<ToolContext, 'deps'>> & { deps?: Partial<ToolContext['deps']> };

function buildCtx(overrides: CtxOverrides = {}): ToolContext {
    // Pull deps out of overrides so the trailing `...rest` spread can't clobber
    // the merged deps object below with a partial (e.g. a test passing only
    // `deps: { dynamics }`).
    const { deps: depOverrides, ...rest } = overrides;
    const dynamics = depOverrides?.dynamics ?? fakeDynamics();
    const taxFaq = depOverrides?.taxFaq ?? fakeTaxFaq();
    const meta = depOverrides?.meta ?? fakeMeta();
    const graphMail = depOverrides?.graphMail ?? fakeGraphMail();
    const supabase = depOverrides?.supabase ?? fakeSupabase();
    const forms = depOverrides?.forms ?? fakeForms();
    const irp5 = depOverrides?.irp5 ?? fakeIrp5();
    const pdf = depOverrides?.pdf ?? fakePdf();
    const loeOcr = depOverrides?.loeOcr ?? fakeLoeOcr();
    const ownerFilter = rest.ownerFilter;
    const resolvers = makeClientResolvers({ dynamics }, ownerFilter);
    return {
        contactId: 'contact-1',
        phoneNumber: '+27820000000',
        sessionId: 'sess-1',
        entityType: 'client',
        userFullName: 'Jules Customer',
        ownerFilter,
        permittedToolKeys: [],
        resolveClientId: resolvers.resolveClientId,
        resolveClientDetailed: resolvers.resolveClientDetailed,
        pendingUpload: fakePendingUpload(),
        pendingLoe: fakePendingLoe(),
        isStateBLeadUpload: false,
        deps: { dynamics, taxFaq, meta, graphMail, supabase, forms, irp5, pdf, loeOcr },
        ...rest,
    };
}

// ---------------------------------------------------------------------------
// deriveOfferedTools — per role
// ---------------------------------------------------------------------------

test('deriveOfferedTools: client gets every read-only client tool, ungated by permissions', () => {
    const offered = deriveOfferedTools('client', []);
    assert.deepStrictEqual(
        [...offered].sort(),
        [
            'escalate_to_taxcrew',
            'get_audit_status',
            'get_client_cases',
            'get_client_invoices',
            'get_invoice_pdf',
            'get_my_consultant',
            'get_my_details',
            'get_my_referral_code',
            'get_office_contact',
            'get_outstanding_balance',
            'get_received_documents',
            'get_refund_status',
            'get_required_documents',
            'get_submission_status',
            'get_tax_number',
            'list_tax_forms',
            'mark_document_already_sent',
            'opt_out_whatsapp',
            'request_consultant_callback',
            'save_document',
            'send_tax_form',
            'upload_irp5',
        ],
    );
});

test('deriveOfferedTools: staff get only the permission-matched registry tools', () => {
    // get_industries (ungated lookup), save_document (ungated upload), and
    // refer_friend (ungated staff write, slice 5) are always offered to staff,
    // even with no permitted keys.
    assert.deepStrictEqual([...deriveOfferedTools('user', [])].sort(), ['get_industries', 'refer_friend', 'save_document']);
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['view_outstanding_invoices'])].sort(),
        ['get_client_invoices', 'get_industries', 'get_outstanding_balance', 'refer_friend', 'save_document'],
    );
    // view_open_cases now also offers get_case_by_name (staff read, slice 6).
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['view_open_cases'])].sort(),
        ['get_case_by_name', 'get_client_cases', 'get_industries', 'refer_friend', 'save_document'],
    );
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['view_open_cases', 'view_outstanding_invoices'])].sort(),
        ['get_case_by_name', 'get_client_cases', 'get_client_invoices', 'get_industries', 'get_outstanding_balance', 'refer_friend', 'save_document'],
    );
    // get_invoice_pdf (client tool, slice 4) and send_invoice_pdf (staff write,
    // slice 5) both gate on send_invoice_pdf.
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['send_invoice_pdf'])].sort(),
        ['get_industries', 'get_invoice_pdf', 'refer_friend', 'save_document', 'send_invoice_pdf'],
    );
});

test('deriveOfferedTools: staff lookup Tools gate on lookup_client / lookup_lead / create_task', () => {
    // save_document (slice 4) and refer_friend (slice 5) are ungated and always
    // offered to staff, so they ride along in each permitted-key combination.
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['lookup_client'])].sort(),
        ['get_client_details', 'get_industries', 'get_my_clients', 'refer_friend', 'save_document', 'search_contact_by_name'],
    );
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['lookup_lead'])].sort(),
        ['get_industries', 'get_my_leads', 'refer_friend', 'save_document', 'search_lead_by_name'],
    );
    // create_task perm offers both get_task_types (the lookup) and create_task
    // (the write Tool, slice 5).
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['create_task'])].sort(),
        ['create_task', 'get_industries', 'get_task_types', 'refer_friend', 'save_document'],
    );
});

test('deriveOfferedTools: staff write Tools each gate on their own create permission (slice 5)', () => {
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['create_case'])].sort(),
        ['create_case', 'get_industries', 'refer_friend', 'save_document'],
    );
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['create_lead'])].sort(),
        ['create_lead', 'get_industries', 'refer_friend', 'save_document'],
    );
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['create_contact'])].sort(),
        ['create_contact', 'get_industries', 'refer_friend', 'save_document'],
    );
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['create_invoice'])].sort(),
        ['create_invoice', 'get_industries', 'refer_friend', 'save_document'],
    );
});

test('deriveOfferedTools: leads get the client document/escalation Tools (slice 4)', () => {
    // save_document, escalate_to_taxcrew and upload_irp5 carry 'lead' in roles.
    // (The State-B-only restriction on upload_irp5 lives in claude.service, not
    // in the role-based registry derivation.)
    assert.deepStrictEqual(
        [...deriveOfferedTools('lead', [])].sort(),
        ['escalate_to_taxcrew', 'save_document', 'upload_irp5'],
    );
    // Unknown callers (no entityType) still get nothing from the registry.
    assert.deepStrictEqual(deriveOfferedTools(undefined, ['view_outstanding_invoices']), []);
});

test('deriveOfferedTools: unknown callers get only verify_identity (slice 6)', () => {
    // The 'unknown' role added in slice 6 — verify_identity is the sole entry
    // offered to a caller whose phone isn't in the system, regardless of keys.
    assert.deepStrictEqual([...deriveOfferedTools('unknown', [])], ['verify_identity']);
    assert.deepStrictEqual([...deriveOfferedTools('unknown', ['view_open_cases'])], ['verify_identity']);
});

test('deriveOfferedTools: the LoE trio gates on upload_letter_of_engagement (slice 6)', () => {
    assert.deepStrictEqual(
        [...deriveOfferedTools('user', ['upload_letter_of_engagement'])].sort(),
        ['confirm_loe_upload', 'get_industries', 'refer_friend', 'save_document', 'update_loe_field', 'upload_letter_of_engagement'],
    );
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

test('registry: every entry carries a non-empty description + input_schema (TOOLS is derived from these)', () => {
    // The Anthropic tool definitions (claude.service TOOLS) are derived from the
    // registry now, so a missing description/schema would silently ship a malformed
    // tool definition. Guard the invariant at the source (ADR 0003, final slice).
    for (const entry of Object.values(REGISTRY)) {
        assert.equal(typeof entry.description, 'string', `${entry.name} description type`);
        assert.ok(entry.description.length > 0, `${entry.name} has a non-empty description`);
        assert.equal(typeof entry.input_schema, 'object', `${entry.name} has an input_schema`);
        assert.ok(entry.input_schema !== null, `${entry.name} input_schema not null`);
    }
});

test('runTool: an unknown tool name is a hard error (no legacy fallback)', async () => {
    // The strangler migration is complete — every Tool is a registry entry, so
    // an unknown name rejects rather than silently falling back (ADR 0003, final slice).
    const ctx = buildCtx({});
    await assert.rejects(
        () => runTool('some_unmigrated_tool', { a: 1 }, ctx),
        /Unknown tool: some_unmigrated_tool/,
    );
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
        deps: { dynamics: fakeDynamics(overrides), taxFaq: fakeTaxFaq() },
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

// ---------------------------------------------------------------------------
// get_client_cases handler — client + staff paths
// ---------------------------------------------------------------------------

test('get_client_cases: client gets their own cases as a bare JSON array', async () => {
    const cases = [{ new_name: 'Return 2025' }];
    let askedFor: string | undefined;
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({ getClientCases: async (id: string) => { askedFor = id; return cases; } }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_client_cases', {}, ctx);
    assert.equal(out, JSON.stringify(cases));
    assert.equal(askedFor, 'contact-1');
});

function casesStaffCtx(overrides: FakeOverrides = {}): ToolContext {
    return buildCtx({
        entityType: 'user',
        ownerFilter: 'staff-1',
        permittedToolKeys: ['view_open_cases'],
        deps: { dynamics: fakeDynamics(overrides), taxFaq: fakeTaxFaq() },
    });
}

test('get_client_cases: staff with no client name gets their own assigned cases', async () => {
    const cases = [{ new_name: 'Staff case' }];
    let askedFor: string | undefined;
    const ctx = casesStaffCtx({ getStaffCases: async (id: string) => { askedFor = id; return cases; } });
    const out = await runTool('get_client_cases', {}, ctx);
    assert.equal(out, JSON.stringify(cases));
    assert.equal(askedFor, 'contact-1'); // the staff member's own contactId
});

test('get_client_cases: staff success resolves the named client and wraps the result', async () => {
    const cases = [{ new_name: 'Return 2025' }];
    const ctx = casesStaffCtx({
        searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules Customer', mobilephone: '+27' }],
        getClientCases: async () => cases,
    });
    const out = await runTool('get_client_cases', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({ client_id: 'c-9', client_name: 'Jules Customer', cases }));
});

test('get_client_cases: staff ambiguous match returns the candidate list', async () => {
    const ctx = casesStaffCtx({
        searchContactByName: async () => [
            { contactid: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { contactid: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    });
    const out = await runTool('get_client_cases', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'multiple_matches',
        message: 'Multiple clients match "Jules". Ask the user which one they mean.',
        candidates: [
            { id: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { id: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    }));
});

test('get_client_cases: staff not-found returns the not_found error string', async () => {
    const ctx = casesStaffCtx({ searchContactByName: async () => [] });
    const out = await runTool('get_client_cases', { client: 'Ghost' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'not_found',
        message: 'No client found matching "Ghost". Ask for the full name or phone number, or call get_my_clients.',
    }));
});

test('get_client_cases: staff lookup error surfaces as lookup_failed', async () => {
    const ctx = casesStaffCtx({ getContactByPhone: async () => { throw new Error('CRM down'); } });
    const out = await runTool('get_client_cases', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'lookup_failed',
        message: 'Client lookup failed: CRM down.',
    }));
});

// ---------------------------------------------------------------------------
// get_outstanding_balance handler — client + staff paths
// ---------------------------------------------------------------------------

test('get_outstanding_balance: client gets their own balance off ctx identity', async () => {
    let askedFor: string | undefined;
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getOpenInvoiceTotal: async (id: string) => { askedFor = id; return { total: 1234.5, count: 2 }; },
            }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_outstanding_balance', {}, ctx);
    assert.equal(out, JSON.stringify({
        client_id: 'contact-1',
        outstanding_amount: 'R1234.50',
        open_invoices: 2,
    }));
    assert.equal(askedFor, 'contact-1');
});

function balanceStaffCtx(overrides: FakeOverrides = {}): ToolContext {
    return buildCtx({
        entityType: 'user',
        ownerFilter: 'staff-1',
        permittedToolKeys: ['view_outstanding_invoices'],
        deps: { dynamics: fakeDynamics(overrides), taxFaq: fakeTaxFaq() },
    });
}

test('get_outstanding_balance: staff success resolves the named client and wraps the total', async () => {
    const ctx = balanceStaffCtx({
        searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules Customer', mobilephone: '+27' }],
        getOpenInvoiceTotal: async () => ({ total: 999, count: 1 }),
    });
    const out = await runTool('get_outstanding_balance', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({
        client_id: 'c-9',
        client_name: 'Jules Customer',
        outstanding_amount: 'R999.00',
        open_invoices: 1,
    }));
});

test('get_outstanding_balance: staff ambiguous match returns the candidate list', async () => {
    const ctx = balanceStaffCtx({
        searchContactByName: async () => [
            { contactid: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { contactid: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    });
    const out = await runTool('get_outstanding_balance', { client: 'Jules' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'multiple_matches',
        message: 'Multiple clients match "Jules". Ask the user which one they mean.',
        candidates: [
            { id: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { id: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    }));
});

test('get_outstanding_balance: staff not-found returns the not_found error string', async () => {
    const ctx = balanceStaffCtx({ searchContactByName: async () => [] });
    const out = await runTool('get_outstanding_balance', { client: 'Ghost' }, ctx);
    assert.equal(out, JSON.stringify({
        error: 'not_found',
        message: 'No client found matching "Ghost".',
    }));
});

// ---------------------------------------------------------------------------
// get_my_consultant handler
// ---------------------------------------------------------------------------

test('get_my_consultant: returns the consultant on success', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getContactOwnerId: async () => 'owner-1',
                getSystemUserById: async () => ({ id: 'owner-1', fullname: 'Sam Consultant', email: 'sam@ttt.co.za' }),
            }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_my_consultant', {}, ctx);
    assert.equal(out, JSON.stringify({
        status: 'success',
        fullname: 'Sam Consultant',
        email: 'sam@ttt.co.za',
        message: 'Your consultant is Sam Consultant. You can reach them at sam@ttt.co.za.',
    }));
});

test('get_my_consultant: omits the email line when the consultant has no email', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getContactOwnerId: async () => 'owner-1',
                getSystemUserById: async () => ({ id: 'owner-1', fullname: 'Sam Consultant', email: null }),
            }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_my_consultant', {}, ctx);
    assert.equal(out, JSON.stringify({
        status: 'success',
        fullname: 'Sam Consultant',
        email: null,
        message: 'Your consultant is Sam Consultant.',
    }));
});

test('get_my_consultant: no_consultant when no owner is assigned', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactOwnerId: async () => null }), taxFaq: fakeTaxFaq() } });
    const out = await runTool('get_my_consultant', {}, ctx);
    assert.equal(out, JSON.stringify({
        status: 'no_consultant',
        message: "You don't have a dedicated consultant assigned yet. Would you like me to request a callback from our team?",
    }));
});

test('get_my_consultant: no_consultant when the owner record cannot be loaded', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({ getContactOwnerId: async () => 'owner-1', getSystemUserById: async () => null }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_my_consultant', {}, ctx);
    assert.equal(out, JSON.stringify({
        status: 'no_consultant',
        message: "You don't have a dedicated consultant assigned yet. Would you like me to request a callback from our team?",
    }));
});

// ---------------------------------------------------------------------------
// get_office_contact handler
// ---------------------------------------------------------------------------

test('get_office_contact: returns the nearest branch when location matches a region', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getContactLocation: async () => ({ city: 'Umhlanga', province: 'KwaZulu-Natal', geographicLocation: null }),
            }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_office_contact', {}, ctx);
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, 'success');
    assert.match(parsed.message, /Head Office \(Durban\)/);
    assert.match(parsed.message, /\+27 31 764 7733/);
    // A single matched branch — not the full list.
    assert.doesNotMatch(parsed.message, /Cape Town/);
});

test('get_office_contact: lists all branches when the location is unknown', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({ getContactLocation: async () => null }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_office_contact', {}, ctx);
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, 'success');
    assert.match(parsed.message, /Head Office \(Durban\)/);
    assert.match(parsed.message, /Johannesburg/);
    assert.match(parsed.message, /Cape Town/);
    assert.match(parsed.message, /Port Elizabeth/);
});

test('get_office_contact: falls back to all branches when the location lookup throws', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getContactLocation: async () => { throw new Error('CRM down'); },
            }),
            taxFaq: fakeTaxFaq(),
        },
    });
    const out = await runTool('get_office_contact', {}, ctx);
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, 'success');
    assert.match(parsed.message, /Cape Town/);
});

// ---------------------------------------------------------------------------
// get_my_referral_code handler
// ---------------------------------------------------------------------------

test('get_my_referral_code: missing_code when no code is on the contact', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactReferralCode: async () => null }), taxFaq: fakeTaxFaq() } });
    const out = await runTool('get_my_referral_code', {}, ctx);
    assert.equal(out, JSON.stringify({
        status: 'missing_code',
        code: null,
        message: 'No referral code is set on this contact record. Apologise briefly, offer to have the consultant look into it (request_consultant_callback). Do NOT invent a code.',
    }));
});

test('get_my_referral_code: returns the referral payload carrying the code on success', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactReferralCode: async () => 'REF123' }), taxFaq: fakeTaxFaq() } });
    const out = await runTool('get_my_referral_code', {}, ctx);
    const payload = JSON.parse(out);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.code, 'REF123');
    assert.ok(payload.magic_link.includes('REF123'));
});

// ---------------------------------------------------------------------------
// Tax-season FAQ Tools — delegate to the TaxFaqPort with the mapped params
// ---------------------------------------------------------------------------

test('get_required_documents: delegates to the port with contactId + parsed tax_year', async () => {
    const ctx = buildCtx();
    const out = await runTool('get_required_documents', { tax_year: 2026 }, ctx);
    assert.deepStrictEqual(JSON.parse(out), { tool: 'required', contactId: 'contact-1', taxYear: 2026 });
});

test('get_required_documents: omits tax_year when it is not a number', async () => {
    const ctx = buildCtx();
    const out = await runTool('get_required_documents', { tax_year: 'whoops' }, ctx);
    assert.deepStrictEqual(JSON.parse(out), { tool: 'required', contactId: 'contact-1' });
});

test('get_refund_status: passes the caller name + phone through to the port', async () => {
    const ctx = buildCtx({ userFullName: 'Jules Customer', phoneNumber: '+27820000000' });
    const out = await runTool('get_refund_status', {}, ctx);
    assert.deepStrictEqual(JSON.parse(out), {
        tool: 'refund',
        contactId: 'contact-1',
        clientName: 'Jules Customer',
        clientPhone: '+27820000000',
    });
});

test('get_refund_status: falls back to "Client" when no name is on the turn', async () => {
    const ctx = buildCtx({ userFullName: null, phoneNumber: null });
    const out = await runTool('get_refund_status', { tax_year: 2025 }, ctx);
    assert.deepStrictEqual(JSON.parse(out), {
        tool: 'refund',
        contactId: 'contact-1',
        clientName: 'Client',
        clientPhone: null,
        taxYear: 2025,
    });
});

test('get_submission_status / get_received_documents / get_audit_status delegate to their port methods', async () => {
    const ctx = buildCtx();
    assert.deepStrictEqual(
        JSON.parse(await runTool('get_submission_status', { tax_year: 2024 }, ctx)),
        { tool: 'submission', contactId: 'contact-1', taxYear: 2024 },
    );
    assert.deepStrictEqual(
        JSON.parse(await runTool('get_received_documents', {}, ctx)),
        { tool: 'received', contactId: 'contact-1' },
    );
    assert.deepStrictEqual(
        JSON.parse(await runTool('get_audit_status', { tax_year: 2026 }, ctx)),
        { tool: 'audit', contactId: 'contact-1', taxYear: 2026 },
    );
});

test('tax-faq tools and consultant/referral tools are denied to staff (client-only roles)', async () => {
    const ctx = buildCtx({ entityType: 'user', ownerFilter: 'staff-1', permittedToolKeys: ['view_open_cases', 'view_outstanding_invoices'] });
    for (const name of ['get_required_documents', 'get_refund_status', 'get_my_consultant', 'get_my_referral_code']) {
        assert.equal(await runTool(name, {}, ctx), DENIED, `${name} should be denied to staff`);
    }
});

// ---------------------------------------------------------------------------
// Staff lookup Tools (slice 3) — role + requiredPerm gate, handler behaviour
// ---------------------------------------------------------------------------

// A staff ctx with the given permitted keys and a fake DynamicsPort.
function lookupStaffCtx(permittedToolKeys: string[], overrides: FakeOverrides = {}): ToolContext {
    return buildCtx({
        entityType: 'user',
        contactId: 'staff-1',
        ownerFilter: 'staff-1',
        permittedToolKeys,
        deps: { dynamics: fakeDynamics(overrides), taxFaq: fakeTaxFaq() },
    });
}

test('staff lookup Tools are denied to a client role', async () => {
    const ctx = buildCtx({ entityType: 'client' });
    for (const name of ['get_my_clients', 'get_my_leads', 'search_contact_by_name', 'get_client_details', 'get_task_types', 'search_lead_by_name', 'get_industries']) {
        assert.equal(await runTool(name, { name: 'x', client: 'x' }, ctx), DENIED, `${name} should be denied to a client`);
    }
});

test('staff lookup Tools are denied when the staff member lacks the permission', async () => {
    // No keys → every gated lookup Tool denied; get_industries (ungated) still runs.
    const ctx = lookupStaffCtx([]);
    for (const name of ['get_my_clients', 'get_my_leads', 'search_contact_by_name', 'get_client_details', 'get_task_types', 'search_lead_by_name']) {
        assert.equal(await runTool(name, { name: 'x', client: 'x' }, ctx), DENIED, `${name} should be denied without its permission`);
    }
});

test('get_my_clients: returns the client list, scoped to the staff member', async () => {
    const clients = [{ contactid: 'c-1', fullname: 'Jules Customer' }];
    let askedFor: string | undefined;
    const ctx = lookupStaffCtx(['lookup_client'], { getMyClients: async (id: string) => { askedFor = id; return clients; } });
    assert.equal(await runTool('get_my_clients', {}, ctx), JSON.stringify(clients));
    assert.equal(askedFor, 'staff-1');
});

test('get_my_clients: returns the canned empty message when none are assigned', async () => {
    const ctx = lookupStaffCtx(['lookup_client'], { getMyClients: async () => [] });
    assert.equal(await runTool('get_my_clients', {}, ctx), 'No clients found assigned to you.');
});

test('get_my_leads: returns the lead list, scoped to the staff member', async () => {
    const leads = [{ new_leadid: 'l-1', fullname: 'Prospect One' }];
    let askedFor: string | undefined;
    const ctx = lookupStaffCtx(['lookup_lead'], { getMyLeads: async (id: string) => { askedFor = id; return leads; } });
    assert.equal(await runTool('get_my_leads', {}, ctx), JSON.stringify(leads));
    assert.equal(askedFor, 'staff-1');
});

test('get_my_leads: returns the canned empty message when none are assigned', async () => {
    const ctx = lookupStaffCtx(['lookup_lead'], { getMyLeads: async () => [] });
    assert.equal(await runTool('get_my_leads', {}, ctx), 'No leads found assigned to you.');
});

test('search_contact_by_name: returns matches and scopes the search to the owner', async () => {
    const matches = [{ contactid: 'c-1', fullname: 'Jules Customer', mobilephone: '+27' }];
    let scopedTo: string | undefined;
    const ctx = lookupStaffCtx(['lookup_client'], {
        searchContactByName: async (_name: string, ownerId?: string) => { scopedTo = ownerId; return matches; },
    });
    assert.equal(await runTool('search_contact_by_name', { name: 'Jules' }, ctx), JSON.stringify(matches));
    assert.equal(scopedTo, 'staff-1');
});

test('search_contact_by_name: returns the canned not-found message when nothing matches', async () => {
    const ctx = lookupStaffCtx(['lookup_client'], { searchContactByName: async () => [] });
    assert.equal(await runTool('search_contact_by_name', { name: 'Ghost' }, ctx), 'No contacts found matching that name.');
});

test('get_client_details: resolves the client then returns the details JSON', async () => {
    const details = { contactid: 'c-1', fullname: 'Jules Customer', taxnumber: '123' };
    const ctx = lookupStaffCtx(['lookup_client'], {
        searchContactByName: async () => [{ contactid: 'c-1', fullname: 'Jules Customer', mobilephone: '+27' }],
        getContactDetails: async () => details,
    });
    assert.equal(await runTool('get_client_details', { client: 'Jules' }, ctx), JSON.stringify(details));
});

test('get_client_details: returns the load-failed message when the contact resolves but details are null', async () => {
    const ctx = lookupStaffCtx(['lookup_client'], {
        searchContactByName: async () => [{ contactid: 'c-1', fullname: 'Jules Customer', mobilephone: '+27' }],
        getContactDetails: async () => null,
    });
    assert.equal(await runTool('get_client_details', { client: 'Jules' }, ctx), 'Client found but could not load details.');
});

test('get_client_details: returns the not-found message when the client cannot be resolved', async () => {
    const ctx = lookupStaffCtx(['lookup_client'], { getContactByPhone: async () => null, searchContactByName: async () => [] });
    assert.equal(await runTool('get_client_details', { client: 'Ghost' }, ctx), 'No client found matching that name or phone number.');
});

test('get_task_types: returns the list, or the canned empty message', async () => {
    const types = [{ id: 't-1', name: 'Provisional' }];
    const ok = lookupStaffCtx(['create_task'], { getTaskTypes: async () => types });
    assert.equal(await runTool('get_task_types', {}, ok), JSON.stringify(types));
    const empty = lookupStaffCtx(['create_task'], { getTaskTypes: async () => [] });
    assert.equal(await runTool('get_task_types', {}, empty), 'No task types found.');
});

test('search_lead_by_name: returns matches as a bare array', async () => {
    const matches = [{ new_leadid: 'l-1', fullname: 'Prospect One', mobilephone: '+27' }];
    const ctx = lookupStaffCtx(['lookup_lead'], { searchLeadByName: async () => matches });
    assert.equal(await runTool('search_lead_by_name', { name: 'Prospect' }, ctx), JSON.stringify(matches));
});

test('search_lead_by_name: not-found returns the three-option not_found payload, scoped to the owner', async () => {
    let scopedTo: string | undefined;
    const ctx = lookupStaffCtx(['lookup_lead'], {
        searchLeadByName: async (_name: string, ownerId?: string) => { scopedTo = ownerId; return []; },
    });
    const out = await runTool('search_lead_by_name', { name: 'Ghost' }, ctx);
    const payload = JSON.parse(out);
    assert.equal(payload.status, 'not_found');
    assert.equal(payload.scope, 'owned_by_you');
    assert.ok(payload.message.includes('No active leads assigned to you match "Ghost"'));
    assert.ok(payload.message.includes('call get_my_leads'));
    assert.equal(scopedTo, 'staff-1');
});

test('search_lead_by_name: not-found scope is all_leads when the staff has no owner filter', async () => {
    const ctx = buildCtx({
        entityType: 'user',
        contactId: 'staff-1',
        ownerFilter: undefined,
        permittedToolKeys: ['lookup_lead'],
        deps: { dynamics: fakeDynamics({ searchLeadByName: async () => [] }), taxFaq: fakeTaxFaq() },
    });
    const payload = JSON.parse(await runTool('search_lead_by_name', { name: 'Ghost' }, ctx));
    assert.equal(payload.scope, 'all_leads');
});

test('get_industries: ungated — runs for staff with no permitted keys', async () => {
    const industries = [{ id: 'i-1', name: 'Medical' }];
    const ctx = lookupStaffCtx([], { getIndustries: async () => industries });
    const out = await runTool('get_industries', { name_filter: 'med' }, ctx);
    assert.deepStrictEqual(JSON.parse(out), { status: 'ok', count: 1, industries });
});

test('get_industries: returns the no_match payload when nothing matches', async () => {
    const ctx = lookupStaffCtx([], { getIndustries: async () => [] });
    const out = await runTool('get_industries', { name_filter: 'zzz' }, ctx);
    const payload = JSON.parse(out);
    assert.equal(payload.status, 'no_match');
    assert.ok(payload.message.includes('No industries matched "zzz"'));
});

test('get_industries: no_match echoes "(no filter)" when called without a filter', async () => {
    const ctx = lookupStaffCtx([], { getIndustries: async () => [] });
    const payload = JSON.parse(await runTool('get_industries', {}, ctx));
    assert.ok(payload.message.includes('No industries matched "(no filter)"'));
});

// ===========================================================================
// Slice 4 — client document & action Tools
// ===========================================================================

// ---------------------------------------------------------------------------
// get_invoice_pdf handler
// ---------------------------------------------------------------------------

test('get_invoice_pdf: returns a download link on success', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getInvoiceByNumber: async () => ({ invoicenumber: 'INV123' }) }) } });
    const payload = JSON.parse(await runTool('get_invoice_pdf', { invoice_number: 'INV123' }, ctx));
    assert.equal(payload.status, 'success');
    assert.equal(payload.pdfLink, 'http://localhost:3001/api/pdf/invoice/INV123');
    assert.ok(payload.message.includes("Here's your invoice:"));
});

test('get_invoice_pdf: returns not-found error when the invoice is missing', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getInvoiceByNumber: async () => null }) } });
    const payload = JSON.parse(await runTool('get_invoice_pdf', { invoice_number: 'INV999' }, ctx));
    assert.deepStrictEqual(payload, { status: 'error', message: 'Invoice INV999 not found.' });
});

test('get_invoice_pdf: staff need the send_invoice_pdf permission', async () => {
    const denied = buildCtx({ entityType: 'user', ownerFilter: 'staff-1', permittedToolKeys: [] });
    assert.equal(await runTool('get_invoice_pdf', { invoice_number: 'INV1' }, denied), DENIED);
    const allowed = buildCtx({
        entityType: 'user',
        ownerFilter: 'staff-1',
        permittedToolKeys: ['send_invoice_pdf'],
        deps: { dynamics: fakeDynamics({ getInvoiceByNumber: async () => ({ invoicenumber: 'INV1' }) }) },
    });
    assert.equal(JSON.parse(await runTool('get_invoice_pdf', { invoice_number: 'INV1' }, allowed)).status, 'success');
});

// ---------------------------------------------------------------------------
// request_consultant_callback handler
// ---------------------------------------------------------------------------

test('request_consultant_callback: records in Dynamics, emails the owner (taxcrew CC), flags the session', async () => {
    let sent: any = null;
    let flagged: string | null = null;
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                createCallbackRequest: async () => true,
                getContactOwnerId: async () => 'owner-1',
                getSystemUserById: async () => ({ id: 'owner-1', fullname: 'Sam Consultant', email: 'sam@ttt-tax.co.za' }),
            }),
            graphMail: fakeGraphMail({ sendMail: async (p) => { sent = p; return true; } }),
            supabase: fakeSupabase({ flagSessionEscalation: async (id) => { flagged = id; } }),
        },
    });
    const payload = JSON.parse(await runTool('request_consultant_callback', { reason: 'help' }, ctx));
    assert.equal(payload.status, 'success');
    assert.deepStrictEqual(sent.to, ['sam@ttt-tax.co.za']);
    assert.deepStrictEqual(sent.cc, ['taxcrew@ttt-tax.co.za']);
    assert.equal(flagged, 'sess-1');
});

test('request_consultant_callback: still confirms positively when the CRM write fails (email is the backup)', async () => {
    let flagged: string | null = null;
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                createCallbackRequest: async () => false,
                getContactOwnerId: async () => 'owner-1',
                getSystemUserById: async () => ({ id: 'owner-1', fullname: 'Sam Consultant', email: 'sam@ttt-tax.co.za' }),
            }),
            graphMail: fakeGraphMail({ sendMail: async () => true }),
            supabase: fakeSupabase({ flagSessionEscalation: async (id) => { flagged = id; } }),
        },
    });
    const payload = JSON.parse(await runTool('request_consultant_callback', { reason: 'call me' }, ctx));
    assert.equal(payload.status, 'success');
    assert.match(payload.message, /passed to your consultant/);
    assert.equal(flagged, 'sess-1'); // flagged via the email backup
});

test('request_consultant_callback: never reports failure even when both the CRM write and email fail', async () => {
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({ createCallbackRequest: async () => false }),
            graphMail: fakeGraphMail({ sendMail: async () => false }),
        },
    });
    const payload = JSON.parse(await runTool('request_consultant_callback', {}, ctx));
    assert.equal(payload.status, 'success');
    assert.match(payload.message, /passed to your consultant/);
});

// ---------------------------------------------------------------------------
// escalate_to_taxcrew handler
// ---------------------------------------------------------------------------

test('escalate_to_taxcrew: emails the owner (taxcrew CC) for a client and flags the session', async () => {
    let sent: any = null;
    let flagged = false;
    const ctx = buildCtx({
        deps: {
            dynamics: fakeDynamics({
                getContactOwnerId: async () => 'owner-1',
                getSystemUserById: async () => ({ id: 'owner-1', fullname: 'Owner One', email: 'owner@ttt-tax.co.za' }),
            }),
            graphMail: fakeGraphMail({ sendMail: async (p) => { sent = p; return true; } }),
            supabase: fakeSupabase({ flagSessionEscalation: async () => { flagged = true; } }),
        },
    });
    const payload = JSON.parse(await runTool('escalate_to_taxcrew', { question: 'Q?', reason: 'wants email' }, ctx));
    assert.equal(payload.status, 'success');
    assert.ok(payload.message.includes("Owner One (with taxcrew CC'd)"));
    assert.deepStrictEqual(sent.to, ['owner@ttt-tax.co.za']);
    assert.deepStrictEqual(sent.cc, ['taxcrew@ttt-tax.co.za']);
    assert.equal(flagged, true);
});

test('escalate_to_taxcrew: falls back to taxcrew-only when no owner email (lead)', async () => {
    let sent: any = null;
    const ctx = buildCtx({
        entityType: 'lead',
        deps: { graphMail: fakeGraphMail({ sendMail: async (p) => { sent = p; return true; } }) },
    });
    const payload = JSON.parse(await runTool('escalate_to_taxcrew', { question: 'Q?', reason: 'r' }, ctx));
    assert.equal(payload.status, 'success');
    assert.ok(payload.message.includes('the taxcrew'));
    assert.deepStrictEqual(sent.to, ['taxcrew@ttt-tax.co.za']);
    assert.equal(sent.cc, undefined);
});

test('escalate_to_taxcrew: returns an error when sendMail fails', async () => {
    const ctx = buildCtx({ deps: { graphMail: fakeGraphMail({ sendMail: async () => false }) } });
    const payload = JSON.parse(await runTool('escalate_to_taxcrew', { question: 'Q', reason: 'r' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('taxcrew@ttt-tax.co.za'));
});

// ---------------------------------------------------------------------------
// list_tax_forms handler
// ---------------------------------------------------------------------------

test('list_tax_forms: mode=all returns the full catalog without a profile lookup', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactTaxProfile: async () => { throw new Error('should not be called'); } }) } });
    const payload = JSON.parse(await runTool('list_tax_forms', { mode: 'all' }, ctx));
    assert.equal(payload.status, 'ok');
    assert.equal(payload.mode, 'all');
});

test('list_tax_forms: no source codes on file returns no_codes', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactTaxProfile: async () => ({ sourceCodes: [], industryName: null }) }) } });
    const payload = JSON.parse(await runTool('list_tax_forms', {}, ctx));
    assert.equal(payload.status, 'no_codes');
    assert.equal(payload.mode, 'personalized');
});

test('list_tax_forms: source codes with no matching forms returns no_matches', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ getContactTaxProfile: async () => ({ sourceCodes: ['9999'], industryName: null }) }) } });
    const payload = JSON.parse(await runTool('list_tax_forms', {}, ctx));
    assert.equal(payload.status, 'no_matches');
});

// ---------------------------------------------------------------------------
// send_tax_form handler
// ---------------------------------------------------------------------------

test('send_tax_form: invalid form_key returns invalid_key', async () => {
    const ctx = buildCtx();
    const payload = JSON.parse(await runTool('send_tax_form', { form_key: 'nope' }, ctx));
    assert.equal(payload.status, 'invalid_key');
});

test('send_tax_form: sends the resolved file and logs to the timeline', async () => {
    const prevEnv = process.env.GRAPH_CLIENT_ID;
    process.env.GRAPH_CLIENT_ID = 'set';
    try {
        let logged = false;
        let sentTo: string | null = null;
        const ctx = buildCtx({
            deps: {
                forms: fakeForms({ resolveLatestFormFile: async () => ({ buffer: Buffer.from('x'), filename: 'vehicle-2026.pdf', year: 2026 }) }),
                meta: fakeMeta({ sendDocument: async (to) => { sentTo = to; return { delivered: true, dryRun: false }; } }),
                dynamics: fakeDynamics({ logTaxFormSentToContact: async () => { logged = true; return { success: true }; } }),
            },
        });
        const payload = JSON.parse(await runTool('send_tax_form', { form_key: 'vehicle_detail' }, ctx));
        assert.equal(payload.status, 'sent');
        assert.equal(payload.year, 2026);
        assert.equal(sentTo, '+27820000000');
        assert.equal(logged, true);
    } finally {
        if (prevEnv === undefined) delete process.env.GRAPH_CLIENT_ID; else process.env.GRAPH_CLIENT_ID = prevEnv;
    }
});

test('send_tax_form: resolve failure returns resolve_failed', async () => {
    const prevEnv = process.env.GRAPH_CLIENT_ID;
    process.env.GRAPH_CLIENT_ID = 'set';
    try {
        const ctx = buildCtx({ deps: { forms: fakeForms({ resolveLatestFormFile: async () => null }) } });
        const payload = JSON.parse(await runTool('send_tax_form', { form_key: 'vehicle_detail' }, ctx));
        assert.equal(payload.status, 'resolve_failed');
    } finally {
        if (prevEnv === undefined) delete process.env.GRAPH_CLIENT_ID; else process.env.GRAPH_CLIENT_ID = prevEnv;
    }
});

// ---------------------------------------------------------------------------
// opt_out_whatsapp handler
// ---------------------------------------------------------------------------

test('opt_out_whatsapp: success returns the opt-out confirmation', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ updateWhatsAppOptIn: async () => true }) } });
    const payload = JSON.parse(await runTool('opt_out_whatsapp', {}, ctx));
    assert.equal(payload.status, 'success');
    assert.ok(payload.message.includes('opted out of WhatsApp'));
});

test('opt_out_whatsapp: failure returns an error', async () => {
    const ctx = buildCtx({ deps: { dynamics: fakeDynamics({ updateWhatsAppOptIn: async () => false }) } });
    assert.equal(JSON.parse(await runTool('opt_out_whatsapp', {}, ctx)).status, 'error');
});

// ---------------------------------------------------------------------------
// save_document handler
// ---------------------------------------------------------------------------

test('save_document: no pending upload returns an error', async () => {
    const ctx = buildCtx({ pendingUpload: fakePendingUpload({ has: () => false }) });
    const payload = JSON.parse(await runTool('save_document', { doc_type: 'IRP5' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('No pending document upload found'));
});

test('save_document: client saves to their own profile and flags the session', async () => {
    let savedEntity: any = null;
    let flagged = false;
    const ctx = buildCtx({
        pendingUpload: fakePendingUpload({ has: () => true, save: async (_d, e) => { savedEntity = e; return { success: true, fileName: 'f.pdf' }; } }),
        deps: { supabase: fakeSupabase({ flagSessionDocUpload: async () => { flagged = true; } }) },
    });
    const payload = JSON.parse(await runTool('save_document', { doc_type: 'Payslip' }, ctx));
    assert.equal(payload.status, 'success');
    assert.equal(payload.message, 'Your payslip has been saved to your profile.');
    assert.deepStrictEqual(savedEntity, { id: 'contact-1', type: 'client' });
    assert.equal(flagged, true);
});

test('save_document: staff with no resolvable client returns the could-not-determine error', async () => {
    const ctx = buildCtx({
        entityType: 'user',
        ownerFilter: 'staff-1',
        pendingUpload: fakePendingUpload({ has: () => true }),
        deps: { dynamics: fakeDynamics({ getContactByPhone: async () => null, searchContactByName: async () => [] }) },
    });
    const payload = JSON.parse(await runTool('save_document', { doc_type: 'IRP5', client: 'Nobody' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Could not determine which record'));
});

test('save_document: save failure returns the retry error', async () => {
    const ctx = buildCtx({ pendingUpload: fakePendingUpload({ has: () => true, save: async () => ({ success: false }) }) });
    const payload = JSON.parse(await runTool('save_document', { doc_type: 'Logbook' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Failed to save the document'));
});

// ---------------------------------------------------------------------------
// upload_irp5 handler
// ---------------------------------------------------------------------------

test('upload_irp5: not confirmed returns not_confirmed', async () => {
    const ctx = buildCtx({ pendingUpload: fakePendingUpload({ has: () => true }) });
    const payload = JSON.parse(await runTool('upload_irp5', { confirmed_by_user: false }, ctx));
    assert.equal(payload.error, 'not_confirmed');
});

test('upload_irp5: no staged file returns no_pending_upload', async () => {
    const ctx = buildCtx({ pendingUpload: fakePendingUpload({ peek: () => null }) });
    const payload = JSON.parse(await runTool('upload_irp5', { confirmed_by_user: true }, ctx));
    assert.equal(payload.error, 'no_pending_upload');
});

test('upload_irp5: client success clears the upload, flags the session, and renders the list', async () => {
    let cleared = false;
    let flagged = false;
    const ctx = buildCtx({
        pendingUpload: fakePendingUpload({
            peek: () => ({ fileName: 'irp5.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') }),
            clear: () => { cleared = true; },
        }),
        deps: {
            dynamics: fakeDynamics({ getContactDetails: async () => ({ fullname: 'Jules Customer' }) }),
            supabase: fakeSupabase({ flagSessionDocUpload: async () => { flagged = true; } }),
            irp5: fakeIrp5({
                processClientIrp5Upload: async () => ({
                    status: 'irp5_processed',
                    employerName: 'Acme',
                    assessmentYear: 2026,
                    certificateNumber: 'C1',
                    sourceCodes: ['3601'],
                    irp5RecordId: 'r1',
                    irp5Updated: false,
                    taxsubmissionsdocumentId: 't1',
                    sharepointUrl: 'http://sp',
                    wrongYearWarning: undefined,
                    outstanding: [],
                }),
            }),
        },
    });
    const payload = JSON.parse(await runTool('upload_irp5', { confirmed_by_user: true }, ctx));
    assert.equal(payload.status, 'irp5_processed');
    assert.equal(payload.employer_name, 'Acme');
    assert.ok(payload.message.includes('Acme'));
    assert.equal(cleared, true);
    assert.equal(flagged, true);
});

test('upload_irp5: State-B lead routes to the lead pipeline (no contact lookup)', async () => {
    const ctx = buildCtx({
        entityType: 'lead',
        isStateBLeadUpload: true,
        pendingUpload: fakePendingUpload({ peek: () => ({ fileName: 'irp5.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') }) }),
        deps: {
            irp5: fakeIrp5({ processStateBLeadIrp5Upload: async () => JSON.stringify({ status: 'irp5_staged_for_lead', pending_id: 'p1' }) }),
        },
    });
    const payload = JSON.parse(await runTool('upload_irp5', { confirmed_by_user: true }, ctx));
    assert.equal(payload.status, 'irp5_staged_for_lead');
    assert.equal(payload.pending_id, 'p1');
});

test('upload_irp5: a non-State-B lead is rejected as wrong_role', async () => {
    const ctx = buildCtx({
        entityType: 'lead',
        isStateBLeadUpload: false,
        pendingUpload: fakePendingUpload({ has: () => true, peek: () => ({ fileName: 'f', mimeType: 'application/pdf', buffer: Buffer.from('x') }) }),
    });
    const payload = JSON.parse(await runTool('upload_irp5', { confirmed_by_user: true }, ctx));
    assert.equal(payload.error, 'wrong_role');
});

// ---------------------------------------------------------------------------
// mark_document_already_sent handler
// ---------------------------------------------------------------------------

test('mark_document_already_sent: records the noted docs and returns noted_unverified', async () => {
    const seen: string[] = [];
    const ctx = buildCtx({
        deps: { dynamics: fakeDynamics({ markDocumentClientStated: async (p) => { seen.push(p.canonicalDocType); return { success: true, taxYear: 2026 }; } }) },
    });
    const payload = JSON.parse(await runTool('mark_document_already_sent', { doc_types: ['IRP5', 'Bank statement'] }, ctx));
    assert.equal(payload.status, 'noted_unverified');
    assert.deepStrictEqual(payload.recorded, ['IRP5', 'Bank statement']);
    assert.deepStrictEqual(seen, ['IRP5', 'Bank statement']);
});

test('mark_document_already_sent: empty doc_types returns no_doc_types', async () => {
    const ctx = buildCtx();
    const payload = JSON.parse(await runTool('mark_document_already_sent', { doc_types: [] }, ctx));
    assert.equal(payload.error, 'no_doc_types');
});

test('mark_document_already_sent: all writes failing returns write_failed', async () => {
    const ctx = buildCtx({
        deps: { dynamics: fakeDynamics({ markDocumentClientStated: async () => ({ success: false, taxYear: 2026 }) }) },
    });
    const payload = JSON.parse(await runTool('mark_document_already_sent', { doc_types: ['IRP5'] }, ctx));
    assert.equal(payload.error, 'write_failed');
});

// ===========================================================================
// Slice 5 — staff write Tools
// ===========================================================================

const GUID = '11111111-1111-1111-1111-111111111111';

// A staff ctx with the given permitted keys and a fake DynamicsPort (+ optional
// other Port overrides), modelled on lookupStaffCtx.
function writeStaffCtx(
    permittedToolKeys: string[],
    dynOverrides: FakeOverrides = {},
    deps: Partial<ToolContext['deps']> = {},
): ToolContext {
    return buildCtx({
        entityType: 'user',
        contactId: 'staff-1',
        ownerFilter: 'staff-1',
        permittedToolKeys,
        userFullName: 'Sam Staff',
        deps: { dynamics: fakeDynamics(dynOverrides), taxFaq: fakeTaxFaq(), ...deps },
    });
}

// ---- gating: every write Tool is denied to a client, and to staff lacking the key ----

test('staff write Tools are denied to a client role', async () => {
    const ctx = buildCtx({ entityType: 'client' });
    for (const name of ['create_case', 'create_lead', 'create_contact', 'create_invoice', 'create_task', 'send_invoice_pdf', 'refer_friend']) {
        assert.equal(await runTool(name, {}, ctx), DENIED, `${name} should be denied to a client`);
    }
});

test('staff write Tools (except refer_friend) are denied without their create permission', async () => {
    const ctx = writeStaffCtx([]);
    for (const name of ['create_case', 'create_lead', 'create_contact', 'create_invoice', 'create_task', 'send_invoice_pdf']) {
        assert.equal(await runTool(name, {}, ctx), DENIED, `${name} should be denied without its permission`);
    }
});

// ---- create_case ----

test('create_case: staff success resolves the named client and returns the case number', async () => {
    let createdFor: string | null = null;
    const ctx = writeStaffCtx(['create_case'], {
        searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules Customer', mobilephone: '+27' }],
        createCase: async (id) => { createdFor = id; return { new_name: 'CASE-42' }; },
    });
    const payload = JSON.parse(await runTool('create_case', { case_type: 'Query', description: 'd', priority: 'Low', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'success');
    assert.equal(payload.case_number, 'CASE-42');
    assert.equal(createdFor, 'c-9');
});

test('create_case: staff with no resolvable client returns the could-not-find error', async () => {
    const ctx = writeStaffCtx(['create_case'], { getContactByPhone: async () => null, searchContactByName: async () => [] });
    const payload = JSON.parse(await runTool('create_case', { case_type: 'Query', description: 'd', priority: 'Low', client: 'Ghost' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes("Please provide the client's full name"));
});

test('create_case: a failed CRM write returns the try-again error', async () => {
    const ctx = writeStaffCtx(['create_case'], {
        searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules', mobilephone: '+27' }],
        createCase: async () => null,
    });
    const payload = JSON.parse(await runTool('create_case', { case_type: 'Query', description: 'd', priority: 'Low', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Failed to create the case in CRM. Please try again.'));
});

// ---- create_lead ----

test('create_lead: success maps the choice values and returns the lead id', async () => {
    let sent: any = null;
    const ctx = writeStaffCtx(['create_lead'], { createLead: async (p) => { sent = p; return { new_leadid: 'lead-9' }; } });
    const payload = JSON.parse(await runTool('create_lead', {
        first_name: 'Pat', last_name: 'Prospect', client_type: 'Individual', lead_type: 'Tax', industry_id: GUID,
    }, ctx));
    assert.equal(payload.status, 'success');
    assert.equal(payload.lead_id, 'lead-9');
    assert.equal(sent.clientType, 0);          // Individual
    assert.equal(sent.leadType, 100000000);    // Tax
    assert.equal(sent.ownerSystemUserId, 'staff-1');
});

test('create_lead: unknown client_type is rejected before any CRM write', async () => {
    let called = false;
    const ctx = writeStaffCtx(['create_lead'], { createLead: async () => { called = true; return { new_leadid: 'x' }; } });
    const payload = JSON.parse(await runTool('create_lead', {
        first_name: 'Pat', last_name: 'P', client_type: 'Alien', lead_type: 'Tax', industry_id: GUID,
    }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Unknown client_type "Alien"'));
    assert.equal(called, false);
});

test('create_lead: a non-GUID industry_id is rejected', async () => {
    const ctx = writeStaffCtx(['create_lead']);
    const payload = JSON.parse(await runTool('create_lead', {
        first_name: 'Pat', last_name: 'P', client_type: 'Individual', lead_type: 'Tax', industry_id: 'medical',
    }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('industry_id must be a GUID'));
});

// ---- create_contact ----

test('create_contact: success returns the new contact id', async () => {
    const ctx = writeStaffCtx(['create_contact'], { createContact: async () => ({ contactid: 'c-new' }) });
    const payload = JSON.parse(await runTool('create_contact', {
        first_name: 'New', last_name: 'Client', entity_type: 'Business', industry_id: GUID,
    }, ctx));
    assert.equal(payload.status, 'success');
    assert.equal(payload.contact_id, 'c-new');
});

test('create_contact: unknown entity_type is rejected', async () => {
    const ctx = writeStaffCtx(['create_contact']);
    const payload = JSON.parse(await runTool('create_contact', {
        first_name: 'New', last_name: 'Client', entity_type: 'Alien', industry_id: GUID,
    }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Unknown entity_type "Alien"'));
});

// ---- create_invoice ----

test('create_invoice: success maps the invoice type and returns the invoice id', async () => {
    let sent: any = null;
    const ctx = writeStaffCtx(['create_invoice'], { createInvoice: async (p) => { sent = p; return { new_invoicesid: 'inv-9' }; } });
    const payload = JSON.parse(await runTool('create_invoice', { customer_contact_id: GUID, invoice_type: 'Tax' }, ctx));
    assert.equal(payload.status, 'success');
    assert.equal(payload.invoice_id, 'inv-9');
    assert.equal(sent.invoiceType, 100000000);
});

test('create_invoice: a non-GUID customer_contact_id is rejected', async () => {
    const ctx = writeStaffCtx(['create_invoice']);
    const payload = JSON.parse(await runTool('create_invoice', { customer_contact_id: 'Jules', invoice_type: 'Tax' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('customer_contact_id must be a Contact GUID'));
});

// ---- create_task ----

test('create_task: success returns the confirmation message', async () => {
    let sent: any = null;
    const ctx = writeStaffCtx(['create_task'], { createTask: async (p) => { sent = p; return { success: true }; } });
    const payload = JSON.parse(await runTool('create_task', {
        client_or_lead: GUID, entity_type: 'contact', task_type_id: 't-1', task_type_name: 'Provisional', tax_year: 2025,
    }, ctx));
    assert.equal(payload.status, 'success');
    assert.ok(payload.message.includes('Task "Provisional" created successfully for tax year 2025.'));
    assert.equal(sent.primaryRepId, 'staff-1');
});

test('create_task: a failed CRM write surfaces the error', async () => {
    const ctx = writeStaffCtx(['create_task'], { createTask: async () => ({ success: false, error: 'boom' }) });
    const payload = JSON.parse(await runTool('create_task', {
        client_or_lead: GUID, entity_type: 'contact', task_type_id: 't-1', task_type_name: 'Provisional', tax_year: 2025,
    }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Failed to create task: boom'));
});

// ---- send_invoice_pdf ----

test('send_invoice_pdf: success resolves the client, renders + sends the PDF, and logs the timeline', async () => {
    let sentTo: string | null = null;
    let logged = false;
    let renderedRow: any = null;
    const ctx = writeStaffCtx(
        ['send_invoice_pdf'],
        {
            searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules Customer', mobilephone: '+27820001111' }],
            getContactDetails: async () => ({ mobilephone: '+27820001111', fullname: 'Jules Customer' }),
            getInvoiceByNumber: async () => ({ invoicenumber: 'INV123' }),
            logInvoiceSentToContact: async () => { logged = true; return { success: true }; },
        },
        {
            meta: fakeMeta({ sendDocument: async (to) => { sentTo = to; return { delivered: true, dryRun: false }; } }),
            pdf: fakePdf({ generateInvoicePdf: async (row) => { renderedRow = row; return Buffer.from('pdf'); } }),
        },
    );
    const payload = JSON.parse(await runTool('send_invoice_pdf', { invoice_number: 'INV123', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'sent');
    assert.equal(payload.invoice_number, 'INV123');
    assert.equal(sentTo, '+27820001111');
    assert.equal(logged, true);
    assert.deepStrictEqual(renderedRow, { invoicenumber: 'INV123' });
    assert.ok(payload.whatsapp_caption.includes('Sam Staff from TTT'));
});

test('send_invoice_pdf: dry-run reports TEST MODE and still logs the audit trail', async () => {
    let logged = false;
    const ctx = writeStaffCtx(
        ['send_invoice_pdf'],
        {
            searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules', mobilephone: '+27820001111' }],
            getContactDetails: async () => ({ mobilephone: '+27820001111', fullname: 'Jules' }),
            getInvoiceByNumber: async () => ({ invoicenumber: 'INV123' }),
            logInvoiceSentToContact: async () => { logged = true; return { success: true }; },
        },
        { meta: fakeMeta({ sendDocument: async () => ({ delivered: false, dryRun: true }) }) },
    );
    const payload = JSON.parse(await runTool('send_invoice_pdf', { invoice_number: 'INV123', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'sent');
    assert.equal(payload.dry_run, true);
    assert.ok(payload.message.includes('TEST MODE'));
    assert.equal(logged, true);
});

test('send_invoice_pdf: no matching client returns client_not_found', async () => {
    const ctx = writeStaffCtx(['send_invoice_pdf'], { getContactByPhone: async () => null, searchContactByName: async () => [] });
    const payload = JSON.parse(await runTool('send_invoice_pdf', { invoice_number: 'INV1', client: 'Ghost' }, ctx));
    assert.equal(payload.status, 'client_not_found');
});

test('send_invoice_pdf: multiple matches with no single mobile returns client_ambiguous', async () => {
    const ctx = writeStaffCtx(['send_invoice_pdf'], {
        searchContactByName: async () => [
            { contactid: 'c-1', fullname: 'Jules A', mobilephone: '+271' },
            { contactid: 'c-2', fullname: 'Jules B', mobilephone: '+272' },
        ],
    });
    const payload = JSON.parse(await runTool('send_invoice_pdf', { invoice_number: 'INV1', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'client_ambiguous');
    assert.equal(payload.candidates.length, 2);
});

test('send_invoice_pdf: a resolved client with no mobile returns no_whatsapp_number', async () => {
    const ctx = writeStaffCtx(['send_invoice_pdf'], {
        searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules', mobilephone: '+27' }],
        getContactDetails: async () => ({ mobilephone: null, fullname: 'Jules' }),
    });
    const payload = JSON.parse(await runTool('send_invoice_pdf', { invoice_number: 'INV1', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'no_whatsapp_number');
});

test('send_invoice_pdf: a missing invoice returns invoice_not_found and nothing is sent', async () => {
    let sent = false;
    const ctx = writeStaffCtx(
        ['send_invoice_pdf'],
        {
            searchContactByName: async () => [{ contactid: 'c-9', fullname: 'Jules', mobilephone: '+27820001111' }],
            getContactDetails: async () => ({ mobilephone: '+27820001111', fullname: 'Jules' }),
            getInvoiceByNumber: async () => null,
        },
        { meta: fakeMeta({ sendDocument: async () => { sent = true; return { delivered: true, dryRun: false }; } }) },
    );
    const payload = JSON.parse(await runTool('send_invoice_pdf', { invoice_number: 'INV404', client: 'Jules' }, ctx));
    assert.equal(payload.status, 'invoice_not_found');
    assert.equal(sent, false);
});

// ---- refer_friend (ungated) ----

test('refer_friend: ungated — runs for staff with no permitted keys', async () => {
    let sent: any = null;
    const ctx = writeStaffCtx([], {
        getContactOwnerId: async () => 'owner-1',
        createLead: async (p) => { sent = p; return { new_leadid: 'lead-9' }; },
    });
    const payload = JSON.parse(await runTool('refer_friend', {
        friend_name: 'Bob Friend', friend_phone: '+27820002222', friend_email: 'bob@x.co', service: 'Tax',
    }, ctx));
    assert.equal(payload.status, 'success');
    assert.ok(payload.message.includes("Bob Friend's details have been passed to our Tax team"));
    assert.equal(sent.referredByContactId, 'staff-1');
    assert.equal(sent.ownerSystemUserId, 'owner-1');
    assert.equal(sent.leadType, 100000000);
});

test('refer_friend: a failed CRM write returns the referral error', async () => {
    const ctx = writeStaffCtx([], { getContactOwnerId: async () => 'owner-1', createLead: async () => null });
    const payload = JSON.parse(await runTool('refer_friend', {
        friend_name: 'Bob Friend', friend_phone: '+27820002222', friend_email: 'bob@x.co', service: 'Tax',
    }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Failed to create the referral.'));
});

// ===========================================================================
// Slice 6 — staff read (get_case_by_name), LoE flow, and unknown verify_identity
// ===========================================================================

// ---- get_case_by_name -----------------------------------------------------

test('get_case_by_name: returns the matching cases JSON', async () => {
    const cases = [{ name: 'Lloyd Pienaar - 2025', stage: 'Active' }];
    const ctx = writeStaffCtx(['view_open_cases'], { searchCaseByName: async () => cases });
    const out = await runTool('get_case_by_name', { case_name: 'Lloyd' }, ctx);
    assert.equal(out, JSON.stringify(cases));
});

test('get_case_by_name: returns the canned message when nothing matches', async () => {
    const ctx = writeStaffCtx(['view_open_cases'], { searchCaseByName: async () => [] });
    const out = await runTool('get_case_by_name', { case_name: 'Nobody' }, ctx);
    assert.equal(out, 'No cases found matching that name.');
});

test('get_case_by_name: denied for staff lacking view_open_cases', async () => {
    const ctx = writeStaffCtx([], { searchCaseByName: async () => [{ name: 'x' }] });
    assert.equal(await runTool('get_case_by_name', { case_name: 'x' }, ctx), DENIED);
});

// ---- verify_identity (unknown caller, no contactId) -----------------------

function unknownCtx(overrides: FakeOverrides = {}, ctxOverrides: Partial<ToolContext> = {}): ToolContext {
    return buildCtx({
        entityType: 'unknown',
        contactId: null,
        phoneNumber: '+27820009999',
        ...ctxOverrides,
        deps: { dynamics: fakeDynamics(overrides) },
    });
}

test('verify_identity: found — links the phone and returns the welcome payload', async () => {
    let linked: { id: string; phone: string } | null = null;
    const ctx = unknownCtx({
        searchContactByIdNumber: async () => ({ contactid: 'c-7', fullname: 'Thandi Client' }),
        linkPhoneToContact: async (id, phone) => { linked = { id, phone }; return true; },
    });
    const payload = JSON.parse(await runTool('verify_identity', { id_number: '8001015009087' }, ctx));
    assert.equal(payload.status, 'found');
    assert.equal(payload.contactid, 'c-7');
    assert.ok(payload.message.includes('Welcome back, Thandi Client'));
    assert.deepStrictEqual(linked, { id: 'c-7', phone: '+27820009999' });
});

test('verify_identity: not found returns the consultant-will-be-in-touch payload', async () => {
    const ctx = unknownCtx({ searchContactByIdNumber: async () => null });
    const payload = JSON.parse(await runTool('verify_identity', { id_number: '0000000000000' }, ctx));
    assert.equal(payload.status, 'not_found');
    assert.ok(payload.message.includes('No account found with that ID number'));
});

test('verify_identity: runs for an unknown caller via runTool (no contactId, role-gated)', async () => {
    // The whole point of slice 6: an unidentified caller (no contactId) still
    // dispatches through runTool because the 'unknown' role allows it.
    const ctx = unknownCtx({ searchContactByIdNumber: async () => null });
    assert.equal(ctx.contactId, null);
    const payload = JSON.parse(await runTool('verify_identity', { id_number: '1' }, ctx));
    assert.equal(payload.status, 'not_found');
    // And it's not offered to known roles.
    const clientCtx = buildCtx({ entityType: 'client' });
    assert.equal(await runTool('verify_identity', { id_number: '1' }, clientCtx), DENIED);
});

// ---- LoE flow: upload_letter_of_engagement --------------------------------

const PDF_UPLOAD = { fileName: 'loe.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') };
const LEAD_GUID = '11111111-2222-3333-4444-555555555555';

function loeStaffCtx(
    permittedToolKeys: string[],
    opts: {
        staged?: { fileName: string; mimeType: string; buffer: Buffer } | null;
        dyn?: FakeOverrides;
        loeOcr?: Partial<LoeOcrPort>;
        pendingLoe?: Partial<PendingLoeState>;
        cleared?: { v: boolean };
    } = {},
): ToolContext {
    return buildCtx({
        entityType: 'user',
        contactId: 'staff-1',
        ownerFilter: 'staff-1',
        sessionId: 'sess-loe',
        permittedToolKeys,
        pendingUpload: fakePendingUpload({
            peek: () => (opts.staged === undefined ? PDF_UPLOAD : opts.staged),
            clear: () => { if (opts.cleared) opts.cleared.v = true; },
        }),
        pendingLoe: fakePendingLoe(opts.pendingLoe),
        deps: { dynamics: fakeDynamics(opts.dyn), loeOcr: fakeLoeOcr(opts.loeOcr) },
    });
}

test('upload_letter_of_engagement: OCRs, stages, clears the upload, and returns pending_review', async () => {
    const cleared = { v: false };
    let saved: any = null;
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        cleared,
        loeOcr: {
            isConfigured: () => true,
            ocrDocument: async () => ({ fullMarkdown: 'BANK: Capitec', pageCount: 1 }),
            extractBankingDetails: async () => ({ bankName: 'Capitec', accountNumber: '123' }),
        },
        pendingLoe: {
            save: async (p) => { saved = p; return 'pending-row-1'; },
            get: async () => ({ bank_name: 'Capitec', account_number: '123', lead_name: 'New Lead' }),
        },
    });
    const payload = JSON.parse(await runTool('upload_letter_of_engagement', { lead_id: LEAD_GUID, lead_name: 'New Lead' }, ctx));
    assert.equal(payload.status, 'pending_review');
    assert.equal(payload.lead_name, 'New Lead');
    assert.ok(payload.fields.includes('Bank Name: Capitec'));
    assert.ok(payload.message.includes("I've extracted the following details"));
    // The extracted fields were threaded into the staged save, and the in-memory
    // upload was cleared once the data lived in Supabase.
    assert.equal(saved.leadId, LEAD_GUID);
    assert.equal(saved.bankName, 'Capitec');
    assert.equal(cleared.v, true);
});

test('upload_letter_of_engagement: warns when an LOE was already received', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        dyn: { checkLoeAlreadyReceived: async () => ({ alreadyReceived: true, leadName: 'Existing Lead' }) },
        loeOcr: { isConfigured: () => false },
        pendingLoe: { save: async () => 'row', get: async () => ({}) },
    });
    const payload = JSON.parse(await runTool('upload_letter_of_engagement', { lead_id: LEAD_GUID, lead_name: 'Existing Lead' }, ctx));
    assert.equal(payload.status, 'pending_review');
    assert.ok(payload.already_received_warning.includes('already been received for Existing Lead'));
});

test('upload_letter_of_engagement: no staged file returns no_pending_upload', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], { staged: null });
    const payload = JSON.parse(await runTool('upload_letter_of_engagement', { lead_id: LEAD_GUID, lead_name: 'X' }, ctx));
    assert.equal(payload.error, 'no_pending_upload');
});

test('upload_letter_of_engagement: a non-PDF staged file is rejected', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        staged: { fileName: 'loe.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('x') },
    });
    const payload = JSON.parse(await runTool('upload_letter_of_engagement', { lead_id: LEAD_GUID, lead_name: 'X' }, ctx));
    assert.equal(payload.error, 'wrong_file_type');
});

test('upload_letter_of_engagement: a non-GUID lead_id is rejected', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement']);
    const payload = JSON.parse(await runTool('upload_letter_of_engagement', { lead_id: 'not-a-guid', lead_name: 'X' }, ctx));
    assert.equal(payload.error, 'invalid_lead_id');
});

test('upload_letter_of_engagement: a failed stage returns the retry error', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], { pendingLoe: { save: async () => null } });
    const payload = JSON.parse(await runTool('upload_letter_of_engagement', { lead_id: LEAD_GUID, lead_name: 'X' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Failed to stage LOE data for review'));
});

test('upload_letter_of_engagement: denied for staff lacking the permission', async () => {
    const ctx = loeStaffCtx([]);
    assert.equal(await runTool('upload_letter_of_engagement', { lead_id: LEAD_GUID, lead_name: 'X' }, ctx), DENIED);
});

// ---- LoE flow: confirm_loe_upload -----------------------------------------

const STAGED_ROW = {
    lead_id: LEAD_GUID, lead_name: 'New Lead', file_name: 'loe.pdf', file_buffer: Buffer.from('pdf'),
    bank_name: 'Capitec', account_number: '123',
};

test('confirm_loe_upload: writes the file + fields and returns confirmed', async () => {
    let deleted = false;
    const writes: any[] = [];
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        dyn: {
            uploadLoeFileToCrm: async () => ({ success: true }),
            writeLoeFieldsToLead: async (id, fields) => { writes.push({ id, fields }); return { success: true, flagSet: true }; },
        },
        pendingLoe: { confirm: async () => STAGED_ROW, delete: async () => { deleted = true; } },
    });
    const payload = JSON.parse(await runTool('confirm_loe_upload', {}, ctx));
    assert.equal(payload.status, 'confirmed');
    assert.equal(payload.lead_name, 'New Lead');
    assert.equal(writes[0].id, LEAD_GUID);
    assert.equal(writes[0].fields.bankName, 'Capitec');
    assert.equal(deleted, true);
});

test('confirm_loe_upload: nothing staged returns the no-pending error', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], { pendingLoe: { confirm: async () => null } });
    const payload = JSON.parse(await runTool('confirm_loe_upload', {}, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('No pending LOE data found to confirm'));
});

test('confirm_loe_upload: a failed file upload aborts before the field write', async () => {
    let fieldWritten = false;
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        dyn: {
            uploadLoeFileToCrm: async () => ({ success: false, error: 'boom' }),
            writeLoeFieldsToLead: async () => { fieldWritten = true; return { success: true, flagSet: true }; },
        },
        pendingLoe: { confirm: async () => STAGED_ROW },
    });
    const payload = JSON.parse(await runTool('confirm_loe_upload', {}, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Failed to upload LOE PDF to CRM: boom'));
    assert.equal(fieldWritten, false);
});

test('confirm_loe_upload: a failed field write returns partial_success', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        dyn: {
            uploadLoeFileToCrm: async () => ({ success: true }),
            writeLoeFieldsToLead: async () => ({ success: false, flagSet: false, error: 'field boom' }),
        },
        pendingLoe: { confirm: async () => STAGED_ROW },
    });
    const payload = JSON.parse(await runTool('confirm_loe_upload', {}, ctx));
    assert.equal(payload.status, 'partial_success');
    assert.ok(payload.message.includes('the field update failed: field boom'));
});

// ---- LoE flow: update_loe_field -------------------------------------------

test('update_loe_field: updates a field and re-shows the staged details', async () => {
    let updated: { f: string; v: string } | null = null;
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], {
        pendingLoe: {
            updateField: async (f, v) => { updated = { f, v }; return true; },
            get: async () => ({ bank_name: 'Capitec' }),
        },
    });
    const payload = JSON.parse(await runTool('update_loe_field', { field_name: 'bank_name', new_value: 'Capitec' }, ctx));
    assert.equal(payload.status, 'updated');
    assert.equal(payload.field_name, 'bank_name');
    assert.ok(payload.fields.includes('Bank Name: Capitec'));
    assert.deepStrictEqual(updated, { f: 'bank_name', v: 'Capitec' });
});

test('update_loe_field: missing field_name/new_value is rejected', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement']);
    const payload = JSON.parse(await runTool('update_loe_field', { field_name: 'bank_name' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Both field_name and new_value are required'));
});

test('update_loe_field: a rejected update surfaces the no-pending error', async () => {
    const ctx = loeStaffCtx(['upload_letter_of_engagement'], { pendingLoe: { updateField: async () => false } });
    const payload = JSON.parse(await runTool('update_loe_field', { field_name: 'bank_name', new_value: 'X' }, ctx));
    assert.equal(payload.status, 'error');
    assert.ok(payload.message.includes('Could not update field "bank_name"'));
});
