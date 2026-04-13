"use node";
import * as msal from '@azure/msal-node';
import axios from 'axios';
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Access token caching variables (global scope in Node action)
let accessToken: string | null = null;
let tokenExpiry: number = 0;

const getConfig = () => {
    if (!process.env.DYNAMICS_CLIENT_ID || !process.env.DYNAMICS_CLIENT_SECRET || !process.env.DYNAMICS_TENANT_ID || !process.env.DYNAMICS_URL) {
        throw new Error('Missing Dynamics CRM configuration in env vars');
    }
    return {
        clientId: process.env.DYNAMICS_CLIENT_ID,
        clientSecret: process.env.DYNAMICS_CLIENT_SECRET,
        tenantId: process.env.DYNAMICS_TENANT_ID,
        baseUrl: process.env.DYNAMICS_URL.replace(/\/$/, '')
    };
};

const getToken = async () => {
    if (accessToken && Date.now() < tokenExpiry) {
        return accessToken;
    }

    const config = getConfig();
    const msalConfig = {
        auth: {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            authority: `https://login.microsoftonline.com/${config.tenantId}`,
        }
    };

    const cca = new msal.ConfidentialClientApplication(msalConfig);
    const clientCredentialRequest = {
        scopes: [`${config.baseUrl}/.default`],
    };

    const response = await cca.acquireTokenByClientCredential(clientCredentialRequest);

    if (!response || !response.accessToken) {
        throw new Error('Failed to acquire access token');
    }

    accessToken = response.accessToken;
    tokenExpiry = response.expiresOn ? response.expiresOn.getTime() : Date.now() + 55 * 60 * 1000;

    return accessToken;
};

// Helper for axios requests
const dynamicsRequest = async (method: 'GET' | 'POST' | 'PATCH', endpoint: string, data?: any) => {
    const token = await getToken();
    const config = getConfig();
    const url = `${config.baseUrl}/api/data/v9.2/${endpoint}`;

    try {
        const response = await axios({
            method,
            url,
            data,
            headers: {
                'Authorization': `Bearer ${token}`,
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Prefer': 'return=representation,odata.include-annotations="*"'
            }
        });
        return response.data;
    } catch (error: any) {
        console.error(`Dynamics ${method} ${endpoint} failed:`, error?.response?.data || error.message);
        return null;
    }
};

export const getContactByPhone = internalAction({
    args: { phoneNumber: v.string() },
    handler: async (ctx, args) => {
        // 1. Prepare Phone Number Formats
        const original = args.phoneNumber; // e.g. 27832852913
        let localFormat = original;

        if (original.startsWith('27')) {
            localFormat = '0' + original.substring(2); // 0787133880
        } else if (original.startsWith('+27')) {
            localFormat = '0' + original.substring(3); // 0787133880
        }

        // Remove spaces just in case
        const cleanOriginal = original.replace(/\s/g, '');
        const cleanLocal = localFormat.replace(/\s/g, '');

        console.log(`[Dynamics] Searching for Contact: ${cleanOriginal} OR ${cleanLocal}`);

        // 2. Search Contacts (Try both formats)
        const contactFilter = `(mobilephone eq '${cleanOriginal}' or mobilephone eq '${cleanLocal}') and statecode eq 0`;
        const contactQuery = `contacts?$filter=${encodeURIComponent(contactFilter)}&$select=contactid,fullname,riivo_whatsappoptinout&$top=1`;

        try {
            const contactRes = await dynamicsRequest('GET', contactQuery);
            if (contactRes?.value?.length > 0) {
                const c = contactRes.value[0];
                console.log(`[Dynamics] Found Contact: ${c.fullname}`);
                return {
                    id: c.contactid,
                    type: 'contact',
                    fullname: c.fullname,
                    optIn: c.riivo_whatsappoptinout
                };
            }
        } catch (e: any) {
            console.error(`[Dynamics] Contact search failed:`, e?.response?.data || e.message);
        }

        // 3. Search Leads (Try both formats)
        const leadFilter = `(ttt_mobilephone eq '${cleanOriginal}' or ttt_mobilephone eq '${cleanLocal}') and statecode eq 0`;
        const leadQuery = `leads?$filter=${encodeURIComponent(leadFilter)}&$select=leadid,fullname&$top=1`;

        try {
            const leadRes = await dynamicsRequest('GET', leadQuery);
            if (leadRes?.value?.length > 0) {
                const l = leadRes.value[0];
                console.log(`[Dynamics] Found Lead: ${l.fullname}`);
                return {
                    id: l.leadid,
                    type: 'lead',
                    fullname: l.fullname,
                    optIn: false
                };
            }
        } catch (e: any) {
            // If leads endpoint doesn't exist or other error, just log and return null
            console.warn(`[Dynamics] Lead search failed (ignoring):`, e?.response?.data || e.message);
        }

        console.log(`[Dynamics] No Contact or Lead found for ${args.phoneNumber}`);
        return null;
    },
});

