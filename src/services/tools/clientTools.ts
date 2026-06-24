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
import { buildReferralCodePayload } from '../referral-window';
import {
    TAX_FORMS,
    getAllForms,
    getFormByKey,
    getPersonalizedForms,
    formatCatalogMessage,
    formatSendCaption,
} from '../taxForms.service';
import { renderOutstandingDocsList } from '../../domain/irp5Reply';
import { pickBranchForLocation, formatBranch, formatAllBranches } from '../../utils/officeContacts';

const getMyDetails: ToolEntry = {
    name: 'get_my_details',
    description: "Use when the user asks for their details on file, profile information, personal info, or wants to see what data you have about them. Do NOT use this for invoices or cases.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const details = await ctx.deps.dynamics.getContactDetails(ctx.contactId as string);
        return details ? JSON.stringify(details) : "I couldn't retrieve your details at this time.";
    },
};

const getTaxNumber: ToolEntry = {
    name: 'get_tax_number',
    description: "Use this when the user asks for their tax number, tax reference number, or income tax number.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const taxNumber = await ctx.deps.dynamics.getContactTaxNumber(ctx.contactId as string);
        return taxNumber ? `Your Tax Number is: ${taxNumber}` : 'I could not find a tax number on your profile.';
    },
};

const getClientInvoices: ToolEntry = {
    name: 'get_client_invoices',
    description: "Get invoices. For clients, returns their own invoices. For staff, provide a client name or phone to look up their invoices.",
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

const getClientCases: ToolEntry = {
    name: 'get_client_cases',
    description: "Get the client's tax returns (called \"cases\" internally in the CRM, but ALWAYS refer to them as \"tax returns\" when talking to a client). For clients, returns their own tax returns. For staff, returns tax returns they own as consultant — for staff you can use \"case\" since it's internal vocabulary. Optionally provide a client name or phone to look up a specific client's tax returns. If a result is clearly a non-tax-return type (e.g. a Complaint, Query, Claim, Admin), refer to it by that specific type instead.",
    input_schema: {
        type: 'object',
        properties: {
            client: { type: 'string', description: "Client name or phone number (optional — to look up a specific client's tax returns)" },
        },
        required: [],
    },
    roles: ['client', 'user'],
    requiredPerm: 'view_open_cases',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { client?: string };
        if (ctx.entityType === 'user' && a.client) {
            const r = await ctx.resolveClientDetailed(a.client);
            if (r.status === 'found') {
                const data = await ctx.deps.dynamics.getClientCases(r.id);
                return JSON.stringify({ client_id: r.id, client_name: r.fullname, cases: data });
            } else if (r.status === 'ambiguous') {
                return JSON.stringify({
                    error: 'multiple_matches',
                    message: `Multiple clients match "${a.client}". Ask the user which one they mean.`,
                    candidates: r.candidates,
                });
            } else if (r.status === 'not_found') {
                return JSON.stringify({
                    error: 'not_found',
                    message: `No client found matching "${a.client}". Ask for the full name or phone number, or call get_my_clients.`,
                });
            } else {
                return JSON.stringify({
                    error: 'lookup_failed',
                    message: `Client lookup failed: ${r.message}.`,
                });
            }
        }
        if (ctx.entityType === 'user') {
            // Staff viewing their own assigned cases.
            const data = await ctx.deps.dynamics.getStaffCases(ctx.contactId as string);
            return JSON.stringify(data);
        }
        // Client viewing their own cases.
        const data = await ctx.deps.dynamics.getClientCases(ctx.contactId as string);
        return JSON.stringify(data);
    },
};

const getOutstandingBalance: ToolEntry = {
    name: 'get_outstanding_balance',
    description: "Get the total outstanding (unpaid) invoice amount for a client. For clients, returns their own balance. For staff, provide a client name or phone.",
    input_schema: {
        type: 'object',
        properties: {
            client: { type: 'string', description: 'Client name or phone number (staff only — not needed for clients)' },
        },
        required: [],
    },
    roles: ['client', 'user'],
    requiredPerm: 'view_outstanding_invoices',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { client?: string };
        let targetId = ctx.contactId;
        let targetName: string | undefined;
        if (ctx.entityType === 'user' && a.client) {
            const r = await ctx.resolveClientDetailed(a.client);
            if (r.status === 'found') {
                targetId = r.id;
                targetName = r.fullname;
            } else if (r.status === 'ambiguous') {
                return JSON.stringify({
                    error: 'multiple_matches',
                    message: `Multiple clients match "${a.client}". Ask the user which one they mean.`,
                    candidates: r.candidates,
                });
            } else if (r.status === 'not_found') {
                return JSON.stringify({
                    error: 'not_found',
                    message: `No client found matching "${a.client}".`,
                });
            }
            // A lookup 'error' falls through to a balance lookup on the caller's
            // own contactId, matching the legacy first-round behaviour.
        }
        const balance = await ctx.deps.dynamics.getOpenInvoiceTotal(targetId as string);
        return JSON.stringify({
            client_id: targetId,
            client_name: targetName,
            outstanding_amount: `R${balance.total.toFixed(2)}`,
            open_invoices: balance.count,
        });
    },
};

