import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { handleIncomingMessage, verifyWebhook } from './controllers/webhook.controller';
import chatRoute from './routes/chat.route';
import uploadRoute from './routes/upload.route';
import pdfRoute from './routes/pdf.route';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Meta WhatsApp Webhook
app.get('/webhook', verifyWebhook);
app.post('/webhook', handleIncomingMessage);

// Direct chat API for testing
app.use('/api', chatRoute);
app.use('/api/upload', uploadRoute);
app.use('/api/pdf', pdfRoute);

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 TTT WhatsApp Tax Bot server running on port ${PORT}`);
    console.log(`📱 Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`💬 Chat API: http://localhost:${PORT}/api/chat`);
});

// Graceful shutdown — release port when nodemon restarts
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
