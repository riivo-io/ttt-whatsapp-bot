/**
 * TTTFG-5196: the signing page's settings. Off unless all are set:
 *   SIGNING_PUBLIC_URL        where the page is served, for the links (https://<Tina's web host>, no trailing slash)
 *   SIGNING_CALLBACK_SECRET   the HMAC key the page signs its callbacks with (and the claims callback checks)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   table signing_requests and bucket "signing"
 *                             (migration 20261027120000_signing_requests.sql)
 *   SIGNING_API_KEY           optional: lets another service create requests with POST /sign/api/requests
 */
import type { SigningDeps } from './signing';
import { supabaseSigningStore } from './store';

let deps: (SigningDeps & { apiKey?: string }) | undefined;

export function signingFromEnv(): (SigningDeps & { apiKey?: string }) | null {
    const publicUrl = process.env.SIGNING_PUBLIC_URL;
    const callbackSecret = process.env.SIGNING_CALLBACK_SECRET;
    if (!publicUrl || !callbackSecret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    return (deps ??= { store: supabaseSigningStore(), publicUrl: publicUrl.replace(/\/$/, ''), callbackSecret, apiKey: process.env.SIGNING_API_KEY || undefined });
}
