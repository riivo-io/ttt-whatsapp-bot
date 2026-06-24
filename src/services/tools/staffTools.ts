/**
 * Staff-audience Tool handlers, migrated into the Tool registry (slice 3).
 *
 * These are the first Tools to exercise the `requiredPerm` gate heavily: each
 * entry's `roles` is `['user']` and (except `get_industries`) its `requiredPerm`
 * matches the key the inline `STAFF_TOOL_PERMISSIONS` re-check used to enforce.
 * The gate is now *derived* from these fields by `entryAllowed` / `runTool` and
 * the offered list by `deriveOfferedTools` — there is no second list.
 *
 * Each handler is `handle(args, ctx) => Promise<string>` and reaches services
 * only through `ctx.deps` (the narrow `DynamicsPort`) and the shared resolvers on
 * `ctx`. The returned strings are byte-for-byte the ones the legacy first-round
 * dispatch produced.
 */

import { register, type ToolContext, type ToolEntry } from './registry';

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Choice option-set value maps (Power Apps Choice → integer) ----
// Lifted verbatim from claude.service's first-round dispatch closure. Lead's
// riivo_clienttype and Contact's riivo_clienttypeindbus share the global "Client
// Type" choice set.
const CLIENT_TYPE_VALUES: Record<string, number> = {
    'Individual': 0,
    'Business': 1,
    'Private Company': 2,
    'Closed Corporation': 3,
    'Business Trust': 4,
    'Sole Proprietorship': 5,
};
// Lead's riivo_leadtype is the global "Lead Types" choice set.
const LEAD_TYPE_VALUES: Record<string, number> = {
    'Tax': 100000000,
    'Accounting': 100000001,
    'Long Term Insurance': 463630001,
    'Short Term Insurance': 463630002,
};
// Invoice's riivo_invoicetype.
const INVOICE_TYPE_VALUES: Record<string, number> = {
    'Tax': 100000000,
    'Accounting': 100000001,
};

const getMyClients: ToolEntry = {
    name: 'get_my_clients',
    description: "Use when a staff member asks to see their CLIENTS — confirmed contacts they own. Do NOT use this for leads or prospects. Returns contacts assigned to them.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['user'],
    requiredPerm: 'lookup_client',
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const data = await ctx.deps.dynamics.getMyClients(ctx.contactId as string);
        return data.length > 0 ? JSON.stringify(data) : 'No clients found assigned to you.';
    },
};

const getMyLeads: ToolEntry = {
    name: 'get_my_leads',
    description: "Use when a staff member asks to see their LEADS — prospects in the onboarding pipeline that they own as consultant. Leads and clients are different: clients are confirmed contacts, leads are not yet clients. Returns each lead's id, full name, mobile number, and email. This is ALL the lead info we have — do NOT then call get_client_details for a lead (leads are not contacts and get_client_details will return nothing). Just answer from what this tool returns.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['user'],
    requiredPerm: 'lookup_lead',
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const data = await ctx.deps.dynamics.getMyLeads(ctx.contactId as string);
        return data.length > 0 ? JSON.stringify(data) : 'No leads found assigned to you.';
    },
};

const searchContactByName: ToolEntry = {
    name: 'search_contact_by_name',
    description: "Search for a contact by name. Use this when a staff member needs to find a client. Returns matching contacts with their IDs.",
    input_schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The client name to search for (partial match supported)' },
        },
        required: ['name'],
    },
    roles: ['user'],
    requiredPerm: 'lookup_client',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { name?: string };
        const results = await ctx.deps.dynamics.searchContactByName(a.name as string, ctx.ownerFilter);
        return results.length > 0 ? JSON.stringify(results) : 'No contacts found matching that name.';
    },
};

const getClientDetails: ToolEntry = {
    name: 'get_client_details',
    description: "Get a specific CLIENT's (contact record) full profile: name, phone, email, ID number, tax number. For staff to look up any confirmed client. Do NOT use this for LEADS — leads live in a separate entity and this tool will not find them. For lead info, use search_lead_by_name or get_my_leads, which already return complete lead details.",
    input_schema: {
        type: 'object',
        properties: {
            client: { type: 'string', description: 'Client name or phone number' },
        },
        required: ['client'],
    },
    roles: ['user'],
    requiredPerm: 'lookup_client',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { client?: string };
        const resolved = await ctx.resolveClientId(a.client);
        if (resolved) {
            const details = await ctx.deps.dynamics.getContactDetails(resolved);
            return details ? JSON.stringify(details) : 'Client found but could not load details.';
        }
        return 'No client found matching that name or phone number.';
    },
};

const getTaskTypes: ToolEntry = {
    name: 'get_task_types',
    description: "Get the list of available task types. Use this when a staff member wants to create a task, so they can pick the correct type.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['user'],
    requiredPerm: 'create_task',
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const taskTypes = await ctx.deps.dynamics.getTaskTypes();
        return taskTypes.length > 0 ? JSON.stringify(taskTypes) : 'No task types found.';
    },
};

const searchLeadByName: ToolEntry = {
    name: 'search_lead_by_name',
    description: "Search for a lead by name. Scoped to leads owned by the calling staff member. Returns each match's id, full name, and mobile number — that is the COMPLETE lead info we expose. Do NOT then call get_client_details for any of the results (leads are not contacts and that tool won't find them). If nothing comes back, the tool will tell you and you should offer to create a new lead via create_lead.",
    input_schema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The lead name to search for (partial match supported)' },
        },
        required: ['name'],
    },
    roles: ['user'],
    requiredPerm: 'lookup_lead',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { name?: string };
        const results = await ctx.deps.dynamics.searchLeadByName(a.name as string, ctx.ownerFilter);
        if (results.length > 0) {
            return JSON.stringify(results);
        }
        return JSON.stringify({
            status: 'not_found',
            scope: ctx.ownerFilter ? 'owned_by_you' : 'all_leads',
            message: `No active leads assigned to you match "${a.name}". Ask the staff member what they'd like to do next, offering these three options:\n1. Check the spelling or give more details (full name, phone).\n2. See the full list of their leads (call get_my_leads).\n3. Create a new lead for this person (call create_lead — you'll need first name, last name, client_type, lead_type, and industry).\nPresent all three options and let them choose.`,
        });
    },
};

