/**
 * Client-audience Tool handlers, migrated into the Tool registry (slice 1).
 *
 * Each handler is `handle(args, ctx) => Promise<string>` and reaches services
 * only through `ctx.deps` (the narrow Ports) — never via a direct singleton
 * import. The returned string is the same tool-result Claude already consumes;
 * these three are byte-for-byte the strings the inline first-round dispatch
 * produced before the migration.
 */

import { register, type ToolContext, type ToolEntry } from './registry';

const getMyDetails: ToolEntry = {
    name: 'get_my_details',
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const details = await ctx.deps.dynamics.getContactDetails(ctx.contactId as string);
        return details ? JSON.stringify(details) : "I couldn't retrieve your details at this time.";
    },
};

const getTaxNumber: ToolEntry = {
    name: 'get_tax_number',
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const taxNumber = await ctx.deps.dynamics.getContactTaxNumber(ctx.contactId as string);
        return taxNumber ? `Your Tax Number is: ${taxNumber}` : 'I could not find a tax number on your profile.';
    },
};

const getClientInvoices: ToolEntry = {
    name: 'get_client_invoices',
    input_schema: {
        type: 'object',
        properties: {
            client: { type: 'string', description: 'Client name or phone number (staff only — not needed for clients viewing their own)' },
        },
        required: [],
    },
    roles: ['client', 'user'],
    requiredPerm: 'view_outstanding_invoices',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { client?: string };
        if (ctx.entityType === 'user') {
            if (!a.client) {
                return 'I need a client name or phone number to look up their invoices. Which client?';
            }
            const r = await ctx.resolveClientDetailed(a.client);
            if (r.status === 'found') {
                const data = await ctx.deps.dynamics.getClientInvoices(r.id);
                return JSON.stringify({ client_id: r.id, client_name: r.fullname, invoices: data });
            } else if (r.status === 'ambiguous') {
                return JSON.stringify({
                    error: 'multiple_matches',
                    message: `Multiple clients match "${a.client}". Ask the user which one they mean.`,
                    candidates: r.candidates,
                });
            } else if (r.status === 'not_found') {
                return JSON.stringify({
                    error: 'not_found',
                    message: `No client found matching "${a.client}". Ask the user to provide the full name, or a phone number, or call get_my_clients to see the full list of their clients.`,
                });
            } else {
                return JSON.stringify({
                    error: 'lookup_failed',
                    message: `Client lookup failed: ${r.message}. Tell the user the CRM had an error.`,
                });
            }
        }
        const data = await ctx.deps.dynamics.getClientInvoices(ctx.contactId as string);
        return JSON.stringify(data);
    },
};

export const clientToolEntries: ToolEntry[] = [getMyDetails, getTaxNumber, getClientInvoices];

register(clientToolEntries);