const getMyConsultant: ToolEntry = {
    name: 'get_my_consultant',
    description: "Look up the client's assigned consultant (the owner of their contact record in Dynamics). Use this when the client asks who their consultant is, who is handling their account, who their tax practitioner is, or similar. Returns the consultant's name and email.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const ownerId = await ctx.deps.dynamics.getContactOwnerId(ctx.contactId as string);
        if (!ownerId) {
            return JSON.stringify({
                status: 'no_consultant',
                message: "You don't have a dedicated consultant assigned yet. Would you like me to request a callback from our team?",
            });
        }
        const consultant = await ctx.deps.dynamics.getSystemUserById(ownerId);
        if (!consultant) {
            return JSON.stringify({
                status: 'no_consultant',
                message: "You don't have a dedicated consultant assigned yet. Would you like me to request a callback from our team?",
            });
        }
        const emailLine = consultant.email ? ` You can reach them at ${consultant.email}.` : '';
        return JSON.stringify({
            status: 'success',
            fullname: consultant.fullname,
            email: consultant.email,
            message: `Your consultant is ${consultant.fullname}.${emailLine}`,
        });
    },
};

const getOfficeContact: ToolEntry = {
    name: 'get_office_contact',
    description: "Use when the client asks for a GENERAL way to contact TTT — a phone number, an email, the office details, or 'how do I reach you / the office'. Do NOT use this when they ask for their own specific consultant (use get_my_consultant for that). Returns the TTT branch nearest the client (based on their location on file) or all branches if their location isn't known. Relay the returned details verbatim.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        let detail = formatAllBranches();
        if (ctx.entityType === 'client' && ctx.contactId) {
            try {
                const loc = await ctx.deps.dynamics.getContactLocation(ctx.contactId);
                const branch = loc ? pickBranchForLocation(loc) : null;
                if (branch) detail = formatBranch(branch);
            } catch (e: any) {
                console.warn(`[get_office_contact] location lookup failed: ${e?.message || e}`);
            }
        }
        return JSON.stringify({
            status: 'success',
            message: `Share these TTT office contact details with the client, exactly as written:\n\n${detail}`,
        });
    },
};

const getMyReferralCode: ToolEntry = {
    name: 'get_my_referral_code',
    description: "Client wants their own referral code / referral link to share with a friend so the friend can sign up to TTT. Returns the client's unique referral code (from Dynamics) for embedding into a magic link. The model is responsible for composing the reply and including the full programme explanation — see the get_my_referral_code response instructions in the system prompt.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        if (!ctx.contactId) {
            return JSON.stringify({ status: 'error', message: 'No contact context — cannot look up referral code.' });
        }
        const code = await ctx.deps.dynamics.getContactReferralCode(ctx.contactId);
        if (!code) {
            return JSON.stringify({
                status: 'missing_code',
                code: null,
                message: 'No referral code is set on this contact record. Apologise briefly, offer to have the consultant look into it (request_consultant_callback). Do NOT invent a code.',
            });
        }
        return JSON.stringify(buildReferralCodePayload({ code, currentDate: new Date() }));
    },
};

// ── Tax-season FAQ Tools ───────────────────────────────────────────────────
// These delegate to the TaxFaqPort handlers, which already encapsulate the
// Dynamics/Graph/required-docs logic and the not-found / disabled / error paths.
// The handler here is only responsible for mapping ctx + args onto the call.

const parseTaxYear = (args: unknown): number | undefined => {
    const a = (args ?? {}) as { tax_year?: unknown };
    return typeof a.tax_year === 'number' ? a.tax_year : undefined;
};

const taxYearSchema = {
    type: 'object',
    properties: {
        tax_year: { type: 'number', description: 'Optional 4-digit tax year.' },
    },
    required: [],
} as const;

const getRequiredDocuments: ToolEntry = {
    name: 'get_required_documents',
    description: "Tell the client which tax documents are still outstanding. Use this whenever the client asks what documents they need to send, upload, submit, or provide — \"what do I need?\", \"what must I send for my tax return?\", \"what docs do you need from me?\", \"what's outstanding?\". The tool builds the expected list from the client's SARS source codes + industry (falling back to a typical-return baseline if none are on file), then cross-references the riivo_taxsubmissionsdocuments entity to mark what's already been uploaded and what's still missing. The returned message is already formatted — relay it verbatim; do NOT paraphrase it or mention SARS source codes.",
    input_schema: {
        type: 'object',
        properties: {
            tax_year: { type: 'number', description: 'Optional 4-digit tax year (e.g. 2026) if the client specifies one. Omit to use the most recent preseason record.' },
        },
        required: [],
    },
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        return ctx.deps.taxFaq.getRequiredDocuments({
            contactId: ctx.contactId as string,
            taxYear: parseTaxYear(args),
        });
    },
};

const getRefundStatus: ToolEntry = {
    name: 'get_refund_status',
    description: "Answer 'what's my refund?' for the client. Reads riivo_potentialrefund on each of the client's ACTIVE tax returns (cases in the CRM). If the field is populated, returns the rand amount along with the tax return stage and tax year. If the field is null or 0, returns a 'we're not sure yet' status AND fires an email to the tax return owner via tina-bot nudging them to confirm the amount. When relaying to the client, ALWAYS use the phrase \"tax return\" — never \"case\". Use whenever the client asks about their refund — \"how much will I get back?\", \"any update on my refund?\", \"is my refund in yet?\".",
    input_schema: {
        type: 'object',
        properties: {
            tax_year: { type: 'number', description: 'Optional 4-digit tax year. Omit to list all active tax returns.' },
        },
        required: [],
    },
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        return ctx.deps.taxFaq.getRefundStatus({
            contactId: ctx.contactId as string,
            clientName: ctx.userFullName || 'Client',
            clientPhone: ctx.phoneNumber,
            taxYear: parseTaxYear(args),
        });
    },
};

