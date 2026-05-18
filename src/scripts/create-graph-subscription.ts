/**
 * Bootstrap or refresh the Microsoft Graph mail subscription that powers the
 * email-to-WhatsApp relay (tina-bot mailbox).
 *
 * Run once after every deploy to a new environment (or to recover after a
 * subscription was deleted manually). The cron at /api/cron/graph-renew-subscription
 * keeps it alive afterwards — but the cron isn't visible to the user, so this
 * script is the deliberate, manual bootstrap step.
 *
 * Idempotent:
 *   - No existing subscription → creates one.
 *   - Existing subscription expiring soon → renews it.
 *   - Existing subscription healthy → no-op.
 *   - Existing subscription already expired → deletes + recreates.
 *
 * Run with: npx ts-node src/scripts/create-graph-subscription.ts
 */

import dotenv from 'dotenv';
import { graphMailService } from '../services/graphMail.service';

dotenv.config();

const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
    const baseUrl = process.env.GRAPH_WEBHOOK_BASE_URL;
    const clientState = process.env.GRAPH_WEBHOOK_CLIENT_STATE;
    if (!baseUrl) throw new Error('Missing GRAPH_WEBHOOK_BASE_URL in .env');
    if (!clientState) throw new Error('Missing GRAPH_WEBHOOK_CLIENT_STATE in .env');

    const notificationUrl = `${baseUrl.replace(/\/$/, '')}/webhook/email`;
    console.log(`[Bootstrap] Notification URL: ${notificationUrl}`);

    const sub = await graphMailService.ensureSubscription(notificationUrl, clientState, RENEW_WITHIN_MS);
    if (!sub) {
        console.error('[Bootstrap] Failed to create or refresh subscription. See above logs.');
        process.exit(1);
    }
    console.log(`[Bootstrap] Subscription healthy.`);
    console.log(`            id:        ${sub.id}`);
    console.log(`            resource:  ${sub.resource}`);
    console.log(`            expiresAt: ${sub.expirationDateTime}`);
}

main().catch(err => {
    console.error('[Bootstrap] Fatal:', err?.message || err);
    process.exit(1);
});
