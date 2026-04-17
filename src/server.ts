import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { handleIncomingMessage, verifyWebhook } from './controllers/webhook.controller';
import pdfRoute from './routes/pdf.route';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/webhook', verifyWebhook);
app.post('/webhook', handleIncomingMessage);

app.use('/api/pdf', pdfRoute);

const server = app.listen(PORT, () => {
    console.log(`🚀 TTT WhatsApp Tax Bot server running on port ${PORT}`);
    console.log(`📱 Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`📄 PDF downloads:   http://localhost:${PORT}/api/pdf`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
