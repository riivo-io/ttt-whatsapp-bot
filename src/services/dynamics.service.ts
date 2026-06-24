console.log('[boot] dynamics.service: before axios');
import axios from 'axios';
console.log('[boot] dynamics.service: before msal');
import * as msal from '@azure/msal-node';
console.log('[boot] dynamics.service: before dotenv');
import dotenv from 'dotenv';
console.log('[boot] dynamics.service: before crm types');
import { CrmEntity } from '../types/crm.types';
console.log('[boot] dynamics.service: before supabase');
import { supabaseService, BadDebtDetail, BadDebtInvoiceSummary } from './supabase.service';
import { PRESEASON_SELECT_FIELDS } from '../utils/preseasonDocTypes';
import {
    Invoice,
    InvoiceLineItem,
    invoiceFromByNumberRow,
    invoiceFromByIdRow,
    lineItemFromRow,
} from '../domain/invoice';
console.log('[boot] dynamics.service: imports done');
// mistralService and loeExtractorService are no longer called from dynamics.service
// — OCR + extraction now happen in the claude.service handler, and confirmed
// fields are passed to writeLoeFieldsToLead as plain values.

dotenv.config();

// Define CrmEntity locally if not imported, or ensure import is correct.
// Based on previous file content, it was defined locally.
export interface LocalCrmEntity {
    id: string;
    type: 'client' | 'lead' | 'user';
    fullname: string;
}

const AUDIT_FIELDS = ['ttt_ai_triggered_by', 'ttt_ai_model', 'ttt_ai_generated_at'];

/**
 * Notes sentinel stamped on the Issue 27 "already sent it" escape-hatch row.
 * A `riivo_taxsubmissionsdocuments` row carrying this in `riivo_documentnotes`
 * is an UNVERIFIED client-stated marker, NOT a verified receipt: it suppresses
 * the re-ask in re-derivation but must never be counted/surfaced as received.
 * Worded so a consultant reading the CRM sees exactly what it is (ADR 0002
 * decision 3). Do not reword without updating isClientStatedMarkerRow.
 */
export const CLIENT_STATED_DOC_NOTE = 'CLIENT STATES PROVIDED — UNVERIFIED (client says this was sent to their consultant; TTT has not received or verified it)';

/**
 * True when a tax-submission-document row is an unverified client-stated marker
 * (Issue 27) rather than a verified upload. Keys on the notes sentinel — the
 * one field we control on write. Verified WhatsApp uploads and Power Automate
 * emailed-doc rows never carry it.
 */
export function isClientStatedMarkerRow(row: any): boolean {
    const notes = typeof row?.riivo_documentnotes === 'string' ? row.riivo_documentnotes : '';
    return notes.toUpperCase().includes('CLIENT STATES PROVIDED');
}

// Boolean field on the new_lead entity indicating a signed Letter of
// Engagement has been received. Schema name in Dynamics is riivo_LoEReceived;
// the Web API uses the lowercased logical name.
const LEAD_LOE_RECEIVED_FIELD = 'riivo_loereceived';

// Boolean field on the new_lead entity indicating the lead has completed the
// SARS eFiling shared-access OTP. Staff-flipped manually for now.
const LEAD_OTP_COMPLETED_FIELD = 'riivo_efilingotpcompleted';

// `riivo_leadtype` optionset value for the Tax service track. Leads on this
// track must complete BOTH the LoE upload and the SARS OTP gate before
// converting to a contact. Other tracks (Accounting, Insurance, FP) only
// gate on the LoE.
export const LEAD_TYPE_TAX = 100000000;

// riivo_request option-set values. statecode is the built-in Dynamics state
// field (0 = Active, 1 = Inactive). The integer values below mirror what was
// configured in the Power Apps maker for this environment.
export const REQUEST_STATE = {
    ACTIVE: 0,
    INACTIVE: 1,
} as const;

export const REQUEST_STATUSCODE = {
    // Active
    NEW: 1,
    AWAITING_FEEDBACK: 463630001,
    IN_PROGRESS: 463630002,
    CLASSIFIED: 463630004,
    BOT_ANSWERED: 463630005,
    ESCALATED: 463630006,
    // Inactive
    RESOLVED_BY_BOT: 2,
    CLOSED: 463630003,
    RESOLVED_TIMEOUT: 463630007,
    RESOLVED_BY_STAFF: 463630008,
} as const;

// riivo_resolutionmethod option set
export const RESOLUTION_METHOD = {
    AUTO_DIRECT_ANSWER: 463630000,
    AUTO_TOOL_CALL: 463630001,
    FEEDBACK_CONFIRMED: 463630002,
    TIMEOUT_ASSUMED_RESOLVED: 463630003,
    STAFF_RESOLVED: 463630004,
    NOT_RESOLVED_ESCALATED: 463630005,
} as const;

// riivo_clientfeedback option set
export const CLIENT_FEEDBACK = {
    CONFIRMED: 463630000,
    REJECTED: 463630001,
    NO_RESPONSE_TIMEOUT: 463630002,
    NOT_ASKED: 463630003,
} as const;

// riivo_classificationlevel option set
export const CLASSIFICATION_LEVEL = {
    L1: 463630000,
    L2: 463630001,
    L3: 463630002,
    ESCALATION: 463630003,
} as const;

// Bad-debt threshold (PRD-bad-debt-collection.md §4). An open invoice
// (ttt_outstanding > 0) that is >= 30 calendar days old (inclusive) puts the
// client in bad-debt state. Calendar days, not working days.
export const BAD_DEBT_AGE_DAYS = 30;

// Model-driven app id for the TTT Dynamics app. Deep links into records must
// carry the appid so the record opens in the right app context — without it
// the link can land on a blank/wrong app shell. Override via DYNAMICS_APP_ID
// if the app id ever changes.
export const DYNAMICS_APP_ID = process.env.DYNAMICS_APP_ID || '8beff390-07da-4354-9d43-c58f2b665f94';

/**
 * Build a deep link to a Dynamics record. `entity` is the entity logical name
 * (e.g. 'new_lead' for leads, 'contact' for clients). Returns null when
 * DYNAMICS_URL isn't configured so callers can fall back gracefully.
 */
export function buildDynamicsRecordUrl(entity: string, id: string): string | null {
    const base = process.env.DYNAMICS_URL?.replace(/\/$/, '');
    if (!base) return null;
    return `${base}/main.aspx?appid=${DYNAMICS_APP_ID}&pagetype=entityrecord&etn=${entity}&id=${id}`;
}

/**
 * Strip trailing parenthetical admin markers from a Dynamics case row's
 * `new_name` before it ever reaches the model context. Admins occasionally
 * annotate case names with internal labels — "(duplicate)", "(test)",
 * "(refund pending)" — that should never surface to clients. The regex
 * matches at most one parenthetical group of up to 30 chars at the very end.
 */
function sanitizeCaseRow<T extends { new_name?: any }>(row: T): T {
    if (!row || typeof row !== 'object') return row;
    if (typeof row.new_name === 'string') {
        const cleaned = row.new_name.replace(/\s*\([^)]{1,30}\)\s*$/, '').trim();
        if (cleaned !== row.new_name) {
            return { ...row, new_name: cleaned };
        }
    }
    return row;
}

export class DynamicsService {
    private cca: msal.ConfidentialClientApplication;
    private baseUrl: string;
    private accessToken: string | null = null;
    private tokenExpiry: number = 0;
    // Cache of entities that DON'T have audit columns — skip adding them on future writes
    private entitiesWithoutAudit: Set<string> = new Set(['riivo_whatsappcommunicationses', 'new_leads', 'new_cases']);

    constructor() {
        if (!process.env.DYNAMICS_CLIENT_ID || !process.env.DYNAMICS_CLIENT_SECRET || !process.env.DYNAMICS_TENANT_ID || !process.env.DYNAMICS_URL) {
            throw new Error('Missing Dynamics CRM configuration in .env');
        }

        const config = {
            auth: {
                clientId: process.env.DYNAMICS_CLIENT_ID,
                clientSecret: process.env.DYNAMICS_CLIENT_SECRET,
                authority: `https://login.microsoftonline.com/${process.env.DYNAMICS_TENANT_ID}`,
            }
        };

        this.cca = new msal.ConfidentialClientApplication(config);
        this.baseUrl = process.env.DYNAMICS_URL.replace(/\/$/, ''); // Remove trailing slash
    }

