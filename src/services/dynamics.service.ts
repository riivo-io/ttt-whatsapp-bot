import axios from 'axios';
import * as msal from '@azure/msal-node';
import dotenv from 'dotenv';
import { CrmEntity } from '../types/crm.types';
import { supabaseService } from './supabase.service';

dotenv.config();

// Define CrmEntity locally if not imported, or ensure import is correct.
// Based on previous file content, it was defined locally.
export interface LocalCrmEntity {
    id: string;
    type: 'client' | 'lead' | 'user';
    fullname: string;
}

const AUDIT_FIELDS = ['ttt_ai_triggered_by', 'ttt_ai_model', 'ttt_ai_generated_at'];

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

    async searchContactByName(name: string): Promise<any[]> {
        const token = await this.getToken();
        try {
            const filter = `contains(fullname,'${name}') and statecode eq 0`;
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
    }): Promise<any | null> {
        const payload: any = {
            'ttt_firstname': params.firstName,
            'ttt_lastname': params.lastName,
        };
        if (params.phone) payload['ttt_mobilephone'] = params.phone;
        if (params.email) payload['ttt_email'] = params.email;
        if (params.department) payload['riivo_requestedservice'] = params.department;
        if (params.notes) payload['riivo_notes'] = params.notes;

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

    async searchLeadByName(name: string): Promise<any[]> {
        const token = await this.getToken();
        try {
            const filter = `contains(ttt_firstname,'${name}') or contains(ttt_lastname,'${name}')`;
            const url = `${this.baseUrl}/api/data/v9.2/new_leads?$filter=${encodeURIComponent(filter + " and statecode eq 0")}&$select=new_leadid,ttt_firstname,ttt_lastname,ttt_mobilephone&$top=5`;
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
}

export const dynamicsService = new DynamicsService();
