import { Request, Response } from 'express';
import { openAIService } from '../services/openai.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService } from '../services/dynamics.service';
import { supabaseService } from '../services/supabase.service';
import { stagePendingUpload } from '../services/pendingUpload.service';

const SIGN_UP_GREETING = `👋 Hi there! It looks like you're not registered with TTT yet.\n\nTo get started, please sign up using the link below. Once registered, message us again and we'll be able to assist you with all your tax needs!`;
const SIGN_UP_LINK = `https://www.taxtechnicianstoday.co.za/sign-up`;

type ResolvedEntity = {
    crmEntity: any | null;
    staffRoleId: string | null;
    permittedTools: string[];
};

async function resolveSender(phoneNumber: string): Promise<ResolvedEntity> {
    let crmEntity: any = null;
    let staffRoleId: string | null = null;
    let permittedTools: string[] = [];

    const staff = await supabaseService.findStaffByPhone(phoneNumber);
    if (staff) {
        crmEntity = { id: staff.dynamics_user_id, type: 'user', fullname: staff.full_name };
        staffRoleId = staff.role_id;
        permittedTools = staff.role_id ? await supabaseService.getPermittedTools(staff.role_id) : [];
        console.log(`[Webhook] ${phoneNumber} matched staff "${staff.full_name}" role_id=${staff.role_id || 'NONE'} tools=${permittedTools.length}`);
        return { crmEntity, staffRoleId, permittedTools };
    }

    const previousSession = await supabaseService.findPreviousSession(phoneNumber);
    if (previousSession) {
        try {
            crmEntity = await dynamicsService.getEntityById(previousSession.crm_id, previousSession.crm_type);
            if (crmEntity) {
                console.log(`[Webhook] ${phoneNumber} identified from Supabase cache: ${crmEntity.type} "${crmEntity.fullname}"`);
                return { crmEntity, staffRoleId, permittedTools };
            }
        } catch (e) {
            console.warn('[Webhook] Supabase-cached CRM lookup failed:', (e as Error).message);
        }
    }

    try {
        crmEntity = await dynamicsService.getContactByPhone(phoneNumber);
        if (crmEntity) {
            console.log(`[Webhook] ${phoneNumber} found in Dynamics: ${crmEntity.type} "${crmEntity.fullname}"`);
        }
    } catch (e) {
        console.warn('[Webhook] Dynamics lookup failed:', (e as Error).message);
    }

    return { crmEntity, staffRoleId, permittedTools };
}

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

type IncomingMessage = {
    from: string;
    text: string;
    document?: { id: string; filename: string; mimeType: string };
};

function extractIncoming(metaMessage: any): IncomingMessage | null {
    const from = metaMessage.from;
    if (!from) return null;

    if (metaMessage.type === 'text') {
        return { from, text: metaMessage.text?.body || '' };
    }

    if (metaMessage.type === 'interactive') {
        const interactive = metaMessage.interactive;
        if (interactive?.type === 'button_reply') {
            return { from, text: interactive.button_reply.title };
        }
        if (interactive?.type === 'list_reply') {
            return { from, text: interactive.list_reply.title };
        }
        return null;
    }

    if (metaMessage.type === 'document') {
        const doc = metaMessage.document;
        return {
            from,
            text: doc?.caption || '',
            document: {
                id: doc.id,
                filename: doc.filename || `document-${Date.now()}.pdf`,
                mimeType: doc.mime_type || 'application/pdf',
            },
        };
    }

    if (metaMessage.type === 'image') {
        const img = metaMessage.image;
        return {
            from,
            text: img?.caption || '',
            document: {
                id: img.id,
                filename: `image-${Date.now()}.${(img.mime_type || 'image/jpeg').split('/')[1] || 'jpg'}`,
                mimeType: img.mime_type || 'image/jpeg',
            },
        };
    }

    return null;
}

