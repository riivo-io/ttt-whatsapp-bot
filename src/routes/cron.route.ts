import { Router, Request, Response } from 'express';
import { caseService } from '../services/case.service';
import { graphMailService } from '../services/graphMail.service';
import { sweepExpiredRelays } from '../controllers/emailRelay.controller';
import { idempotencyService } from '../services/idempotency.service';
console.log('[boot] cron.route: imports done');

// Subscriptions max out at ~70h. Renew anything within 24h of expiry.
const GRAPH_RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

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

/**
 * Renew (or initially create) the Microsoft Graph mail subscription that
 * powers the email-to-WhatsApp relay. Idempotent — call as often as you like.
 *
 * - First call after deploy: creates the subscription (because none exists).
 *   You can also run this manually via curl to bootstrap.
 * - Subsequent calls within the 24h-pre-expiry window: PATCH-renew.
 * - Calls after expiry: delete + recreate.
 * - Calls when subscription is healthy (>24h to expiry): no-op.
 *
 * Also expires any relay-consent rows past their 48h window and emails the
 * forwarder so they know to follow up directly.
 */
router.get('/graph-renew-subscription', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    const baseUrl = process.env.GRAPH_WEBHOOK_BASE_URL;
    const clientState = process.env.GRAPH_WEBHOOK_CLIENT_STATE;
    if (!baseUrl || !clientState) {
        res.status(500).json({
            ok: false,
            error: 'Missing GRAPH_WEBHOOK_BASE_URL or GRAPH_WEBHOOK_CLIENT_STATE',
        });
        return;
    }

    try {
        const notificationUrl = `${baseUrl.replace(/\/$/, '')}/webhook/email`;
        const sub = await graphMailService.ensureSubscription(notificationUrl, clientState, GRAPH_RENEW_WITHIN_MS);
        const expired = await sweepExpiredRelays();
        res.json({
            ok: true,
            subscription: sub ? { id: sub.id, expiresAt: sub.expirationDateTime } : null,
            relaysExpired: expired,
        });
    } catch (e: any) {
        console.error('[Cron] graph-renew-subscription failed:', e?.message || e);
        res.status(500).json({ ok: false, error: e?.message || 'unknown' });
    }
});

/**
 * Vercel Cron target — deletes webhook idempotency rows older than 7 days.
 * Meta's at-least-once retry window is 7 days; rows older than that can't
 * cause a duplicate, so they're dead weight. Three columns per row + an
 * index on received_at means this is a sub-second delete.
 */
router.get('/cleanup-webhook-events', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    try {
        const deleted = await idempotencyService.cleanupOldWebhookEvents();
        console.log(`[Cron] cleanup-webhook-events deleted ${deleted} rows`);
        res.json({ ok: true, deleted });
    } catch (e: any) {
        console.error('[Cron] cleanup-webhook-events failed:', e?.message || e);
        res.status(500).json({ ok: false, error: e?.message || 'unknown' });
    }
});

export default router;
