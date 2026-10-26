/**
 * TTTFG-5196: the signing page's settings, on Tina web and the worker alike. Off unless these are set:
 *   SIGNING_PUBLIC_URL        where the page is served, for the links (https://<Tina's web host>, no trailing slash)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   table signing_requests and bucket "signing"
 *                             (migration 20261027120000_signing_requests.sql)
 * Optional:
 *   SIGNING_CALLBACK_SECRET   the HMAC key the page signs its callbacks with. Unset: a key derived from the Supabase
 *                             service key, which web and worker share. Set it when a caller outside Tina takes callbacks
 *   SIGNING_API_KEY           lets another service create requests with POST /sign/api/requests
 */
import crypto from 'crypto';
import type { SigningDeps } from './signing';
import { supabaseSigningStore } from './store';

let deps: (SigningDeps & { apiKey?: string }) | undefined;

/** The callback key: SIGNING_CALLBACK_SECRET, else derived from the Supabase service key. Null when neither is set. */
export function callbackSecretFromEnv(): string | null {
    if (process.env.SIGNING_CALLBACK_SECRET) return process.env.SIGNING_CALLBACK_SECRET;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return service ? crypto.createHmac('sha256', service).update('TTTFG-5196 signing callback').digest('hex') : null;
}

export function signingFromEnv(): (SigningDeps & { apiKey?: string }) | null {
    const publicUrl = process.env.SIGNING_PUBLIC_URL;
    const callbackSecret = callbackSecretFromEnv();
    if (!publicUrl || !callbackSecret || !process.env.SUPABASE_URL) return null;
    return (deps ??= { store: supabaseSigningStore(), publicUrl: publicUrl.replace(/\/$/, ''), callbackSecret, apiKey: process.env.SIGNING_API_KEY || undefined });
}