export const updateWhatsAppOptIn = internalAction({
    args: { contactId: v.string(), optIn: v.boolean() },
    handler: async (ctx, args) => {
        const res = await dynamicsRequest('PATCH', `contacts(${args.contactId})`, {
            "riivo_whatsappoptinout": args.optIn
        });
        return res !== null; // axios returns data on success, null on our catch
    },
});

export const logMessage = internalAction({
    args: {
        contactId: v.optional(v.string()),
        entityType: v.optional(v.string()), // 'contact' or 'lead'
        messageContent: v.string(),
        direction: v.string(), // 'Incoming' or 'Outgoing'
        phoneNumber: v.string()
    },
    handler: async (ctx, args) => {
        const directionValue = args.direction === 'Incoming' ? 463630000 : 463630001;
        const payload: any = {
            "subject": `WhatsApp ${args.direction}: ${args.phoneNumber}`,
            "description": args.messageContent,
            "riivo_messagedirection": directionValue,
            "riivo_from": args.direction === 'Incoming' ? args.phoneNumber : 'Bot',
            "riivo_to": args.direction === 'Incoming' ? 'Bot' : args.phoneNumber,
            "riivo_timestamp": new Date().toISOString()
        };

        if (args.contactId && args.entityType) {
            if (args.entityType === 'contact') {
                payload['regardingobjectid_contact@odata.bind'] = `/contacts(${args.contactId})`;
            } else if (args.entityType === 'lead') {
                payload['regardingobjectid_lead@odata.bind'] = `/leads(${args.contactId})`;
            }
        }

        await dynamicsRequest('POST', 'riivo_whatsappcommunicationses', payload);
    },
});

export const getRecentMessages = internalAction({
    args: { contactId: v.string() },
    handler: async (ctx, args) => {
        const yesterday = new Date();
        yesterday.setHours(yesterday.getHours() - 24);
        const dateFilter = yesterday.toISOString();

        // Filter by regarding object
        const filter = `_regardingobjectid_value eq ${args.contactId} and createdon gt ${dateFilter}`;
        const query = `riivo_whatsappcommunicationses?$filter=${encodeURIComponent(filter)}&$select=description,riivo_messagedirection,createdon&$orderby=createdon desc&$top=10`;

        const res = await dynamicsRequest('GET', query);
        const messages = res?.value || [];

        return messages.map((msg: any) => ({
            role: msg.riivo_messagedirection === 463630000 ? 'user' : 'assistant',
            content: msg.description || ''
        })).reverse();
    },
});

export const getClientInvoices = internalAction({
    args: { contactId: v.string() },
    handler: async (ctx, args) => {
        const query = `new_invoiceses?$filter=_ttt_customer_value eq ${args.contactId}&$select=new_invoicesid,new_name,riivo_totalinclvat,statecode,statuscode&$orderby=createdon desc&$top=5`;
        const res = await dynamicsRequest('GET', query);
        return res?.value || [];
    },
});

export const getClientCases = internalAction({
    args: { contactId: v.string() },
    handler: async (ctx, args) => {
        const query = `new_cases?$filter=_ttt_clientname_value eq ${args.contactId}&$select=new_name,icon_caseprocess,icon_casestage,statecode,createdon&$orderby=createdon desc&$top=5`;
        const res = await dynamicsRequest('GET', query);
        return res?.value || [];
    },
});

