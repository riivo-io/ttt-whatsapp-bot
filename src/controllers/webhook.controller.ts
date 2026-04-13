import { Request, Response } from 'express';
import { openAIService } from '../services/openai.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService } from '../services/dynamics.service';
import { supabaseService } from '../services/supabase.service';
import { sendMessage } from '../services/clickatell.service';

const SIGN_UP_GREETING = `👋 Hi there! It looks like you're not registered with TTT yet.\n\nTo get started, please sign up using the link below. Once registered, message us again and we'll be able to assist you with all your tax needs!`;
const SIGN_UP_LINK = `https://www.taxtechnicianstoday.co.za/sign-up`;

/**
 * Resolve a phone number to a CRM entity.
 * Order: Supabase cached session → Dynamics (contacts → leads → users) → null
 */
async function resolveContact(phoneNumber: string): Promise<any | null> {
    // 1. Check Supabase for previous sessions
    const previousSession = await supabaseService.findPreviousSession(phoneNumber);
    if (previousSession) {
        try {
            const cached = await dynamicsService.getEntityById(previousSession.crm_id, previousSession.crm_type);
            if (cached) {
                console.log(`[Resolve] ${phoneNumber} identified from Supabase cache: ${cached.type} "${cached.fullname}"`);
                return cached;
            }
        } catch (e) {
            console.warn('[Resolve] Supabase-cached CRM lookup failed:', (e as Error).message);
        }
    }

    // 2. Search Dynamics CRM (contacts → leads → users)
    try {
        const entity = await dynamicsService.getContactByPhone(phoneNumber);
        if (entity) {
            console.log(`[Resolve] ${phoneNumber} found in Dynamics: ${entity.type} "${entity.fullname}"`);
            return entity;
        }
    } catch (e) {
        console.warn('[Resolve] Dynamics lookup failed:', (e as Error).message);
    }

    return null;
}

/**
 * Verifies the webhook for Meta WhatsApp API.
 * This is required during the initial setup in the Meta App Dashboard.
 */
export function verifyWebhook(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.error('Webhook verification failed: Invalid token');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
}

/**
 * Handles incoming webhook events from Meta WhatsApp API AND Clickatell (Legacy).
 */