// get_industries is intentionally ungated (no requiredPerm) — it's a supporting
// lookup used by both create_lead and create_contact and only returns harmless
// reference data, so it stays available to any staff member.
const getIndustries: ToolEntry = {
    name: 'get_industries',
    description: "Search the TTT industry list for a lead or contact. Pass a name_filter (e.g. 'doctor', 'tax') to narrow down. Use this BEFORE create_lead or create_contact so you can resolve the industry name the staff member gave you to a GUID. If multiple matches come back, ask the staff member to disambiguate.",
    input_schema: {
        type: 'object',
        properties: {
            name_filter: { type: 'string', description: 'Substring to match against industry name. Optional — omit to fetch the first 50 industries alphabetically (rarely useful).' },
        },
        required: [],
    },
    roles: ['user'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { name_filter?: string };
        const industries = await ctx.deps.dynamics.getIndustries(a.name_filter);
        if (industries.length === 0) {
            return JSON.stringify({
                status: 'no_match',
                message: `No industries matched "${a.name_filter || '(no filter)'}". Ask the staff member to try a different keyword or use 'Other'.`,
            });
        }
        return JSON.stringify({ status: 'ok', count: industries.length, industries });
    },
};

// ===========================================================================
// Staff write Tools (slice 5). Each carries roles=['user'] and the matching
// requiredPerm (refer_friend is intentionally ungated, as it was in the legacy
// dispatch). Bodies are byte-for-byte the legacy first-round handlers; services
// are reached only through ctx.deps (DynamicsPort / MetaPort / PdfPort).
// ===========================================================================

const createCase: ToolEntry = {
    name: 'create_case',
    description: "Create a new case in the CRM. Gather ALL required info from the user BEFORE calling: case_type, description, and priority. For staff users, also ask which client and use search_contact_by_name first to get their contact ID.",
    input_schema: {
        type: 'object',
        properties: {
            case_type: { type: 'string', enum: ['Claim', 'Query', 'Complaint', 'Admin', 'Other'], description: 'The type of case' },
            description: { type: 'string', description: 'Brief description of the case' },
            priority: { type: 'string', enum: ['High', 'Medium', 'Low'], description: 'Priority level' },
            client: { type: 'string', description: "The client's name or phone number to link the case to. Required for staff users. Not needed for clients (auto-linked)." },
        },
        required: ['case_type', 'description', 'priority'],
    },
    roles: ['user'],
    requiredPerm: 'create_case',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { case_type?: string; description?: string; priority?: string; client?: string };

        // Resolve the target contact ID
        let targetContactId: string | null = null;
        if (ctx.entityType === 'client') {
            // Clients create cases for themselves
            targetContactId = ctx.contactId || null;
        } else if (a.client) {
            // Staff provided a client name or phone — resolve to GUID
            const clientInput = a.client.trim();
            console.log(`[Claude] create_case: resolving client "${clientInput}"...`);
            if (GUID_REGEX.test(clientInput)) {
                targetContactId = clientInput;
            } else {
                const byPhone = await ctx.deps.dynamics.getContactByPhone(clientInput);
                if (byPhone && byPhone.type === 'client') {
                    targetContactId = byPhone.id;
                    console.log(`[Claude] create_case: found by phone: ${byPhone.fullname} (${byPhone.id})`);
                } else {
                    const byName = await ctx.deps.dynamics.searchContactByName(clientInput, ctx.ownerFilter);
                    if (byName.length > 0) {
                        targetContactId = byName[0].contactid;
                        console.log(`[Claude] create_case: found by name: ${byName[0].fullname} (${targetContactId})`);
                    }
                }
            }
        }

        console.log(`[Claude] create_case targetContactId: ${targetContactId}, entityType: ${ctx.entityType}`);

        if (!targetContactId) {
            return JSON.stringify({
                status: 'error',
                message: "Could not find a matching client. Please provide the client's full name.",
            });
        }
        const result = await ctx.deps.dynamics.createCase(
            targetContactId,
            a.case_type as string,
            a.description as string,
            a.priority as string,
        );
        if (result) {
            return JSON.stringify({
                status: 'success',
                case_number: result.new_name || result.new_caseid,
                message: `Case ${result.new_name || result.new_caseid} created successfully.`,
            });
        }
        return JSON.stringify({ status: 'error', message: 'Failed to create the case in CRM. Please try again.' });
    },
};