const getSubmissionStatus: ToolEntry = {
    name: 'get_submission_status',
    description: "Answer 'have you submitted me?'. The bot knows a client has been submitted iff an active tax return exists for them — TTT only sets one up once the return is ready to file. Returns per-year submission status sourced from icon_casestage on each active tax return. When relaying to the client, ALWAYS use the phrase \"tax return\" — never \"case\". Use whenever the client asks about whether their return has been filed — \"have you submitted my return?\", \"did you file me already?\", \"any update on my submission?\".",
    input_schema: taxYearSchema,
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        return ctx.deps.taxFaq.getSubmissionStatus({
            contactId: ctx.contactId as string,
            taxYear: parseTaxYear(args),
        });
    },
};

const getReceivedDocuments: ToolEntry = {
    name: 'get_received_documents',
    description: "Answer 'have you received my docs?' / 'what have you got from me so far?'. Reads every active row from riivo_taxsubmissionsdocuments linked to the client (single source of truth — covers both WhatsApp uploads and Power Automate emailed-doc rows) and returns a flat list of document types received. When relaying to the client, ALWAYS use the phrase \"tax return\" — never \"case\". Use whenever the client wants to confirm what TTT has received from them.",
    input_schema: taxYearSchema,
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        return ctx.deps.taxFaq.getReceivedDocuments({
            contactId: ctx.contactId as string,
            taxYear: parseTaxYear(args),
        });
    },
};

const getAuditStatus: ToolEntry = {
    name: 'get_audit_status',
    description: "Answer 'is my tax return in audit / what's happening with my audit?'. Detects audit by checking whether any active tax return has icon_casestage set to the 'On Audit' value. If on audit, reads riivo_dateplacedonaudit and computes working days elapsed, plus tells the client whether they're within the standard 21-day SARS window or the extended 60-day window. When relaying to the client, ALWAYS use the phrase \"tax return\" — never \"case\". Use whenever the client asks about audit, verification, or SARS reviewing their return.",
    input_schema: taxYearSchema,
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        return ctx.deps.taxFaq.getAuditStatus({
            contactId: ctx.contactId as string,
            taxYear: parseTaxYear(args),
        });
    },
};

// ── Client document & action Tools (slice 4) ───────────────────────────────
// Write/action Tools migrated off the inline dispatch. They reach the wider
// service surface (Meta, Graph mail, Supabase flags, SharePoint forms, the IRP5
// pipeline) through narrow Ports on ctx.deps, and the staged WhatsApp upload via
// ctx.pendingUpload. Output strings are byte-for-byte the legacy first-round
// dispatch; see ADR 0003 for the two get_invoice_pdf / follow-up-loop strings
// that this slice unifies onto the first-round version.

const getInvoicePdf: ToolEntry = {
    name: 'get_invoice_pdf',
    description: "Use this when the user wants to VIEW or DOWNLOAD a PDF of a specific invoice for themselves. Returns a link. Do NOT use this to send an invoice to a client — use send_invoice_pdf for that.",
    input_schema: {
        type: 'object',
        properties: {
            invoice_number: { type: 'string', description: 'The invoice number (e.g. INV123)' },
        },
        required: ['invoice_number'],
    },
    roles: ['client', 'user'],
    requiredPerm: 'send_invoice_pdf',
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { invoice_number?: string };
        const invoiceNum = a.invoice_number;
        const invoice = await ctx.deps.dynamics.getInvoiceByNumber(invoiceNum as string);
        if (!invoice) {
            return JSON.stringify({ status: 'error', message: `Invoice ${invoiceNum} not found.` });
        }
        // Return a download link — the /api/pdf route regenerates the PDF on
        // demand from the same source data.
        console.log(`[PDF] Invoice ${invoiceNum} found, returning download link`);
        return JSON.stringify({
            status: 'success',
            message: `Here's your invoice: [📄 Download ${invoiceNum}.pdf](http://localhost:3001/api/pdf/invoice/${invoiceNum})`,
            pdfLink: `http://localhost:3001/api/pdf/invoice/${invoiceNum}`,
        });
    },
};