    private async getToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        try {
            const clientCredentialRequest = {
                scopes: [`${this.baseUrl}/.default`],
            };

            const response = await this.cca.acquireTokenByClientCredential(clientCredentialRequest);

            if (!response || !response.accessToken) {
                throw new Error('Failed to acquire access token');
            }

            this.accessToken = response.accessToken;
            this.tokenExpiry = response.expiresOn ? response.expiresOn.getTime() : Date.now() + 55 * 60 * 1000;

            return this.accessToken;
        } catch (error) {
            console.error('Dynamics Auth Error:', error);
            throw error;
        }
    }

    /**
     * Add audit fields to a payload. If the entity is known to not have them, skip.
     */
    private addAuditFields(entity: string, payload: any, triggeredBy: string): any {
        if (this.entitiesWithoutAudit.has(entity)) return payload;
        return {
            ...payload,
            ttt_ai_triggered_by: triggeredBy,
            ttt_ai_model: 'claude-opus-4-7',
            ttt_ai_generated_at: new Date().toISOString(),
        };
    }

    /**
     * Remove audit fields from a payload (for retry after undeclared property error).
     */
    private stripAuditFields(payload: any): any {
        const stripped = { ...payload };
        for (const f of AUDIT_FIELDS) delete stripped[f];
        return stripped;
    }

    /**
     * Check if an error is about an undeclared audit field.
     */
    private isAuditFieldError(error: any): boolean {
        const msg = error?.response?.data?.error?.message || '';
        return AUDIT_FIELDS.some(f => msg.includes(f));
    }

    /**
     * POST to CRM with automatic audit field retry.
     * Tries with audit fields first. If Dynamics rejects them, retries without and caches.
     */
    private async crmPost(entity: string, payload: any, triggeredBy: string): Promise<any> {
        const token = await this.getToken();
        const headers = {
            'Authorization': `Bearer ${token}`,
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        };
        const url = `${this.baseUrl}/api/data/v9.2/${entity}`;
        const fullPayload = this.addAuditFields(entity, payload, triggeredBy);

        try {
            const response = await axios.post(url, fullPayload, { headers });
            console.log(`[CRM POST ✓] ${entity} — record created`);
            return response;
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            if (this.isAuditFieldError(error)) {
                console.log(`[CRM POST] ${entity} — audit columns missing, retrying without`);
                this.entitiesWithoutAudit.add(entity);
                const response = await axios.post(url, this.stripAuditFields(fullPayload), { headers });
                console.log(`[CRM POST ✓] ${entity} — record created (no audit)`);
                return response;
            }
            console.error(`[CRM POST ✗] ${entity} — ${errMsg}`);
            console.error(`[CRM POST ✗] Payload keys: ${Object.keys(fullPayload).join(', ')}`);
            throw error;
        }
    }

    /**
     * PATCH to CRM with automatic audit field retry.
     */
    private async crmPatch(entity: string, recordUrl: string, payload: any, triggeredBy: string): Promise<any> {
        const token = await this.getToken();
        const headers = {
            'Authorization': `Bearer ${token}`,
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };
        const fullPayload = this.addAuditFields(entity, payload, triggeredBy);

        try {
            const response = await axios.patch(recordUrl, fullPayload, { headers });
            console.log(`[CRM PATCH ✓] ${entity} — record updated`);
            return response;
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            if (this.isAuditFieldError(error)) {
                console.log(`[CRM PATCH] ${entity} — audit columns missing, retrying without`);
                this.entitiesWithoutAudit.add(entity);
                const response = await axios.patch(recordUrl, this.stripAuditFields(fullPayload), { headers });
                console.log(`[CRM PATCH ✓] ${entity} — record updated (no audit)`);
                return response;
            }
            console.error(`[CRM PATCH ✗] ${entity} — ${errMsg}`);
            console.error(`[CRM PATCH ✗] Payload keys: ${Object.keys(fullPayload).join(', ')}`);
            throw error;
        }
    }

    private async searchEntity(collection: string, filter: string, select: string[]): Promise<any | null> {
        const token = await this.getToken();

        try {
            const url = `${this.baseUrl}/api/data/v9.2/${collection}?$filter=${encodeURIComponent(filter)}&$select=${select.join(',')}&$top=1`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });

            if (response.data && response.data.value && response.data.value.length > 0) {
                return response.data.value[0];
            }

            return null;
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[CRM GET ✗] ${collection} search — ${errMsg}`);
            console.error(`[CRM GET ✗] Filter: ${filter}`);
            return null;
        }
    }

    private async getList(collection: string, filter: string, select: string[]): Promise<any[]> {
        const token = await this.getToken();

        try {
            const url = `${this.baseUrl}/api/data/v9.2/${collection}?$filter=${encodeURIComponent(filter)}&$select=${select.join(',')}&$orderby=createdon desc&$top=5`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Prefer': 'odata.include-annotations="*"'
                }
            });

            return response.data.value || [];
        } catch (error: any) {
            console.error(`Error getting list from ${collection}:`, error?.response?.data || error.message);
            return [];
        }
    }

    async getMyClients(userId: string): Promise<any[]> {
        return this.getList(
            'contacts',
            `_ownerid_value eq ${userId} and statecode eq 0`,
            ['contactid', 'fullname', 'mobilephone', 'emailaddress1']
        );
    }

    /**
     * List active Leads owned by the staff member. Distinct from getMyClients
     * (which returns Contacts) — Leads are prospects in the onboarding pipeline,
     * Contacts are confirmed clients.
     */
    async getMyLeads(userId: string): Promise<any[]> {
        const rows = await this.getList(
            'new_leads',
            `_ownerid_value eq ${userId} and statecode eq 0`,
            ['new_leadid', 'ttt_firstname', 'ttt_lastname', 'ttt_mobilephone', 'ttt_email']
        );
        return rows.map((l: any) => ({
            new_leadid: l.new_leadid,
            fullname: `${l.ttt_firstname || ''} ${l.ttt_lastname || ''}`.trim(),
            mobilephone: l.ttt_mobilephone,
            email: l.ttt_email,
        }));
    }

    async getClientInvoices(contactId: string): Promise<any[]> {
        return this.getList(
            'new_invoiceses',
            `_ttt_customer_value eq ${contactId}`,
            // Bad-debt detection (PRD-bad-debt-collection.md §11.1) needs the
            // open-invoice signal, the payment-reference number, the invoice age
            // and the partial-payment fields alongside the existing total.
            ['new_invoicesid', 'new_name', 'ttt_invoiceid', 'createdon',
             'ttt_outstanding', 'ttt_paymentreceived', 'riivo_totalinclvat',
             'statecode', 'statuscode']
        );
    }

    async getInvoiceByNumber(invoiceNumber: string): Promise<Invoice | null> {
        const token = await this.getToken();
        const selectFields = [
            // Invoice header
            'new_name', 'createdon',
            // Customer details
            'riivo_customerfullname', 'riivo_customerstreet', 'riivo_customerprovince',
            'riivo_customersuburb', 'riivo_customerponumber', 'riivo_customercity',
            'riivo_customercountry', 'riivo_customervatnumber',
            // Consultant details
            'riivo_consultantcompany', 'riivo_consultantfullname', 'riivo_consultantstreet',
            'riivo_consultantsuburb', 'riivo_consultantprovince', 'riivo_consultantponumber',
            'riivo_consultantcity', 'riivo_consultantcountry', 'riivo_consultantvatnumber',
            // Totals
            'ttt_sarsreimbursement', 'ttt_totalwithinterest', 'riivo_vattotal', 'riivo_totalinclvat',
            // Banking
            'icon_accountholdername', 'icon_bank', 'icon_accountnumber',
            'icon_accounttype', 'icon_branchnumber'
        ];

        try {
            // Use contains since invoice names are like "Jules Test - INV522385182"
            const url = `${this.baseUrl}/api/data/v9.2/new_invoiceses?$filter=${encodeURIComponent(`contains(new_name,'${invoiceNumber}')`)}&$select=${selectFields.join(',')}&$top=1`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });

            if (response.data?.value?.length > 0) {
                return invoiceFromByNumberRow(response.data.value[0]);
            }
            return null;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to get invoice:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    async getClientCases(contactId: string): Promise<any[]> {
        const rows = await this.getList(
            'new_cases',
            `_ttt_clientname_value eq ${contactId}`,
            ['new_name', 'icon_caseprocess', 'icon_casestage', 'statecode', 'createdon']
        );
        return rows.map(sanitizeCaseRow);
    }

    /**
     * Active tax cases for a client with all fields the FAQ bot needs in
     * one shot — refund, audit date, stage, year, owner. Filtered to
     * statecode=Active. Annotation headers are included via getList() so
     * formatted OptionSet labels come along for free.
     */
    async getActiveTaxCases(contactId: string): Promise<any[]> {
        const rows = await this.getList(
            'new_cases',
            `_ttt_clientname_value eq ${contactId} and statecode eq 0`,
            [
                'new_caseid',
                'new_name',
                'icon_caseprocess',
                'icon_casestage',
                'ttt_taxyear',
                'riivo_potentialrefund',
                'riivo_dateplacedonaudit',
                'statecode',
                'createdon',
                '_ownerid_value',
            ]
        );
        return rows.map(sanitizeCaseRow);
    }

    /**
     * Active preseason documentation records for a client. One record per
     * tax year is the expected pattern. Caller can filter to a specific
     * year afterwards. Selects every per-type doc field so the bot can
     * compute outstanding + received lists from a single read.
     */
    async getPreseasonDocsForClient(contactId: string): Promise<any[]> {
        return this.getList(
            'riivo_preseasondocumentations',
            `_riivo_customer_value eq ${contactId} and statecode eq 0`,
            [...PRESEASON_SELECT_FIELDS]
        );
    }

    /**
     * Per-document rows uploaded for a case. These flow in from the email
     * Power Automate flow (and, post-migration, from the WhatsApp bot's
     * dual-write path). Annotation headers give us the human-readable
     * document type label without a second lookup. Uses an inline query
     * (not getList) because the FAQ bot needs the full doc list per case,
     * not the default $top=5.
     */
    async getTaxSubmissionDocsByCase(caseId: string): Promise<any[]> {
        return this.querySubmissionDocs(`_riivo_case_value eq ${caseId} and statecode eq 0`);
    }

    /**
     * Per-document rows linked to a preseason record. Requires the
     * `_riivo_preseasondoc_value` lookup added per the CRM spec — until
     * the admin creates it Dynamics will respond with an error which the
     * inline query swallows. Safe to ship the bot before the schema
     * change lands.
     */
    async getTaxSubmissionDocsByPreseason(preseasonId: string): Promise<any[]> {
        return this.querySubmissionDocs(`_riivo_preseasondoc_value eq ${preseasonId} and statecode eq 0`);
    }

    /**
     * All active document rows uploaded for a client (across all cases and
     * tax years). Primary source of truth for "what have I uploaded?" —
     * every WhatsApp upload writes a row here with `_riivo_client_value`
     * set, and Power Automate does the same for emailed docs.
     */
    async getTaxSubmissionDocsByClient(contactId: string, taxYear?: number): Promise<any[]> {
        let filter = `_riivo_client_value eq ${contactId} and statecode eq 0`;
        if (typeof taxYear === 'number' && Number.isFinite(taxYear)) {
            filter += ` and riivo_taxyear eq ${taxYear}`;
        }
        return this.querySubmissionDocs(filter);
    }

    private async querySubmissionDocs(filter: string): Promise<any[]> {
        const token = await this.getToken();
        const selectFields = [
            'riivo_taxsubmissionsdocumentsid',
            'riivo_taxsubmissionsdocument',
            '_riivo_documenttype_value',
            'riivo_filereference',
            'riivo_documentnotes',
            'createdon',
        ];
        try {
            const url = `${this.baseUrl}/api/data/v9.2/riivo_taxsubmissionsdocumentses?$filter=${encodeURIComponent(filter)}&$select=${selectFields.join(',')}&$orderby=createdon desc&$top=100`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Prefer': 'odata.include-annotations="*"',
                },
            });
            return response.data?.value || [];
        } catch (error: any) {
            console.warn(`[Dynamics CRM] querySubmissionDocs(${filter}) failed:`, error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    async getStaffCases(userId: string): Promise<any[]> {
        const rows = await this.getList(
            'new_cases',
            `_ownerid_value eq ${userId} and statecode eq 0`,
            ['new_name', 'icon_caseprocess', 'icon_casestage', 'statecode', 'createdon', '_ttt_clientname_value']
        );
        return rows.map(sanitizeCaseRow);
    }

    async getContactByPhone(phoneNumber: string): Promise<any | null> {
        // Staff (internal "user") resolution is gated behind STAFF_MODE_ENABLED.
        // While it's off we skip the systemusers lookup so a staff phone falls
        // through to contact/lead instead of resolving as 'user' (which otherwise
        // wins the user > client > lead priority below).
        const staffModeEnabled = process.env.STAFF_MODE_ENABLED === 'true';
        // Search ALL tables in parallel to detect duplicates and pick the right role
        const contactsFilter = this.phoneOrFilter('mobilephone', phoneNumber);
        const leadsFilter = this.phoneOrFilter('ttt_mobilephone', phoneNumber);
        const usersFilter = this.phoneOrFilter('mobilephone', phoneNumber);
        const [contact, lead, user] = await Promise.all([
            this.searchEntity(
                'contacts',
                `(${contactsFilter}) and statecode eq 0`,
                ['contactid', 'fullname', 'riivo_whatsappoptinout']
            ),
            this.searchEntity(
                'new_leads',
                `(${leadsFilter}) and statecode eq 0`,
                ['new_leadid', 'ttt_firstname', 'ttt_lastname', LEAD_LOE_RECEIVED_FIELD, LEAD_OTP_COMPLETED_FIELD, 'riivo_leadtype']
            ),
            staffModeEnabled
                ? this.searchEntity(
                    'systemusers',
                    usersFilter,
                    ['systemuserid', 'fullname']
                )
                : Promise.resolve(null),
        ]);

        // Count how many tables matched — warn if duplicated
        const matches = [
            contact ? 'client' : null,
            lead ? 'lead' : null,
            user ? 'user' : null,
        ].filter(Boolean);

        if (matches.length > 1) {
            console.warn(`[Dynamics CRM] ${phoneNumber} found in MULTIPLE tables: ${matches.join(', ')}. Using priority: user > client > lead.`);
        }

        // Priority: user (staff) > client (contact) > lead (prospect)
        if (user) {
            return {
                id: user.systemuserid,
                type: 'user',
                fullname: user.fullname
            };
        }

        if (contact) {
            return {
                id: contact.contactid,
                type: 'client',
                fullname: contact.fullname,
                optIn: contact.riivo_whatsappoptinout
            };
        }

        if (lead) {
            return {
                id: lead.new_leadid,
                type: 'lead',
                fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim(),
                loeReceived: lead[LEAD_LOE_RECEIVED_FIELD] === true,
                otpCompleted: lead[LEAD_OTP_COMPLETED_FIELD] === true,
                leadType: typeof lead.riivo_leadtype === 'number' ? lead.riivo_leadtype : null,
            };
        }

        return null;
    }

    /**
     * Look up by email across contacts, leads, and systemusers — used by the
     * email-relay flow (TTT staff forwards a client email to tina-bot@; we
     * need to find that client's WhatsApp number).
     *
     * Same priority as getContactByPhone: user > client > lead. Returns the
     * mobile number alongside the entity so the caller doesn't need a second
     * round-trip. Returns null if no match.
     */
    async getEntityByEmail(email: string): Promise<any | null> {
        const normalized = email.trim().toLowerCase();
        if (!normalized) return null;

        // Dataverse rejects tolower() in $filter ("function isn't supported"),
        // but `eq` on string columns is already case-insensitive — so a plain
        // equality match handles "Foo@bar.com" vs. "foo@bar.com" correctly.
        const odataEmail = normalized.replace(/'/g, "''");
        // Staff resolution gated behind STAFF_MODE_ENABLED — see getContactByPhone.
        const staffModeEnabled = process.env.STAFF_MODE_ENABLED === 'true';
        const [contact, lead, user] = await Promise.all([
            this.searchEntity(
                'contacts',
                `emailaddress1 eq '${odataEmail}' and statecode eq 0`,
                ['contactid', 'fullname', 'mobilephone', 'emailaddress1', 'riivo_whatsappoptinout']
            ),
            this.searchEntity(
                'new_leads',
                `ttt_email eq '${odataEmail}' and statecode eq 0`,
                ['new_leadid', 'ttt_firstname', 'ttt_lastname', 'ttt_mobilephone', 'ttt_email', LEAD_LOE_RECEIVED_FIELD, LEAD_OTP_COMPLETED_FIELD, 'riivo_leadtype']
            ),
            staffModeEnabled
                ? this.searchEntity(
                    'systemusers',
                    `internalemailaddress eq '${odataEmail}' and isdisabled eq false`,
                    ['systemuserid', 'fullname', 'mobilephone', 'internalemailaddress']
                )
                : Promise.resolve(null),
        ]);

        const matches = [contact ? 'client' : null, lead ? 'lead' : null, user ? 'user' : null].filter(Boolean);
        if (matches.length > 1) {
            console.warn(`[Dynamics CRM] Email ${normalized} found in MULTIPLE tables: ${matches.join(', ')}. Using priority: user > client > lead.`);
        }

        if (user) {
            return {
                id: user.systemuserid,
                type: 'user',
                fullname: user.fullname,
                email: user.internalemailaddress || normalized,
                mobilephone: user.mobilephone || null,
            };
        }
        if (contact) {
            return {
                id: contact.contactid,
                type: 'client',
                fullname: contact.fullname,
                email: contact.emailaddress1 || normalized,
                mobilephone: contact.mobilephone || null,
                optIn: contact.riivo_whatsappoptinout,
            };
        }
        if (lead) {
            return {
                id: lead.new_leadid,
                type: 'lead',
                fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim(),
                email: lead.ttt_email || normalized,
                mobilephone: lead.ttt_mobilephone || null,
                loeReceived: lead[LEAD_LOE_RECEIVED_FIELD] === true,
                otpCompleted: lead[LEAD_OTP_COMPLETED_FIELD] === true,
                leadType: typeof lead.riivo_leadtype === 'number' ? lead.riivo_leadtype : null,
            };
        }

        return null;
    }

    /**
     * Search for a phone number but return only the entity matching the specified type.
     * Used in test mode to force a specific CRM context.
     */
    async getContactByPhoneAndType(phoneNumber: string, type: 'client' | 'lead' | 'user'): Promise<any | null> {
        if (type === 'client') {
            const contact = await this.searchEntity(
                'contacts',
                `(${this.phoneOrFilter('mobilephone', phoneNumber)}) and statecode eq 0`,
                ['contactid', 'fullname', 'riivo_whatsappoptinout']
            );
            if (contact) return { id: contact.contactid, type: 'client', fullname: contact.fullname, optIn: contact.riivo_whatsappoptinout };
        } else if (type === 'lead') {
            const lead = await this.searchEntity(
                'new_leads',
                `(${this.phoneOrFilter('ttt_mobilephone', phoneNumber)}) and statecode eq 0`,
                ['new_leadid', 'ttt_firstname', 'ttt_lastname', LEAD_LOE_RECEIVED_FIELD, LEAD_OTP_COMPLETED_FIELD, 'riivo_leadtype']
            );
            if (lead) return {
                id: lead.new_leadid,
                type: 'lead',
                fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim(),
                loeReceived: lead[LEAD_LOE_RECEIVED_FIELD] === true,
                otpCompleted: lead[LEAD_OTP_COMPLETED_FIELD] === true,
                leadType: typeof lead.riivo_leadtype === 'number' ? lead.riivo_leadtype : null,
            };
        } else if (type === 'user') {
            const user = await this.searchEntity(
                'systemusers',
                this.phoneOrFilter('mobilephone', phoneNumber),
                ['systemuserid', 'fullname']
            );
            if (user) return { id: user.systemuserid, type: 'user', fullname: user.fullname };
        }
        return null;
    }

    /**
     * Build an OData OR filter across SA phone-format variants so a lookup
     * matches whether Dynamics stores the number as "0832852913",
     * "+27832852913", or "27832852913".
     */
    private phoneOrFilter(field: string, phoneNumber: string): string {
        const trimmed = phoneNumber.trim().replace(/\s+/g, '');
        const variants = new Set<string>([trimmed]);
        if (trimmed.startsWith('0') && trimmed.length === 10) {
            variants.add('+27' + trimmed.slice(1));
            variants.add('27' + trimmed.slice(1));
        } else if (trimmed.startsWith('+27') && trimmed.length === 12) {
            variants.add('0' + trimmed.slice(3));
            variants.add('27' + trimmed.slice(1));
        } else if (trimmed.startsWith('27') && trimmed.length === 11) {
            variants.add('0' + trimmed.slice(2));
            variants.add('+' + trimmed);
        }
        return Array.from(variants).map(v => `${field} eq '${v.replace(/'/g, "''")}'`).join(' or ');
    }

    /**
     * Look up a CRM entity by its ID and type (used when resuming from a cached Supabase session).
     */
    /**
     * Look up the owning systemuser GUID for a given contact. Used by the
     * referral flow so that a lead created via refer_friend inherits the
     * referring client's consultant as its owner (which keeps the new required
     * Lead.ownerid field populated without asking the client to nominate one).
     */
    async getContactOwnerId(contactId: string): Promise<string | null> {
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId} and statecode eq 0`,
            ['contactid', '_ownerid_value']
        );
        return contact?._ownerid_value || null;
    }

    /**
     * Look up the owning systemuser GUID for a given lead. Mirrors
     * getContactOwnerId so a request raised off a lead can inherit the lead's
     * owner (keeping request ownership aligned with the consultant already on
     * the lead).
     */
    async getLeadOwnerId(leadId: string): Promise<string | null> {
        const lead = await this.searchEntity(
            'new_leads',
            `new_leadid eq ${leadId} and statecode eq 0`,
            ['new_leadid', '_ownerid_value']
        );
        return lead?._ownerid_value || null;
    }

    /**
     * Read the fields needed to personalise the required-documents list:
     * the contact's SARS source codes (multi-select optionset, stored as the
     * formatted label string) and industry name.
     *
     * Returns the 4-digit codes extracted from the formatted labels (e.g.
     * "3601 - Salary; 3606 - Commission" → ['3601', '3606']). This is robust
     * to whatever numeric optionset values Dataverse assigned.
     */
    async getContactTaxProfile(
        contactId: string
    ): Promise<{ sourceCodes: string[]; industryName: string | null } | null> {
        const token = await this.getToken();
        try {
            const url = `${this.baseUrl}/api/data/v9.2/contacts(${contactId})?$select=contactid,riivo_sourcecode,_riivo_industryid_value`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Prefer': 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
                },
            });
            const c = response.data;
            if (!c) return null;

            const sourceLabel: string =
                c['riivo_sourcecode@OData.Community.Display.V1.FormattedValue'] || '';
            const sourceCodes = Array.from(
                new Set((sourceLabel.match(/\b\d{4}\b/g) as string[] | null) || [])
            );

            const industryName: string | null =
                c['_riivo_industryid_value@OData.Community.Display.V1.FormattedValue'] || null;

            console.log(`[tax profile] contact=${contactId} sourceLabel="${sourceLabel}" codes=${JSON.stringify(sourceCodes)} industry="${industryName}"`);

            return { sourceCodes, industryName };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[CRM GET ✗] getContactTaxProfile(${contactId}) — ${errMsg}`);
            return null;
        }
    }

    /**
     * Look up a systemuser (consultant) by id. Returns null if the id belongs
     * to a Team rather than a User, or if the user is disabled/not found.
     */
    async getSystemUserById(
        systemUserId: string
    ): Promise<{ id: string; fullname: string; email: string | null } | null> {
        const user = await this.searchEntity(
            'systemusers',
            `systemuserid eq ${systemUserId} and isdisabled eq false`,
            ['systemuserid', 'fullname', 'internalemailaddress']
        );
        if (!user) return null;
        return {
            id: user.systemuserid,
            fullname: user.fullname,
            email: user.internalemailaddress || null,
        };
    }

    /**
     * Read a contact's location fields so the office-contact tool can route the
     * client to their nearest branch. riivo_geographiclocation is an optionset,
     * so we read its formatted label rather than the raw numeric value. All
     * three fields are best-effort — any/all may be empty.
     */
    async getContactLocation(
        contactId: string
    ): Promise<{ city: string | null; province: string | null; geographicLocation: string | null } | null> {
        const token = await this.getToken();
        try {
            const url = `${this.baseUrl}/api/data/v9.2/contacts(${contactId})?$select=contactid,address1_city,address1_stateorprovince,riivo_geographiclocation`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Prefer': 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
                },
            });
            const c = response.data;
            if (!c) return null;
            return {
                city: c.address1_city || null,
                province: c.address1_stateorprovince || null,
                geographicLocation:
                    c['riivo_geographiclocation@OData.Community.Display.V1.FormattedValue'] || null,
            };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[CRM GET ✗] getContactLocation(${contactId}) — ${errMsg}`);
            return null;
        }
    }

    async getEntityById(crmId: string, crmType: string): Promise<any | null> {
        try {
            if (crmType === 'contact' || crmType === 'client') {
                const contact = await this.searchEntity(
                    'contacts',
                    `contactid eq ${crmId} and statecode eq 0`,
                    ['contactid', 'fullname', 'riivo_whatsappoptinout']
                );
                if (contact) {
                    return { id: contact.contactid, type: 'client', fullname: contact.fullname, optIn: contact.riivo_whatsappoptinout };
                }
            } else if (crmType === 'lead') {
                const lead = await this.searchEntity(
                    'new_leads',
                    `new_leadid eq ${crmId} and statecode eq 0`,
                    ['new_leadid', 'ttt_firstname', 'ttt_lastname', LEAD_LOE_RECEIVED_FIELD, LEAD_OTP_COMPLETED_FIELD, 'riivo_leadtype']
                );
                if (lead) {
                    return {
                        id: lead.new_leadid,
                        type: 'lead',
                        fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim(),
                        loeReceived: lead[LEAD_LOE_RECEIVED_FIELD] === true,
                        otpCompleted: lead[LEAD_OTP_COMPLETED_FIELD] === true,
                        leadType: typeof lead.riivo_leadtype === 'number' ? lead.riivo_leadtype : null,
                    };
                }
            } else if (crmType === 'user') {
                const user = await this.searchEntity(
                    'systemusers',
                    `systemuserid eq ${crmId}`,
                    ['systemuserid', 'fullname']
                );
                if (user) {
                    return { id: user.systemuserid, type: 'user', fullname: user.fullname };
                }
            }
        } catch (error: any) {
            console.warn(`[Dynamics CRM] Failed to look up ${crmType} ${crmId}:`, error.message);
        }
        return null;
    }

    async getContactDetails(contactId: string): Promise<any | null> {
        return this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['contactid', 'fullname', 'firstname', 'lastname', 'mobilephone', 'emailaddress1', 'ttt_taxnumber', 'ttt_idnumber', 'riivo_whatsappoptinout']
        );
    }

    async searchContactByName(name: string, ownerId?: string): Promise<any[]> {
        const token = await this.getToken();
        try {
            // If ownerId is supplied (staff context), scope to clients owned by that consultant
            const ownerClause = ownerId ? ` and _ownerid_value eq ${ownerId}` : '';
            const filter = `contains(fullname,'${name}') and statecode eq 0${ownerClause}`;
            const url = `${this.baseUrl}/api/data/v9.2/contacts?$filter=${encodeURIComponent(filter)}&$select=contactid,fullname,mobilephone&$top=5`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });
            return (response.data.value || []).map((c: any) => ({
                contactid: c.contactid,
                fullname: c.fullname,
                mobilephone: c.mobilephone
            }));
        } catch (error: any) {
            console.error('[Dynamics CRM] Contact name search failed:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    async createCase(
        contactId: string,
        caseType: string,
        description: string,
        priority: string
    ): Promise<any | null> {
        const token = await this.getToken();

        // Map case type to icon_caseprocess option set values
        // TODO: Verify these option set values match your CRM
        const caseTypeMap: Record<string, number> = {
            'Claim': 757710000,
            'Query': 757710001,
            'Complaint': 757710002,
            'Admin': 757710003,
            'Other': 757710004,
        };

        // Map priority
        const priorityMap: Record<string, number> = {
            'High': 757710000,
            'Medium': 757710001,
            'Low': 757710002,
        };

        // Validate contactId is a GUID (not a phone number)
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRegex.test(contactId)) {
            console.error(`[Dynamics CRM] createCase called with invalid contactId (not a GUID): ${contactId}`);
            return null;
        }

        // Get contact name for the case title
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['fullname']
        );
        const clientName = contact?.fullname || 'Unknown';
        const year = new Date().getFullYear();

        const payload: any = {
            'new_name': `${clientName} - ${year}`,
            'ttt_additionalinformation': `[${caseType}] [${priority}] ${description}`,
            'icon_caseprocess': caseTypeMap[caseType] ?? 757710000,
            'ttt_taxyear': 100000005, // TODO: map to correct option set value for current tax year
        };

        try {
            // Step 1: Create the case without the client lookup
            const response = await this.crmPost('new_cases', payload, contactId);
            const caseId = response.data?.new_caseid;
            console.log(`[Dynamics CRM] Created case ${caseId} for contact ${contactId}: ${response.data?.new_name}`);

            // Step 2: Link the client using the correct navigation property
            if (caseId && contactId) {
                try {
                    await axios.put(
                        `${this.baseUrl}/api/data/v9.2/new_cases(${caseId})/ttt_ClientName_contact/$ref`,
                        { '@odata.id': `${this.baseUrl}/api/data/v9.2/contacts(${contactId})` },
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'OData-MaxVersion': '4.0',
                                'OData-Version': '4.0',
                                'Content-Type': 'application/json',
                            }
                        }
                    );
                    console.log(`[Dynamics CRM] Linked case ${caseId} to contact ${contactId}`);
                } catch (linkError: any) {
                    console.error('[Dynamics CRM] Failed to link client to case:', linkError?.response?.data?.error?.message || linkError.message);
                    console.log('[Dynamics CRM] Case was created but client link failed. Try linking manually in CRM.');
                }
            }
            await supabaseService.logCrmWrite({
                crmEntity: 'new_cases',
                crmRecordId: response.data?.new_caseid,
                action: 'create',
                payload,
                triggeredBy: contactId,
            });
            return response.data;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create case:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    async searchCaseByName(caseName: string): Promise<any[]> {
        return this.getList(
            'new_cases',
            `contains(new_name,'${caseName}')`,
            ['new_caseid', 'new_name', 'icon_caseprocess', 'icon_casestage', 'statecode', 'createdon', 'ttt_taxyear', 'ttt_additionalinformation', '_ttt_clientname_value', '_ownerid_value']
        );
    }

    async getOpenInvoiceTotal(contactId: string): Promise<{ total: number; count: number }> {
        const invoices = await this.getList(
            'new_invoiceses',
            `_ttt_customer_value eq ${contactId} and statecode eq 0`,
            ['riivo_totalinclvat']
        );
        const total = invoices.reduce((sum: number, inv: any) => sum + (inv.riivo_totalinclvat || 0), 0);
        return { total, count: invoices.length };
    }

    /**
     * Deterministic bad-debt detection (PRD-bad-debt-collection.md §6.2).
     * Reads the client's open invoices (ttt_outstanding > 0) plus each invoice's
     * createdon, and returns a BadDebtDetail when at least one open invoice is
     * >= 30 calendar days old (inclusive). Returns null when the client is in
     * good standing (no open invoice, or every open invoice still within terms).
     *
     * The returned detail describes the OVERDUE (>= 30-day) invoices only — those
     * are the ones we surface and send. Oldest-first so the PDF cap (§7.1) drops
     * the freshest extras, not the most-overdue ones.
     */
    async getBadDebtState(contactId: string): Promise<BadDebtDetail | null> {
        const rows = await this.getList(
            'new_invoiceses',
            `_ttt_customer_value eq ${contactId} and statecode eq 0 and ttt_outstanding gt 0`,
            ['new_invoicesid', 'ttt_invoiceid', 'new_name', 'createdon',
             'ttt_outstanding', 'ttt_paymentreceived', 'riivo_totalinclvat']
        );
        if (!rows.length) return null;

        const now = Date.now();
        const ageInDays = (createdon: string): number => {
            const created = new Date(createdon).getTime();
            if (!Number.isFinite(created)) return 0;
            return Math.floor((now - created) / (1000 * 60 * 60 * 24));
        };

        const overdue: BadDebtInvoiceSummary[] = rows
            .map((inv: any): BadDebtInvoiceSummary => ({
                invoiceId: (inv.ttt_invoiceid || inv.new_name || '').toString().trim(),
                recordId: inv.new_invoicesid,
                outstanding: typeof inv.ttt_outstanding === 'number' ? inv.ttt_outstanding : Number(inv.ttt_outstanding) || 0,
                total: typeof inv.riivo_totalinclvat === 'number' ? inv.riivo_totalinclvat : Number(inv.riivo_totalinclvat) || 0,
                paymentReceived: typeof inv.ttt_paymentreceived === 'number' ? inv.ttt_paymentreceived : Number(inv.ttt_paymentreceived) || 0,
                ageDays: ageInDays(inv.createdon),
            }))
            .filter(inv => inv.ageDays >= BAD_DEBT_AGE_DAYS)
            .sort((a, b) => b.ageDays - a.ageDays);

        if (!overdue.length) return null;

        return {
            totalOutstanding: Math.round(overdue.reduce((s, i) => s + i.outstanding, 0) * 100) / 100,
            openInvoiceCount: overdue.length,
            oldestAgeDays: overdue[0].ageDays,
            invoices: overdue,
        };
    }

    /**
     * Line items for a single invoice (riivo_invoicelineitems), used to build the
     * invoice-gen API payload. Returns [] on error / no items so the caller can
     * still generate a header-only PDF or fall back to the text payment ask.
     */
    async getInvoiceLineItems(invoiceId: string): Promise<InvoiceLineItem[]> {
        const token = await this.getToken();
        const selectFields = [
            'riivo_invoicelineitemsid', 'riivo_name', 'riivo_itemdescriptionfx',
            'riivo_qty', 'riivo_price', 'riivo_amount', 'riivo_subtotal',
            'riivo_totalvat', 'riivo_totalinclvat',
        ];
        try {
            const url = `${this.baseUrl}/api/data/v9.2/riivo_invoicelineitemses?$filter=${encodeURIComponent(`_riivo_invoice_value eq ${invoiceId} and statecode eq 0`)}&$select=${selectFields.join(',')}&$orderby=createdon asc&$top=100`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                },
            });
            return (response.data?.value || []).map(lineItemFromRow);
        } catch (error: any) {
            console.warn(`[Dynamics CRM] getInvoiceLineItems(${invoiceId}) failed:`, error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    /**
     * Fetch a full invoice record by its GUID for the invoice-gen API payload
     * (PRD-bad-debt-collection.md §7.1). Field set + formatted-label annotations
     * mirror the Power Automate flow that drives the same Azure Function:
     * customer/consultant blocks, the 30/60/90-day interest amounts (`terms`),
     * ttt_discountamount for the totals calc, the icon_* banking option labels,
     * and _ownerid_value so a Tax invoice can pull the consultant's bank account.
     */
    async getInvoiceById(invoiceId: string): Promise<Invoice | null> {
        const token = await this.getToken();
        const selectFields = [
            'new_invoicesid', 'new_name', 'ttt_invoiceid', 'createdon', '_ownerid_value',
            'riivo_invoicetype', 'ttt_discountamount', 'ttt_description',
            'riivo_dayinterestamounttest', 'riivo_dayinterestamount', 'riivo_dayinterestamountnew',
            'riivo_customerfullname', 'riivo_customerstreet', 'riivo_customerprovince',
            'riivo_customersuburb', 'riivo_customerponumber', 'riivo_customercity',
            'riivo_customercountry', 'riivo_customervatnumber',
            'riivo_consultantcompany', 'riivo_consultantfullname', 'riivo_consultantstreet',
            'riivo_consultantsuburb', 'riivo_consultantprovince', 'riivo_consultantponumber',
            'riivo_consultantcity', 'riivo_consultantcountry', 'riivo_consultantvatnumber',
            'icon_accountholdername', 'icon_bank', 'icon_accountnumber',
            'icon_accounttype', 'icon_branchnumber',
        ];
        try {
            const url = `${this.baseUrl}/api/data/v9.2/new_invoiceses(${invoiceId})?$select=${selectFields.join(',')}`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    // icon_bank / icon_accounttype are option sets — the API
                    // payload needs their display labels, not the numeric values.
                    'Prefer': 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
                },
            });
            return response.data ? invoiceFromByIdRow(response.data) : null;
        } catch (error: any) {
            console.warn(`[Dynamics CRM] getInvoiceById(${invoiceId}) failed:`, error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    /**
     * Banking details held on a consultant's systemuser record. For Tax invoices
     * the invoice-gen payload pulls the account number / holder / branch from the
     * owning consultant (the icon_* fields on the invoice carry the bank +
     * account-type option labels only). Returns null on error / not found.
     */
    async getConsultantBanking(
        systemUserId: string
    ): Promise<{ accountNumber: string; accountHolder: string; branchNumber: string } | null> {
        const user = await this.searchEntity(
            'systemusers',
            `systemuserid eq ${systemUserId}`,
            ['systemuserid', 'ttt_accountnumber', 'ttt_accountholdername', 'ttt_branchnumber']
        );
        if (!user) return null;
        return {
            accountNumber: user.ttt_accountnumber || '',
            accountHolder: user.ttt_accountholdername || '',
            branchNumber: user.ttt_branchnumber || '',
        };
    }

    async getContactTaxNumber(contactId: string): Promise<string | null> {
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['ttt_taxnumber']
        );
        return contact ? contact.ttt_taxnumber : null;
    }

    async getContactReferralCode(contactId: string): Promise<string | null> {
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['riivo_referralcode']
        );
        return contact?.riivo_referralcode || null;
    }

    async getContactByReferralCode(code: string): Promise<{ id: string; fullname: string; firstname: string } | null> {
        const trimmed = code.trim();
        if (!trimmed) return null;
        const safe = trimmed.replace(/'/g, "''");
        const contact = await this.searchEntity(
            'contacts',
            `riivo_referralcode eq '${safe}' and statecode eq 0`,
            ['contactid', 'fullname', 'firstname']
        );
        if (!contact?.contactid) return null;
        return {
            id: contact.contactid,
            fullname: contact.fullname || '',
            firstname: contact.firstname || '',
        };
    }

    async createLead(params: {
        firstName: string;
        lastName: string;
        phone?: string;
        email?: string;
        department?: string;
        notes?: string;
        referredByContactId?: string;
        // New required fields for staff-driven lead creation. Optional in the
        // signature so the existing refer_friend flow still compiles, but
        // Dynamics will reject the POST if they are missing because the fields
        // are marked Business Required at the table level.
        clientType?: number;        // riivo_clienttype Choice (0=Individual,1=Business,2=Private Company,3=Closed Corp,4=Business Trust,5=Sole Prop)
        leadType?: number;          // riivo_leadtype Choice (100000000=Tax,100000001=Accounting,463630001=Long Term Insurance,463630002=Short Term Insurance)
        leadSource?: number;        // riivo_leadsource Choice (e.g. 463630005=WhatsApp — new option, may not exist in every env yet)
        industryId?: string;        // riivo_industries GUID for riivo_Industry_lookup
        ownerSystemUserId?: string; // systemuser GUID for ownerid
        ownerTeamId?: string;       // team GUID for ownerid — takes precedence over ownerSystemUserId when set
        ownerFallbackSystemUserId?: string; // systemuser GUID to retry with if the primary owner is rejected (e.g. team doesn't exist in env)
    }): Promise<any | null> {
        const payload: any = {
            'ttt_firstname': params.firstName,
            'ttt_lastname': params.lastName,
        };
        if (params.phone) payload['ttt_mobilephone'] = params.phone;
        if (params.email) payload['ttt_email'] = params.email;
        if (params.department) payload['riivo_requestedservice'] = params.department;
        if (params.notes) payload['riivo_notes'] = params.notes;
        if (typeof params.clientType === 'number') payload['riivo_clienttype'] = params.clientType;
        if (typeof params.leadType === 'number') payload['riivo_leadtype'] = params.leadType;
        if (typeof params.leadSource === 'number') payload['riivo_leadsource'] = params.leadSource;
        if (params.industryId) payload['riivo_Industry_lookup@odata.bind'] = `/riivo_industries(${params.industryId})`;
        if (params.ownerTeamId) {
            payload['ownerid@odata.bind'] = `/teams(${params.ownerTeamId})`;
        } else if (params.ownerSystemUserId) {
            payload['ownerid@odata.bind'] = `/systemusers(${params.ownerSystemUserId})`;
        }

        const triggeredBy = params.referredByContactId || params.phone || 'unknown';

        // riivo_leadsource is currently a dev-only option set, and the default
        // owner GUID is a prod-only systemuser. Either can make Dataverse reject
        // the whole POST in the wrong environment, so on failure we strip the
        // offending field and retry rather than losing the lead entirely.
        const attempt = async (currentPayload: any): Promise<any> => {
            return this.crmPost('new_leads', currentPayload, triggeredBy);
        };

        let ownerFallbackTried = false;
        const tryStripField = (currentPayload: any, errMsg: string): any | null => {
            const lower = errMsg.toLowerCase();
            if ('riivo_leadsource' in currentPayload && lower.includes('riivo_leadsource')) {
                const next = { ...currentPayload };
                delete next['riivo_leadsource'];
                console.warn('[Dynamics CRM] riivo_leadsource rejected — retrying lead without it');
                return next;
            }
            if ('ownerid@odata.bind' in currentPayload && (lower.includes('ownerid') || lower.includes('systemuser') || lower.includes('team') || lower.includes('does not exist'))) {
                if (!ownerFallbackTried && params.ownerFallbackSystemUserId) {
                    ownerFallbackTried = true;
                    const next = { ...currentPayload };
                    next['ownerid@odata.bind'] = `/systemusers(${params.ownerFallbackSystemUserId})`;
                    console.warn(`[Dynamics CRM] ownerid rejected — retrying with fallback systemuser ${params.ownerFallbackSystemUserId}`);
                    return next;
                }
                const next = { ...currentPayload };
                delete next['ownerid@odata.bind'];
                console.warn('[Dynamics CRM] ownerid rejected — retrying lead without it');
                return next;
            }
            return null;
        };

        let currentPayload = payload;
        for (let i = 0; i < 4; i++) {
            try {
                const response = await attempt(currentPayload);
                console.log(`[Dynamics CRM] Created lead: ${params.firstName} ${params.lastName}`);
                await supabaseService.logCrmWrite({
                    crmEntity: 'new_leads',
                    crmRecordId: response.data?.new_leadid,
                    action: 'create',
                    payload: currentPayload,
                    triggeredBy,
                });
                return response.data;
            } catch (error: any) {
                const errMsg = error?.response?.data?.error?.message || error.message || '';
                const stripped = tryStripField(currentPayload, errMsg);
                if (!stripped) {
                    console.error('[Dynamics CRM] Failed to create lead:', errMsg);
                    return null;
                }
                currentPayload = stripped;
            }
        }
        console.error('[Dynamics CRM] Failed to create lead after fallback retries');
        return null;
    }

    /**
     * Create a Contact in Dynamics. All fields below are Business Required on
     * the Contact table, so omitting any of them will cause Dataverse to reject
     * the POST. The chat layer (create_contact tool) is responsible for
     * gathering them all from the staff member before calling.
     */
    async createContact(params: {
        firstName: string;
        lastName: string;
        entityType: number;          // riivo_clienttypeindbus Choice (same global Client Type values 0-5)
        industryId: string;          // riivo_industries GUID for riivo_IndustryId
        ownerSystemUserId: string;   // systemuser GUID for ownerid
        primaryRepSystemUserId: string; // systemuser GUID for icon_PrimaryTTTRepresentative
        phone?: string;
        email?: string;
    }): Promise<{ contactid?: string } | null> {
        const payload: any = {
            firstname: params.firstName,
            lastname: params.lastName,
            riivo_clienttypeindbus: params.entityType,
            'riivo_IndustryId@odata.bind': `/riivo_industries(${params.industryId})`,
            'ownerid@odata.bind': `/systemusers(${params.ownerSystemUserId})`,
            'icon_PrimaryTTTRepresentative@odata.bind': `/systemusers(${params.primaryRepSystemUserId})`,
        };
        if (params.phone) payload.mobilephone = params.phone;
        if (params.email) payload.emailaddress1 = params.email;

        try {
            const response = await this.crmPost('contacts', payload, params.ownerSystemUserId);
            const contactid = response.data?.contactid;
            console.log(`[Dynamics CRM] Created contact: ${params.firstName} ${params.lastName} (${contactid})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'contacts',
                crmRecordId: contactid,
                action: 'create',
                payload,
                triggeredBy: params.ownerSystemUserId,
            });
            return { contactid };
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create contact:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    /**
     * Create an Invoice in Dynamics. The Customer field on the new_invoice
     * entity is a polymorphic Customer lookup — bot is currently scoped to
     * Contact-only customers (Account customers can be added later by binding
     * ttt_Customer_account instead).
     */
    async createInvoice(params: {
        customerContactId: string;   // contact GUID for ttt_Customer
        invoiceType: number;         // riivo_invoicetype Choice (100000000=Tax, 100000001=Accounting)
        ownerSystemUserId: string;   // systemuser GUID for ownerid
    }): Promise<{ new_invoicesid?: string } | null> {
        const payload: any = {
            'ttt_Customer_contact@odata.bind': `/contacts(${params.customerContactId})`,
            riivo_invoicetype: params.invoiceType,
            'ownerid@odata.bind': `/systemusers(${params.ownerSystemUserId})`,
        };

        try {
            // Entity set name is new_invoiceses (Dynamics auto-pluralizes the
            // already-plural-looking logical name 'new_invoices' → 'new_invoiceses').
            // Matches the collection segment used elsewhere (getClientInvoices,
            // getInvoiceByNumber). Using 'new_invoices' returns a 404.
            const response = await this.crmPost('new_invoiceses', payload, params.ownerSystemUserId);
            const invoiceId = response.data?.new_invoicesid;
            console.log(`[Dynamics CRM] Created invoice ${invoiceId} for contact ${params.customerContactId}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'new_invoiceses',
                crmRecordId: invoiceId,
                action: 'create',
                payload,
                triggeredBy: params.ownerSystemUserId,
            });
            return { new_invoicesid: invoiceId };
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create invoice:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    /**
     * Lookup industries from the riivo_industries table. Used both as a picker
     * for staff creating leads/contacts and to validate an industry GUID.
     * Optional nameFilter does a case-insensitive contains match (server-side)
     * so we don't have to ship 60+ rows over the wire each time.
     */
    async getIndustries(nameFilter?: string): Promise<{ id: string; name: string }[]> {
        const token = await this.getToken();
        try {
            const filters = ['statecode eq 0', 'statuscode eq 1'];
            if (nameFilter && nameFilter.trim()) {
                const safe = nameFilter.replace(/'/g, "''");
                filters.push(`contains(riivo_industry,'${safe}')`);
            }
            const url = `${this.baseUrl}/api/data/v9.2/riivo_industries?$filter=${encodeURIComponent(filters.join(' and '))}&$select=riivo_industryid,riivo_industry&$orderby=riivo_industry&$top=50`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                },
            });
            return (response.data.value || []).map((i: any) => ({
                id: i.riivo_industryid,
                name: i.riivo_industry,
            }));
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to fetch industries:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    async searchContactByIdNumber(idNumber: string): Promise<any | null> {
        return this.searchEntity(
            'contacts',
            `ttt_idnumber eq '${idNumber}' and statecode eq 0`,
            ['contactid', 'fullname', 'mobilephone', 'emailaddress1']
        );
    }

    async linkPhoneToContact(contactId: string, phoneNumber: string): Promise<boolean> {
        try {
            await this.crmPatch('contacts', `${this.baseUrl}/api/data/v9.2/contacts(${contactId})`, { 'mobilephone': phoneNumber }, phoneNumber);
            console.log(`[Dynamics CRM] Linked phone ${phoneNumber} to contact ${contactId}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'contacts',
                crmRecordId: contactId,
                action: 'update',
                payload: { mobilephone: phoneNumber },
                triggeredBy: phoneNumber,
            });
            return true;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to link phone:', error?.response?.data?.error?.message || error.message);
            return false;
        }
    }

    async logMessage(
        entity: any | null,
        messageContent: string,
        direction: 'Incoming' | 'Outgoing',
        phoneNumber: string,
        requestId?: string | null
    ): Promise<void> {
        const directionValue = direction === 'Incoming' ? 463630000 : 463630001;

        const payload: any = {
            "subject": `WhatsApp ${direction}: ${phoneNumber}`,
            "description": messageContent,
            "riivo_messagedirection": directionValue,
            "riivo_from": direction === 'Incoming' ? phoneNumber : 'Bot',
            "riivo_to": direction === 'Incoming' ? 'Bot' : phoneNumber,
            "riivo_timestamp": new Date().toISOString()
        };

        // Prefer threading under the request so staff can see the full
        // conversation on the request record in CRM. Fall back to the
        // contact/lead binding only when no request exists.
        if (requestId) {
            payload['regardingobjectid_riivo_request@odata.bind'] = `/riivo_requests(${requestId})`;
        } else if (entity) {
            if (entity.type === 'client') {
                payload['regardingobjectid_contact@odata.bind'] = `/contacts(${entity.id})`;
            } else if (entity.type === 'lead') {
                payload['regardingobjectid_new_lead@odata.bind'] = `/new_leads(${entity.id})`;
            }
        }

        try {
            await this.crmPost('riivo_whatsappcommunicationses', payload, entity?.id || phoneNumber);
            console.log(`[Dynamics CRM] Logged ${direction} message for ${phoneNumber}${requestId ? ` (request ${requestId})` : ''}`);
        } catch (error: any) {
            console.error('[Dynamics CRM] Logging failed:', error?.response?.data?.error?.message || error.message);
        }
    }

    /**
     * Attach a signed Letter of Engagement (PDF) as an annotation on a Lead
     * and flip the LOE-received flag on that Lead. Used by the staff
     * upload_letter_of_engagement tool. PDF-only enforcement happens upstream
     * in the tool handler — this method assumes the caller has validated the
     * mime type.
     */
    /**
     * Check if a lead already has an LOE on file. Returns the lead's name
     * for display purposes plus the flag state. Non-fatal — returns
     * { alreadyReceived: false } if the query fails.
     */
    async checkLoeAlreadyReceived(leadId: string): Promise<{ alreadyReceived: boolean; leadName?: string }> {
        try {
            const existing = await this.searchEntity(
                'new_leads',
                `new_leadid eq ${leadId}`,
                ['new_leadid', LEAD_LOE_RECEIVED_FIELD, 'ttt_firstname', 'ttt_lastname']
            );
            if (existing && existing[LEAD_LOE_RECEIVED_FIELD] === true) {
                const name = `${existing.ttt_firstname || ''} ${existing.ttt_lastname || ''}`.trim() || 'this lead';
                return { alreadyReceived: true, leadName: name };
            }
        } catch (err: any) {
            console.warn(`[Dynamics CRM] Could not check LOE status for lead ${leadId}:`, err?.message || err);
        }
        return { alreadyReceived: false };
    }

    /**
     * Upload the signed LOE PDF to the Lead's File column
     * (riivo_SignedLetterofEngagement) and create a timeline annotation
     * recording the upload event. Called AFTER the staff has confirmed the
     * extracted data — by this point the file is definitely the right one.
     */
    async uploadLoeFileToCrm(
        leadId: string,
        fileName: string,
        fileBuffer: Buffer,
        triggeredBy: string
    ): Promise<{ success: boolean; error?: string }> {
        // Step 1: Upload the PDF to the File column via PATCH with raw bytes.
        try {
            const token = await this.getToken();
            const url = `${this.baseUrl}/api/data/v9.2/new_leads(${leadId})/riivo_signedletterofengagement`;
            await axios.patch(url, fileBuffer, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream',
                    'x-ms-file-name': fileName,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            console.log(`[Dynamics CRM] Uploaded LOE file ${fileName} to lead ${leadId} file column`);
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error('[Dynamics CRM] LOE file column upload failed:', errMsg);
            return { success: false, error: errMsg };
        }

        // Step 2: Create a timeline annotation recording the upload event.
        // No file body in the annotation — the PDF lives in the File column.
        const annotationPayload: any = {
            subject: 'Signed Letter of Engagement',
            notetext: `Signed LOE "${fileName}" uploaded via WhatsApp Bot at ${new Date().toISOString()}.`,
            'objectid_new_lead@odata.bind': `/new_leads(${leadId})`,
            objecttypecode: 'new_lead',
        };
        try {
            const response = await this.crmPost('annotations', annotationPayload, triggeredBy);
            const annotationId = response.data?.annotationid;
            console.log(`[Dynamics CRM] Created LOE timeline note for lead ${leadId} (annotation ${annotationId})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'annotations',
                crmRecordId: annotationId,
                action: 'create',
                payload: { subject: annotationPayload.subject, lead_id: leadId },
                triggeredBy,
            });
        } catch (error: any) {
            // Non-fatal — the file is already uploaded, the annotation is just
            // the audit trail. Log but don't fail the whole operation.
            console.error('[Dynamics CRM] LOE annotation failed:', error?.response?.data?.error?.message || error.message);
        }

        return { success: true };
    }

    /**
     * Write confirmed LOE fields to the Lead record. Takes the staff-reviewed
     * field values (not raw OCR output) so any corrections are honoured.
     * Flips riivo_LoEReceived = true in the same PATCH.
     */
    /**
     * Read a Lead by its id. Returns the fields needed by the post-LoE
     * activation flow: name, phone, the two onboarding gate flags, and lead
     * type so non-Tax leads can be skipped.
     */
    async getLeadById(leadId: string): Promise<{
        id: string;
        firstname: string;
        lastname: string;
        fullname: string;
        mobilephone: string | null;
        loeReceived: boolean;
        otpCompleted: boolean;
        leadType: number | null;
    } | null> {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!leadId || !guidRegex.test(leadId)) {
            console.warn(`[Dynamics CRM] getLeadById: invalid lead id: ${leadId}`);
            return null;
        }
        const lead = await this.searchEntity(
            'new_leads',
            `new_leadid eq ${leadId}`,
            ['new_leadid', 'ttt_firstname', 'ttt_lastname', 'ttt_mobilephone', LEAD_LOE_RECEIVED_FIELD, LEAD_OTP_COMPLETED_FIELD, 'riivo_leadtype'],
        );
        if (!lead) return null;
        const firstname = (lead.ttt_firstname || '').trim();
        const lastname = (lead.ttt_lastname || '').trim();
        return {
            id: lead.new_leadid,
            firstname,
            lastname,
            fullname: `${firstname} ${lastname}`.trim(),
            mobilephone: lead.ttt_mobilephone || null,
            loeReceived: lead[LEAD_LOE_RECEIVED_FIELD] === true,
            otpCompleted: lead[LEAD_OTP_COMPLETED_FIELD] === true,
            leadType: typeof lead.riivo_leadtype === 'number' ? lead.riivo_leadtype : null,
        };
    }

    /**
     * Find Tax leads with `riivo_loereceived = true` that have NOT yet been
     * processed by the post-LoE activation flow. "Processed" is tracked by a
     * sentinel riivo_request row with classificationtopic = 'post_loe_activation'.
     * Used by the hourly safety-net cron.
     */
    async findLeadsAwaitingPostLoeActivation(): Promise<{ id: string }[]> {
        const token = await this.getToken();
        try {
            const leadFilter = `${LEAD_LOE_RECEIVED_FIELD} eq true and statecode eq 0 and riivo_leadtype eq ${LEAD_TYPE_TAX}`;
            const url = `${this.baseUrl}/api/data/v9.2/new_leads?$filter=${encodeURIComponent(leadFilter)}&$select=new_leadid&$top=200`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                },
            });
            const leads: { new_leadid: string }[] = response.data?.value || [];
            if (leads.length === 0) return [];

            // For each lead, check whether the sentinel already exists. We
            // could do this with a single Web API query but the cardinality
            // of leads-with-LoE-true and-no-sentinel is small enough that
            // a per-lead lookup is fine, and a $expand isn't safe because
            // we don't have a guaranteed nav from new_lead → riivo_requests.
            const out: { id: string }[] = [];
            for (const l of leads) {
                const sentinelFilter = `_riivo_lead_value eq ${l.new_leadid} and riivo_classificationtopic eq 'post_loe_activation'`;
                const sentinelUrl = `${this.baseUrl}/api/data/v9.2/riivo_requests?$filter=${encodeURIComponent(sentinelFilter)}&$select=riivo_requestid&$top=1`;
                try {
                    const sentinelRes = await axios.get(sentinelUrl, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'OData-MaxVersion': '4.0',
                            'OData-Version': '4.0',
                            'Accept': 'application/json',
                        },
                    });
                    if (!sentinelRes.data?.value?.length) {
                        out.push({ id: l.new_leadid });
                    }
                } catch (e: any) {
                    console.warn(`[Dynamics CRM] sentinel lookup failed for lead ${l.new_leadid}:`, e?.response?.data?.error?.message || e.message);
                }
            }
            return out;
        } catch (error: any) {
            console.error('[Dynamics CRM] findLeadsAwaitingPostLoeActivation failed:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    /**
     * Look up the post-LoE activation sentinel for a lead. Returns the
     * request id if found, null otherwise. Used by the activation handler
     * for the idempotency check.
     */
    async findPostLoeActivationSentinel(leadId: string): Promise<string | null> {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!leadId || !guidRegex.test(leadId)) return null;
        const filter = `_riivo_lead_value eq ${leadId} and riivo_classificationtopic eq 'post_loe_activation'`;
        const row = await this.searchEntity('riivo_requests', filter, ['riivo_requestid']);
        return row?.riivo_requestid || null;
    }

    /**
     * Write the post-LoE activation sentinel — a riivo_request row tagged with
     * classificationtopic = 'post_loe_activation'. Future activations are
     * short-circuited by findPostLoeActivationSentinel.
     *
     * Dynamics does NOT allow create-as-inactive directly: the create silently
     * keeps state=Active, and any statuscode that's only valid in Inactive
     * (e.g. RESOLVED_BY_BOT=2) then rolls the transaction back with
     * "N is not a valid status code for state code riivo_RequestState.Active".
     * The canonical pattern (see resolveOpenOtpRequestsForLead) is
     * create-active-then-patch-inactive. The sentinel only needs to be
     * findable, so even if the PATCH fails the row exists and idempotency
     * holds.
     */
    async createPostLoeActivationSentinel(leadId: string, phoneNumber: string): Promise<string | null> {
        const payload: any = {
            riivo_clientmobilenumber: phoneNumber,
            riivo_channel: 1,
            riivo_category: 0,
            riivo_priority: 1,
            riivo_description: 'Post-LoE activation processed (sentinel).',
            riivo_classificationtopic: 'post_loe_activation',
            statecode: REQUEST_STATE.ACTIVE,
            statuscode: REQUEST_STATUSCODE.NEW,
            'riivo_Lead@odata.bind': `/new_leads(${leadId})`,
        };
        let requestId: string | null = null;
        try {
            const response = await this.crmPost('riivo_requests', payload, leadId);
            requestId = response.data?.riivo_requestid || null;
        } catch (error: any) {
            console.error(`[Dynamics CRM] createPostLoeActivationSentinel failed for lead ${leadId}:`, error?.response?.data?.error?.message || error.message);
            return null;
        }
        if (requestId) {
            await this.updateRequest(requestId, {
                statecode: REQUEST_STATE.INACTIVE,
                statuscode: REQUEST_STATUSCODE.RESOLVED_BY_BOT,
            });
        }
        return requestId;
    }

    /**
     * Attach a Lead annotation summarising an IRP5 the lead sent on WhatsApp
     * before their conversion to a Contact. The PDF itself lives in SharePoint;
     * this annotation gives consultants a timeline-visible record so they can
     * see the upload happened pre-conversion.
     */
    async createIrp5AnnotationOnLead(leadId: string, payload: {
        employerName: string | null;
        assessmentYear: number | null;
        certificateNumber: string | null;
        sourceCodes: string[];
        sharepointUrl: string;
    }): Promise<{ success: boolean; annotationId?: string; error?: string }> {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRegex.test(leadId)) {
            return { success: false, error: 'invalid_lead_id' };
        }
        const year = payload.assessmentYear ?? '(unknown)';
        const noteText = [
            'IRP5 received from client via WhatsApp.',
            '',
            `Employer: ${payload.employerName || '(unknown)'}`,
            `Tax year: ${year}`,
            `Certificate number: ${payload.certificateNumber || '(unknown)'}`,
            `Source codes detected: ${payload.sourceCodes.join(', ') || '(none)'}`,
            '',
            `PDF: ${payload.sharepointUrl}`,
            '',
            'This IRP5 is staged in Supabase (pending_irp5s) and will apply automatically to the client\'s Contact record once they convert.',
        ].join('\n');

        const annPayload: any = {
            subject: `IRP5 received via WhatsApp (${year})`,
            notetext: noteText,
            'objectid_new_lead@odata.bind': `/new_leads(${leadId})`,
            objecttypecode: 'new_lead',
        };

        try {
            const response = await this.crmPost('annotations', annPayload, leadId);
            const annotationId = response.data?.annotationid;
            console.log(`[Dynamics CRM] Created IRP5 annotation ${annotationId} on lead ${leadId}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'annotations',
                crmRecordId: annotationId,
                action: 'create',
                payload: {
                    subject: annPayload.subject,
                    objecttypecode: annPayload.objecttypecode,
                    lead_id: leadId,
                    certificate_number: payload.certificateNumber,
                    employer_name: payload.employerName,
                },
                triggeredBy: leadId,
            });
            return { success: true, annotationId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[Dynamics CRM] Failed to create IRP5 annotation on lead ${leadId}:`, errMsg);
            return { success: false, error: errMsg };
        }
    }

    async writeLoeFieldsToLead(
        leadId: string,
        fields: {
            bankName?: string | null;
            accountName?: string | null;
            accountNumber?: string | null;
            accountType?: string | null;
            branchNameCode?: string | null;
            signedAt?: string | null;
            signedAtConsultant?: string | null;
            signedDate?: string | null;
            clientFirstName?: string | null;
            clientLastName?: string | null;
            idNumber?: string | null;
            incomeTaxNumber?: string | null;
            physicalAddress?: string | null;
            emailAddress?: string | null;
            contactNumber?: string | null;
            industry?: string | null;
        },
        triggeredBy: string
    ): Promise<{ success: boolean; flagSet: boolean; error?: string }> {
        const payload: Record<string, any> = { [LEAD_LOE_RECEIVED_FIELD]: true };
        // Banking
        if (fields.bankName)            payload.riivo_bankname = fields.bankName;
        if (fields.accountName)         payload.riivo_accountname = fields.accountName;
        if (fields.accountNumber)       payload.riivo_accountnumber = fields.accountNumber;
        if (fields.accountType)         payload.riivo_accounttype = fields.accountType;
        if (fields.branchNameCode)      payload.riivo_branchnamecode = fields.branchNameCode;
        // Signing
        if (fields.signedAt)            payload.riivo_signedat = fields.signedAt;
        if (fields.signedAtConsultant)  payload.riivo_signedatconsultant = fields.signedAtConsultant;
        if (fields.signedDate)          payload.riivo_loesubmissiondate = fields.signedDate;
        // Client details
        if (fields.clientFirstName)     payload.ttt_firstname = fields.clientFirstName;
        if (fields.clientLastName)      payload.ttt_lastname = fields.clientLastName;
        if (fields.idNumber)            payload.ttt_idnumber = fields.idNumber;
        if (fields.incomeTaxNumber)     payload.riivo_incometaxnumber = fields.incomeTaxNumber;
        if (fields.physicalAddress)     payload.riivo_address1street1 = fields.physicalAddress;
        if (fields.emailAddress)        payload.ttt_email = fields.emailAddress;
        if (fields.contactNumber)       payload.ttt_mobilephone = fields.contactNumber;
        // riivo_industry is an Int32 Choice field in Dynamics, not free text.
        // We extract it from the LOE for display/review but cannot write it
        // without a label→integer mapping. Skipped for now.
        // if (fields.industry) payload.riivo_industry = fields.industry;

        try {
            await this.crmPatch(
                'new_leads',
                `${this.baseUrl}/api/data/v9.2/new_leads(${leadId})`,
                payload,
                triggeredBy
            );
            await supabaseService.logCrmWrite({
                crmEntity: 'new_leads',
                crmRecordId: leadId,
                action: 'update',
                payload,
                triggeredBy,
            });
            return { success: true, flagSet: true };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[Dynamics CRM] Failed to write LOE fields to lead ${leadId}:`, errMsg);
            return { success: false, flagSet: false, error: errMsg };
        }
    }

    async markLeadOtpCompleteAndReadyToConvert(leadId: string, triggeredBy: string): Promise<{ success: boolean; error?: string }> {
        const payload = {
            [LEAD_OTP_COMPLETED_FIELD]: true,
            icon_converttoclient: true,
        };
        try {
            await this.crmPatch(
                'new_leads',
                `${this.baseUrl}/api/data/v9.2/new_leads(${leadId})`,
                payload,
                triggeredBy
            );
            await supabaseService.logCrmWrite({
                crmEntity: 'new_leads',
                crmRecordId: leadId,
                action: 'update',
                payload,
                triggeredBy,
            });
            return { success: true };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[Dynamics CRM] Failed to flag OTP done + convert for lead ${leadId}:`, errMsg);
            return { success: false, error: errMsg };
        }
    }

    /**
     * Log an "invoice PDF sent via WhatsApp" annotation to a Contact's timeline.
     * Separate from uploadDocument because we're not attaching a file here —
     * the PDF itself lives in Meta's media store; the timeline note is just
     * the audit record that the send happened. Audit fields are added
     * automatically by crmPost via addAuditFields.
     */
    /**
     * Timeline entry for a tax form PDF sent to (or received from) a client.
     * Mirrors logInvoiceSentToContact — annotation entity, contact-bound,
     * no file body (the binary lives in SharePoint / Meta media).
     */
    async logTaxFormSentToContact(
        contactId: string,
        formLabel: string,
        year: number,
        filename: string,
        triggeredBy: string
    ): Promise<{ success: boolean; annotationId?: string; error?: string }> {
        const payload: any = {
            subject: `Tina sent ${formLabel} (${year}) to client`,
            notetext: filename,
            'objectid_contact@odata.bind': `/contacts(${contactId})`,
            objecttypecode: 'contact',
        };
        try {
            const response = await this.crmPost('annotations', payload, triggeredBy);
            const annotationId = response.data?.annotationid;
            console.log(`[Dynamics CRM] Logged tax-form send "${formLabel}" (${year}) on contact ${contactId} (annotation ${annotationId})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'annotations',
                crmRecordId: annotationId,
                action: 'create',
                payload: { subject: payload.subject, objecttypecode: payload.objecttypecode, contact_id: contactId, form_label: formLabel, year },
                triggeredBy,
            });
            return { success: true, annotationId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error('[Dynamics CRM] Failed to log tax-form send note:', errMsg);
            return { success: false, error: errMsg };
        }
    }

    async logTaxFormReceivedFromContact(
        contactId: string,
        formLabel: string,
        filename: string,
        triggeredBy: string
    ): Promise<{ success: boolean; annotationId?: string; error?: string }> {
        const payload: any = {
            subject: `Tina received completed ${formLabel} from client`,
            notetext: filename,
            'objectid_contact@odata.bind': `/contacts(${contactId})`,
            objecttypecode: 'contact',
        };
        try {
            const response = await this.crmPost('annotations', payload, triggeredBy);
            const annotationId = response.data?.annotationid;
            console.log(`[Dynamics CRM] Logged tax-form return "${formLabel}" on contact ${contactId} (annotation ${annotationId})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'annotations',
                crmRecordId: annotationId,
                action: 'create',
                payload: { subject: payload.subject, objecttypecode: payload.objecttypecode, contact_id: contactId, form_label: formLabel },
                triggeredBy,
            });
            return { success: true, annotationId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error('[Dynamics CRM] Failed to log tax-form return note:', errMsg);
            return { success: false, error: errMsg };
        }
    }

    async logInvoiceSentToContact(
        contactId: string,
        invoiceNumber: string,
        triggeredBy: string
    ): Promise<{ success: boolean; annotationId?: string; error?: string }> {
        const payload: any = {
            subject: `Invoice ${invoiceNumber} sent via WhatsApp`,
            notetext: `Invoice PDF delivered to client via WhatsApp Bot at ${new Date().toISOString()}.`,
            'objectid_contact@odata.bind': `/contacts(${contactId})`,
            objecttypecode: 'contact',
        };

        try {
            const response = await this.crmPost('annotations', payload, triggeredBy);
            const annotationId = response.data?.annotationid;
            console.log(`[Dynamics CRM] Logged invoice-send note for ${invoiceNumber} on contact ${contactId} (annotation ${annotationId})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'annotations',
                crmRecordId: annotationId,
                action: 'create',
                payload: {
                    subject: payload.subject,
                    objecttypecode: payload.objecttypecode,
                    contact_id: contactId,
                    invoice_number: invoiceNumber,
                },
                triggeredBy,
            });
            return { success: true, annotationId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error('[Dynamics CRM] Failed to log invoice-send note:', errMsg);
            return { success: false, error: errMsg };
        }
    }

    async uploadDocument(
        entity: any | null,
        fileName: string,
        mimeType: string,
        fileBuffer: Buffer
    ): Promise<void> {
        if (!entity) {
            console.warn('[Dynamics CRM] Cannot upload document: No linked entity found.');
            return;
        }

        const base64Content = fileBuffer.toString('base64');

        const payload: any = {
            "subject": `WhatsApp Document: ${fileName}`,
            "filename": fileName,
            "mimetype": mimeType,
            "documentbody": base64Content,
            "notetext": "Document received via WhatsApp Bot."
        };

        // Link to regarding object (only contacts — lead/user nav property names need verification)
        if (entity.type === 'client') {
            payload['objectid_contact@odata.bind'] = `/contacts(${entity.id})`;
            payload['objecttypecode'] = 'contact';
        } else if (entity.type === 'lead') {
            payload['objectid_new_lead@odata.bind'] = `/new_leads(${entity.id})`;
            payload['objecttypecode'] = 'new_lead';
        }

        try {
            await this.crmPost('annotations', payload, entity.id);
            console.log(`[Dynamics CRM] Uploaded document ${fileName} to ${entity.type} ${entity.id}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'annotations',
                action: 'create',
                payload: { subject: payload.subject, filename: payload.filename, mimetype: payload.mimetype, objecttypecode: payload.objecttypecode },
                triggeredBy: entity.id,
            });
        } catch (error: any) {
            console.error('[Dynamics CRM] Document upload failed:', error?.response?.data?.error?.message || error.message);
        }
    }

    /**
     * Create a riivo_taxsubmissionsdocuments row for a WhatsApp-uploaded
     * document. Matches the shape Power Automate writes for emailed docs:
     *   - _riivo_client_value links to the contact
     *   - riivo_taxsubmissionsdocument (primary name) carries the canonical
     *     doc-type label string (since _riivo_documenttype_value lookup is
     *     unused today by both Power Automate and this bot)
     *   - riivo_filereference holds the SharePoint webUrl
     *   - riivo_taxyear is a plain Whole Number (e.g. 2025)
     *   - riivo_uploaded = true to match Power Automate's flag
     *
     * Tax-year inference: if the client has exactly one active preseason
     * record, use that year; otherwise fall back to CURRENT_TAX_SEASON_YEAR.
     *
     * Case auto-link: if exactly one active case exists for the client at
     * the inferred year, populate _riivo_case_value. Otherwise leave null
     * (matches Power Automate's "consultant manually attaches" pattern).
     *
     * Preseason auto-link: gated by ENABLE_PRESEASON_DOC_LINK env flag —
     * off by default until the admin ships the _riivo_preseasondoc_value
     * lookup. Once on, the row links to the matching preseason record so
     * the spec §3 status-reason recalc flow fires.
     */
    async createTaxSubmissionDocument(params: {
        contactId: string;
        canonicalDocType: string;
        fileReferenceUrl: string;
        documentNotes: string;
        triggeredBy: string;
    }): Promise<{ success: boolean; recordId?: string; taxYear: number; caseId?: string; preseasonId?: string; error?: string }> {
        const inferred = await this.inferUploadContext(params.contactId);

        const payload: any = {
            'riivo_taxsubmissionsdocument': params.canonicalDocType,
            'riivo_filereference': params.fileReferenceUrl,
            'riivo_taxyear': inferred.taxYear,
            'riivo_uploaded': true,
            'riivo_documentnotes': params.documentNotes,
            'riivo_Client@odata.bind': `/contacts(${params.contactId})`,
        };

        // Case + preseason auto-links are gated behind env flags because the
        // corresponding lookup columns aren't always present on the entity
        // (depends on the CRM admin's schema state). Power Automate doesn't
        // write either — consultants attach manually — so leaving both off
        // is the safe default. Turn on once the lookup names are confirmed.
        if (inferred.caseId && process.env.ENABLE_CASE_DOC_LINK === 'true') {
            payload['_riivo_case_value@odata.bind'] = `/new_cases(${inferred.caseId})`;
        }

        if (inferred.preseasonId && process.env.ENABLE_PRESEASON_DOC_LINK === 'true') {
            payload['_riivo_preseasondoc_value@odata.bind'] = `/riivo_preseasondocumentations(${inferred.preseasonId})`;
        }

        try {
            const response = await this.crmPost('riivo_taxsubmissionsdocumentses', payload, params.triggeredBy);
            const recordId = response.data?.riivo_taxsubmissionsdocumentsid;
            console.log(`[Dynamics CRM] Created taxsubmissionsdocument ${recordId} for contact ${params.contactId}, year ${inferred.taxYear}, case ${inferred.caseId || 'none'}, preseason ${inferred.preseasonId || 'none'}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'riivo_taxsubmissionsdocumentses',
                crmRecordId: recordId,
                action: 'create',
                payload: {
                    canonical_doc_type: params.canonicalDocType,
                    tax_year: inferred.taxYear,
                    case_id: inferred.caseId,
                    preseason_id: inferred.preseasonId,
                    file_reference: params.fileReferenceUrl,
                },
                triggeredBy: params.triggeredBy,
            });
            return { success: true, recordId, taxYear: inferred.taxYear, caseId: inferred.caseId, preseasonId: inferred.preseasonId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[Dynamics CRM] Failed to create taxsubmissionsdocument for contact ${params.contactId}:`, errMsg);
            return { success: false, taxYear: inferred.taxYear, error: errMsg };
        }
    }

    /**
     * Record the Issue 27 "already sent it" escape hatch: an UNVERIFIED
     * "client states provided" marker for a doc the client says they already
     * sent to their consultant. Writes a `riivo_taxsubmissionsdocuments`-shaped
     * row that is clearly distinct from a verified upload —
     *   - `riivo_uploaded = false` (verified WhatsApp/Power Automate rows set true)
     *   - NO `riivo_filereference` (there is no file)
     *   - `riivo_documentnotes` = CLIENT_STATED_DOC_NOTE sentinel
     * The canonical doc label rides in `riivo_taxsubmissionsdocument` so
     * re-derivation can loose-match and suppress that item's re-ask across
     * session resets. It is NEVER counted as a verified receipt (see
     * isClientStatedMarkerRow); a consultant can confirm or clear it.
     */
    async markDocumentClientStated(params: {
        contactId: string;
        canonicalDocType: string;
        triggeredBy: string;
    }): Promise<{ success: boolean; recordId?: string; taxYear: number; error?: string }> {
        const inferred = await this.inferUploadContext(params.contactId);

        const payload: any = {
            'riivo_taxsubmissionsdocument': params.canonicalDocType,
            'riivo_taxyear': inferred.taxYear,
            'riivo_uploaded': false,
            'riivo_documentnotes': `${CLIENT_STATED_DOC_NOTE} — ${params.canonicalDocType}`,
            'riivo_Client@odata.bind': `/contacts(${params.contactId})`,
        };

        try {
            const response = await this.crmPost('riivo_taxsubmissionsdocumentses', payload, params.triggeredBy);
            const recordId = response.data?.riivo_taxsubmissionsdocumentsid;
            console.log(`[Dynamics CRM] Recorded UNVERIFIED client-stated marker ${recordId} for contact ${params.contactId}, doc "${params.canonicalDocType}", year ${inferred.taxYear}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'riivo_taxsubmissionsdocumentses',
                crmRecordId: recordId,
                action: 'create',
                payload: {
                    canonical_doc_type: params.canonicalDocType,
                    tax_year: inferred.taxYear,
                    client_stated_unverified: true,
                },
                triggeredBy: params.triggeredBy,
            });
            return { success: true, recordId, taxYear: inferred.taxYear };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[Dynamics CRM] Failed to record client-stated marker for contact ${params.contactId}:`, errMsg);
            return { success: false, taxYear: inferred.taxYear, error: errMsg };
        }
    }

    /**
     * Active IRP5 records for a client in a specific assessment year. One
     * row per employer is the expected pattern — multi-job filers will have
     * several. Used by the IRP5 upload flow to (a) dedupe re-sends by
     * certificate number and (b) union source codes across all of a client's
     * IRP5s before computing the outstanding-doc list.
     */
    async getIrp5RecordsForClient(contactId: string, assessmentYear: number): Promise<any[]> {
        const token = await this.getToken();
        const filter = `_riivo_client_value eq ${contactId} and riivo_assessmentyearint eq ${assessmentYear} and statecode eq 0`;
        const url = `${this.baseUrl}/api/data/v9.2/riivo_irp5s?$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=20`;
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Prefer': 'odata.include-annotations="*"',
                },
            });
            return response.data?.value || [];
        } catch (error: any) {
            console.warn(`[Dynamics CRM] getIrp5RecordsForClient(${contactId}, ${assessmentYear}) failed:`, error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    /**
     * Create (or update if a row with the same certificate number already
     * exists for this client) a riivo_irp5s record from extracted IRP5
     * fields. Banking fields are deliberately NOT touched — those come from
     * the LoE flow and the IRP5 doesn't carry them.
     *
     * Dedupe is keyed on riivo_certificatenumber: a client re-sending the
     * same IRP5 updates the existing row rather than creating a duplicate
     * (the SARS cert number is unique per issuance).
     */
    async createIrp5Record(params: {
        contactId: string;
        filename: string;
        sharepointUrl?: string;
        fields: Record<string, any>;
    }): Promise<{ success: boolean; recordId?: string; updated?: boolean; error?: string }> {
        const payload: Record<string, any> = {
            ...params.fields,
            'riivo_filename': params.filename,
            'riivo_Client@odata.bind': `/contacts(${params.contactId})`,
        };

        // Look for an existing row with the same certificate number for this
        // client. Dedupe is per-client (not global) — different clients can
        // legitimately have the same cert number across distinct CRMs/years.
        const certNumber = params.fields['riivo_certificatenumber'];
        if (certNumber) {
            const token = await this.getToken();
            const filter = `_riivo_client_value eq ${params.contactId} and riivo_certificatenumber eq '${String(certNumber).replace(/'/g, "''")}' and statecode eq 0`;
            const url = `${this.baseUrl}/api/data/v9.2/riivo_irp5s?$filter=${encodeURIComponent(filter)}&$select=riivo_irp5id&$top=1`;
            try {
                const response = await axios.get(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                    },
                });
                const existing = response.data?.value?.[0];
                if (existing?.riivo_irp5id) {
                    const recordUrl = `${this.baseUrl}/api/data/v9.2/riivo_irp5s(${existing.riivo_irp5id})`;
                    await this.crmPatch('riivo_irp5s', recordUrl, payload, params.contactId);
                    console.log(`[Dynamics CRM] Updated existing riivo_irp5s ${existing.riivo_irp5id} (cert ${certNumber}) for contact ${params.contactId}`);
                    await supabaseService.logCrmWrite({
                        crmEntity: 'riivo_irp5s',
                        crmRecordId: existing.riivo_irp5id,
                        action: 'update',
                        payload: { certificate_number: certNumber, filename: params.filename },
                        triggeredBy: params.contactId,
                    });
                    return { success: true, recordId: existing.riivo_irp5id, updated: true };
                }
            } catch (error: any) {
                // Dedupe lookup failure is non-fatal — fall through and create.
                console.warn(`[Dynamics CRM] IRP5 dedupe lookup failed (proceeding with create): ${error?.response?.data?.error?.message || error.message}`);
            }
        }

        try {
            const response = await this.crmPost('riivo_irp5s', payload, params.contactId);
            const recordId = response.data?.riivo_irp5id;
            console.log(`[Dynamics CRM] Created riivo_irp5s ${recordId} for contact ${params.contactId} (cert ${certNumber || 'unknown'})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'riivo_irp5s',
                crmRecordId: recordId,
                action: 'create',
                payload: { certificate_number: certNumber, filename: params.filename },
                triggeredBy: params.contactId,
            });
            return { success: true, recordId, updated: false };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error(`[Dynamics CRM] Failed to create riivo_irp5s for contact ${params.contactId}:`, errMsg);
            return { success: false, error: errMsg };
        }
    }

    /**
     * Resolve tax-year + optional case-link + optional preseason-link from a
     * contact's active preseason records and cases. Used by
     * createTaxSubmissionDocument; pulled out so the inference is easy to
     * unit-test independent of the CRM POST.
     */
    private async inferUploadContext(contactId: string): Promise<{
        taxYear: number;
        caseId?: string;
        preseasonId?: string;
    }> {
        const fallbackYear = parseInt(process.env.CURRENT_TAX_SEASON_YEAR || '', 10);
        const safeFallback = Number.isFinite(fallbackYear) ? fallbackYear : new Date().getFullYear() - 1;

        const preseasonRecords = await this.getPreseasonDocsForClient(contactId);
        let taxYear = safeFallback;
        let preseasonId: string | undefined;

        if (preseasonRecords.length === 1) {
            const rec = preseasonRecords[0];
            const yearLabel = rec?.['riivo_taxyear@OData.Community.Display.V1.FormattedValue'];
            const parsed = parseInt(yearLabel, 10);
            if (Number.isFinite(parsed)) taxYear = parsed;
            preseasonId = rec?.riivo_preseasondocumentationid;
        } else if (preseasonRecords.length > 1) {
            const matching = preseasonRecords.find(r => {
                const label = r?.['riivo_taxyear@OData.Community.Display.V1.FormattedValue'];
                return parseInt(label, 10) === safeFallback;
            });
            if (matching) preseasonId = matching.riivo_preseasondocumentationid;
        }

        const activeCases = await this.getActiveTaxCases(contactId);
        const yearStr = String(taxYear);
        const yearMatchedCases = activeCases.filter(c => {
            const label = c?.['ttt_taxyear@OData.Community.Display.V1.FormattedValue'];
            return label === yearStr;
        });
        const caseId = yearMatchedCases.length === 1 ? yearMatchedCases[0].new_caseid : undefined;

        return { taxYear, caseId, preseasonId };
    }

    /**
     * Create a riivo_request record for a qualifying inbound WhatsApp case.
     * Returns the new record's riivo_requestid, or null on failure.
     *
     * Option-set values:
     *   riivo_channel   1 = WhatsApp
     *   riivo_category  0 = Tax (default)
     *   riivo_priority  1 = Medium (default)
     */
    async createRequest(params: {
        contactId?: string;
        leadId?: string;
        contactType: 'client' | 'lead';
        phoneNumber: string;
        description: string;
        category?: number;
        priority?: number;
    }): Promise<{ riivo_requestid: string } | null> {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const targetId = params.contactType === 'client' ? params.contactId : params.leadId;
        if (!targetId || !guidRegex.test(targetId)) {
            console.error(`[Dynamics CRM] createRequest: invalid ${params.contactType} id: ${targetId}`);
            return null;
        }

        // riivo_description is capped at 100 chars in Dynamics — anything longer
        // is rejected with a validation error and the whole record fails to
        // create. Truncate defensively so a long lead name or chatty query
        // doesn't sink the request; warn so we can spot truncation in logs.
        const rawDescription = params.description || '';
        const description = rawDescription.slice(0, 100);
        if (rawDescription.length > 100) {
            console.warn(`[Dynamics CRM] createRequest: description truncated from ${rawDescription.length} to 100 chars`);
        }

        const payload: any = {
            riivo_clientmobilenumber: params.phoneNumber,
            riivo_channel: 1,
            riivo_category: params.category ?? 0,
            riivo_priority: params.priority ?? 1,
            riivo_description: description,
            statecode: REQUEST_STATE.ACTIVE,
            statuscode: REQUEST_STATUSCODE.NEW,
        };

        if (params.contactType === 'client') {
            payload['riivo_Client@odata.bind'] = `/contacts(${targetId})`;
        } else {
            payload['riivo_Lead@odata.bind'] = `/new_leads(${targetId})`;
        }

        // Inherit the owner from the linked client/lead so the request lands
        // with the consultant who already owns that record rather than the
        // integration user. Best-effort: if the lookup fails we leave ownerid
        // unset and let Power Automate's default assignment take over.
        const ownerId = params.contactType === 'client'
            ? await this.getContactOwnerId(targetId)
            : await this.getLeadOwnerId(targetId);
        if (ownerId) {
            payload['ownerid@odata.bind'] = `/systemusers(${ownerId})`;
        }

        try {
            const response = await this.crmPost('riivo_requests', payload, targetId);
            const riivoRequestId: string | undefined = response.data?.riivo_requestid;
            console.log(`[Dynamics CRM] Created riivo_request ${riivoRequestId} for ${params.contactType} ${targetId}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'riivo_requests',
                crmRecordId: riivoRequestId,
                action: 'create',
                payload,
                triggeredBy: targetId,
            });
            return riivoRequestId ? { riivo_requestid: riivoRequestId } : null;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create riivo_request:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    /**
     * Patch a riivo_request record with state-transition fields (statecode,
     * statuscode, resolution fields, classification, feedback, escalation).
     * Best-effort — logs and swallows errors so a Dynamics outage doesn't break
     * the Supabase-side case update that preceded it.
     */
    async updateRequest(requestId: string, patch: Record<string, any>): Promise<void> {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!requestId || !guidRegex.test(requestId)) {
            console.warn(`[Dynamics CRM] updateRequest: skipping invalid request id: ${requestId}`);
            return;
        }
        try {
            await this.crmPatch(
                'riivo_requests',
                `${this.baseUrl}/api/data/v9.2/riivo_requests(${requestId})`,
                patch,
                requestId
            );
        } catch (error: any) {
            console.warn(`[Dynamics CRM] updateRequest ${requestId} failed:`, error?.response?.data?.error?.message || error.message);
        }
    }

    /**
     * Resolve any open riivo_requests tagged otp_signup / otp_help for the
     * given lead. Called when the lead taps "Sorted, OTP done" so the records
     * we created off their OTP asks don't linger after the gate is cleared.
     * Best-effort.
     */
    async resolveOpenOtpRequestsForLead(leadId: string): Promise<void> {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!leadId || !guidRegex.test(leadId)) {
            console.warn(`[Dynamics CRM] resolveOpenOtpRequestsForLead: invalid lead id: ${leadId}`);
            return;
        }
        const filter = `_riivo_lead_value eq ${leadId} and statecode eq 0 and (riivo_classificationtopic eq 'otp_signup' or riivo_classificationtopic eq 'otp_help')`;
        const open = await this.getList('riivo_requests', filter, ['riivo_requestid', 'riivo_classificationtopic']);
        if (open.length === 0) return;
        const resolvedAt = new Date().toISOString();
        await Promise.all(open.map(async (row: any) => {
            const id = row.riivo_requestid;
            if (!id) return;
            await this.updateRequest(id, {
                statecode: REQUEST_STATE.INACTIVE,
                statuscode: REQUEST_STATUSCODE.RESOLVED_BY_BOT,
                riivo_clientfeedback: CLIENT_FEEDBACK.CONFIRMED,
                riivo_resolutionmethod: RESOLUTION_METHOD.FEEDBACK_CONFIRMED,
                riivo_resolvedon: resolvedAt,
            });
        }));
        console.log(`[Dynamics CRM] Auto-resolved ${open.length} open OTP request(s) for lead ${leadId}`);
    }

    /**
     * Create a callback request in Dynamics CRM (riivo_requests entity).
     * Power Automate will handle consultant assignment and notifications.
     */
    async createCallbackRequest(
        entity: { id: string; type: 'client' | 'lead' | 'user'; fullname: string } | null,
        phoneNumber: string,
        reason?: string
    ): Promise<boolean> {
        const payload: any = {
            "riivo_clientmobilenumber": phoneNumber,
            "riivo_channel": 1, // WhatsApp channel
            "riivo_description": reason || "Client requested to speak with a consultant via WhatsApp.",
            "riivo_category": 0, // Default category
            "riivo_priority": 1  // Default priority
        };

        // Link to contact (lead/user nav property names need verification)
        if (entity) {
            if (entity.type === 'client') {
                payload['riivo_Client@odata.bind'] = `/contacts(${entity.id})`;
            } else if (entity.type === 'lead') {
                payload['riivo_Lead@odata.bind'] = `/new_leads(${entity.id})`;
            }

            // Inherit the owner from the linked client/lead so the callback
            // request lands with that record's consultant. Best-effort.
            const ownerId = entity.type === 'client'
                ? await this.getContactOwnerId(entity.id)
                : entity.type === 'lead'
                    ? await this.getLeadOwnerId(entity.id)
                    : null;
            if (ownerId) {
                payload['ownerid@odata.bind'] = `/systemusers(${ownerId})`;
            }
        }

        try {
            const triggeredBy = entity?.id || phoneNumber;
            await this.crmPost('riivo_requests', payload, triggeredBy);
            console.log(`[Dynamics CRM] Created callback request for ${phoneNumber}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'riivo_requests',
                action: 'create',
                payload,
                triggeredBy: entity?.id || phoneNumber,
            });
            return true;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create callback request:', error?.response?.data?.error?.message || error.message);
            return false;
        }
    }

    /**
     * Update WhatsApp opt-in/out status for a contact.
     * @param contactId - The contact GUID
     * @param optIn - true to opt in, false to opt out
     */
    async updateWhatsAppOptIn(contactId: string, optIn: boolean): Promise<boolean> {
        try {
            await this.crmPatch('contacts', `${this.baseUrl}/api/data/v9.2/contacts(${contactId})`, { "riivo_whatsappoptinout": optIn }, contactId);
            console.log(`[Dynamics CRM] Updated WhatsApp opt-in for contact ${contactId}: ${optIn}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'contacts',
                crmRecordId: contactId,
                action: 'update',
                payload: { riivo_whatsappoptinout: optIn },
                triggeredBy: contactId,
            });
            return true;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to update WhatsApp opt-in:', error?.response?.data?.error?.message || error.message);
            return false;
        }
    }

    // --- Task Types cache ---
    private taskTypesCache: { id: string; name: string }[] | null = null;

    async getTaskTypes(): Promise<{ id: string; name: string }[]> {
        if (this.taskTypesCache) return this.taskTypesCache;

        const token = await this.getToken();
        try {
            const url = `${this.baseUrl}/api/data/v9.2/riivo_tasktypes?$select=riivo_tasktypeid,riivo_name&$orderby=riivo_name&$top=50`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });
            this.taskTypesCache = (response.data.value || []).map((t: any) => ({
                id: t.riivo_tasktypeid,
                name: t.riivo_name,
            }));
            return this.taskTypesCache!;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to fetch task types:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    async createTask(params: {
        regardingId: string;
        regardingType: 'contact' | 'lead';
        taskTypeId: string;
        taskTypeName: string;
        taxYear: number;
        primaryRepId: string;
        description?: string;
    }): Promise<{ success: boolean; taskId?: string; error?: string }> {
        const now = new Date();
        const subject = `${params.taskTypeName} - ${now.toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`;

        const taxYearValue = 463630000 + (params.taxYear - 2015);

        const payload: any = {
            subject,
            riivo_taxyear: taxYearValue,
            prioritycode: 1,
        };

        if (params.description) {
            payload.description = params.description;
        }

        // Bind regarding object
        if (params.regardingType === 'contact') {
            payload['regardingobjectid_contact_task@odata.bind'] = `/contacts(${params.regardingId})`;
        } else {
            payload['regardingobjectid_new_lead_task@odata.bind'] = `/new_leads(${params.regardingId})`;
        }

        // Bind task type
        payload['riivo_TaskType_Task@odata.bind'] = `/riivo_tasktypes(${params.taskTypeId})`;

        // Bind primary representative
        payload['riivo_PrimaryRepresentative_Task@odata.bind'] = `/systemusers(${params.primaryRepId})`;

        try {
            console.log(`[Dynamics CRM] createTask payload:`, JSON.stringify(payload, null, 2));
            const response = await this.crmPost('tasks', payload, params.primaryRepId);
            const taskId = response.data?.activityid;
            console.log(`[Dynamics CRM] Created task "${subject}" (${taskId})`);
            await supabaseService.logCrmWrite({
                crmEntity: 'tasks',
                crmRecordId: taskId,
                action: 'create',
                payload,
                triggeredBy: params.primaryRepId,
            });
            return { success: true, taskId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            const fullError = error?.response?.data?.error || error.message;
            console.error('[Dynamics CRM] Failed to create task:', errMsg);
            console.error('[Dynamics CRM] Full error:', JSON.stringify(fullError));
            console.error('[Dynamics CRM] Payload was:', JSON.stringify(payload, null, 2));
            return { success: false, error: errMsg };
        }
    }

    async searchLeadByName(name: string, ownerId?: string): Promise<any[]> {
        const token = await this.getToken();
        try {
            // Lead has no computed fullname field (unlike Contact), so a single
            // contains() against firstname OR lastname misses anything where the
            // staff member typed both names. Split on whitespace and AND each
            // token's (firstname OR lastname) clause together so "Rosie Brouckaert"
            // matches a lead with firstname=Rosie, lastname=Brouckaert.
            const tokens = name.trim().split(/\s+/).filter(Boolean);
            const tokenClauses = tokens.map(tok => {
                const safe = tok.replace(/'/g, "''");
                return `(contains(ttt_firstname,'${safe}') or contains(ttt_lastname,'${safe}'))`;
            });
            // Scope to the caller's own leads when ownerId is provided (staff flow).
            // Matches the behaviour of searchContactByName so staff-driven searches
            // consistently return "my leads" instead of the whole org's pipeline.
            const ownerClause = ownerId ? ` and _ownerid_value eq ${ownerId}` : '';
            const filter = `${tokenClauses.join(' and ')} and statecode eq 0${ownerClause}`;
            const url = `${this.baseUrl}/api/data/v9.2/new_leads?$filter=${encodeURIComponent(filter)}&$select=new_leadid,ttt_firstname,ttt_lastname,ttt_mobilephone&$top=5`;
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });
            return (response.data.value || []).map((l: any) => ({
                new_leadid: l.new_leadid,
                fullname: `${l.ttt_firstname || ''} ${l.ttt_lastname || ''}`.trim(),
                mobilephone: l.ttt_mobilephone,
            }));
        } catch (error: any) {
            console.error('[Dynamics CRM] Lead name search failed:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    async getRecentMessages(contactId: string, limit: number = 10): Promise<{ role: 'user' | 'assistant', content: string }[]> {
        const token = await this.getToken();

        // Filter for last 24 hours
        const yesterday = new Date();
        yesterday.setHours(yesterday.getHours() - 24);
        const dateFilter = yesterday.toISOString();

        try {
            // Determine if contactId is contact or lead (we might need to check both or assume contact for now based on usage)
            // Ideally we'd filter by _regardingobjectid_value but OData makes that tricky with polymorphism.
            // Simplified approach: Filter by contact link if we know it's a contact.

            // NOTE: The previous logMessage uses 'regardingobjectid_contact' bind. 
            // So we look for _regardingobjectid_value matching contactId.
            // Use standard OData filter for createdon > 24h ago.

            const filter = `_regardingobjectid_value eq ${contactId} and createdon gt ${dateFilter}`;

            const messages = await this.getList(
                'riivo_whatsappcommunicationses',
                filter,
                ['description', 'riivo_messagedirection', 'createdon']
            );

            // Map to ChatMessage format
            // riivo_messagedirection: 463630000 = Incoming (User), 463630001 = Outgoing (Bot)
            return messages.map(msg => ({
                role: (msg.riivo_messagedirection === 463630000 ? 'user' : 'assistant') as 'user' | 'assistant',
                content: msg.description || ''
            })).reverse(); // Reverse to have oldest first for Claude context

        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to fetch recent messages:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }

    /**
     * Fetch all active internal staff members from Dynamics.
     * Used by the sync script to populate the Supabase users table.
     * Returns only enabled (non-disabled) non-application users.
     */
    async getSystemUsers(): Promise<{ systemuserid: string; fullname: string; mobilephone: string | null; internalemailaddress: string | null }[]> {
        const token = await this.getToken();
        const results: any[] = [];
        // OData $filter: isdisabled eq false excludes deactivated accounts;
        // applicationid eq null excludes service principals / app users.
        let url: string | null = `${this.baseUrl}/api/data/v9.2/systemusers?$select=systemuserid,fullname,mobilephone,internalemailaddress&$filter=isdisabled eq false and applicationid eq null&$top=500`;

        try {
            while (url) {
                const response: any = await axios.get(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Prefer': 'odata.maxpagesize=500'
                    }
                });
                if (response.data.value) results.push(...response.data.value);
                url = response.data['@odata.nextLink'] || null;
            }
            return results;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to fetch system users:', error?.response?.data?.error?.message || error.message);
            throw error;
        }
    }
}

export const dynamicsService = new DynamicsService();