const createLead: ToolEntry = {
    name: 'create_lead',
    description: "Create a new lead (prospect) in the CRM. Before calling, you MUST gather: first name, last name, client_type, lead_type, and the industry. Use get_industries to resolve the industry to a GUID — ask the staff member what industry the lead is in, then call get_industries with a name_filter to find a match. Phone, email, and notes are optional.",
    input_schema: {
        type: 'object',
        properties: {
            first_name: { type: 'string', description: "Lead's first name" },
            last_name: { type: 'string', description: "Lead's last name" },
            client_type: { type: 'string', enum: ['Individual', 'Business', 'Private Company', 'Closed Corporation', 'Business Trust', 'Sole Proprietorship'], description: 'What kind of entity the lead is. Ask the staff member.' },
            lead_type: { type: 'string', enum: ['Tax', 'Accounting', 'Long Term Insurance', 'Short Term Insurance'], description: 'Which TTT service line this lead is for. Ask the staff member.' },
            industry_id: { type: 'string', description: 'GUID of the lead\'s industry from riivo_industries. MUST be resolved via get_industries first — do not invent.' },
            phone: { type: 'string', description: "Lead's phone number (optional)" },
            email: { type: 'string', description: "Lead's email address (optional)" },
            notes: { type: 'string', description: 'Any additional notes (optional)' },
        },
        required: ['first_name', 'last_name', 'client_type', 'lead_type', 'industry_id'],
    },
    roles: ['user'],
    requiredPerm: 'create_lead',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as Record<string, any>;
        if (!ctx.contactId) {
            return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot set lead owner.' });
        }
        const clientTypeValue = CLIENT_TYPE_VALUES[a.client_type];
        const leadTypeValue = LEAD_TYPE_VALUES[a.lead_type];
        if (clientTypeValue === undefined) {
            return JSON.stringify({ status: 'error', message: `Unknown client_type "${a.client_type}". Must be one of: ${Object.keys(CLIENT_TYPE_VALUES).join(', ')}.` });
        }
        if (leadTypeValue === undefined) {
            return JSON.stringify({ status: 'error', message: `Unknown lead_type "${a.lead_type}". Must be one of: ${Object.keys(LEAD_TYPE_VALUES).join(', ')}.` });
        }
        if (!a.industry_id || !GUID_REGEX.test(String(a.industry_id))) {
            return JSON.stringify({ status: 'error', message: 'industry_id must be a GUID returned by get_industries. Run get_industries first to resolve the industry name.' });
        }
        const result = await ctx.deps.dynamics.createLead({
            firstName: a.first_name,
            lastName: a.last_name,
            phone: a.phone,
            email: a.email,
            notes: a.notes,
            clientType: clientTypeValue,
            leadType: leadTypeValue,
            industryId: a.industry_id,
            ownerSystemUserId: ctx.contactId,
        });
        if (result) {
            return JSON.stringify({
                status: 'success',
                lead_id: result.new_leadid,
                message: `Lead ${a.first_name} ${a.last_name} created successfully.`,
            });
        }
        return JSON.stringify({ status: 'error', message: 'Failed to create the lead. Check the server logs for the Dynamics error.' });
    },
};

const createContact: ToolEntry = {
    name: 'create_contact',
    description: "Create a new contact (client) in the CRM. Before calling, you MUST gather: first name, last name, entity_type, and the industry. Use get_industries to resolve the industry to a GUID. The Consultant (owner) and Primary TTT Representative both default to the staff member calling — do not ask for them.",
    input_schema: {
        type: 'object',
        properties: {
            first_name: { type: 'string', description: "Contact's first name" },
            last_name: { type: 'string', description: "Contact's last name" },
            entity_type: { type: 'string', enum: ['Individual', 'Business', 'Private Company', 'Closed Corporation', 'Business Trust', 'Sole Proprietorship'], description: 'What kind of entity the contact is. Ask the staff member.' },
            industry_id: { type: 'string', description: 'GUID of the contact\'s industry from riivo_industries. MUST be resolved via get_industries first.' },
            phone: { type: 'string', description: "Contact's mobile number (optional)" },
            email: { type: 'string', description: "Contact's email address (optional)" },
        },
        required: ['first_name', 'last_name', 'entity_type', 'industry_id'],
    },
    roles: ['user'],
    requiredPerm: 'create_contact',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as Record<string, any>;
        if (!ctx.contactId) {
            return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot set contact owner.' });
        }
        const entityTypeValue = CLIENT_TYPE_VALUES[a.entity_type];
        if (entityTypeValue === undefined) {
            return JSON.stringify({ status: 'error', message: `Unknown entity_type "${a.entity_type}". Must be one of: ${Object.keys(CLIENT_TYPE_VALUES).join(', ')}.` });
        }
        if (!a.industry_id || !GUID_REGEX.test(String(a.industry_id))) {
            return JSON.stringify({ status: 'error', message: 'industry_id must be a GUID returned by get_industries.' });
        }
        const result = await ctx.deps.dynamics.createContact({
            firstName: a.first_name,
            lastName: a.last_name,
            entityType: entityTypeValue,
            industryId: a.industry_id,
            ownerSystemUserId: ctx.contactId,
            primaryRepSystemUserId: ctx.contactId,
            phone: a.phone,
            email: a.email,
        });
        if (result?.contactid) {
            return JSON.stringify({
                status: 'success',
                contact_id: result.contactid,
                message: `Contact ${a.first_name} ${a.last_name} created successfully.`,
            });
        }
        return JSON.stringify({ status: 'error', message: 'Failed to create the contact. Check the server logs for the Dynamics error.' });
    },
};

