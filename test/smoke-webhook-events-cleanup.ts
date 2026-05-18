/**
 * Smoke test for the 7-day webhook idempotency cleanup (Issue 9).
 *
 * Touches the real Supabase configured in .env. Inserts a fixture of rows
 * with received_at backdated > 7 days mixed with fresh rows, runs the
 * cleanup service method, and asserts only the old rows were deleted.
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Run: tsx test/smoke-webhook-events-cleanup.ts
 *
 * Safe to run repeatedly — uses sentinel meta_message_ids prefixed with
 * `smoke-test:` so it can't collide with real Meta wamids, and tears down
 * its own fixture at the end.
 */

import { createClient } from '@supabase/supabase-js';
import { idempotencyService } from '../src/services/idempotency.service';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — abort');
    process.exit(2);
}

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FIXTURE_PREFIX = 'smoke-test:cleanup:';
const OLD_ID = `${FIXTURE_PREFIX}old`;
const FRESH_ID = `${FIXTURE_PREFIX}fresh`;

async function tearDown(): Promise<void> {
    await client.from('whatsapp_webhook_events').delete().like('meta_message_id', `${FIXTURE_PREFIX}%`);
}

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    const assert = (cond: boolean, label: string) => {
        if (cond) { passed++; console.log(`  ✓ ${label}`); }
        else      { failed++; console.error(`  ✗ ${label}`); }
    };

    // Clear any prior fixture from a failed previous run
    await tearDown();

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const { error: insertErr } = await client.from('whatsapp_webhook_events').insert([
        { meta_message_id: OLD_ID, phone_number: '27000000001', received_at: eightDaysAgo },
        { meta_message_id: FRESH_ID, phone_number: '27000000002', received_at: oneDayAgo },
    ]);
    if (insertErr) {
        console.error('Fixture insert failed:', insertErr.message);
        process.exit(2);
    }
    console.log(`Inserted fixture: ${OLD_ID} (8d old), ${FRESH_ID} (1d old)`);

    const deleted = await idempotencyService.cleanupOldWebhookEvents();
    console.log(`Service reported deleted: ${deleted}`);
    assert(deleted >= 1, 'cleanup deletes at least the old fixture row');

    // Verify the fresh row survived and the old row is gone
    const { data: surviving } = await client
        .from('whatsapp_webhook_events')
        .select('meta_message_id')
        .like('meta_message_id', `${FIXTURE_PREFIX}%`);
    const ids = (surviving || []).map(r => r.meta_message_id);
    assert(!ids.includes(OLD_ID), `${OLD_ID} (8d old) was deleted`);
    assert(ids.includes(FRESH_ID), `${FRESH_ID} (1d old) survived`);

    await tearDown();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
    console.error('Test crashed:', err);
    try { await tearDown(); } catch {}
    process.exit(2);
});
