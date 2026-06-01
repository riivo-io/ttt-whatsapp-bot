import { Router, Request, Response } from 'express';
import express from 'express';
import { activateLeadPostLoe } from '../services/loeActivation.service';
import { verifyHmacSha256 } from '../utils/hmac';
console.log('[boot] loeSigned.route: imports done');

const router = Router();

const SIGNATURE_HEADER = 'x-loe-signature';

/**
 * POST /webhook/loe-signed
 *
 * Called by the LoE Next.js app (ttt-financial-forms) the moment a signed LoE
 * lands. Triggers the post-LoE activation flow: WhatsApp thank-you to the
 * lead + taxcrew notification email + sentinel row in Dynamics.
 *
 * Idempotent — duplicate calls return 200 with activated=false. The hourly
 * safety-net cron is the backup if this fires.
 */
router.post(
    '/',
    express.raw({ type: 'application/json', limit: '64kb' }),
    async (req: Request, res: Response) => {
        const secret = process.env.LOE_ACTIVATION_WEBHOOK_SECRET;
        if (!secret) {
            console.error('[LoESigned] LOE_ACTIVATION_WEBHOOK_SECRET not configured');
            res.status(500).json({ error: 'webhook_not_configured' });
            return;
        }

        const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        const headerSig = req.header(SIGNATURE_HEADER) || req.header('X-LoE-Signature');

        if (!verifyHmacSha256(rawBody, headerSig, secret)) {
            console.warn('[LoESigned] bad_signature received');
            res.status(401).json({ error: 'bad_signature' });
            return;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
            res.status(400).json({ error: 'bad_json' });
            return;
        }

        const leadId = typeof parsed?.leadId === 'string' ? parsed.leadId.trim() : '';
        if (!leadId) {
            res.status(400).json({ error: 'missing_lead_id' });
            return;
        }

        try {
            const result = await activateLeadPostLoe(leadId);
            switch (result.outcome) {
                case 'activated':
                    res.json({ ok: true, activated: true });
                    return;
                case 'already_activated':
                    res.json({ ok: true, activated: false, reason: 'already_activated' });
                    return;
                case 'non_tax_lead':
                    res.json({ ok: true, activated: false, reason: 'non_tax_lead' });
                    return;
                case 'lead_not_found':
                    res.status(404).json({ error: 'lead_not_found' });
                    return;
                case 'dynamics_unavailable':
                    res.status(503).json({ error: 'dynamics_unavailable', detail: result.error });
                    return;
                default:
                    res.status(500).json({ error: 'unknown_outcome' });
                    return;
            }
        } catch (e: any) {
            console.error('[LoESigned] activation handler threw:', e?.message || e);
            res.status(500).json({ error: 'internal_error', detail: e?.message });
        }
    },
);

export default router;