const createInvoice: ToolEntry = {
    name: 'create_invoice',
    description: "Create a new invoice for an existing client. Before calling, you MUST resolve the customer to a Contact GUID via search_contact_by_name (the bot only supports invoicing Contacts, not Accounts). Then ask the staff member which type of invoice it is (Tax or Accounting). The Consultant (owner) defaults to the staff member calling.",
    input_schema: {
        type: 'object',
        properties: {
            customer_contact_id: { type: 'string', description: 'Contact GUID of the customer. MUST come from search_contact_by_name — never invent.' },
            invoice_type: { type: 'string', enum: ['Tax', 'Accounting'], description: 'Which type of invoice this is. Ask the staff member.' },
        },
        required: ['customer_contact_id', 'invoice_type'],
    },
    roles: ['user'],
    requiredPerm: 'create_invoice',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as Record<string, any>;
        if (!ctx.contactId) {
            return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot set invoice owner.' });
        }
        const invoiceTypeValue = INVOICE_TYPE_VALUES[a.invoice_type];
        if (invoiceTypeValue === undefined) {
            return JSON.stringify({ status: 'error', message: `Unknown invoice_type "${a.invoice_type}". Must be one of: ${Object.keys(INVOICE_TYPE_VALUES).join(', ')}.` });
        }
        if (!a.customer_contact_id || !GUID_REGEX.test(String(a.customer_contact_id))) {
            return JSON.stringify({ status: 'error', message: 'customer_contact_id must be a Contact GUID resolved via search_contact_by_name.' });
        }
        const result = await ctx.deps.dynamics.createInvoice({
            customerContactId: a.customer_contact_id,
            invoiceType: invoiceTypeValue,
            ownerSystemUserId: ctx.contactId,
        });
        if (result?.new_invoicesid) {
            return JSON.stringify({
                status: 'success',
                invoice_id: result.new_invoicesid,
                message: `${a.invoice_type} invoice created successfully.`,
            });
        }
        return JSON.stringify({ status: 'error', message: 'Failed to create the invoice. Check the server logs for the Dynamics error.' });
    },
};

const createTask: ToolEntry = {
    name: 'create_task',
    description: "Create a new task in the CRM for a client or lead. Gather ALL required info before calling: the client/lead (resolve their ID first using search_contact_by_name or search_lead_by_name), task type (use get_task_types to show options), and tax year. The primary representative is automatically set to the staff member.",
    input_schema: {
        type: 'object',
        properties: {
            client_or_lead: { type: 'string', description: 'The resolved GUID of the client (contact) or lead to link the task to.' },
            entity_type: { type: 'string', enum: ['contact', 'lead'], description: 'Whether the regarding entity is a contact or lead.' },
            task_type_id: { type: 'string', description: 'The GUID of the selected task type from get_task_types.' },
            task_type_name: { type: 'string', description: 'The display name of the task type (used for the subject line).' },
            tax_year: { type: 'number', description: 'The tax year as a 4-digit number (e.g. 2025).' },
            description: { type: 'string', description: 'Optional notes or description for the task.' },
        },
        required: ['client_or_lead', 'entity_type', 'task_type_id', 'task_type_name', 'tax_year'],
    },
    roles: ['user'],
    requiredPerm: 'create_task',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as Record<string, any>;
        const result = await ctx.deps.dynamics.createTask({
            regardingId: a.client_or_lead,
            regardingType: a.entity_type,
            taskTypeId: a.task_type_id,
            taskTypeName: a.task_type_name,
            taxYear: a.tax_year,
            primaryRepId: ctx.contactId as string,
            description: a.description,
        });
        if (result.success) {
            return JSON.stringify({
                status: 'success',
                message: `Task "${a.task_type_name}" created successfully for tax year ${a.tax_year}.`,
            });
        }
        return JSON.stringify({ status: 'error', message: `Failed to create task: ${result.error}` });
    },
};

