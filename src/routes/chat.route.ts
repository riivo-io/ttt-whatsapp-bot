import { Request, Response, Router } from 'express';
import { dynamicsService } from '../services/dynamics.service';
import { openAIService } from '../services/openai.service';
import { supabaseService } from '../services/supabase.service';

const router = Router();

interface ChatRequest {
    message: string;
    phoneNumber?: string;
    testOverride?: {
        type: 'client' | 'lead' | 'user';
        newSession?: boolean;
    };
}

const TEST_PHONE = '0832852913';

// Direct chat endpoint for testing (bypasses WhatsApp)
router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    try {
        const { message, phoneNumber, testOverride }: ChatRequest = req.body;
        const isTestMode = testOverride && process.env.NODE_ENV !== 'production';
        const senderNumber = isTestMode ? `${TEST_PHONE}-${testOverride.type}` : (phoneNumber || '0787133880');

        if (!message) {
            res.status(400).json({ error: 'Message is required' });
            return;
        }

        let crmEntity: any = null;

        if (isTestMode) {
            // --- TEST MODE: Look up real CRM entity filtered by selected type ---

            // Expire any existing session so we start fresh when context is switched
            if (testOverride.newSession) {
                const oldSession = await supabaseService.findPreviousSession(senderNumber);
                if (oldSession) {
                    await supabaseService.expireSession(oldSession.id);
                    console.log(`[Chat API] TEST MODE: Expired old session ${oldSession.id}`);
                }
            }

            try {
                crmEntity = await dynamicsService.getContactByPhoneAndType(TEST_PHONE, testOverride.type);
                if (crmEntity) {
                    console.log(`[Chat API] TEST MODE: Found ${crmEntity.type} "${crmEntity.fullname}" in Dynamics`);
                } else {
                    console.warn(`[Chat API] TEST MODE: No ${testOverride.type} found for ${TEST_PHONE} in Dynamics`);
                }
            } catch (e) {
                console.warn('[Chat API] TEST MODE: Dynamics lookup failed:', (e as Error).message);
            }
        } else {
            // 1. Check Supabase for previous sessions (cached CRM identity)
            const previousSession = await supabaseService.findPreviousSession(senderNumber);

            if (previousSession) {
                // We know this number — verify they still exist in Dynamics
                try {
                    crmEntity = await dynamicsService.getEntityById(previousSession.crm_id, previousSession.crm_type);
                    if (crmEntity) {
                        console.log(`[Chat API] ${senderNumber} identified from Supabase cache: ${crmEntity.type} "${crmEntity.fullname}"`);
                    }
                } catch (e) {
                    console.warn('[Chat API] Supabase-cached CRM lookup failed:', (e as Error).message);
                }
            }

            // 2. If not cached, search Dynamics CRM (contacts → leads → users)
            if (!crmEntity) {
                try {
                    crmEntity = await dynamicsService.getContactByPhone(senderNumber);
                    if (crmEntity) {
                        console.log(`[Chat API] ${senderNumber} found in Dynamics: ${crmEntity.type} "${crmEntity.fullname}"`);
                    }
                } catch (dynamicsError) {
                    console.warn('[Chat API] Dynamics unavailable, continuing without CRM:', (dynamicsError as Error).message);
                }
            }
        }

        // 3. If not found, let the AI handle with verify_identity tool
        if (!crmEntity) {
            console.log(`[Chat API] ${senderNumber} not found — routing to AI for identity verification`);

            const session = await supabaseService.getOrCreateSession(senderNumber, null, 'unknown');
            await supabaseService.saveMessage(session.id, 'user', message);
            const history = await supabaseService.getHistory(session.id);
            const historyWithoutCurrent = history.slice(0, -1);

            const response = await openAIService.generateResponse(
                message, undefined, senderNumber, historyWithoutCurrent, undefined
            );

            await supabaseService.saveMessage(session.id, 'assistant', response);
            res.status(200).json({ response });
            return;
        }

        // 3. Supabase: Get or create session
        const session = await supabaseService.getOrCreateSession(
            senderNumber,
            crmEntity.id,
            crmEntity.type
        );

        if (!isTestMode) {
            // 4. Auto opt-in for contacts
            if (crmEntity.type === 'client' && !crmEntity.optIn) {
                try {
                    await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
                } catch (e) {
                    console.warn('[Chat API] Opt-in update failed:', (e as Error).message);
                }
            }

            // 5. Dynamics: Log incoming message
            try {
                await dynamicsService.logMessage(crmEntity, message, 'Incoming', senderNumber);
            } catch (e) {
                console.warn('[Chat API] Incoming log failed:', (e as Error).message);
            }
        }

        // 6. Supabase: Save incoming message
        await supabaseService.saveMessage(session.id, 'user', message);

        // 7. Supabase: Load conversation history for OpenAI context
        const history = await supabaseService.getHistory(session.id);

        console.log(`[Chat API] ${senderNumber} (${session.crm_type}) session=${session.id} history=${history.length}`);

        let interactivePayload = undefined;
        let response = '';

        // UI TEST: simulate interactive buttons
        if (message.toLowerCase() === '/testbuttons') {
            response = 'Here are some test buttons using the Interactive Message format:';
            interactivePayload = {
                type: 'button',
                body: { text: response },
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'btn_yes', title: 'Yes' } },
                        { type: 'reply', reply: { id: 'btn_no', title: 'No' } },
                        { type: 'reply', reply: { id: 'btn_help', title: 'Help' } },
                    ],
                },
            };
        } else {
            // 7. OpenAI: generate response with full Supabase history
            //    We pass history WITHOUT the current user message — it's already in history
            //    from the saveMessage above, but getHistory includes it.
            //    So we pass all messages except the last one (current) to avoid duplication,
            //    since openAIService appends the userMessage itself.
            const historyWithoutCurrent = history.slice(0, -1);
            response = await openAIService.generateResponse(message, crmEntity?.id, senderNumber, historyWithoutCurrent, crmEntity?.type);
        }

        // 8. Supabase: Save bot response
        await supabaseService.saveMessage(session.id, 'assistant', response);

        // 9. Classify intent and update session (non-blocking)
        openAIService.classifyIntent(message, response, session.current_intent)
            .then(intent => {
                console.log(`[Chat API] Intent: ${intent}`);
                return supabaseService.updateSessionState(session.id, intent, null);
            })
            .catch(e => console.warn('[Chat API] Intent classification failed:', e.message));

        // 10. Dynamics: Log outgoing message (skip in test mode)
        if (!isTestMode) {
            try {
                await dynamicsService.logMessage(crmEntity, response, 'Outgoing', senderNumber);
            } catch (e) {
                console.warn('[Chat API] Outgoing log failed:', (e as Error).message);
            }
        }

        console.log(`[Chat API] Bot: ${response.slice(0, 80)}...`);

        res.status(200).json({ response, interactive: interactivePayload });
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: 'Failed to generate response' });
    }
});

export default router;