const requestConsultantCallback: ToolEntry = {
    name: 'request_consultant_callback',
    description: "Use this when the client wants to speak to their consultant, talk to a human, needs personal assistance, or wants someone to call them back.",
    input_schema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Optional reason why they want to speak to a consultant' },
        },
        required: [],
    },
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { reason?: string };
        const reason = (a.reason || '').toString().trim();

        // 1) Record the callback in Dynamics (routes to the client's consultant).
        let recorded = false;
        try {
            const crmEntity = await ctx.deps.dynamics.getContactByPhone(ctx.phoneNumber || ctx.contactId || '');
            recorded = await ctx.deps.dynamics.createCallbackRequest(
                crmEntity,
                ctx.phoneNumber || ctx.contactId || 'unknown',
                reason || undefined,
            );
        } catch (e: any) {
            console.warn(`[request_consultant_callback] createCallbackRequest failed: ${e?.message || e}`);
        }

        // 2) Also email the consultant directly so it lands in their inbox now —
        // their owner first, with taxcrew CC'd as backup (clients only; leads /
        // unknown fall back to taxcrew-only).
        const TAXCREW_INBOX = 'taxcrew@ttt-tax.co.za';
        const senderLabel = ctx.userFullName?.trim() || 'A client';
        const phoneLine = ctx.phoneNumber || 'no phone on record';
        const roleLabel = ctx.entityType === 'client'
            ? 'TTT client'
            : ctx.entityType === 'lead'
                ? 'lead (mid-onboarding)'
                : 'unknown sender';
        let ownerName: string | null = null;
        let ownerEmail: string | null = null;
        if (ctx.entityType === 'client' && ctx.contactId) {
            try {
                const ownerId = await ctx.deps.dynamics.getContactOwnerId(ctx.contactId);
                if (ownerId) {
                    const consultant = await ctx.deps.dynamics.getSystemUserById(ownerId);
                    if (consultant?.email) {
                        ownerName = consultant.fullname || null;
                        ownerEmail = consultant.email;
                    }
                }
            } catch (e: any) {
                console.warn(`[request_consultant_callback] owner lookup failed: ${e?.message || e}`);
            }
        }
        const greeting = ownerName ? `${ownerName.split(/\s+/)[0]},` : 'Team,';
        const body = [
            greeting,
            '',
            `${senderLabel} (${phoneLine}, ${roleLabel}) asked Tina for a consultant callback.`,
            '',
            `Reason:`,
            reason || 'The client asked to speak to their consultant / for a callback.',
            '',
            `Tina has told them you'll be in touch, so please reach out on ${phoneLine} when you can.`,
            '',
            '— Tina',
        ].join('\n');
        const toList = ownerEmail ? [ownerEmail] : [TAXCREW_INBOX];
        const ccList = ownerEmail ? [TAXCREW_INBOX] : undefined;
        let emailSent = false;
        try {
            emailSent = await ctx.deps.graphMail.sendMail({
                to: toList,
                cc: ccList,
                subject: `Tina callback request — ${senderLabel}`,
                bodyText: body,
            });
        } catch (e: any) {
            console.error(`[request_consultant_callback] sendMail threw: ${e?.message || e}`);
        }

        if ((recorded || emailSent) && ctx.sessionId) {
            await ctx.deps.supabase.flagSessionEscalation(ctx.sessionId);
        }

        // ALWAYS confirm positively — the request has been captured and routed to
        // the consultant (Dynamics record and/or direct email). NEVER tell the
        // client it failed to log, even if a step hiccupped.
        const now = new Date();
        const saTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
        const hour = saTime.getHours();
        const day = saTime.getDay(); // 0 = Sunday, 6 = Saturday
        const isWorkingHours = day >= 1 && day <= 5 && hour >= 8 && hour < 17;
        const whenLine = isWorkingHours
            ? 'A consultant will be in touch within 24 hours.'
            : 'A consultant will be in touch on the next business day.';
        return JSON.stringify({
            status: 'success',
            message: `Your request has been passed to your consultant. ${whenLine} Confirm this warmly. Do NOT say the request failed or that the system wouldn't let you log it.`,
        });
    },
};

