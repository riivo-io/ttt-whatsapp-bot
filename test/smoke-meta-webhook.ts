/**
 * Fires a real Meta-shaped WhatsApp webhook payload at localhost:3001 so the
 * full ingester → Service Bus → worker pipeline runs without touching Meta.
 *
 *   npx tsx test/smoke-meta-webhook.ts <phoneE164NoPlus> [message...]
 *
 * Example:
 *   npx tsx test/smoke-meta-webhook.ts 27821234567 hello bot
 */

import axios from 'axios';

const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '1126852847178432';
const WABA_ID = process.env.META_WABA_ID || '0000000000';
const URL = process.env.SMOKE_URL || 'http://localhost:3001/webhook';

async function main(): Promise<void> {
    const [phone, ...rest] = process.argv.slice(2);
    if (!phone) {
        console.error('Usage: tsx test/smoke-meta-webhook.ts <phoneE164NoPlus> [message...]');
        process.exit(1);
    }
    const message = rest.length ? rest.join(' ') : 'smoke test ' + new Date().toISOString();
    const wamid = 'wamid.smoke-' + Date.now();

    const payload = {
        object: 'whatsapp_business_account',
        entry: [{
            id: WABA_ID,
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                        display_phone_number: '27000000000',
                        phone_number_id: PHONE_NUMBER_ID,
                    },
                    contacts: [{
                        profile: { name: 'Smoke Test' },
                        wa_id: phone,
                    }],
                    messages: [{
                        from: phone,
                        id: wamid,
                        timestamp: Math.floor(Date.now() / 1000).toString(),
                        type: 'text',
                        text: { body: message },
                    }],
                },
            }],
        }],
    };

    console.log(`→ POST ${URL}`);
    console.log(`   phone=${phone}  wamid=${wamid}`);
    console.log(`   message=${JSON.stringify(message)}`);

    const res = await axios.post(URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
    });
    console.log(`← ${res.status} ${res.statusText}`);
}

main().catch(err => {
    console.error('smoke failed:', err?.message || err);
    process.exit(1);
});