const sendInvoicePdf: ToolEntry = {
    name: 'send_invoice_pdf',
    description: "Staff-only: DELIVER an invoice PDF to a specific client via WhatsApp. Requires the invoice number AND which client to send it to (name or phone number). Fetches the invoice, generates the PDF, sends as a WhatsApp document message, and logs the send to the client's timeline. Do NOT use this when the staff just wants to preview the PDF — use get_invoice_pdf for that.",
    input_schema: {
        type: 'object',
        properties: {
            invoice_number: { type: 'string', description: 'The invoice number to send (e.g. INV123)' },
            client: { type: 'string', description: 'The client to send to — their name or phone number. Will be resolved to a Contact record.' },
        },
        required: ['invoice_number', 'client'],
    },
    roles: ['user'],
    requiredPerm: 'send_invoice_pdf',
    // Orchestrates the 6-step flow (resolve client → fetch invoice → generate PDF →
    // send via Meta → log timeline note). Every failure mode returns a structured
    // status so the AI can surface a clear message to staff. Dry-run mode (no Meta
    // creds) is handled transparently inside the MetaPort's sendDocument.
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { invoice_number?: string; client?: string };
        const invoiceNum = a.invoice_number;
        const clientInput = a.client;
        if (!invoiceNum || !clientInput) {
            return JSON.stringify({ status: 'error', message: 'Both invoice_number and client are required.' });
        }
        if (!ctx.contactId) {
            return JSON.stringify({ status: 'error', message: 'No staff identity on session — cannot log invoice-send note.' });
        }

        // 1. Resolve the client to a Contact GUID. Inlined (rather than reusing
        //    resolveClientDetailed) to preserve the legacy phone-first priority:
        //    a phone that also matches a systemuser/lead must not win over the
        //    contact match.
        let clientId: string | null = null;
        let clientFullname = '';
        const inputTrimmed = clientInput.trim();
        if (GUID_REGEX.test(inputTrimmed)) {
            clientId = inputTrimmed;
        } else {
            try {
                const phoneShaped = /^[+0-9\s]+$/.test(inputTrimmed) && inputTrimmed.replace(/\D/g, '').length >= 9;
                if (phoneShaped) {
                    const contactDirect = await ctx.deps.dynamics.getContactByPhoneAndType(inputTrimmed, 'client');
                    if (contactDirect) {
                        clientId = contactDirect.id;
                        clientFullname = contactDirect.fullname || '';
                    }
                }
                if (!clientId) {
                    const byPhone = await ctx.deps.dynamics.getContactByPhone(inputTrimmed);
                    if (byPhone?.type === 'client') {
                        clientId = byPhone.id;
                        clientFullname = byPhone.fullname || '';
                    }
                }
                if (!clientId) {
                    const matches = await ctx.deps.dynamics.searchContactByName(inputTrimmed, ctx.ownerFilter);
                    console.log(`[send_invoice_pdf] searchContactByName("${inputTrimmed}", owner=${ctx.ownerFilter || 'none'}) → ${matches.length} match(es)`);
                    if (matches.length === 0) {
                        return JSON.stringify({ status: 'client_not_found', message: `No client matched "${clientInput}". Ask the staff to clarify — full name or phone number.` });
                    }
                    if (matches.length > 1) {
                        // Auto-resolve when only one candidate has a usable mobile
                        // number — the others physically cannot receive a WhatsApp
                        // document, so making the staff disambiguate is wasted friction.
                        const withMobile = matches.filter((m: any) => m.mobilephone && String(m.mobilephone).trim().length > 0);
                        if (withMobile.length === 1) {
                            console.log(`[send_invoice_pdf] Auto-resolved ambiguity: only ${withMobile[0].fullname} has a mobile; picking that contact.`);
                            clientId = withMobile[0].contactid;
                            clientFullname = withMobile[0].fullname || '';
                        } else {
                            return JSON.stringify({
                                status: 'client_ambiguous',
                                candidates: matches.map((m: any) => ({ id: m.contactid, fullname: m.fullname, mobilephone: m.mobilephone })),
                                message: `Multiple clients match "${clientInput}". Show the candidates (names + phones) to the staff and ask which one. When they pick one, re-call send_invoice_pdf with \`client\` set to that candidate's \`id\` value (the long GUID like "50334bea-1a00-f111-..."). Do NOT pass their name. Do NOT pass their phone number. ONLY the \`id\` GUID will work — anything else will loop back to this same ambiguous response.`,
                            });
                        }
                    } else {
                        clientId = matches[0].contactid;
                        clientFullname = matches[0].fullname || '';
                    }
                }
            } catch (e: any) {
                return JSON.stringify({ status: 'error', message: `Client lookup failed: ${e?.message || 'unknown error'}` });
            }
        }
        if (!clientId) {
            return JSON.stringify({ status: 'client_not_found', message: `No client matched "${clientInput}".` });
        }

        // 2. Fetch the contact's mobile number from Dynamics.
        const details = await ctx.deps.dynamics.getContactDetails(clientId);
        const clientPhone: string | undefined = details?.mobilephone || undefined;
        if (!clientPhone) {
            return JSON.stringify({ status: 'no_whatsapp_number', client_name: clientFullname, message: `${clientFullname || 'The client'} has no mobile number on file, so the PDF cannot be sent. Ask staff to update the client's contact record first.` });
        }
        if (!clientFullname && details?.fullname) clientFullname = details.fullname;

        // 3. Fetch the invoice and generate the PDF.
        const invoice = await ctx.deps.dynamics.getInvoiceByNumber(invoiceNum);
        if (!invoice) {
            return JSON.stringify({ status: 'invoice_not_found', message: `Invoice ${invoiceNum} could not be found in the CRM. Nothing was sent.` });
        }
        let pdfBuffer: Buffer;
        try {
            pdfBuffer = await ctx.deps.pdf.generateInvoicePdf(invoice);
        } catch (err: any) {
            console.error('[send_invoice_pdf] PDF generation failed:', err?.message || err);
            return JSON.stringify({ status: 'send_failed', message: `PDF generation failed for invoice ${invoiceNum}. Nothing was sent. Please try again.` });
        }

        // 4. Send via Meta (or stub in dry-run mode). Caption includes recipient's
        //    first name + sender's name so the client sees who at TTT initiated the
        //    send. Falls back gracefully if either name is missing.
        const recipientFirst = clientFullname ? clientFullname.split(/\s+/)[0] : '';
        const senderName = (ctx.userFullName && ctx.userFullName.trim()) || 'the team';
        const greeting = recipientFirst ? `Hi ${recipientFirst}` : 'Hi there';
        const caption = `${greeting}, ${senderName} from TTT has sent you an invoice. Please find it attached. Thank you.`;
        const sendResult = await ctx.deps.meta.sendDocument(
            clientPhone,
            pdfBuffer,
            `${invoiceNum}.pdf`,
            caption,
        );

        // 5. If Meta reported a real failure (not a dry-run), stop here — no
        //    timeline note. Dry-run counts as "would have delivered" so we still
        //    log the audit trail.
        if (!sendResult.delivered && !sendResult.dryRun) {
            return JSON.stringify({ status: 'send_failed', message: `WhatsApp delivery failed: ${sendResult.error || 'unknown error'}. The client was not notified and no timeline note was written.` });
        }

        // 6. Log the send to the client's Contact timeline.
        await ctx.deps.dynamics.logInvoiceSentToContact(clientId, invoiceNum, ctx.contactId);

        const pdfPreviewUrl = `http://localhost:3001/api/pdf/invoice/${invoiceNum}`;
        return JSON.stringify({
            status: 'sent',
            invoice_number: invoiceNum,
            client_name: clientFullname || 'the client',
            client_phone: clientPhone,
            whatsapp_caption: caption,
            dry_run: Boolean(sendResult.dryRun),
            pdf_preview_url: pdfPreviewUrl,
            message: sendResult.dryRun
                ? `TEST MODE — no real WhatsApp message was sent. Confirm to the staff that:\n- Invoice ${invoiceNum} has been "sent" to ${clientFullname || 'the client'}.\n- It would have been delivered to: ${clientPhone}\n- PDF preview link: ${pdfPreviewUrl}\n- The caption that would accompany the PDF reads: "${caption}"\nMention all four lines (client name + phone + preview link + caption) verbatim so the staff can verify targeting, content, and message wording.`
                : `Invoice ${invoiceNum} has been sent to ${clientFullname || 'the client'} via WhatsApp.`,
        });
    },
};