const escalateToTaxcrew: ToolEntry = {
    name: 'escalate_to_taxcrew',
    description: "Forward the client's question in writing to the team — emails the client's TTT consultant (with the taxcrew inbox CC'd). ONLY call this when the client has EXPLICITLY asked for their question to be forwarded, emailed, or sent to a human (e.g. 'can someone email me about this', 'send my question to the team'). Do NOT call this off your own initiative just because you can't answer — say so honestly and stay engaged instead. For a phone callback request, use request_consultant_callback instead.",
    input_schema: {
        type: 'object',
        properties: {
            question: { type: 'string', description: "The user's question or request, in their own words. Quote the most recent message; don't paraphrase." },
            reason: { type: 'string', description: "Short note on what the client wants — e.g. 'client asked for the team to email them about this', 'client wants written follow-up on penalty status'." },
        },
        required: ['question', 'reason'],
    },
    roles: ['client', 'lead'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { question?: string; reason?: string };
        const question = (a.question || '').toString().trim();
        const reason = (a.reason || '').toString().trim();
        const senderLabel = ctx.userFullName?.trim() || 'Unknown sender';
        const phoneLine = ctx.phoneNumber || 'no phone on record';
        const roleLabel = ctx.entityType === 'client'
            ? 'TTT client'
            : ctx.entityType === 'lead'
                ? 'lead (mid-onboarding)'
                : 'unknown sender';

        // Resolve the client's owner (their assigned consultant) so the
        // escalation lands in their inbox first, with taxcrew CC'd as
        // backup. Only meaningful for clients — leads/unknown fall
        // back to taxcrew-only.
        const TAXCREW_INBOX = 'taxcrew@ttt-tax.co.za';
        let ownerName: string | null = null;
        let ownerEmail: string | null = null;
        if (ctx.entityType === 'client' && ctx.contactId) {
            try {
                const ownerId = await ctx.deps.dynamics.getContactOwnerId(ctx.contactId);
                if (ownerId) {
                    const consultant = await ctx.deps.dynamics.getSystemUserById(ownerId);
                    if (consultant?.email) {
                        ownerName = consultant.fullname || null;
                        ownerEmail = consultant.email;
                    }
                }
            } catch (e: any) {
                console.warn(`[escalate_to_taxcrew] owner lookup failed: ${e?.message || e}`);
            }
        }

        const subject = `Tina escalation — ${senderLabel}`;
        const greeting = ownerName ? `${ownerName.split(/\s+/)[0]},` : 'Team,';
        const body = [
            greeting,
            '',
            `${senderLabel} (${phoneLine}, ${roleLabel}) asked Tina to forward their question to you.`,
            '',
            `Their question:`,
            question || '(not captured)',
            '',
            `Context:`,
            reason || '(not captured)',
            '',
            `Tina has told them you'll be in touch, so please reach out on ${phoneLine} or by email when you can.`,
            '',
            '— Tina',
        ].join('\n');

        const toList = ownerEmail ? [ownerEmail] : [TAXCREW_INBOX];
        const ccList = ownerEmail ? [TAXCREW_INBOX] : undefined;

        let emailSent = false;
        try {
            emailSent = await ctx.deps.graphMail.sendMail({
                to: toList,
                cc: ccList,
                subject,
                bodyText: body,
            });
        } catch (e: any) {
            console.error(`[escalate_to_taxcrew] sendMail threw: ${e?.message || e}`);
        }
        if (emailSent) {
            if (ctx.sessionId) await ctx.deps.supabase.flagSessionEscalation(ctx.sessionId);
            const routedLabel = ownerEmail
                ? `${ownerName || 'your consultant'} (with taxcrew CC'd)`
                : `the taxcrew`;
            return JSON.stringify({
                status: 'success',
                message: `Escalation emailed to ${routedLabel}. Tell the user briefly that you've forwarded their question and the team will be in touch on this number. Do NOT promise a specific turnaround time.`,
            });
        } else {
            return JSON.stringify({
                status: 'error',
                message: 'Could not send the escalation email. Tell the user to email taxcrew@ttt-tax.co.za directly with their question and the team will pick it up. Apologise briefly.',
            });
        }
    },
};

const listTaxForms: ToolEntry = {
    name: 'list_tax_forms',
    description: "List the blank tax forms the client can fill in. Use mode=\"personalized\" by default (filters to forms relevant to the client's SARS source codes). Use mode=\"all\" when the client explicitly asks for the full catalog or sends the canonical text \"What tax forms do you have for me?\". Returns a WhatsApp-formatted message body the assistant should relay verbatim.",
    input_schema: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['personalized', 'all'], description: 'Which slice of the catalog to return. Defaults to personalized.' },
        },
        required: [],
    },
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { mode?: string };
        const mode: 'personalized' | 'all' = a.mode === 'all' ? 'all' : 'personalized';
        const clientContactId = ctx.contactId;

        if (mode === 'all') {
            const allForms = getAllForms();
            const message = formatCatalogMessage(allForms, 'all', []);
            console.log(`[TaxForms] list_all count=${allForms.length}`);
            return JSON.stringify({ status: 'ok', mode, message });
        }

        if (!clientContactId) {
            return JSON.stringify({
                status: 'no_codes',
                mode,
                message: 'I don\'t have your IRP5 details on file yet, so I can\'t recommend a specific form. We have three forms in total - say "show me all forms" if you want to see the full list.',
            });
        }

        const profile = await ctx.deps.dynamics.getContactTaxProfile(clientContactId);
        const sourceCodes = profile?.sourceCodes || [];
        if (sourceCodes.length === 0) {
            console.log(`[TaxForms] list_empty_no_codes clientId=${clientContactId}`);
            return JSON.stringify({
                status: 'no_codes',
                mode,
                message: 'I don\'t have your IRP5 details on file yet, so I can\'t recommend a specific form. We have three forms in total - say "show me all forms" if you want to see the full list.',
            });
        }

        const personalized = getPersonalizedForms(sourceCodes);
        if (personalized.length === 0) {
            console.log(`[TaxForms] list_empty_no_matches clientId=${clientContactId} codes=${JSON.stringify(sourceCodes)}`);
            return JSON.stringify({
                status: 'no_matches',
                mode,
                message: 'Based on your profile, you don\'t need any of our blank forms - your IRP5 details cover your situation. If you\'ve got a new income source we don\'t know about, say "show me all forms" and I\'ll list everything.',
            });
        }

        const omittedForms = TAX_FORMS.filter(f => !personalized.some(p => p.key === f.key));
        const message = formatCatalogMessage(personalized, 'personalized', omittedForms);
        console.log(`[TaxForms] list_personalized clientId=${clientContactId} matched_count=${personalized.length}`);
        return JSON.stringify({ status: 'ok', mode, message });
    },
};

