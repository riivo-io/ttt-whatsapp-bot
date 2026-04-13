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

export class DynamicsService {
    private cca: msal.ConfidentialClientApplication;
    private baseUrl: string;
    private accessToken: string | null = null;
    private tokenExpiry: number = 0;

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
        } catch (error) {
            console.error(`Error searching ${collection}:`, error);
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
            // TODO: Add icon_caseprocess and ttt_taxyear once we know the correct option set values
        };

        // If your CRM has a dedicated priority field on new_cases, add it here:
        // payload['riivo_priority'] = priorityMap[priority] ?? 757710001;

        try {
            // Step 1: Create the case without the client lookup
            const response = await axios.post(
                `${this.baseUrl}/api/data/v9.2/new_cases`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation'
                    }
                }
            );
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

    async getContactTaxNumber(contactId: string): Promise<string | null> {
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['ttt_taxnumber']
        );
        return contact ? contact.ttt_taxnumber : null;
    }

    async logMessage(
        entity: any | null,
        messageContent: string,
        direction: 'Incoming' | 'Outgoing',
        phoneNumber: string
    ): Promise<void> {
        const token = await this.getToken();
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
                // Lead binding — skip if nav property name is unknown
                // TODO: verify the correct navigation property name for leads on riivo_whatsappcommunicationses
                console.log(`[Dynamics CRM] Skipping regarding-object bind for lead (nav property unknown)`);
            }
            // For 'user' (staff) — no regarding-object binding needed
        }

        try {
            await axios.post(
                `${this.baseUrl}/api/data/v9.2/riivo_whatsappcommunicationses`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation'
                    }
                }
            );
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

        const token = await this.getToken();
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
            console.log(`[Dynamics CRM] Skipping document link for lead (nav property unknown)`);
        }

        try {
            await axios.post(
                `${this.baseUrl}/api/data/v9.2/annotations`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
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
        const token = await this.getToken();

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
                console.log(`[Dynamics CRM] Skipping callback link for lead (nav property unknown)`);
            }
        }

        try {
            await axios.post(
                `${this.baseUrl}/api/data/v9.2/riivo_requests`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation'
                    }
                }
            );
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
        const token = await this.getToken();

        try {
            await axios.patch(
                `${this.baseUrl}/api/data/v9.2/contacts(${contactId})`,
                {
                    "riivo_whatsappoptinout": optIn
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            );
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
