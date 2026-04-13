import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CLICKATELL_API_URL = 'https://platform.clickatell.com/v1/message';

interface ClickatellMessage {
    channel: string;
    to: string;
    content: string;
}

export async function sendMessage(to: string, content: string): Promise<void> {
    const apiKey = process.env.CLICKATELL_API_KEY;

    if (!apiKey) {
        console.warn('Clickatell API key not configured. Message not sent.');
        console.log(`[MOCK] Would send to ${to}: ${content}`);
        return;
    }

    try {
        const message: ClickatellMessage = {
            channel: 'whatsapp',
            to: to,
            content: content,
        };

        const response = await axios.post(
            CLICKATELL_API_URL,
            message,
            {
                headers: {
                    'Authorization': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            }
        );

        console.log('Message sent successfully:', response.data);
    } catch (error) {
        console.error('Clickatell API Error:', error);
        throw new Error('Failed to send message via Clickatell');
    }
}