export const getInvoiceByNumber = internalAction({
    args: { invoiceNumber: v.string() },
    handler: async (ctx, args) => {
        // Only fetching minimal fields for demo response generation
        const selectFields = [
            'new_name', 'createdon', 'riivo_totalinclvat', 'riivo_customerfullname'
        ].join(',');

        const query = `new_invoiceses?$filter=contains(new_name,'${args.invoiceNumber}')&$select=${selectFields}&$top=1`;
        const res = await dynamicsRequest('GET', query);
        return res?.value?.[0] || null;
    },
});

export const createCallbackRequest = internalAction({
    args: {
        contactId: v.string(),
        entityType: v.string(),
        phoneNumber: v.string(),
        reason: v.optional(v.string())
    },
    handler: async (ctx, args) => {
        const payload: any = {
            "riivo_clientmobilenumber": args.phoneNumber,
            "riivo_channel": 1,
            "riivo_description": args.reason || "Client WhatsApp Callback Request",
            "riivo_category": 0,
            "riivo_priority": 1
        };

        if (args.entityType === 'contact') {
            payload['riivo_Client@odata.bind'] = `/contacts(${args.contactId})`;
        } else {
            payload['riivo_Lead@odata.bind'] = `/leads(${args.contactId})`;
        }

        const res = await dynamicsRequest('POST', 'riivo_requests', payload);
        return res !== null;
    },
});

export const getContactTaxNumber = internalAction({
    args: { contactId: v.string() },
    handler: async (ctx, args) => {
        const query = `contacts(${args.contactId})?$select=ttt_taxnumber`;
        const res = await dynamicsRequest('GET', query);
        return res?.ttt_taxnumber || null;
    },
});

export const sendWhatsAppMessage = internalAction({
    args: { to: v.string(), message: v.string() },
    handler: async (ctx, args) => {
        const token = process.env.META_WHATSAPP_TOKEN;
        const phoneNumberId = process.env.META_PHONE_NUMBER_ID;

        if (!token || !phoneNumberId) {
            console.error("Meta configuration missing");
            return;
        }

        try {
            await axios.post(
                `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: args.to,
                    type: 'text',
                    text: { body: args.message }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`[Meta] Sent reply to ${args.to}`);
        } catch (error: any) {
            console.error('[Meta] Failed to send message:', error?.response?.data || error.message);
        }
    },
});

export const uploadDocument = internalAction({
    args: {
        contactId: v.string(),
        entityType: v.string(),
        fileName: v.string(),
        mimeType: v.string(),
        base64Content: v.string()
    },
    handler: async (ctx, args) => {
        const payload: any = {
            "subject": `WhatsApp Document: ${args.fileName}`,
            "filename": args.fileName,
            "mimetype": args.mimeType,
            "documentbody": args.base64Content,
            "notetext": "Document received via WhatsApp Bot."
        };

        if (args.entityType === 'contact') {
            payload['objectid_contact@odata.bind'] = `/contacts(${args.contactId})`;
            payload['objecttypecode'] = 'contact';
        } else {
            payload['objectid_lead@odata.bind'] = `/leads(${args.contactId})`;
            payload['objecttypecode'] = 'lead';
        }

        const res = await dynamicsRequest('POST', 'annotations', payload);
        if (res !== null) {
            console.log(`[Dynamics CRM] Uploaded document ${args.fileName} to ${args.entityType} ${args.contactId}`);
            return true;
        }
        return false;
    },
});

export const getMetaMediaUrl = internalAction({
    args: { mediaId: v.string() },
    handler: async (ctx, args) => {
        const token = process.env.META_WHATSAPP_TOKEN;
        if (!token) return null;

        try {
            // 1. Get URL
            const res = await axios.get(`https://graph.facebook.com/v19.0/${args.mediaId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const mediaUrl = res.data.url;

            // 2. Download File
            const fileRes = await axios.get(mediaUrl, {
                headers: { 'Authorization': `Bearer ${token}` },
                responseType: 'arraybuffer'
            });

            return {
                buffer: Buffer.from(fileRes.data).toString('base64'),
                mimeType: fileRes.headers['content-type']
            };
        } catch (error: any) {
            console.error('[Meta] Failed to download media:', error?.response?.data || error.message);
            return null;
        }
    }
});