const referFriend: ToolEntry = {
    name: 'refer_friend',
    description: "STAFF ONLY. Use when a TTT staff member (on a phone call with a client, or following up after one) wants to log a referral from an existing client on the client's behalf. Creates a new lead linked to the referring client. Ask the staff member for the friend's name, phone number, email address, and which service they need. This tool is NOT exposed to clients — clients can only get their own referral link via get_my_referral_code and must forward it themselves.",
    input_schema: {
        type: 'object',
        properties: {
            friend_name: { type: 'string', description: "The friend's full name" },
            friend_phone: { type: 'string', description: "The friend's phone number" },
            friend_email: { type: 'string', description: "The friend's email address" },
            service: { type: 'string', enum: ['Insurance', 'Tax', 'Accounting', 'Financial Planning', 'Not sure'], description: "Which service they're interested in" },
        },
        required: ['friend_name', 'friend_phone', 'friend_email', 'service'],
    },
    // refer_friend is STAFF ONLY but intentionally ungated (no requiredPerm) — it
    // was never listed in the legacy STAFF_TOOL_PERMISSIONS map.
    roles: ['user'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as Record<string, any>;
        const nameParts = (a.friend_name || '').trim().split(/\s+/);
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || firstName;

        // Map the client-facing service enum to the riivo_leadtype Choice value.
        // "Insurance" / "Financial Planning" / "Not sure" fall through to Tax as a
        // safe default — TTT staff can re-route the lead afterwards if needed.
        // Keeping this here (not in the dynamics method) so the staff create_lead
        // tool stays strict.
        const REFER_LEAD_TYPE_MAP: Record<string, number> = {
            'Tax': 100000000,
            'Accounting': 100000001,
            'Insurance': 463630002,        // defaulting to Short Term Insurance
            'Financial Planning': 100000001,
            'Not sure': 100000000,
        };
        const leadTypeValue = REFER_LEAD_TYPE_MAP[a.service] ?? 100000000;

        // Inherit owner from the referring client so the new lead has a populated
        // ownerid (Lead.ownerid is now Business Required). If we can't resolve it,
        // the create will fail at Dynamics — log a clear error rather than guess.
        let ownerSystemUserId: string | undefined;
        if (ctx.contactId) {
            ownerSystemUserId = (await ctx.deps.dynamics.getContactOwnerId(ctx.contactId)) || undefined;
            if (!ownerSystemUserId) {
                console.warn(`[refer_friend] Could not resolve owner for referring contact ${ctx.contactId}; lead create will likely fail.`);
            }
        }

        // "Other" industry — keeps Industry populated without asking the client.
        // Hardcoded GUID from riivo_industries (label "Other"). If TTT changes that
        // record, update this constant.
        const OTHER_INDUSTRY_ID = '02c54e15-95ce-f011-8543-000d3a69c99c';

        const result = await ctx.deps.dynamics.createLead({
            firstName,
            lastName,
            phone: a.friend_phone,
            email: a.friend_email,
            department: a.service,
            notes: `Referred by existing client. Interested in: ${a.service || 'Not specified'}`,
            referredByContactId: ctx.contactId ?? undefined,
            clientType: 0,                  // Individual — referrals default to person
            leadType: leadTypeValue,
            industryId: OTHER_INDUSTRY_ID,
            ownerSystemUserId,
        });
        if (result) {
            return JSON.stringify({
                status: 'success',
                message: `${a.friend_name}'s details have been passed to our ${a.service || ''} team. We'll be in touch with them shortly.`,
            });
        }
        return JSON.stringify({ status: 'error', message: 'Failed to create the referral.' });
    },
};

// ===========================================================================
// Staff read + LoE flow Tools (slice 6). get_case_by_name is a staff read
// (gated by view_open_cases); the LoE trio is gated by upload_letter_of_engagement
// and drives the staged OCR → review → CRM-write flow. The OCR/extraction
// pipeline is reached through ctx.deps.loeOcr; the staged WhatsApp file through
// ctx.pendingUpload; the staged Supabase review row through ctx.pendingLoe — so
// none of mistral/loe-extractor/supabase enter the tool module graph. Output
// strings + schemas are byte-for-byte the legacy first-round dispatch.
// ===========================================================================

const getCaseByName: ToolEntry = {
    name: 'get_case_by_name',
    description: "Search for a specific case by name or reference (e.g. 'Lloyd Pienaar - 2025'). Returns case details including stage, process, and status.",
    input_schema: {
        type: 'object',
        properties: {
            case_name: { type: 'string', description: 'The case name or partial name to search for' },
        },
        required: ['case_name'],
    },
    roles: ['user'],
    requiredPerm: 'view_open_cases',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { case_name?: string };
        const cases = await ctx.deps.dynamics.searchCaseByName(a.case_name as string);
        return cases.length > 0 ? JSON.stringify(cases) : 'No cases found matching that name.';
    },
};

// Pure formatter: render the staged LoE row (all 16 reviewable fields) for the
// staff member. Lifted verbatim from claude.service's enclosing-scope closure.
function formatLoeFields(row: any): string {
    const lines: string[] = [];
    const f = (label: string, val: any) => lines.push(`• ${label}: ${val || '(not found)'}`);
    // Client details
    f('First Name', row.client_first_name);
    f('Last Name', row.client_last_name);
    f('ID Number', row.id_number);
    f('Income Tax Number', row.income_tax_number);
    f('Physical Address', row.physical_address);
    f('Email', row.email_address);
    f('Contact Number', row.contact_number);
    f('Industry', row.industry);
    // Banking
    f('Bank Name', row.bank_name);
    f('Account Name', row.account_name);
    f('Account Number', row.account_number);
    f('Account Type', row.account_type);
    f('Branch Name/Code', row.branch_name_code);
    // Signing
    f('Signed At (Client)', row.signed_at);
    f('Signed At (Consultant)', row.signed_at_consultant);
    f('Signed Date', row.signed_date);
    return lines.join('\n');
}

