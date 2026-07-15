/**
 * The Tool registry — single source of truth for what a Tool is.
 *
 * A **Tool** is a capability the bot can invoke during a Claude turn. Each Tool
 * lives as one entry in the `REGISTRY` table: its Anthropic `description` +
 * `input_schema`, the roles allowed to be offered it, its optional staff
 * permission gate, and its handler are all one thing in one place. The Anthropic
 * tool definitions (`claude.service`'s `TOOLS`) are derived from these entries, so
 * there is no parallel hand-maintained array to keep in sync.
 *
 * Dispatch collapses to a single `runTool(name, args, ctx)` call used identically
 * at both Claude dispatch sites (first round + follow-up loop). The strangler
 * migration is complete: every Tool is a registry entry, so an unknown tool name is
 * a hard error rather than a legacy fallback.
 *
 * Handlers reach services only through `ctx.deps` (narrow **Ports**), never via a
 * direct singleton import. That seam is what makes a Tool testable with a fake Port
 * and no Anthropic client. See `docs/PRD-tool-registry.md` and ADR 0003.
 */

// Which entity types may be offered a Tool. Matches claude.service's entityType
// space ('client' | 'lead' | 'user'); a caller whose phone isn't in the system
// maps to 'unknown' (slice 6), the only role offered `verify_identity`.
export type EntityType = 'client' | 'lead' | 'user' | 'unknown';

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
    getClientCases(contactId: string): Promise<any[]>;
    getStaffCases(userId: string): Promise<any[]>;
    getContactOwnerId(contactId: string): Promise<string | null>;
    getSystemUserById(systemUserId: string): Promise<{ id: string; fullname: string; email: string | null } | null>;
    getContactLocation(contactId: string): Promise<{ city: string | null; province: string | null; geographicLocation: string | null } | null>;
    getOpenInvoiceTotal(contactId: string): Promise<{ total: number; count: number }>;
    getContactReferralCode(contactId: string): Promise<string | null>;
    getMyClients(userId: string): Promise<any[]>;
    getMyLeads(userId: string): Promise<any[]>;
    searchLeadByName(name: string, ownerId?: string): Promise<any[]>;
    getTaskTypes(): Promise<{ id: string; name: string }[]>;
    getIndustries(nameFilter?: string): Promise<{ id: string; name: string }[]>;
    getInvoiceByNumber(invoiceNumber: string): Promise<any | null>;
    updateWhatsAppOptIn(contactId: string, optIn: boolean): Promise<boolean>;
    createCallbackRequest(entity: { id: string; type: 'client' | 'lead' | 'user'; fullname: string } | null, phoneNumber: string, reason?: string): Promise<boolean>;
    getContactTaxProfile(contactId: string): Promise<{ sourceCodes: string[]; industryName: string | null } | null>;
    logTaxFormSentToContact(contactId: string, formLabel: string, year: number, filename: string, triggeredBy: string): Promise<{ success: boolean; annotationId?: string; error?: string }>;
    // Staff write methods (slice 5).
    createCase(contactId: string, caseType: string, description: string, priority: string): Promise<any | null>;
    createLead(params: {
        firstName: string;
        lastName: string;
        phone?: string;
        email?: string;
        department?: string;
        notes?: string;
        referredByContactId?: string;
        clientType?: number;
        leadType?: number;
        leadSource?: number;
        industryId?: string;
        ownerSystemUserId?: string;
        ownerTeamId?: string;
        ownerFallbackSystemUserId?: string;
    }): Promise<any | null>;
    createContact(params: {
        firstName: string;
        lastName: string;
        entityType: number;
        industryId: string;
        ownerSystemUserId: string;
        primaryRepSystemUserId: string;
        phone?: string;
        email?: string;
    }): Promise<{ contactid?: string } | null>;
    createInvoice(params: {
        customerContactId: string;
        invoiceType: number;
        ownerSystemUserId: string;
    }): Promise<{ new_invoicesid?: string } | null>;
    createTask(params: {
        regardingId: string;
        regardingType: 'contact' | 'lead';
        taskTypeId: string;
        taskTypeName: string;
        taxYear: number;
        primaryRepId: string;
        description?: string;
    }): Promise<{ success: boolean; taskId?: string; error?: string }>;
    getContactByPhoneAndType(phoneNumber: string, type: 'client' | 'lead' | 'user'): Promise<any | null>;
    logInvoiceSentToContact(contactId: string, invoiceNumber: string, triggeredBy: string): Promise<{ success: boolean; annotationId?: string; error?: string }>;
    // Staff read + lead-onboarding / LoE methods (slice 6).
    searchCaseByName(caseName: string): Promise<any[]>;
    searchContactByIdNumber(idNumber: string): Promise<any | null>;
    linkPhoneToContact(contactId: string, phoneNumber: string): Promise<boolean>;
    checkLoeAlreadyReceived(leadId: string): Promise<{ alreadyReceived: boolean; leadName?: string }>;
    uploadLoeFileToCrm(leadId: string, fileName: string, fileBuffer: Buffer, triggeredBy: string): Promise<{ success: boolean; error?: string }>;
    writeLoeFieldsToLead(
        leadId: string,
        fields: {
            bankName?: string | null; accountName?: string | null; accountNumber?: string | null;
            accountType?: string | null; branchNameCode?: string | null; signedAt?: string | null;
            signedAtConsultant?: string | null; signedDate?: string | null; clientFirstName?: string | null;
            clientLastName?: string | null; idNumber?: string | null; incomeTaxNumber?: string | null;
            physicalAddress?: string | null; emailAddress?: string | null; contactNumber?: string | null;
            industry?: string | null;
        },
        triggeredBy: string,
    ): Promise<{ success: boolean; flagSet: boolean; error?: string }>;
}