async function processMessage(incoming: IncomingMessage): Promise<void> {
    const { from, text, document } = incoming;

    if (document) {
        try {
            const { buffer, mimeType } = await metaWhatsAppService.downloadMedia(document.id);
            stagePendingUpload(from, document.filename, mimeType || document.mimeType, buffer);
        } catch (e) {
            console.error('[Webhook] Failed to download Meta media:', (e as Error).message);
            await metaWhatsAppService.sendMessage(from, "Sorry, I couldn't download that file from WhatsApp. Please try sending it again.");
            return;
        }
    }

    const effectiveText = text || (document ? 'I just sent you a document.' : '');
    if (!effectiveText && !document) {
        console.log(`[Webhook] ${from} sent an unsupported/empty message — ignoring`);
        return;
    }

    const { crmEntity, staffRoleId: initialStaffRoleId, permittedTools: initialTools } = await resolveSender(from);

    if (!crmEntity) {
        console.log(`[Webhook] ${from} not found — sending sign-up link`);
        await metaWhatsAppService.sendMessage(from, SIGN_UP_GREETING);
        await metaWhatsAppService.sendMessage(from, SIGN_UP_LINK);
        return;
    }

    let staffRoleId = initialStaffRoleId;
    let permittedTools = initialTools;

    const session = await supabaseService.getOrCreateSession(
        from,
        crmEntity.id,
        crmEntity.type,
        staffRoleId,
        permittedTools
    );

    if (crmEntity.type === 'user') {
        if (session.role_id) staffRoleId = session.role_id;
        if (session.permitted_tools && session.permitted_tools.length > 0) permittedTools = session.permitted_tools;
    }

    if (crmEntity.type === 'user' && permittedTools.length === 0) {
        const msg = `Hi ${crmEntity.fullname || 'there'} — you don't currently have access to any bot features. Please contact your administrator to request access.`;
        await supabaseService.saveMessage(session.id, 'user', effectiveText);
        await supabaseService.saveMessage(session.id, 'assistant', msg);
        await metaWhatsAppService.sendMessage(from, msg);
        console.log(`[Webhook] No-access staff user "${crmEntity.fullname}" — declined.`);
        return;
    }

    if (crmEntity.type === 'client' && !crmEntity.optIn) {
        try {
            await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
        } catch (e) {
            console.warn('[Webhook] Opt-in update failed:', (e as Error).message);
        }
    }

    try {
        await dynamicsService.logMessage(crmEntity, effectiveText, 'Incoming', from);
    } catch (e) {
        console.warn('[Webhook] Incoming log failed:', (e as Error).message);
    }

    await supabaseService.saveMessage(session.id, 'user', effectiveText);

    const history = await supabaseService.getHistory(session.id);
    const historyWithoutCurrent = history.slice(0, -1);

    console.log(`[Webhook] ${from} (${session.crm_type}) session=${session.id} history=${history.length}`);

    const responseText = await openAIService.generateResponse(
        effectiveText,
        crmEntity.id,
        from,
        historyWithoutCurrent,
        crmEntity.type,
        permittedTools,
        crmEntity.fullname,
        session.id
    );

    await supabaseService.saveMessage(session.id, 'assistant', responseText);

    await metaWhatsAppService.sendMessage(from, responseText);

    openAIService.classifyIntent(effectiveText, responseText, session.current_intent)
        .then(intent => {
            console.log(`[Webhook] Intent: ${intent}`);
            return supabaseService.updateSessionState(session.id, intent, null);
        })
        .catch(e => console.warn('[Webhook] Intent classification failed:', e.message));

    try {
        await dynamicsService.logMessage(crmEntity, responseText, 'Outgoing', from);
    } catch (e) {
        console.warn('[Webhook] Outgoing log failed:', (e as Error).message);
    }

    console.log(`[Webhook] Bot → ${from}: ${responseText.slice(0, 80)}...`);
}

export async function handleIncomingMessage(req: Request, res: Response): Promise<void> {
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object !== 'whatsapp_business_account') {
            console.warn('[Webhook] Non-Meta payload ignored:', JSON.stringify(body).slice(0, 200));
            return;
        }

        for (const entry of body.entry || []) {
            for (const change of entry.changes || []) {
                const value = change.value;
                const messages = value?.messages;
                if (!messages || messages.length === 0) continue;

                for (const message of messages) {
                    const incoming = extractIncoming(message);
                    if (!incoming) {
                        console.log(`[Webhook] Unsupported message type: ${message.type}`);
                        continue;
                    }

                    console.log(`[Webhook] ${incoming.from} → ${incoming.document ? `[doc ${incoming.document.filename}]` : ''} ${incoming.text}`);

                    try {
                        await processMessage(incoming);
                    } catch (err: any) {
                        console.error(`[Webhook] processMessage error for ${incoming.from}:`, err?.message || err);
                        try {
                            await metaWhatsAppService.sendMessage(incoming.from, "Sorry, something went wrong on our side. Please try again in a moment.");
                        } catch {
                            // swallow — avoid error loop
                        }
                    }
                }
            }
        }
    } catch (error: any) {
        console.error('[Webhook] fatal error handling webhook:', error?.message || error);
    }
}
