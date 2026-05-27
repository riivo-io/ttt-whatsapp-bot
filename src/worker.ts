console.log('[boot] worker.ts: start');
import dotenv from 'dotenv';
dotenv.config();
console.log('[boot] worker.ts: dotenv configured');

import http from 'http';
import { startWhatsAppWorkers, stopWhatsAppWorkers } from './workers/whatsappWorker';
import { startFeedbackPromptWorker, stopFeedbackPromptWorker } from './workers/feedbackPromptWorker';
import { startCaseAutoCloseWorker, stopCaseAutoCloseWorker } from './workers/caseAutoCloseWorker';
import { closeProducerQueues } from './queue/whatsappQueue';
import { closeFeedbackPromptQueue } from './queue/feedbackPromptQueue';
import { closeCaseAutoCloseQueue } from './queue/caseAutoCloseQueue';
import { closeServiceBusClient } from './queue/connection';

// App Service "Web App for Containers" runs a readiness probe on PORT (8080
// on Linux) and marks the container Stopped if nothing answers within 230s.
// The worker is a pure queue consumer with no HTTP role, so we expose a
// trivial liveness endpoint purely to satisfy the platform probe.
const healthPort = parseInt(process.env.PORT || '8080', 10);
const healthServer = http
    .createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('worker ok');
    })
    .listen(healthPort, () => console.log(`[boot] worker.ts: healthz listening on :${healthPort}`));

console.log('[boot] worker.ts: starting workers...');
startWhatsAppWorkers();
startFeedbackPromptWorker();
startCaseAutoCloseWorker();
const slots = Math.max(1, parseInt(process.env.MAX_CONCURRENT_SESSIONS || '8', 10));
console.log(`TTT WhatsApp worker process running — ${slots} session slots + feedback-prompt + case-auto-close`);

async function shutdown(signal: string): Promise<void> {
    console.log(`[Worker] received ${signal}, draining...`);
    try {
        await stopWhatsAppWorkers();
        await stopFeedbackPromptWorker();
        await stopCaseAutoCloseWorker();
        await closeProducerQueues();
        await closeFeedbackPromptQueue();
        await closeCaseAutoCloseQueue();
        await closeServiceBusClient();
        await new Promise<void>(resolve => healthServer.close(() => resolve()));
    } catch (e: any) {
        console.error('[Worker] shutdown error:', e?.message || e);
    }
    process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