/**
 * The banking/signing/client fields the LoE OCR pipeline extracts from a signed
 * PDF. Same shape `loe-extractor.service` returns, repeated here so the tool
 * module doesn't import the service (Port discipline). Used as the extract
 * result and the staged-save payload (slice 6).
 */
export interface LoeExtractedFields {
    bankName?: string;
    accountName?: string;
    accountNumber?: string;
    accountType?: string;
    branchNameCode?: string;
    signedAt?: string;
    signedAtConsultant?: string;
    signedDate?: string;
    clientFirstName?: string;
    clientLastName?: string;
    idNumber?: string;
    incomeTaxNumber?: string;
    physicalAddress?: string;
    emailAddress?: string;
    contactNumber?: string;
    industry?: string;
}

/**
 * Narrow Port over the LoE OCR/extraction pipeline (slice 6). `isConfigured` +
 * `ocrDocument` come from `mistral.service`, `extractBankingDetails` from
 * `loe-extractor.service`; the wiring composes both into one object so neither
 * service enters the tool module graph and a test stubs the whole pipeline.
 */
export interface LoeOcrPort {
    isConfigured(): boolean;
    ocrDocument(fileName: string, fileBuffer: Buffer, mimeType: string): Promise<{ fullMarkdown: string; pageCount: number }>;
    extractBankingDetails(ocrMarkdown: string): Promise<LoeExtractedFields>;
}

/**
 * The per-turn staged LoE review state, lifted off `claude.service`'s enclosing
 * scope onto `ctx` (slice 6, mirroring `PendingUploadState`). Each method is
 * bound to this turn's session when the context is built, so the LoE handlers
 * read/confirm/update the staged Supabase row through `ctx` instead of capturing
 * `sessionId`. Returns are kept loose (`any`) so the tool module doesn't import
 * the Supabase row type.
 */
export interface PendingLoeState {
    get(): Promise<any | null>;
    save(params: {
        leadId: string;
        leadName: string | null;
        fileName: string;
        fileBuffer: Buffer;
        ocrMarkdown?: string;
        ocrPageCount?: number;
    } & LoeExtractedFields): Promise<string | null>;
    confirm(): Promise<any | null>;
    delete(): Promise<void>;
    updateField(fieldName: string, newValue: string): Promise<boolean>;
}

/** Narrow Port over the Meta WhatsApp service — only the document-send the form Tools use. */
export interface MetaPort {
    sendDocument(to: string, pdfBuffer: Buffer, fileName: string, caption?: string): Promise<{ delivered: boolean; dryRun: boolean; messageId?: string; error?: string }>;
}

/**
 * Narrow Port over the official invoice-PDF renderer (used by send_invoice_pdf).
 * The wiring closure delegates to invoicePdf.service, which renders via the
 * external invoice-gen Azure Function — so neither the orchestration nor any
 * Dynamics/HTTP detail enters the tool module graph (same seam discipline as
 * FormsPort/Irp5Port). Takes the invoice record GUID; returns null when the
 * generator can't produce a PDF. A test fakes the buffer directly.
 */
export interface PdfPort {
    generateInvoicePdf(invoiceRecordId: string): Promise<Buffer | null>;
}

/** Narrow Port over the Graph mail service — only the send used by escalate_to_taxcrew. */
export interface GraphMailPort {
    sendMail(params: { to: string | string[]; cc?: string[]; subject: string; bodyText: string; replyToMessageId?: string }): Promise<boolean>;
}

/** Narrow Port over Supabase — the per-session flags the action Tools flip. */
export interface SupabasePort {
    flagSessionDocUpload(sessionId: string): Promise<void>;
    flagSessionEscalation(sessionId: string): Promise<void>;
}