const sendTaxForm: ToolEntry = {
    name: 'send_tax_form',
    description: "Deliver a blank tax form PDF to the requesting client via WhatsApp. Use this after the client has chosen which form they want. Always sends the latest year available in SharePoint.",
    input_schema: {
        type: 'object',
        properties: {
            form_key: {
                type: 'string',
                enum: ['vehicle_detail', 'vehicle_detail_multijob', 'commission_expenses'],
                description: 'The form to send. Must match one of the keys returned by list_tax_forms.',
            },
        },
        required: ['form_key'],
    },
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { form_key?: string };
        const formKey = (a.form_key || '').toString();
        const form = getFormByKey(formKey);
        if (!form) {
            console.warn(`[TaxForms] invalid_key key=${formKey}`);
            return JSON.stringify({
                status: 'invalid_key',
                message: `Unknown form_key "${formKey}". Call list_tax_forms first to see the available keys.`,
            });
        }
        const phone = ctx.phoneNumber || undefined;
        if (!phone) {
            return JSON.stringify({ status: 'error', message: 'No phone number on session — cannot deliver the form.' });
        }
        if (!process.env.GRAPH_CLIENT_ID) {
            console.warn('[TaxForms] sharepoint_unconfigured');
            return JSON.stringify({ status: 'sharepoint_unconfigured', message: 'Form delivery isn\'t available in this environment.' });
        }

        let file;
        try {
            file = await ctx.deps.forms.resolveLatestFormFile(form);
        } catch (e: any) {
            console.error(`[TaxForms] resolve_failed key=${form.key} err=${e?.message || e}`);
            return JSON.stringify({
                status: 'resolve_failed',
                message: `I couldn't find the ${form.label} in our forms folder right now. I've flagged it - please ask your consultant directly, or try again later.`,
            });
        }
        if (!file) {
            return JSON.stringify({
                status: 'resolve_failed',
                message: `I couldn't find the ${form.label} in our forms folder right now. I've flagged it - please ask your consultant directly, or try again later.`,
            });
        }

        const caption = formatSendCaption(form.label, file.year);
        const sendResult = await ctx.deps.meta.sendDocument(phone, file.buffer, file.filename, caption);
        if (!sendResult.delivered && !sendResult.dryRun) {
            console.error(`[TaxForms] send_failed key=${form.key} error=${sendResult.error || 'unknown'}`);
            return JSON.stringify({
                status: 'send_failed',
                message: 'I hit a snag sending the form. Please try again in a moment.',
            });
        }

        const clientContactId = ctx.contactId;
        if (clientContactId) {
            try {
                await ctx.deps.dynamics.logTaxFormSentToContact(clientContactId, form.label, file.year, file.filename, clientContactId);
            } catch (e: any) {
                console.warn(`[TaxForms] timeline_send_failed key=${form.key} err=${e?.message || e}`);
            }
        }

        console.log(`[TaxForms] sent key=${form.key} clientId=${clientContactId || 'unknown'} year=${file.year}`);
        return JSON.stringify({
            status: 'sent',
            form_key: form.key,
            form_label: form.label,
            year: file.year,
            dry_run: Boolean(sendResult.dryRun),
            message: `Sent the ${form.label} for the ${file.year} tax year.`,
        });
    },
};

const optOutWhatsapp: ToolEntry = {
    name: 'opt_out_whatsapp',
    description: "Use this when the user wants to stop receiving WhatsApp messages, unsubscribe, or opt out of communications.",
    input_schema: { type: 'object', properties: {}, required: [] },
    roles: ['client'],
    async handle(_args: unknown, ctx: ToolContext): Promise<string> {
        const success = await ctx.deps.dynamics.updateWhatsAppOptIn(ctx.contactId as string, false);
        if (success) {
            return JSON.stringify({
                status: 'success',
                message: "You have been opted out of WhatsApp communications. If you message us again, you'll be opted back in automatically.",
            });
        } else {
            return JSON.stringify({
                status: 'error',
                message: "I couldn't update your preferences. Please contact our office directly.",
            });
        }
    },
};

const saveDocument: ToolEntry = {
    name: 'save_document',
    description: "Save an uploaded document after the user has classified its type. The user uploads a file, then you ask what type it is (IRP5, IT3(a), IT3(b), Payslip, Medical Certificate, Till Slip / Receipt, Logbook, ID Document, Bank Statement, Tax Certificate, Other). For staff, also ask which client it's for. If the user mentioned a specific period, date, or month for the doc (e.g. 'these are my Jan–Mar bank statements' or 'IRP5 for 2024'), pass that as the `notes` field so consultants see it in the CRM row. Call this once you have the document type (and client for staff).",
    input_schema: {
        type: 'object',
        properties: {
            doc_type: { type: 'string', enum: ['IRP5', 'IT3(a)', 'IT3(b)', 'Payslip', 'Medical Certificate', 'Till Slip / Receipt', 'Logbook', 'ID Document', 'Bank Statement', 'Tax Certificate', 'Other'], description: 'The type of document. IRP5 is an annual employee tax certificate. IT3(a) is an investment/retirement income certificate. IT3(b) is an interest/dividends certificate. Till Slip / Receipt covers any expense slip the client wants to claim.' },
            client: { type: 'string', description: 'Client name or phone (staff only — clients auto-link to themselves)' },
            notes: { type: 'string', description: "Optional short free-text note about the doc — date range, month covered, tax year, anything the user said about the period the doc covers. E.g. 'Jan–Mar 2026 statements', 'IRP5 for 2024'. Leave blank if the user said nothing about specifics." },
        },
        required: ['doc_type'],
    },
    roles: ['client', 'user', 'lead'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { doc_type?: string; client?: string; notes?: string };
        if (!ctx.pendingUpload.has()) {
            return JSON.stringify({ status: 'error', message: 'No pending document upload found. Ask the user to upload a file first.' });
        }
        let targetEntity: any = null;
        if (ctx.entityType === 'user' && a.client) {
            // Staff uploading on behalf of a client — resolve name/phone/GUID.
            const resolved = await ctx.resolveClientId(a.client);
            if (resolved) targetEntity = { id: resolved, type: 'client' };
        } else if (ctx.entityType === 'client' && ctx.contactId) {
            targetEntity = { id: ctx.contactId, type: 'client' };
        } else if (ctx.entityType === 'lead' && ctx.contactId) {
            targetEntity = { id: ctx.contactId, type: 'lead' };
        }

        if (!targetEntity) {
            return JSON.stringify({ status: 'error', message: 'Could not determine which record to attach the document to. For staff, provide a client name or phone.' });
        }
        const result = await ctx.pendingUpload.save(a.doc_type as string, targetEntity, a.notes);
        if (result.success) {
            if (ctx.sessionId && targetEntity.type === 'client') await ctx.deps.supabase.flagSessionDocUpload(ctx.sessionId);
            return JSON.stringify({
                status: 'success',
                message: `Your ${(a.doc_type as string).toLowerCase()} has been saved to your profile.`,
            });
        } else {
            return JSON.stringify({ status: 'error', message: 'Failed to save the document. Please try uploading again.' });
        }
    },
};

