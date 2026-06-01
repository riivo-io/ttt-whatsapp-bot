import { Router, Request, Response } from 'express';
import { whatsappTemplateRegistry } from '../services/whatsappTemplateRegistry.service';

console.log('[boot] admin.route: imports done');

const router = Router();

/**
 * Bearer-auth helper. Mirrors cron.route's isAuthorized pattern: in prod,
 * CRON_SECRET must be set and the Authorization header must match. In dev
 * (no secret configured) we open it up so local development isn't blocked.
 */
function isAuthorized(req: Request): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return process.env.NODE_ENV !== 'production';
    }
    const auth = req.header('authorization') || '';
    return auth === `Bearer ${secret}`;
}

/**
 * POST /admin/templates/refresh
 *
 * Force-flush the in-process WhatsApp template cache. Use after editing
 * template wording in Meta's Business Manager — the 1-hour TTL eventually
 * picks the change up on its own, but this endpoint makes the change instant.
 */
router.post('/templates/refresh', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    try {
        const { templatesLoaded, fetchedAt } = await whatsappTemplateRegistry.forceRefresh();
        res.json({ ok: true, templates_loaded: templatesLoaded, fetched_at: fetchedAt });
    } catch (e: any) {
        console.error('[Admin] templates/refresh failed:', e?.message || e);
        res.status(500).json({ ok: false, error: e?.message || 'unknown' });
    }
});

export default router;
