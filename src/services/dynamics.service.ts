import axios from 'axios';
import * as msal from '@azure/msal-node';
import dotenv from 'dotenv';
import { CrmEntity } from '../types/crm.types';
import { supabaseService } from './supabase.service';
// mistralService and loeExtractorService are no longer called from dynamics.service
// — OCR + extraction now happen in the openai.service handler, and confirmed
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

// Boolean field on the new_lead entity indicating a signed Letter of
// Engagement has been received. Schema name in Dynamics is riivo_LoEReceived;
// the Web API uses the lowercased logical name.
const LEAD_LOE_RECEIVED_FIELD = 'riivo_loereceived';

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
            ttt_ai_model: 'gpt-4o-mini',
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
            ['new_invoicesid', 'new_name', 'riivo_totalinclvat', 'statecode', 'statuscode']
        );
    }

    async getInvoiceByNumber(invoiceNumber: string): Promise<any | null> {
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
                return response.data.value[0];
            }
            return null;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to get invoice:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    async getClientCases(contactId: string): Promise<any[]> {
        return this.getList(
            'new_cases',
            `_ttt_clientname_value eq ${contactId}`,
            ['new_name', 'icon_caseprocess', 'icon_casestage', 'statecode', 'createdon']
        );
    }

    async getStaffCases(userId: string): Promise<any[]> {
        return this.getList(
            'new_cases',
            `_ownerid_value eq ${userId} and statecode eq 0`,
            ['new_name', 'icon_caseprocess', 'icon_casestage', 'statecode', 'createdon', '_ttt_clientname_value']
        );
    }

    async getContactByPhone(phoneNumber: string): Promise<any | null> {
        // Search ALL tables in parallel to detect duplicates and pick the right role
        const [contact, lead, user] = await Promise.all([
            this.searchEntity(
                'contacts',
                `mobilephone eq '${phoneNumber}' and statecode eq 0`,
                ['contactid', 'fullname', 'riivo_whatsappoptinout']
            ),
            this.searchEntity(
                'new_leads',
                `ttt_mobilephone eq '${phoneNumber}' and statecode eq 0`,
                ['new_leadid', 'ttt_firstname', 'ttt_lastname']
            ),
            this.searchEntity(
                'systemusers',
                `mobilephone eq '${phoneNumber}'`,
                ['systemuserid', 'fullname']
            ),
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
                fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim()
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
                `mobilephone eq '${phoneNumber}' and statecode eq 0`,
                ['contactid', 'fullname', 'riivo_whatsappoptinout']
            );
            if (contact) return { id: contact.contactid, type: 'client', fullname: contact.fullname, optIn: contact.riivo_whatsappoptinout };
        } else if (type === 'lead') {
            const lead = await this.searchEntity(
                'new_leads',
                `ttt_mobilephone eq '${phoneNumber}' and statecode eq 0`,
                ['new_leadid', 'ttt_firstname', 'ttt_lastname']
            );
            if (lead) return { id: lead.new_leadid, type: 'lead', fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim() };
        } else if (type === 'user') {
            const user = await this.searchEntity(
                'systemusers',
                `mobilephone eq '${phoneNumber}'`,
                ['systemuserid', 'fullname']
            );
            if (user) return { id: user.systemuserid, type: 'user', fullname: user.fullname };
        }
        return null;
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
                    ['new_leadid', 'ttt_firstname', 'ttt_lastname']
                );
                if (lead) {
                    return { id: lead.new_leadid, type: 'lead', fullname: `${lead.ttt_firstname || ''} ${lead.ttt_lastname || ''}`.trim() };
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

    async getContactTaxNumber(contactId: string): Promise<string | null> {
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['ttt_taxnumber']
        );
        return contact ? contact.ttt_taxnumber : null;
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
        industryId?: string;        // riivo_industries GUID for riivo_Industry_lookup
        ownerSystemUserId?: string; // systemuser GUID for ownerid
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
        if (params.industryId) payload['riivo_Industry_lookup@odata.bind'] = `/riivo_industries(${params.industryId})`;
        if (params.ownerSystemUserId) payload['ownerid@odata.bind'] = `/systemusers(${params.ownerSystemUserId})`;

        try {
            const triggeredBy = params.referredByContactId || params.phone || 'unknown';
            const response = await this.crmPost('new_leads', payload, triggeredBy);
            console.log(`[Dynamics CRM] Created lead: ${params.firstName} ${params.lastName}`);
            await supabaseService.logCrmWrite({
                crmEntity: 'new_leads',
                crmRecordId: response.data?.new_leadid,
                action: 'create',
                payload,
                triggeredBy: params.referredByContactId || params.phone || 'unknown',
            });
            return response.data;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create lead:', error?.response?.data?.error?.message || error.message);
            return null;
        }
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
        phoneNumber: string
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

        if (entity) {
            if (entity.type === 'client') {
                payload['regardingobjectid_contact@odata.bind'] = `/contacts(${entity.id})`;
            } else if (entity.type === 'lead') {
                payload['regardingobjectid_new_lead@odata.bind'] = `/new_leads(${entity.id})`;
            }
        }

        try {
            await this.crmPost('riivo_whatsappcommunicationses', payload, entity?.id || phoneNumber);
            console.log(`[Dynamics CRM] Logged ${direction} message for ${phoneNumber}`);
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

    /**
     * Log an "invoice PDF sent via WhatsApp" annotation to a Contact's timeline.
     * Separate from uploadDocument because we're not attaching a file here —
     * the PDF itself lives in Meta's media store; the timeline note is just
     * the audit record that the send happened. Audit fields are added
     * automatically by crmPost via addAuditFields.
     */
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
            })).reverse(); // Reverse to have oldest first for OpenAI context

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