export async function handleIncomingMessage(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body;

        // ==========================================
        // STRATEGY 1: META WHATSAPP CLOUD API
        // ==========================================
        if (body.object === 'whatsapp_business_account') {
            // Loop over entries (usually just 1)
            for (const entry of body.entry) {
                // Loop over changes (usually just 1)
                for (const change of entry.changes) {
                    const value = change.value;

                    // Check if there are messages
                    if (value.messages && value.messages.length > 0) {
                        const message = value.messages[0];

                        // We only handle text messages for now
                        if (message.type === 'text' || message.type === 'interactive') {
                            const from = message.from; // Phone number (e.g. 27832852913)

                            // Extract message body based on type
                            let messageBody = '';
                            if (message.type === 'text') {
                                messageBody = message.text.body;
                            } else if (message.type === 'interactive') {
                                const interactive = message.interactive;
                                if (interactive.type === 'button_reply') {
                                    messageBody = interactive.button_reply.title; // Or .id if prefer ID
                                } else if (interactive.type === 'list_reply') {
                                    messageBody = interactive.list_reply.title;
                                }
                            }

                            console.log(`[Meta] Received message from ${from}: ${messageBody}`);

                            // 1. Resolve contact: Supabase cache → Dynamics (contacts → leads → users)
                            const crmEntity = await resolveContact(from);

                            // 1.5 If not found anywhere, send sign-up link
                            if (!crmEntity) {
                                console.log(`[Meta] ${from} not found in Supabase or Dynamics — sending sign-up link`);
                                await metaWhatsAppService.sendMessage(from, SIGN_UP_GREETING);
                                await metaWhatsAppService.sendMessage(from, SIGN_UP_LINK);
                                continue;
                            }

                            // 2. Auto opt-in for contacts
                            if (crmEntity.type === 'client' && !crmEntity.optIn) {
                                await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
                            }

                            // 3. Supabase: Get or create session
                            const session = await supabaseService.getOrCreateSession(from, crmEntity.id, crmEntity.type);

                            // 4. Log Incoming Message to Dynamics
                            await dynamicsService.logMessage(crmEntity, messageBody, 'Incoming', from);

                            // 5. Generate AI Response
                            const history = await dynamicsService.getRecentMessages(crmEntity.id);
                            console.log(`[OpenAI] History length: ${history.length}`);

                            const responseText = await openAIService.generateResponse(messageBody, crmEntity.id, from, history, crmEntity.type);

                            // 6. Send Reply via Meta
                            await metaWhatsAppService.sendMessage(from, responseText);

                            // 7. Classify intent and update session (non-blocking)
                            openAIService.classifyIntent(messageBody, responseText, session.current_intent)
                                .then(intent => {
                                    console.log(`[Meta] Intent: ${intent}`);
                                    return supabaseService.updateSessionState(session.id, intent, null);
                                })
                                .catch(e => console.warn('[Meta] Intent classification failed:', e.message));

                            // 8. Log Outgoing Message to Dynamics
                            await dynamicsService.logMessage(crmEntity, responseText, 'Outgoing', from);
                        } else {
                            console.log(`[Meta] Received non-text message type: ${message.type}`);
                        }
                    }
                }
            }
            res.sendStatus(200);
            return;
        }

        // ==========================================
        // STRATEGY 2: CLICKATELL (LEGACY)
        // ==========================================
        if (body.content && body.from) {
            console.log(`[Clickatell] Received message from ${body.from}: ${body.content}`);

            const senderNumber = body.from;
            const messageContent = body.content;

            // 1. Resolve contact: Supabase cache → Dynamics (contacts → leads → users)
            const crmEntity = await resolveContact(senderNumber);

            // 1.5 If not found anywhere, send sign-up link
            if (!crmEntity) {
                console.log(`[Clickatell] ${senderNumber} not found in Supabase or Dynamics — sending sign-up link`);
                await sendMessage(senderNumber, SIGN_UP_GREETING);
                await sendMessage(senderNumber, SIGN_UP_LINK);
                res.status(200).json({ success: true, message: 'Sign-up link sent' });
                return;
            }

            // 2. Auto opt-in for contacts
            if (crmEntity.type === 'client' && !crmEntity.optIn) {
                await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
            }

            // 3. Supabase: Get or create session
            const session = await supabaseService.getOrCreateSession(senderNumber, crmEntity.id, crmEntity.type);

            // 4. Log Incoming Message to Dynamics
            await dynamicsService.logMessage(crmEntity, messageContent, 'Incoming', senderNumber);

            // 5. Generate AI Response
            const responseText = await openAIService.generateResponse(messageContent, crmEntity.id, senderNumber, [], crmEntity.type);

            // 6. Send Reply via CLICKATELL
            await sendMessage(senderNumber, responseText);

            // 7. Classify intent and update session (non-blocking)
            openAIService.classifyIntent(messageContent, responseText, session.current_intent)
                .then(intent => {
                    console.log(`[Clickatell] Intent: ${intent}`);
                    return supabaseService.updateSessionState(session.id, intent, null);
                })
                .catch(e => console.warn('[Clickatell] Intent classification failed:', e.message));

            // 8. Log Outgoing Message to Dynamics
            await dynamicsService.logMessage(crmEntity, responseText, 'Outgoing', senderNumber);

            res.status(200).json({ success: true, message: 'Processed via Clickatell' });
            return;
        }

        // Unknown source
        console.warn('Unknown webhook payload:', JSON.stringify(body));
        res.sendStatus(404);

    } catch (error: any) {
        console.error('Error handling webhook:', error);
        res.sendStatus(500);
    }
}