const uploadIrp5: ToolEntry = {
    name: 'upload_irp5',
    description: "Process an IRP5 (or IT3(a)) tax certificate the client has just uploaded. Uploads it to SharePoint, files a riivo_taxsubmissionsdocuments row, OCRs and parses the cert into a riivo_irp5s record, then returns the employer/year + the FULL tailored list of any other docs/forms that help with the return. Relay that whole list in ONE message (the tool gives you a ready 'message' to base it on) — do NOT drip one doc at a time. The file is always on file even if we can't read it, so the message always confirms receipt. ONLY call after the client has confirmed in chat that the file they sent is their IRP5 (set confirmed_by_user=true once they've said so). Do NOT call for any other doc type — use save_document for those.",
    input_schema: {
        type: 'object',
        properties: {
            confirmed_by_user: { type: 'boolean', description: 'True once the client has confirmed in WhatsApp that the staged file is their IRP5 (or IT3(a) equivalent). Never call this tool with confirmed_by_user=false — ask first, then call.' },
        },
        required: ['confirmed_by_user'],
    },
    roles: ['client', 'lead'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { confirmed_by_user?: boolean };
        const phone = ctx.phoneNumber || undefined;
        if (!phone) {
            return JSON.stringify({ status: 'error', error: 'no_phone', message: 'No phone number on session — cannot resolve the staged upload.' });
        }
        if (!ctx.contactId) {
            return JSON.stringify({ status: 'error', error: 'no_contact', message: 'IRP5 uploads require a known client. Ask staff to use save_document instead, or have the client message us directly.' });
        }
        // State B leads (LoE signed, OTP outstanding) can fast-track: we stage
        // the IRP5 in Supabase pre-conversion and apply when the lead becomes a
        // Contact. All other lead states still reject (per PRD §6.7).
        const isStateBLeadForUpload = ctx.isStateBLeadUpload;

        if (ctx.entityType !== 'client' && !isStateBLeadForUpload) {
            return JSON.stringify({ status: 'error', error: 'wrong_role', message: 'upload_irp5 is for client-uploaded certs. Staff should use save_document with doc_type="IRP5".' });
        }
        if (a.confirmed_by_user !== true) {
            return JSON.stringify({ status: 'error', error: 'not_confirmed', message: 'Ask the client to confirm the file is their IRP5 first, then call upload_irp5 with confirmed_by_user=true.' });
        }
        const staged = ctx.pendingUpload.peek();
        if (!staged) {
            return JSON.stringify({ status: 'error', error: 'no_pending_upload', message: 'No file is staged. Ask the client to resend the IRP5.' });
        }

        if (isStateBLeadForUpload) {
            return await ctx.deps.irp5.processStateBLeadIrp5Upload(ctx.contactId, phone, staged);
        }

        const contact = await ctx.deps.dynamics.getContactDetails(ctx.contactId);
        if (!contact?.fullname) {
            return JSON.stringify({ status: 'error', error: 'no_contact_record', message: 'Could not load the contact record from CRM. Please retry in a moment.' });
        }

        // All the SharePoint → tsd-row → OCR → parse → irp5-row → missing-docs
        // work lives in processClientIrp5Upload so the deterministic WhatsApp
        // upload path and this tool path share one implementation. We build the
        // Claude-facing message here.
        const result = await ctx.deps.irp5.processClientIrp5Upload({
            contactId: ctx.contactId,
            contactFullName: contact.fullname,
            fileName: staged.fileName,
            mimeType: staged.mimeType,
            buffer: staged.buffer,
        });
        if (result.status === 'error') {
            // Leave the staged file in place so the client can resend.
            return JSON.stringify(result);
        }
        // Success — done with the staged upload.
        ctx.pendingUpload.clear();
        if (ctx.sessionId) await ctx.deps.supabase.flagSessionDocUpload(ctx.sessionId);

        // List-once (Issue 26): present the FULL tailored list in one message —
        // reasons + forms — never the old one-at-a-time drip. Receipt is
        // confirmed regardless of OCR; we never tell the client we couldn't read
        // the cert.
        const renderedList = renderOutstandingDocsList(result.outstanding).join('\n');
        return JSON.stringify({
            status: 'irp5_processed',
            employer_name: result.employerName,
            assessment_year: result.assessmentYear,
            certificate_number: result.certificateNumber,
            source_codes_found: result.sourceCodes,
            irp5_record_id: result.irp5RecordId,
            irp5_updated: result.irp5Updated,
            taxsubmissionsdocument_id: result.taxsubmissionsdocumentId,
            sharepoint_url: result.sharepointUrl,
            wrong_year_warning: result.wrongYearWarning,
            outstanding_docs: result.outstanding,
            message: result.outstanding.length === 0
                ? `IRP5${result.employerName ? ` from ${result.employerName}` : ''} for the ${result.assessmentYear} tax year is on file. Compose a short warm reply that thanks the client, confirms receipt (✅), names the employer + year, and lets them know that's everything we need for now — their consultant will be in touch if anything else comes up.${result.wrongYearWarning ? ' Also mention: ' + result.wrongYearWarning : ''}`
                : `IRP5${result.employerName ? ` from ${result.employerName}` : ''} for the ${result.assessmentYear} tax year is on file. Compose ONE warm message that (a) thanks the client and confirms receipt (✅), (b) names the employer + year, (c) presents the FULL tailored list below in one go — keep each item's reason — framed "send whatever you have, in any order, no rush". Do NOT drip one doc at a time. For any item marked as a form, tell them you can send it to fill in (they can ask, or use list_tax_forms / send_tax_form). The list:\n${renderedList}${result.wrongYearWarning ? '\n\nAlso gently mention: ' + result.wrongYearWarning : ''}`,
        });
    },
};