/**
 * Narrow Port over the SharePoint-backed forms catalog. Only `resolveLatestFormFile`
 * does I/O (lists + downloads from SharePoint); the rest of taxForms.service is pure
 * and imported directly by the handler.
 */
export interface FormsPort {
    resolveLatestFormFile(form: any): Promise<{ buffer: Buffer; filename: string; year: number } | null>;
}

/**
 * Narrow Port over the IRP5 ingestion pipeline (the OCR/extractor side). Both methods
 * live as free functions in `pendingUpload.service`; the seam is that boundary, so the
 * SharePoint/OCR/extraction internals never enter the tool module graph and a test can
 * stub the whole pipeline with one fake.
 */
export interface Irp5Port {
    processClientIrp5Upload(params: { contactId: string; contactFullName: string; fileName: string; mimeType: string; buffer: Buffer }): Promise<any>;
    processStateBLeadIrp5Upload(leadId: string, phone: string, staged: { fileName: string; mimeType: string; buffer: Buffer }): Promise<string>;
}

/**
 * The per-turn staged-upload buffer, lifted off `claude.service`'s enclosing scope onto
 * `ctx`. Each method is bound to this turn's phone number when the context is built, so
 * upload handlers read the staged file from `ctx` instead of capturing `phoneNumber`.
 */
export interface PendingUploadState {
    has(): boolean;
    peek(): { fileName: string; mimeType: string; buffer: Buffer } | null;
    clear(): void;
    save(docType: string, entity: any, notes?: string): Promise<{ success: boolean; fileName?: string }>;
}

/**
 * Narrow Port over the tax-season FAQ handlers (`taxFaq.service`). These Tools
 * delegate to handlers that themselves reach Dynamics/Graph/required-docs — so
 * the seam is the handler boundary, not the raw Dynamics one. Each method
 * returns the same JSON tool-result string the legacy dispatch relayed. The real
 * `taxFaq.service` exports satisfy this; a test supplies fakes.
 */
export interface TaxFaqPort {
    getRefundStatus(params: { contactId: string; clientName: string; clientPhone: string | null; taxYear?: number }): Promise<string>;
    getSubmissionStatus(params: { contactId: string; taxYear?: number }): Promise<string>;
    getAuditStatus(params: { contactId: string; taxYear?: number }): Promise<string>;
    // `topic` is the optional disclosed non-code scenario (foreign / rental
    // income, Issue 04); the union is inlined to keep the registry free of a
    // domain import. Mirrors `DocTopic` in `src/domain/docRecommendation.ts`.
    getRequiredDocuments(params: { contactId: string; taxYear?: number; topic?: 'foreign_income' | 'rental_income' }): Promise<string>;
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
    /** The caller's full name, used by Tools that personalise an outbound nudge (get_refund_status). */
    userFullName: string | null;
    /** Restricts staff contact lookups to clients they own; undefined for clients/leads. */
    ownerFilter: string | undefined;
    /** Staff permission keys loaded from the session (role_tools). */
    permittedToolKeys: string[];
    /** Resolve a name/phone/GUID to a Contact GUID, or null. */
    resolveClientId(clientInput?: string): Promise<string | null>;
    /** Resolve with disambiguation status + candidates. */
    resolveClientDetailed(clientInput?: string): Promise<ClientResolveResult>;
    /** Per-turn staged WhatsApp upload buffer (bound to this turn's phone). */
    pendingUpload: PendingUploadState;
    /** Per-turn staged LoE review state (bound to this turn's session). */
    pendingLoe: PendingLoeState;
    /**
     * True when the caller is a State-B lead (LoE signed, OTP outstanding, Tax track) —
     * the only lead state allowed to fast-track an IRP5 upload. Derived once per turn in
     * claude.service so upload_irp5 doesn't reconstruct the leadOnboarding check.
     */
    isStateBLeadUpload: boolean;
    deps: {
        dynamics: DynamicsPort;
        taxFaq: TaxFaqPort;
        meta: MetaPort;
        graphMail: GraphMailPort;
        supabase: SupabasePort;
        forms: FormsPort;
        irp5: Irp5Port;
        pdf: PdfPort;
        loeOcr: LoeOcrPort;
    };
}

export interface ToolEntry {
    name: string;
    description: string;            // the Anthropic tool description, co-located with the handler
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
 * The single dispatch entry point. Gates the Tool (role + requiredPerm via
 * entryAllowed), then runs its handler. Every Tool is a registry entry now, so an
 * unknown name is a hard error rather than a silent legacy fallback (the strangler
 * migration is complete — ADR 0003, final slice).
 */
export function runTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const entry = REGISTRY[name];
    if (!entry) return Promise.reject(new Error(`Unknown tool: ${name}`));
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