const uploadLetterOfEngagement: ToolEntry = {
    name: 'upload_letter_of_engagement',
    description: "Start the LOE upload flow. Runs OCR on the uploaded PDF, extracts banking and signing details, and stages them for staff review. Does NOT write to CRM yet — the staff must confirm the extracted data first (via confirm_loe_upload) or correct fields (via update_loe_field). Use ONLY after: (1) the staff member has uploaded a PDF, (2) you've confirmed the target lead via search_lead_by_name. Will refuse non-PDF files.",
    input_schema: {
        type: 'object',
        properties: {
            lead_id: { type: 'string', description: 'The new_leadid GUID of the lead to attach the LOE to.' },
            lead_name: { type: 'string', description: "The lead's full name (for confirmation in the response)." },
        },
        required: ['lead_id', 'lead_name'],
    },
    roles: ['user'],
    requiredPerm: 'upload_letter_of_engagement',
    // OCR → extract → stage in Supabase. Does NOT write to CRM. Returns the
    // extracted fields for staff review.
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { lead_id?: string; lead_name?: string };
        if (!ctx.phoneNumber) {
            return JSON.stringify({ status: 'error', error: 'no_phone', message: 'Cannot upload — no phone number on session.' });
        }
        if (!ctx.sessionId) {
            return JSON.stringify({ status: 'error', message: 'No session ID available — cannot stage LOE data.' });
        }
        const staged = ctx.pendingUpload.peek();
        if (!staged) {
            return JSON.stringify({ status: 'error', error: 'no_pending_upload', message: 'No file is staged. Ask the staff member to upload the signed LOE PDF first.' });
        }
        if (staged.mimeType !== 'application/pdf') {
            return JSON.stringify({
                status: 'error',
                error: 'wrong_file_type',
                message: `Letters of Engagement must be PDF. The uploaded file is ${staged.mimeType || 'an unknown type'}. Please ask the staff member to resend it as a PDF.`,
            });
        }
        if (!a.lead_id || !GUID_REGEX.test(String(a.lead_id))) {
            return JSON.stringify({ status: 'error', error: 'invalid_lead_id', message: 'lead_id must be the GUID returned from search_lead_by_name. Run that lookup first.' });
        }

        // Check if LOE already received — warn but don't block. The staff may
        // legitimately be replacing an old LOE.
        const check = await ctx.deps.dynamics.checkLoeAlreadyReceived(a.lead_id);
        let alreadyReceivedWarning = '';
        if (check.alreadyReceived) {
            alreadyReceivedWarning = `NOTE: An LOE has already been received for ${check.leadName || a.lead_name}. Proceeding will overwrite the existing data. Let the staff member know and ask if they want to continue.`;
            console.log(`[LOE] Lead ${a.lead_id} already has LOE Received = true — proceeding with re-upload`);
        }

        // Run OCR
        let ocrMarkdown: string | null = null;
        let ocrPageCount: number | undefined;
        if (ctx.deps.loeOcr.isConfigured()) {
            try {
                const ocrResult = await ctx.deps.loeOcr.ocrDocument(staged.fileName, staged.buffer, 'application/pdf');
                ocrMarkdown = ocrResult.fullMarkdown;
                ocrPageCount = ocrResult.pageCount;
                console.log(`[LOE] OCR'd ${staged.fileName} → ${ocrPageCount} pages, ${ocrMarkdown.length} chars`);
            } catch (err: any) {
                console.warn(`[LOE] OCR failed: ${err?.message || err}`);
            }
        } else {
            console.log('[LOE] OCR skipped — MISTRAL_API_KEY not set');
        }

        // Log the raw OCR output so we can verify what Mistral saw
        if (ocrMarkdown) {
            console.log(`[LOE] --- OCR RAW TEXT START ---`);
            console.log(ocrMarkdown.slice(0, 3000));
            if (ocrMarkdown.length > 3000) console.log(`[LOE] ... (${ocrMarkdown.length - 3000} more chars truncated from log)`);
            console.log(`[LOE] --- OCR RAW TEXT END ---`);
        }

        // Extract fields
        const extracted = ocrMarkdown
            ? await ctx.deps.loeOcr.extractBankingDetails(ocrMarkdown)
            : {};
        console.log(`[LOE] Extracted fields:`, JSON.stringify(extracted, null, 2));

        // Stage everything in Supabase for review
        const pendingId = await ctx.pendingLoe.save({
            leadId: a.lead_id,
            leadName: a.lead_name || null,
            fileName: staged.fileName,
            fileBuffer: staged.buffer,
            ...extracted,
            // OCR
            ocrMarkdown: ocrMarkdown || undefined,
            ocrPageCount,
        });

        if (!pendingId) {
            return JSON.stringify({ status: 'error', message: 'Failed to stage LOE data for review. Please try again.' });
        }

        // Clear the in-memory pending upload — data is now in Supabase
        ctx.pendingUpload.clear();

        // Return the extracted fields for the AI to show to staff
        const pending = await ctx.pendingLoe.get();
        const fieldDisplay = pending ? formatLoeFields(pending) : '(no fields extracted)';

        return JSON.stringify({
            status: 'pending_review',
            lead_name: a.lead_name,
            fields: fieldDisplay,
            already_received_warning: alreadyReceivedWarning || undefined,
            message: `${alreadyReceivedWarning ? alreadyReceivedWarning + '\n\n' : ''}I've extracted the following details from the LOE for ${a.lead_name}:\n\n${fieldDisplay}\n\nPlease review these details. If anything is incorrect, tell me which field to update (e.g. "bank name should be Capitec"). Once everything looks correct, say "confirm" to write to the CRM.`,
        });
    },
};

