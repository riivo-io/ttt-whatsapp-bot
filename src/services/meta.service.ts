import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

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

    async sendMessage(to: string, message: string): Promise<void> {
        if (!this.token || !this.phoneNumberId) {
            console.error('Cannot send message: Meta configuration missing');
            return;
        }

        try {
            const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to,
                type: 'text',
                text: {
                    body: message
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
                        text: text
                    },
                    action: {
                        buttons: formattedButtons
                    }
                }
            };

            await axios.post(`${this.baseUrl}/${this.phoneNumberId}/messages`, payload, {
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
                `${this.baseUrl}/${this.phoneNumberId}/media`,
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
                `${this.baseUrl}/${this.phoneNumberId}/messages`,
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

            await axios.post(`${this.baseUrl}/${this.phoneNumberId}/messages`, payload, {
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
