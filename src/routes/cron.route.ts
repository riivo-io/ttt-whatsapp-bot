import { Router, Request, Response } from 'express';
import { caseService } from '../services/case.service';

const router = Router();

/**
 * Authenticate a cron request. Accepts either:
 *   - Authorization: Bearer <CRON_SECRET>   (Vercel Cron convention)
 *   - x-cron-secret: <CRON_SECRET>          (fallback)
 * Returns true if authenticated.
 */
function isAuthorized(req: Request): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        // No secret configured → allow in dev. In prod, always set CRON_SECRET.
        return process.env.NODE_ENV !== 'production';
    }
    const auth = req.header('authorization') || '';
    if (auth === `Bearer ${secret}`) return true;

    const headerSecret = req.header('x-cron-secret');
    if (headerSecret === secret) return true;

    return false;
}

/**
 * Vercel Cron target — sweeps timed-out cases.
 * Scheduled daily via vercel.json; message-triggered fallback runs on each
 * incoming client message too.
 */
router.get('/case-timeout', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    try {
        const swept = await caseService.handleTimeout();
        res.json({ ok: true, swept });
    } catch (e: any) {
        console.error('[Cron] case-timeout failed:', e?.message || e);
        res.status(500).json({ ok: false, error: e?.message || 'unknown' });
    }
});

export default router;
