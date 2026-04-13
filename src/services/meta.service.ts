import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export class MetaWhatsAppService {
    private token: string;
    private phoneNumberId: string;
    private baseUrl: string = 'https://graph.facebook.com/v19.0';

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
