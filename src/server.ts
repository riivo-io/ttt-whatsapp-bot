console.log('[boot] server.ts: start');
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { handleIncomingMessage, verifyWebhook } from './controllers/webhook.controller';
import pdfRoute from './routes/pdf.route';
import cronRoute from './routes/cron.route';
import emailRoute from './routes/email.route';
import loeSignedRoute from './routes/loeSigned.route';
console.log('[boot] server.ts: all imports resolved');

dotenv.config();
console.log('[boot] server.ts: dotenv configured');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// Routes that need access to the raw request body for HMAC verification must
// mount BEFORE the global express.json() parser, otherwise the body stream is
// consumed before the route's own raw-body middleware sees it.
app.use('/webhook/loe-signed', loeSignedRoute);

app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/webhook', verifyWebhook);
app.post('/webhook', handleIncomingMessage);

app.use('/api/pdf', pdfRoute);
app.use('/api/cron', cronRoute);
app.use('/webhook/email', emailRoute);

const server = app.listen(PORT, () => {
    console.log(`🚀 TTT WhatsApp Tax Bot server running on port ${PORT}`);
    console.log(`📱 Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`📄 PDF downloads:   http://localhost:${PORT}/api/pdf`);
    console.log(`📧 Email webhook:   http://localhost:${PORT}/webhook/email`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