const confirmLoeUpload: ToolEntry = {
    name: 'confirm_loe_upload',
    description: "Staff has reviewed the extracted LOE data and confirms it is correct. This writes everything to the CRM: the PDF file to the Lead's Signed Letter of Engagement field, the banking/signing fields to the Lead record, and flips LOE Received to true. No parameters needed — reads from the staged data in the current session. Only call this AFTER showing the extracted fields and the staff saying 'yes', 'confirm', 'looks good', or similar.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['user'],
    requiredPerm: 'upload_letter_of_engagement',
    // Write the staged + reviewed data to CRM: PDF file → Lead, fields → Lead,
    // flip LOE Received true.
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        if (!ctx.sessionId) {
            return JSON.stringify({ status: 'error', message: 'No session ID available.' });
        }
        const row = await ctx.pendingLoe.confirm();
        if (!row) {
            return JSON.stringify({ status: 'error', message: 'No pending LOE data found to confirm. Upload a document first.' });
        }

        const triggeredBy = ctx.contactId || 'unknown';

        // Step 1: Upload the PDF file to the Lead's file column
        const fileResult = await ctx.deps.dynamics.uploadLoeFileToCrm(
            row.lead_id,
            row.file_name,
            row.file_buffer,
            triggeredBy,
        );
        if (!fileResult.success) {
            return JSON.stringify({ status: 'error', message: `Failed to upload LOE PDF to CRM: ${fileResult.error}. The data has NOT been written. Please try again.` });
        }

        // Step 2: Write confirmed fields + flip LOE Received flag
        const fieldResult = await ctx.deps.dynamics.writeLoeFieldsToLead(
            row.lead_id,
            {
                bankName: row.bank_name,
                accountName: row.account_name,
                accountNumber: row.account_number,
                accountType: row.account_type,
                branchNameCode: row.branch_name_code,
                signedAt: row.signed_at,
                signedAtConsultant: row.signed_at_consultant,
                signedDate: row.signed_date,
                clientFirstName: row.client_first_name,
                clientLastName: row.client_last_name,
                idNumber: row.id_number,
                incomeTaxNumber: row.income_tax_number,
                physicalAddress: row.physical_address,
                emailAddress: row.email_address,
                contactNumber: row.contact_number,
                industry: row.industry,
            },
            triggeredBy,
        );

        // Clean up staging row
        await ctx.pendingLoe.delete();

        if (!fieldResult.success) {
            return JSON.stringify({
                status: 'partial_success',
                message: `LOE PDF uploaded to ${row.lead_name}'s record, but the field update failed: ${fieldResult.error}. Please update the banking details manually in the CRM.`,
            });
        }

        return JSON.stringify({
            status: 'confirmed',
            lead_name: row.lead_name,
            message: `LOE for ${row.lead_name} has been saved. The signed PDF is attached, banking and signing details are updated, and LOE Received is set to true.`,
        });
    },
};

const updateLoeField: ToolEntry = {
    name: 'update_loe_field',
    description: "Staff wants to correct an extracted LOE field before confirming. Updates the staged data. After updating, show all fields again and ask to confirm or correct more.",
    input_schema: {
        type: 'object',
        properties: {
            field_name: { type: 'string', enum: ['client_first_name', 'client_last_name', 'id_number', 'income_tax_number', 'physical_address', 'email_address', 'contact_number', 'industry', 'bank_name', 'account_name', 'account_number', 'account_type', 'branch_name_code', 'signed_at', 'signed_at_consultant', 'signed_date'], description: 'Which field to update.' },
            new_value: { type: 'string', description: 'The corrected value.' },
        },
        required: ['field_name', 'new_value'],
    },
    roles: ['user'],
    requiredPerm: 'upload_letter_of_engagement',
    // Correct a single staged field before confirming, then re-show all fields.
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        if (!ctx.sessionId) {
            return JSON.stringify({ status: 'error', message: 'No session ID available.' });
        }
        const a = (args ?? {}) as { field_name?: string; new_value?: string };
        if (!a.field_name || !a.new_value) {
            return JSON.stringify({ status: 'error', message: 'Both field_name and new_value are required.' });
        }

        const success = await ctx.pendingLoe.updateField(a.field_name, a.new_value);
        if (!success) {
            return JSON.stringify({ status: 'error', message: `Could not update field "${a.field_name}". Make sure there is a pending LOE upload in progress.` });
        }

        // Re-read and show updated fields
        const pending = await ctx.pendingLoe.get();
        const fieldDisplay = pending ? formatLoeFields(pending) : '(no data)';

        return JSON.stringify({
            status: 'updated',
            field_name: a.field_name,
            new_value: a.new_value,
            fields: fieldDisplay,
            message: `Updated ${a.field_name} to "${a.new_value}". Here are the current details:\n\n${fieldDisplay}\n\nIs everything correct now? Say "confirm" to write to the CRM, or tell me what else to change.`,
        });
    },
};

export const staffToolEntries: ToolEntry[] = [
    getMyClients,
    getMyLeads,
    searchContactByName,
    getClientDetails,
    getTaskTypes,
    searchLeadByName,
    getIndustries,
    createCase,
    createLead,
    createContact,
    createInvoice,
    createTask,
    sendInvoicePdf,
    referFriend,
    getCaseByName,
    uploadLetterOfEngagement,
    confirmLoeUpload,
    updateLoeField,
];

register(staffToolEntries);
