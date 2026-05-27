import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';
import { getActivePhoneNumberId } from '../utils/messageContext';

console.log('[boot] meta.service: imports done');
dotenv.config();
console.log('[boot] meta.service: dotenv configured');

/**
 * Strip characters that break WhatsApp's bold parser. Models frequently emit
 * `•⁠  ⁠*Label:*` (Unicode bullet + word-joiner + asterisks) even when the
 * system prompt forbids it — the invisible word-joiner sits between the space
 * and the `*`, so WhatsApp treats the `*` as literal text instead of bold
 * markup. Post-processing here is more reliable than prompt-level rules.
 */
function sanitizeForWhatsApp(text: string): string {
    if (!text) return text;
    return text
        // Zero-width / invisible joiners that sit between whitespace and *
        .replace(/[\u2060\u200B\u200C\u200D\uFEFF]/g, '')
        // Unicode bullet glyphs → plain hyphen so WhatsApp's bold parser works
        .replace(/^[ \t]*[•◦▪▫‣⁃]\s*/gm, '- ');
}

export class MetaWhatsAppService {
    private token: string;
    private phoneNumberId: string;
    private baseUrl: string = 'https://graph.facebook.com/v22.0';

    constructor() {
        this.token = process.env.META_WHATSAPP_TOKEN || '';
        this.phoneNumberId = process.env.META_PHONE_NUMBER_ID || '';

        if (!this.token || !this.phoneNumberId) {
            console.warn('Meta WhatsApp configuration missing (META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID)');
        }
    }

    /**
     * Pick the phone number id to use for an outbound call: the one the user
     * messaged us on (set in async context by the webhook controller), or the
     * env var fallback for code paths that don't have a webhook context (cron,
     * email relay, scripts).
     */
    private activePhoneNumberId(): string {
        return getActivePhoneNumberId() || this.phoneNumberId;
    }

