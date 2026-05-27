import axios from 'axios';

const HOST = process.env.WHATSAPP_SIGNUP_HOST || 'https://ttt-tax.co.za';
const TOKEN = process.env.WHATSAPP_SIGNUP_TOKEN || '';

export type WhatsAppSignupPayload = {
    name: string;
    email: string;
    phone: string;
    service: 'tax' | 'accounting' | 'insurance' | 'advisory';
    companyName?: string;
    clientType?: number;
    dynamicsId?: string;
    services?: Record<string, boolean>;
};

export async function postWhatsAppSignupNotification(payload: WhatsAppSignupPayload): Promise<void> {
    if (!TOKEN) {
        console.warn('[WhatsAppSignupNotifier] WHATSAPP_SIGNUP_TOKEN not set — skipping email notification');
        return;
    }
    try {
        await axios.post(`${HOST}/api/whatsapp-signup`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-whatsapp-signup-token': TOKEN,
            },
            timeout: 10_000,
        });
        console.log(`[WhatsAppSignupNotifier] Notified email API for ${payload.email} (leadId=${payload.dynamicsId})`);
    } catch (e: any) {
        const status = e?.response?.status;
        const body = e?.response?.data;
        console.error(`[WhatsAppSignupNotifier] POST /api/whatsapp-signup failed (status=${status}):`, body || e.message);
    }
}
