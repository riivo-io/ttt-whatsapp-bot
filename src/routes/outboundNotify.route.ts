import { Router, Request, Response } from 'express';
import express from 'express';
import { supabaseService } from '../services/supabase.service';
import { dynamicsService } from '../services/dynamics.service';
import { whatsappTemplateRegistry } from '../services/whatsappTemplateRegistry.service';
import { verifyHmacSha256 } from '../utils/hmac';

console.log('[boot] outboundNotify.route: imports done');

const router = Router();

const SIGNATURE_HEADER = 'x-outbound-signature';

interface OutboundNotifyPayload {
    phone: string;
    template_name: string;
    template_language?: string;
    template_variables?: string[];
    template_header_variable?: string;
    sender_message_id: string;
    sent_at: string;
    sender?: string;
}

function missingField(field: string, res: Response): void {
    res.status(400).json({ error: 'missing_field', field });
}

/**
 * Resolve a phone to its CRM identity using the same chain Tina's inbound
 * worker uses (staff → cached session → Dynamics contact lookup). Inlined here
 * per PRD §6.5 — a clean refactor into a dedicated service is deferred.
 *
 * Returns { crmId: null, crmType: 'unknown' } for cold phones; the session
 * still gets created so the seeded message has somewhere to land. This mirrors
 * the cold-inbound behavior already in [workers/whatsappProcessor.ts].
 */
async function resolveSenderIdentity(phone: string): Promise<{ crmId: string | null; crmType: string }> {
    const staff = await supabaseService.findStaffByPhone(phone);
    if (staff) {
        return { crmId: staff.dynamics_user_id, crmType: 'user' };
    }

    const prev = await supabaseService.findPreviousSession(phone);
    if (prev && prev.crm_type !== 'user') {
        return { crmId: prev.crm_id, crmType: prev.crm_type };
    }

    try {
        const entity = await dynamicsService.getContactByPhone(phone);
        if (entity) {
            return { crmId: entity.id, crmType: entity.type };
        }
    } catch (e: any) {
        console.warn('[OutboundNotify] dynamics lookup failed:', e?.message || e);
    }

    return { crmId: null, crmType: 'unknown' };
}

/**
 * POST /webhook/outbound-notify
 *
 * Called by external systems (campaign sender, Power Automate flows) right
 * after they send a WhatsApp template to a client. Tina records the outbound
 * in her session history so the client's reply lands with full context.
 *
 * See docs/PRD-external-template-continuity.md for the full contract.
 * Idempotent at the per-message level via messages.external_id.
 */
router.post(
    '/',
    express.raw({ type: 'application/json', limit: '64kb' }),
    async (req: Request, res: Response) => {
        const secret = process.env.OUTBOUND_NOTIFY_SECRET;
        if (!secret) {
            console.error('[OutboundNotify] OUTBOUND_NOTIFY_SECRET not configured');
            res.status(500).json({ error: 'webhook_not_configured' });
            return;
        }

        const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        const headerSig = req.header(SIGNATURE_HEADER) || req.header('X-Outbound-Signature');

        if (!verifyHmacSha256(rawBody, headerSig, secret)) {
            console.warn('[OutboundNotify] bad_signature received');
            res.status(401).json({ error: 'bad_signature' });
            return;
        }

        let parsed: OutboundNotifyPayload;
        try {
            parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
            res.status(400).json({ error: 'bad_json' });
            return;
        }

        const phone = typeof parsed?.phone === 'string' ? parsed.phone.trim() : '';
        if (!phone) return missingField('phone', res);

        const templateName = typeof parsed?.template_name === 'string' ? parsed.template_name.trim() : '';
        if (!templateName) return missingField('template_name', res);

        const senderMessageId = typeof parsed?.sender_message_id === 'string' ? parsed.sender_message_id.trim() : '';
        if (!senderMessageId) return missingField('sender_message_id', res);

        const sentAt = typeof parsed?.sent_at === 'string' ? parsed.sent_at.trim() : '';
        if (!sentAt) return missingField('sent_at', res);

        const language = (typeof parsed?.template_language === 'string' && parsed.template_language.trim()) || 'en';
        const bodyVars = Array.isArray(parsed?.template_variables)
            ? parsed.template_variables.map(v => (v == null ? '' : String(v)))
            : [];
        const headerVar = typeof parsed?.template_header_variable === 'string' ? parsed.template_header_variable : undefined;
        const senderTag = typeof parsed?.sender === 'string' ? parsed.sender : 'unknown';

        // Look up the template — registry handles the lazy refresh + one
        // forced refresh on miss internally.
        let entry;
        try {
            entry = await whatsappTemplateRegistry.getEntry(templateName, language);
        } catch (e: any) {
            console.error('[OutboundNotify] template registry refresh failed:', e?.message || e);
            res.status(503).json({ error: 'meta_unavailable' });
            return;
        }
        if (!entry) {
            console.warn(`[OutboundNotify] template_not_found name=${templateName} lang=${language} sender=${senderTag}`);
            res.status(404).json({ error: 'template_not_found', template_name: templateName });
            return;
        }

        const seededContent = whatsappTemplateRegistry.composeHistoryContent(entry, bodyVars, headerVar);

        const { crmId, crmType } = await resolveSenderIdentity(phone);

        const session = await supabaseService.getOrCreateSession(phone, crmId, crmType);

        const { inserted } = await supabaseService.insertAssistantMessage(session.id, seededContent, {
            externalId: senderMessageId,
            createdAt: sentAt,
        });

        if (!inserted) {
            console.log(`[OutboundNotify] duplicate sender_message_id=${senderMessageId} phone=${phone} sender=${senderTag}`);
            res.json({ ok: true, seeded: false, reason: 'duplicate' });
            return;
        }

        console.log(`[OutboundNotify] seeded template="${templateName}" phone=${phone} sender=${senderTag} session=${session.id}`);
        res.json({ ok: true, seeded: true });
    },
);

export default router;
