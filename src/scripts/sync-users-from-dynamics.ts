/**
 * Sync TTT staff from Dynamics (systemuser entity) to the Supabase users table.
 *
 * - Pulls full_name, mobile_number, and dynamics_user_id from Dynamics.
 * - Upserts each staff member into Supabase matching on dynamics_user_id.
 * - Does NOT overwrite role_id on existing rows (role assignments are managed
 *   in Supabase only, not in Dynamics).
 * - Updates last_synced_at on every row touched.
 *
 * Run with: npm run sync:users
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { DynamicsService } from '../services/dynamics.service';

dotenv.config();

async function syncUsersFromDynamics(): Promise<void> {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const dynamics = new DynamicsService();

    console.log('[Sync] Fetching system users from Dynamics...');
    const dynamicsUsers = await dynamics.getSystemUsers();
    console.log(`[Sync] Fetched ${dynamicsUsers.length} active staff from Dynamics.`);

    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const du of dynamicsUsers) {
        // Check if this user already exists
        const { data: existing, error: lookupError } = await supabase
            .from('users')
            .select('id, role_id')
            .eq('dynamics_user_id', du.systemuserid)
            .maybeSingle();

        if (lookupError) {
            console.error(`[Sync] Lookup failed for ${du.fullname} (${du.systemuserid}):`, lookupError.message);
            failed++;
            continue;
        }

        if (existing) {
            // Update — preserve role_id
            const { error: updateError } = await supabase
                .from('users')
                .update({
                    full_name: du.fullname,
                    mobile_number: du.mobilephone,
                    last_synced_at: now,
                })
                .eq('id', existing.id);

            if (updateError) {
                console.error(`[Sync] Update failed for ${du.fullname}:`, updateError.message);
                failed++;
            } else {
                updated++;
            }
        } else {
            // Create — role_id left NULL so it can be assigned manually in Supabase
            const { error: insertError } = await supabase
                .from('users')
                .insert({
                    full_name: du.fullname,
                    mobile_number: du.mobilephone,
                    dynamics_user_id: du.systemuserid,
                    role_id: null,
                    last_synced_at: now,
                });

            if (insertError) {
                console.error(`[Sync] Insert failed for ${du.fullname}:`, insertError.message);
                failed++;
            } else {
                created++;
            }
        }
    }

    console.log(`[Sync] Done. Created: ${created}, Updated: ${updated}, Failed: ${failed}.`);
}

syncUsersFromDynamics()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[Sync] Fatal error:', err);
        process.exit(1);
    });