const markDocumentAlreadySent: ToolEntry = {
    name: 'mark_document_already_sent',
    description: "Use ONLY when the client says they have ALREADY sent a document straight to their consultant or accountant — e.g. \"I already emailed my IRP5 to my consultant\", \"my accountant has my bank statements already\", \"I sent that to [name] last week\". Records a clearly-UNVERIFIED \"client states provided\" note in the CRM so we stop re-asking for that doc — durably, even after the chat resets — WITHOUT claiming TTT has received or verified it. This is NOT a receipt: do NOT use it for files the client uploads here (those go through save_document / upload_irp5), and after calling it NEVER tell the client we've \"received\" or \"got\" the doc — only that you've NOTED their consultant has it. Acknowledge warmly and stop asking for those docs.",
    input_schema: {
        type: 'object',
        properties: {
            doc_types: {
                type: 'array',
                items: { type: 'string' },
                description: "The document(s) the client says they already sent, one entry per distinct doc. Use the label from the outstanding list where you can (e.g. 'IRP5', 'Bank statement', 'Logbook', '12 payslips', 'Medical aid tax certificate', 'IT3(b)').",
            },
        },
        required: ['doc_types'],
    },
    roles: ['client'],
    async handle(args: unknown, ctx: ToolContext): Promise<string> {
        const a = (args ?? {}) as { doc_types?: unknown };
        if (ctx.entityType !== 'client' || !ctx.contactId) {
            return JSON.stringify({ status: 'error', error: 'wrong_role', message: 'The already-sent note is for known clients only.' });
        }
        const docTypes: string[] = Array.isArray(a.doc_types)
            ? a.doc_types.map((d: any) => String(d ?? '').trim()).filter((d: string) => d.length > 0)
            : [];
        if (docTypes.length === 0) {
            return JSON.stringify({ status: 'error', error: 'no_doc_types', message: 'Ask the client which document(s) they already sent, then call again with doc_types.' });
        }
        const recorded: string[] = [];
        const failed: string[] = [];
        for (const docType of docTypes) {
            const res = await ctx.deps.dynamics.markDocumentClientStated({
                contactId: ctx.contactId,
                canonicalDocType: docType,
                triggeredBy: ctx.contactId,
            });
            (res.success ? recorded : failed).push(docType);
        }
        if (recorded.length === 0) {
            return JSON.stringify({ status: 'error', error: 'write_failed', message: "I couldn't note that just now. Tell the client you'll flag it with their consultant directly, and stay engaged." });
        }
        const one = recorded.length === 1;
        return JSON.stringify({
            status: 'noted_unverified',
            recorded,
            failed,
            message: `Noted as CLIENT-STATED / UNVERIFIED (not received by TTT): ${recorded.join(', ')}. Reply warmly that you've made a note their consultant already has ${one ? 'it' : 'these'} and you won't keep asking. Do NOT say TTT has "received", "got" or "verified" ${one ? 'it' : 'them'} — only that it's noted as already sent to their consultant.`,
        });
    },
};

export const clientToolEntries: ToolEntry[] = [
    getMyDetails,
    getTaxNumber,
    getClientInvoices,
    getClientCases,
    getOutstandingBalance,
    getMyConsultant,
    getOfficeContact,
    getMyReferralCode,
    getRequiredDocuments,
    getRefundStatus,
    getSubmissionStatus,
    getReceivedDocuments,
    getAuditStatus,
    getInvoicePdf,
    requestConsultantCallback,
    escalateToTaxcrew,
    listTaxForms,
    sendTaxForm,
    optOutWhatsapp,
    saveDocument,
    uploadIrp5,
    markDocumentAlreadySent,
];

register(clientToolEntries);
