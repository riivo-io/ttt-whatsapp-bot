import axios from 'axios';

const WEBHOOK_URL = 'http://localhost:3001/webhook';

const testMessages = [
    'What are the current tax brackets in South Africa?',
    'How do I register for eFiling?',
    'What is the deadline for provisional tax?',
];

async function simulateWebhook(message: string, phoneNumber: string = '+27821234567') {
    const payload = {
        messageId: `test-${Date.now()}`,
        channel: 'whatsapp',
        from: phoneNumber,
        to: '+27839876543',
        timestamp: new Date().toISOString(),
        content: message,
        type: 'text',
    };

    console.log('\n📱 Simulating incoming WhatsApp message...');
    console.log(`From: ${phoneNumber}`);
    console.log(`Message: "${message}"`);
    console.log('---');

    try {
        const response = await axios.post(WEBHOOK_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
        });
        console.log('✅ Webhook response:', response.data);
    } catch (error: any) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length > 0) {
        // Custom message from command line
        await simulateWebhook(args.join(' '));
    } else {
        // Run through test messages
        console.log('🧪 Running webhook simulation tests...\n');

        for (const message of testMessages) {
            await simulateWebhook(message);
            console.log('\n' + '='.repeat(50));
        }
    }
}

main();
