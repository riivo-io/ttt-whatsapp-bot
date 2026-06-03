import { Router, Request, Response } from 'express';
import { caseService } from '../services/case.service';
import { graphMailService } from '../services/graphMail.service';
import { sweepExpiredRelays } from '../controllers/emailRelay.controller';
import { idempotencyService } from '../services/idempotency.service';
import { activateLeadPostLoe } from '../services/loeActivation.service';
import { dynamicsService } from '../services/dynamics.service';
import { supabaseService } from '../services/supabase.service';
import { pendingIrp5Service } from '../services/pendingIrp5.service';
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
/**
 * Hourly safety-net cron. Two responsibilities, kept on one endpoint so the
 * cron count stays low:
 *
 *   1. Find Tax leads with `riivo_loereceived = true` that have NOT yet had
 *      the post-LoE activation flow run for them (no sentinel riivo_request
 *      with classificationtopic='post_loe_activation'). Invoke the activation
 *      handler for each — same code path as the /webhook/loe-signed instant
 *      hook, so behavior matches exactly.
 *   2. Drain any pending_irp5s rows whose lead_id now resolves to a Contact
 *      in Dynamics (i.e. the lead has been converted to a Contact by Power
 *      Automate since the last sweep).
 */
async function runLoeActivationSweep(): Promise<void> {
    const summary = { activations: 0, activationsFailed: 0, irp5Drained: 0 };
    const startedAt = Date.now();
    try {
        const leads = await dynamicsService.findLeadsAwaitingPostLoeActivation();
        console.log(`[Cron] loe-activation-sweep: ${leads.length} lead(s) awaiting activation`);
        for (const { id } of leads) {
            try {
                const result = await activateLeadPostLoe(id);
                if (result.outcome === 'activated') {
                    summary.activations += 1;
                } else if (result.outcome === 'dynamics_unavailable' || result.outcome === 'lead_not_found') {
                    summary.activationsFailed += 1;
                }
            } catch (e: any) {
                summary.activationsFailed += 1;
                console.warn(`[Cron] activation failed for ${id}: ${e?.message || e}`);
            }
        }

        const distinctLeadPhones = await supabaseService.findPendingIrp5LeadPhones();
        for (const { leadId, phoneNumber } of distinctLeadPhones) {
            try {
                const resolved = await dynamicsService.getContactByPhone(phoneNumber);
                if (resolved?.type === 'client' && resolved.id) {
                    const drained = await pendingIrp5Service.drainForLead(leadId, resolved.id);
                    summary.irp5Drained += drained;
                }
            } catch (e: any) {
                console.warn(`[Cron] IRP5 drain check failed for lead ${leadId} / phone ${phoneNumber}: ${e?.message || e}`);
            }
        }

        const elapsedMs = Date.now() - startedAt;
        console.log(`[Cron] loe-activation-sweep done in ${elapsedMs}ms: ${JSON.stringify(summary)}`);
    } catch (e: any) {
        console.error('[Cron] loe-activation-sweep failed:', e?.message || e);
    }
}

router.get('/loe-activation-sweep', (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    // KILL SWITCH — set LOE_SWEEP_DISABLED=1 in Azure App Service config to
    // halt the sweep without redeploying. Lets us stop a runaway sweep
    // (e.g. sentinel writes silently failing → every hour re-blasts WhatsApp
    // + taxcrew email for every "loereceived=true, no sentinel" lead) the
    // moment we notice, then re-enable by flipping the var back.
    if (process.env.LOE_SWEEP_DISABLED === '1') {
        console.warn('[Cron] loe-activation-sweep skipped — LOE_SWEEP_DISABLED=1');
        res.json({ ok: true, skipped: true, reason: 'LOE_SWEEP_DISABLED' });
        return;
    }

    // Fire-and-forget. Azure App Service's load balancer caps requests at ~4
    // minutes; a backlog or a slow Dynamics/Meta call used to push the sweep
    // past that, the LB returned 504, and GHA reported a false failure even
    // though the work kept running. Acknowledging immediately and processing
    // in the background keeps GHA honest. Cross-invocation safety is already
    // handled by the per-lead Supabase mutex in idempotencyService.
    void runLoeActivationSweep();
    res.status(202).json({ ok: true, accepted: true });
});

/**
 * One-shot recovery endpoint. Writes a post-LoE activation sentinel for every
 * lead currently in the `loereceived=true, no sentinel` set, WITHOUT firing
 * the WhatsApp or taxcrew email side effects.
 *
 * Needed because createPostLoeActivationSentinel was previously rolling back
 * on the create (Dynamics rejects create-as-Inactive+RESOLVED_BY_BOT), so
 * leads that received the WhatsApp + taxcrew email overnight have no
 * sentinel and would be re-blasted by the next sweep. Run this once after
 * deploying the sentinel fix and before re-enabling the cron schedule.
 *
 * Auth: same CRON_SECRET bearer token as the other cron endpoints.
 */
router.get('/loe-sentinel-backfill', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    const summary: { written: number; failed: number; total: number } = {
        written: 0,
        failed: 0,
        total: 0,
    };

    try {
        const leads = await dynamicsService.findLeadsAwaitingPostLoeActivation();
        summary.total = leads.length;
        console.log(`[Cron] loe-sentinel-backfill: ${leads.length} lead(s) to backfill`);
        for (const { id } of leads) {
            try {
                const lead = await dynamicsService.getLeadById(id);
                const phone = lead?.mobilephone || '';
                const sentinelId = await dynamicsService.createPostLoeActivationSentinel(id, phone);
                if (sentinelId) {
                    summary.written += 1;
                } else {
                    summary.failed += 1;
                    console.warn(`[Cron] loe-sentinel-backfill: createPostLoeActivationSentinel returned null for lead ${id}`);
                }
            } catch (e: any) {
                summary.failed += 1;
                console.warn(`[Cron] loe-sentinel-backfill failed for ${id}: ${e?.message || e}`);
            }
        }
        res.json({ ok: true, summary });
    } catch (e: any) {
        console.error('[Cron] loe-sentinel-backfill failed:', e?.message || e);
        res.status(500).json({ ok: false, error: e?.message || 'unknown' });
    }
});

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
