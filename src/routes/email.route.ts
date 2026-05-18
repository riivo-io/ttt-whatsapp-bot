import { Router, Request, Response } from 'express';
import { processInboundEmail } from '../controllers/emailRelay.controller';
import { GraphChangeNotification } from '../services/graphMail.service';

console.log('[boot] email.route: imports done');

const router = Router();

const EXPECTED_CLIENT_STATE = process.env.GRAPH_WEBHOOK_CLIENT_STATE || '';

// In-memory dedup keyed by Graph message id. Notifications occasionally
// redeliver within seconds; the Supabase graph_message_id unique constraint
// is the durable backstop, this just avoids duplicate Graph fetches.
const PROCESSED_TTL_MS = 5 * 60 * 1000;
const processed = new Map<string, number>();

function alreadyProcessed(id: string): boolean {
    const now = Date.now();
    const expiry = processed.get(id);
    if (expiry !== undefined && expiry > now) return true;
    processed.set(id, now + PROCESSED_TTL_MS);
    if (processed.size > 500) {
        for (const [k, exp] of processed) {
            if (exp <= now) processed.delete(k);
        }
    }
    return false;
}

/**
 * Validation handshake. Microsoft Graph POSTs to this URL when a subscription
 * is being created/renewed with `?validationToken=<opaque>` in the query string
 * and an empty body. We must respond synchronously with the token as plain
 * text, status 200, within 10 seconds.
 *
 * Graph sometimes sends this as GET, sometimes POST — handle both.
 */
function handleValidationIfPresent(req: Request, res: Response): boolean {
    const token = req.query.validationToken;
    if (typeof token === 'string' && token.length > 0) {
        res.status(200).type('text/plain').send(token);
        console.log(`[EmailWebhook] Validation handshake completed (${token.length} chars)`);
        return true;
    }
    return false;
}

/**
 * GET endpoint — only ever called for the validation handshake. Anything else
 * is a 404 / 405.
 */
router.get('/', (req: Request, res: Response) => {
    if (!handleValidationIfPresent(req, res)) {
        res.sendStatus(405);
    }
});

/**
 * POST endpoint — handles both the validation handshake (when validationToken
 * is in the query) and notifications (when it isn't).
 */
router.post('/', async (req: Request, res: Response) => {
    if (handleValidationIfPresent(req, res)) return;

    // ACK fast. Graph aborts the subscription if we keep returning slowly or
    // failing — and downstream Dynamics + Supabase + Meta calls are not fast.
    res.sendStatus(202);

    try {
        const body = req.body as { value?: GraphChangeNotification[] };
        const notifications = body?.value || [];

        for (const notification of notifications) {
            // Reject anything whose clientState doesn't match — protects against
            // anyone POSTing crafted payloads to our public webhook URL.
            if (EXPECTED_CLIENT_STATE && notification.clientState !== EXPECTED_CLIENT_STATE) {
                console.warn(`[EmailWebhook] Rejecting notification with bad clientState (sub=${notification.subscriptionId})`);
                continue;
            }

            const messageId = notification.resourceData?.id;
            if (!messageId) {
                console.warn('[EmailWebhook] Notification missing resourceData.id — skipping');
                continue;
            }

            if (alreadyProcessed(messageId)) {
                console.log(`[EmailWebhook] Duplicate notification for ${messageId} — skipping`);
                continue;
            }

            try {
                await processInboundEmail(messageId);
            } catch (err: any) {
                console.error(`[EmailWebhook] processInboundEmail failed for ${messageId}:`, err?.message || err);
            }
        }
    } catch (error: any) {
        console.error('[EmailWebhook] Fatal error handling notification batch:', error?.message || error);
    }
});

export default router;
