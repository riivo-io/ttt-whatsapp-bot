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
        /** For 'user' type, force a specific role rather than the staff member's real role_id. */
        staffRole?: 'No Access' | 'Some Access' | 'Full Access';
    };
}

const TEST_PHONE = '0832852913';

// Direct chat endpoint for testing (bypasses WhatsApp)
router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    try {
        const { message, phoneNumber, testOverride }: ChatRequest = req.body;
        const isTestMode = testOverride && process.env.NODE_ENV !== 'production';
        // Include staffRole in the sender key so each tested role gets its own session
        const senderNumber = isTestMode
            ? `${TEST_PHONE}-${testOverride.type}${testOverride.type === 'user' && testOverride.staffRole ? '-' + testOverride.staffRole.toLowerCase().replace(/ /g, '_') : ''}`
            : (phoneNumber || '0787133880');

        if (!message) {
            res.status(400).json({ error: 'Message is required' });
            return;
        }

        let crmEntity: any = null;
        let staffRoleId: string | null = null;
        let permittedTools: string[] = [];

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

            // TEST MODE fallback: if Dynamics didn't return the user (transient
            // error, stale phone, etc.), reuse the previous cached identity from
            // Supabase rather than collapsing to the "unknown user" flow.
            if (!crmEntity) {
                const prev = await supabaseService.findPreviousSession(senderNumber);
                if (prev) {
                    crmEntity = { id: prev.crm_id, type: prev.crm_type, fullname: 'Test User' };
                    console.log(`[Chat API] TEST MODE: Dynamics miss — using cached identity ${prev.crm_type} (${prev.crm_id})`);
                }
            }

            // TEST MODE: for 'user' type, also look up their role + permitted tools
            // in Supabase so the access-control path is exercised in testing.
            if (testOverride.type === 'user') {
                // If staffRole is specified, impersonate that role instead of the
                // staff member's actual role_id. This lets us toggle No / Some /
                // Full Access in the UI without mutating the users table.
                if (testOverride.staffRole) {
                    const role = await supabaseService.getRoleByName(testOverride.staffRole);
                    if (role) {
                        staffRoleId = role.id;
                        permittedTools = await supabaseService.getPermittedTools(role.id);
                        console.log(`[Chat API] TEST MODE: Impersonating role "${testOverride.staffRole}" → tools=${permittedTools.length}`);
                    } else {
                        console.warn(`[Chat API] TEST MODE: Role "${testOverride.staffRole}" not found in roles table`);
                    }
                } else {
                    const staff = await supabaseService.findStaffByPhone(TEST_PHONE);
                    if (staff) {
                        staffRoleId = staff.role_id;
                        permittedTools = staff.role_id ? await supabaseService.getPermittedTools(staff.role_id) : [];
                        console.log(`[Chat API] TEST MODE: Loaded role_id=${staff.role_id || 'NONE'} tools=${permittedTools.length} for "${staff.full_name}"`);
                    } else {
                        console.warn(`[Chat API] TEST MODE: No staff record in Supabase users for ${TEST_PHONE}`);
                    }
                }
            }
        } else {
            // 1. Staff identification — check Supabase users table FIRST.
            //    This is the access-control path: staff roles live in Supabase,
            //    not Dynamics, so staff MUST be resolved here.
            const staff = await supabaseService.findStaffByPhone(senderNumber);
            if (staff) {
                crmEntity = { id: staff.dynamics_user_id, type: 'user', fullname: staff.full_name };
                staffRoleId = staff.role_id;
                permittedTools = staff.role_id ? await supabaseService.getPermittedTools(staff.role_id) : [];
                console.log(`[Chat API] ${senderNumber} matched staff "${staff.full_name}" role_id=${staff.role_id || 'NONE'} tools=${permittedTools.length}`);
            }

            // 2. Fall back to previous session cache (for clients/leads we've already resolved)
            if (!crmEntity) {
                const previousSession = await supabaseService.findPreviousSession(senderNumber);
                if (previousSession) {
                    try {
                        crmEntity = await dynamicsService.getEntityById(previousSession.crm_id, previousSession.crm_type);
                        if (crmEntity) {
                            console.log(`[Chat API] ${senderNumber} identified from Supabase cache: ${crmEntity.type} "${crmEntity.fullname}"`);
                        }
                    } catch (e) {
                        console.warn('[Chat API] Supabase-cached CRM lookup failed:', (e as Error).message);
                    }
                }
            }

            // 3. If not cached, search Dynamics (contacts → leads)
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

        // 3. Supabase: Get or create session (staff get role + permitted tools cached)
        const session = await supabaseService.getOrCreateSession(
            senderNumber,
            crmEntity.id,
            crmEntity.type,
            staffRoleId,
            permittedTools
        );

        // If resuming an existing staff session, prefer the cached values on the session
        // so we don't incur a fresh role_tools lookup every message (AC #8).
        if (crmEntity.type === 'user') {
            if (session.role_id) staffRoleId = session.role_id;
            if (session.permitted_tools && session.permitted_tools.length > 0) permittedTools = session.permitted_tools;
        }

        // 3a. NO ACCESS handling — staff user with no enabled tools.
        //     Short-circuit before the AI call so no tools execute.
        if (crmEntity.type === 'user' && permittedTools.length === 0) {
            const msg = `Hi ${crmEntity.fullname || 'there'} — you don't currently have access to any bot features. Please contact your administrator to request access.`;
            await supabaseService.saveMessage(session.id, 'user', message);
            await supabaseService.saveMessage(session.id, 'assistant', msg);
            console.log(`[Chat API] No-access staff user "${crmEntity.fullname}" — declined.`);
            res.status(200).json({ response: msg });
            return;
        }

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
            response = await openAIService.generateResponse(message, crmEntity?.id, senderNumber, historyWithoutCurrent, crmEntity?.type, permittedTools, crmEntity?.fullname, session.id);
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