    async sendMessage(to: string, message: string): Promise<void> {
        if (!this.token || !this.phoneNumberId) {
            console.error('Cannot send message: Meta configuration missing');
            return;
        }

        const cleaned = sanitizeForWhatsApp(message);

        try {
            const url = `${this.baseUrl}/${this.activePhoneNumberId()}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to,
                type: 'text',
                text: {
                    body: cleaned
                }
            };

            await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log(`[Meta WhatsApp] Sent message to ${to}`);
        } catch (error: any) {
            console.error('[Meta WhatsApp] Failed to send message:', error?.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send a pre-approved WhatsApp template. Supports body-variable substitution
     * and per-button payload customization for quick-reply buttons.
     *
     * Use this for outbound messages outside the 24-hour customer-service
     * window, or to open a conversation when the customer hasn't yet messaged
     * us (e.g. the email-relay consent prompt — the email arrived through a
     * different channel, so on the WhatsApp side this is a fresh outbound).
     */
    async sendTemplate(
        to: string,
        params: {
            name: string;
            languageCode: string;
            headerImageLink?: string;
            bodyVariables?: string[];
            bodyNamedVariables?: Record<string, string>;
            buttonPayloads?: { index: number; payload: string }[];
            flowButton?: { index: number; flowActionData?: Record<string, any> };
        }
    ): Promise<{ delivered: boolean; messageId?: string; error?: string }> {
        if (!this.token || !this.phoneNumberId) {
            console.error('Cannot send template: Meta configuration missing');
            return { delivered: false, error: 'Meta configuration missing' };
        }

        const components: any[] = [];
        // Image header — Meta requires this when the template was defined
        // with an image header type. The `link` must be a public HTTPS URL
        // Meta's servers can fetch (we use an Azure blob).
        if (params.headerImageLink) {
            components.push({
                type: 'header',
                parameters: [{ type: 'image', image: { link: params.headerImageLink } }],
            });
        }
        // Named parameters take precedence — Meta rejects the send if the
        // template was defined with named vars ({{customer_name}}) but the
        // request omits parameter_name (or vice-versa).
        if (params.bodyNamedVariables && Object.keys(params.bodyNamedVariables).length > 0) {
            components.push({
                type: 'body',
                parameters: Object.entries(params.bodyNamedVariables).map(([name, text]) => ({
                    type: 'text',
                    parameter_name: name,
                    text,
                })),
            });
        } else if (params.bodyVariables && params.bodyVariables.length > 0) {
            components.push({
                type: 'body',
                parameters: params.bodyVariables.map(v => ({ type: 'text', text: v })),
            });
        }
        if (params.buttonPayloads) {
            for (const btn of params.buttonPayloads) {
                components.push({
                    type: 'button',
                    sub_type: 'quick_reply',
                    index: String(btn.index),
                    parameters: [{ type: 'payload', payload: btn.payload }],
                });
            }
        }
        if (params.flowButton) {
            const flowToken = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            components.push({
                type: 'button',
                sub_type: 'flow',
                index: String(params.flowButton.index),
                parameters: [{
                    type: 'action',
                    action: {
                        flow_token: flowToken,
                        ...(params.flowButton.flowActionData ? { flow_action_data: params.flowButton.flowActionData } : {}),
                    },
                }],
            });
        }

        try {
            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'template',
                template: {
                    name: params.name,
                    language: { code: params.languageCode },
                    ...(components.length > 0 ? { components } : {}),
                },
            };
            const res = await axios.post(`${this.baseUrl}/${this.activePhoneNumberId()}/messages`, payload, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
            });
            const messageId: string | undefined = res.data?.messages?.[0]?.id;
            console.log(`[Meta WhatsApp] Sent template "${params.name}" to ${to} (message ${messageId})`);
            return { delivered: true, messageId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error('[Meta WhatsApp] Failed to send template:', error?.response?.data || error.message);
            return { delivered: false, error: errMsg };
        }
    }

    async sendReplyButtons(to: string, text: string, buttons: { id: string; title: string }[]): Promise<void> {
        if (!this.token || !this.phoneNumberId) {
            console.error('Cannot send buttons: Meta configuration missing');
            return;
        }

        const formattedButtons = buttons.slice(0, 3).map(btn => ({
            type: "reply",
            reply: {
                id: btn.id,
                title: btn.title
            }
        }));

        try {
            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: {
                        text: sanitizeForWhatsApp(text)
                    },
                    action: {
                        buttons: formattedButtons
                    }
                }
            };

            await axios.post(`${this.baseUrl}/${this.activePhoneNumberId()}/messages`, payload, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[Meta WhatsApp] Sent buttons to ${to}`);
        } catch (error: any) {
            console.error('[Meta WhatsApp] Failed to send buttons:', error?.response?.data || error.message);
        }
    }

    /**
     * Send a PDF (or other document) as a WhatsApp document message.
     *
     * Two-step Meta Cloud API flow:
     *   1. POST multipart to /{phoneNumberId}/media with the file → get a media_id
     *   2. POST JSON to /{phoneNumberId}/messages with type=document + media_id
     *
     * If Meta creds are missing (empty token or phone number id), the call drops
     * into DRY-RUN mode: it logs what would have happened and returns a stub
     * result. This lets the rest of the application flow (permission gating,
     * CRM timeline write, audit fields, staff-facing confirmation) be exercised
     * end-to-end without actually needing a live Meta setup.
     */
    async sendDocument(
        to: string,
        pdfBuffer: Buffer,
        fileName: string,
        caption?: string
    ): Promise<{ delivered: boolean; dryRun: boolean; messageId?: string; error?: string }> {
        if (!this.token || !this.phoneNumberId) {
            console.log(`[Meta WhatsApp] DRY RUN: would have sent ${fileName} (${pdfBuffer.length} bytes) to ${to}${caption ? ` with caption "${caption}"` : ''}`);
            return { delivered: false, dryRun: true };
        }

        try {
            // Step 1: upload the PDF as a media asset
            const uploadForm = new FormData();
            uploadForm.append('messaging_product', 'whatsapp');
            uploadForm.append('type', 'application/pdf');
            uploadForm.append('file', pdfBuffer, { filename: fileName, contentType: 'application/pdf' });

            const uploadRes = await axios.post(
                `${this.baseUrl}/${this.activePhoneNumberId()}/media`,
                uploadForm,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        ...uploadForm.getHeaders(),
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                }
            );

            const mediaId: string | undefined = uploadRes.data?.id;
            if (!mediaId) {
                throw new Error('Meta media upload returned no id');
            }

            // Step 2: send the document message referencing the uploaded media
            const messagePayload: any = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'document',
                document: {
                    id: mediaId,
                    filename: fileName,
                    ...(caption ? { caption } : {}),
                },
            };

            const sendRes = await axios.post(
                `${this.baseUrl}/${this.activePhoneNumberId()}/messages`,
                messagePayload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            const messageId: string | undefined = sendRes.data?.messages?.[0]?.id;
            console.log(`[Meta WhatsApp] Sent document ${fileName} to ${to} (message ${messageId})`);
            return { delivered: true, dryRun: false, messageId };
        } catch (error: any) {
            const errMsg = error?.response?.data?.error?.message || error.message;
            console.error('[Meta WhatsApp] Failed to send document:', errMsg);
            return { delivered: false, dryRun: false, error: errMsg };
        }
    }

    async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
        if (!this.token) {
            throw new Error('Cannot download media: META_WHATSAPP_TOKEN missing');
        }

        const metaRes = await axios.get(`${this.baseUrl}/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${this.token}` },
        });

        const downloadUrl: string | undefined = metaRes.data?.url;
        const mimeType: string = metaRes.data?.mime_type || 'application/octet-stream';
        if (!downloadUrl) throw new Error('Meta media lookup returned no url');

        const fileRes = await axios.get(downloadUrl, {
            headers: { 'Authorization': `Bearer ${this.token}` },
            responseType: 'arraybuffer',
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        return { buffer: Buffer.from(fileRes.data), mimeType };
    }

    async sendFlow(
        to: string,
        params: {
            flowId: string;
            flowCta: string;
            body: string;
            header?: string;
            footer?: string;
            firstScreen: string;
            flowToken?: string;
        }
    ): Promise<void> {
        if (!this.token || !this.phoneNumberId) {
            console.error('Cannot send flow: Meta configuration missing');
            return;
        }

        const payload: any = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'flow',
                body: { text: sanitizeForWhatsApp(params.body) },
                action: {
                    name: 'flow',
                    parameters: {
                        flow_message_version: '3',
                        flow_token: params.flowToken || `flow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                        flow_id: params.flowId,
                        flow_cta: params.flowCta,
                        flow_action: 'navigate',
                        flow_action_payload: { screen: params.firstScreen },
                    },
                },
            },
        };
        if (params.header) payload.interactive.header = { type: 'text', text: params.header };
        if (params.footer) payload.interactive.footer = { text: params.footer };

        try {
            await axios.post(`${this.baseUrl}/${this.activePhoneNumberId()}/messages`, payload, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[Meta WhatsApp] Sent flow ${params.flowId} to ${to}`);
        } catch (error: any) {
            console.error('[Meta WhatsApp] Failed to send flow:', error?.response?.data || error.message);
            throw error;
        }
    }

    async sendListMessage(to: string, text: string, buttonText: string, sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]): Promise<void> {
        if (!this.token || !this.phoneNumberId) {
            console.error('Cannot send list: Meta configuration missing');
            return;
        }

        try {
            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: {
                        text: text
                    },
                    action: {
                        button: buttonText,
                        sections: sections
                    }
                }
            };

            await axios.post(`${this.baseUrl}/${this.activePhoneNumberId()}/messages`, payload, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[Meta WhatsApp] Sent list to ${to}`);
        } catch (error: any) {
            console.error('[Meta WhatsApp] Failed to send list:', error?.response?.data || error.message);
        }
    }
}

export const metaWhatsAppService = new MetaWhatsAppService();
