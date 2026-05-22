console.log('[boot] worker.ts: start');
import dotenv from 'dotenv';
dotenv.config();
console.log('[boot] worker.ts: dotenv configured');

import { startWhatsAppWorkers, stopWhatsAppWorkers } from './workers/whatsappWorker';
import { startFeedbackPromptWorker, stopFeedbackPromptWorker } from './workers/feedbackPromptWorker';
import { closeProducerQueues } from './queue/whatsappQueue';
import { closeFeedbackPromptQueue } from './queue/feedbackPromptQueue';
import { closeServiceBusClient } from './queue/connection';

console.log('[boot] worker.ts: starting workers...');
startWhatsAppWorkers();
startFeedbackPromptWorker();
const slots = Math.max(1, parseInt(process.env.MAX_CONCURRENT_SESSIONS || '8', 10));
console.log(`🛠  TTT WhatsApp worker process running — ${slots} session slots + feedback-prompt`);

async function shutdown(signal: string): Promise<void> {
    console.log(`[Worker] received ${signal}, draining...`);
    try {
        await stopWhatsAppWorkers();
        await stopFeedbackPromptWorker();
        await closeProducerQueues();
        await closeFeedbackPromptQueue();
        await closeServiceBusClient();
    } catch (e: any) {
        console.error('[Worker] shutdown error:', e?.message || e);
    }
    process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
