/**
 * TTTFG-5562: the guided claim form's links. Like the signing links (src/signing/signing.ts): a random 256-bit token of
 * which only the SHA-256 is stored, no personal information in the address, 7 days, and a new link for the same claim
 * stops the earlier one. Unlike them the link keeps working until the client submits the form: closing the page and
 * opening the same link carries on where they stopped (AC 5).
 *
 * Table guided_form_links (migration 20261102120000_guided_form_links.sql); in memory for the tests and the preview.
 */
import crypto from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const LINK_DAYS = 7;
/** TTTFG-5188: the email agent, as it signs on the signing page; its callbacks use this caller's key. */
export const EMAIL_CLAIM_CALLER = 'claim-email';

export type LinkStatus = 'open' | 'done' | 'expired' | 'superseded';

export interface GuidedLinkRow {
    id: string;
    token_hash: string;
    claim_id: string;
    phone: string;
    contact_id: string;
    phone_number_id: string | null;
    status: LinkStatus;
    expires_at: string;
    created_at: string;
    opened_at: string | null;
    finished_at: string | null;
    /** TTTFG-5188: an email claim's link. Who to tell when the client submits; absent on a WhatsApp link, whose `phone` Tina carries on with. */
    callback_url?: string | null;
}

export interface GuidedLinkStore {
    insert(row: GuidedLinkRow): Promise<void>;
    byTokenHash(hash: string): Promise<GuidedLinkRow | null>;
    /** The claim's open links made before `createdBefore` become superseded. */
    supersedeOpen(claimId: string, createdBefore: string): Promise<void>;
    update(id: string, patch: Partial<GuidedLinkRow>): Promise<void>;
}

export interface GuidedLinkDeps {
    store: GuidedLinkStore;
    /** Where the page is served (https://host, no trailing slash). */
    publicUrl: string;
    now?: () => Date;
}

const nowOf = (d: GuidedLinkDeps) => d.now?.() ?? new Date();
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createGuidedLink(d: GuidedLinkDeps, input: { claimId: string; phone: string; contactId: string; phoneNumberId?: string | null; callbackUrl?: string }): Promise<{ id: string; url: string; expiresAt: string }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const created = nowOf(d);
    const row: GuidedLinkRow = {
        id: crypto.randomUUID(), token_hash: sha256(token), claim_id: input.claimId, phone: input.phone, contact_id: input.contactId,
        phone_number_id: input.phoneNumberId ?? null, status: 'open', expires_at: new Date(created.getTime() + LINK_DAYS * 86_400_000).toISOString(),
        created_at: created.toISOString(), opened_at: null, finished_at: null,
        // Only when there is one: a WhatsApp link writes the row as it always has.
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    };
    await d.store.insert(row);
    await d.store.supersedeOpen(input.claimId, row.created_at);
    return { id: row.id, url: `${d.publicUrl.replace(/\/$/, '')}/claim-form/${token}`, expiresAt: row.expires_at };
}

export type LinkRefusal = 'not-found' | 'expired' | 'done' | 'superseded';
export type OpenedLink = { ok: true; row: GuidedLinkRow } | { ok: false; reason: LinkRefusal; emailed?: boolean };

/** The link's row, or why it doesn't work. `record`: this is the client opening it (a link preview doesn't count). */
export async function openGuidedLink(d: GuidedLinkDeps, token: string, o: { record?: boolean } = {}): Promise<OpenedLink> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { ok: false, reason: 'not-found' };
    const row = await d.store.byTokenHash(sha256(token));
    if (!row) return { ok: false, reason: 'not-found' };
    const emailed = row.callback_url ? { emailed: true } : {};
    if (row.status === 'done') return { ok: false, reason: 'done', ...emailed };
    if (row.status === 'superseded') return { ok: false, reason: 'superseded', ...emailed };
    if (row.status === 'expired' || Date.parse(row.expires_at) <= nowOf(d).getTime()) {
        if (row.status === 'open') await d.store.update(row.id, { status: 'expired' });
        return { ok: false, reason: 'expired', ...emailed };
    }
    if (o.record && !row.opened_at) {
        row.opened_at = nowOf(d).toISOString();
        await d.store.update(row.id, { opened_at: row.opened_at });
    }
    return { ok: true, row };
}

export const finishGuidedLink = (d: GuidedLinkDeps, id: string) => d.store.update(id, { status: 'done', finished_at: nowOf(d).toISOString() });

/**
 * TTTFG-5188: the client submitted an email claim's form, so its caller carries on. A POST of JSON signed under the caller's
 * own key, as the signing page's callback is. Thrown when it isn't taken: the client's Submit then fails and can be tried again.
 */
export async function postFormDone(link: Pick<GuidedLinkRow, 'callback_url' | 'claim_id'>, key: string, caller: string, post: typeof fetch = fetch): Promise<void> {
    const body = JSON.stringify({ caller, claimId: link.claim_id });
    const res = await post(link.callback_url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signing-signature': crypto.createHmac('sha256', key).update(body).digest('hex') },
        body,
    });
    if (!res.ok) throw new Error(`the form's caller answered ${res.status}`);
}

/**
 * TTTFG-5188: what the email agent may ask Tina to read: an insurer's blank form, in the one folder they are kept in. The
 * agent's own login doesn't reach that site, on purpose, so this mustn't become a way to read anything else on it.
 */
export function isBlankFormUrl(raw: string): boolean {
    try {
        const u = new URL(raw);
        const path = decodeURIComponent(u.pathname);
        return u.protocol === 'https:' && u.hostname.endsWith('.sharepoint.com') && !u.search && !path.includes('..')
            && path.includes('/Shared Documents/Insurance Claims Forms/') && path.toLowerCase().endsWith('.pdf');
    } catch {
        return false;
    }
}

// ------------------------------------------------------------------------------------------------- in memory

export function memoryLinkStore(): GuidedLinkStore & { rows: Map<string, GuidedLinkRow> } {
    const rows = new Map<string, GuidedLinkRow>();
    return {
        rows,
        async insert(row) { rows.set(row.id, { ...row }); },
        async byTokenHash(h) {
            const r = [...rows.values()].find((x) => x.token_hash === h);
            return r ? { ...r } : null;
        },
        async supersedeOpen(claimId, before) {
            for (const r of rows.values()) if (r.claim_id === claimId && r.status === 'open' && r.created_at < before) r.status = 'superseded';
        },
        async update(id, patch) {
            const r = rows.get(id);
            if (r) Object.assign(r, patch);
        },
    };
}

// ------------------------------------------------------------------------------------------------- Supabase

export function supabaseLinkStore(client?: SupabaseClient): GuidedLinkStore {
    let c = client;
    const db = () => (c ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }));
    const fail = (what: string, e: { message: string } | null) => { if (e) throw new Error(`[ClaimForm] ${what}: ${e.message}`); };
    return {
        async insert(row) {
            const { error } = await db().from('guided_form_links').insert(row);
            fail('insert', error);
        },
        async byTokenHash(h) {
            const { data, error } = await db().from('guided_form_links').select('*').eq('token_hash', h).maybeSingle();
            fail('read', error);
            return (data as GuidedLinkRow | null) ?? null;
        },
        async supersedeOpen(claimId, before) {
            const { error } = await db().from('guided_form_links').update({ status: 'superseded' }).eq('claim_id', claimId).eq('status', 'open').lt('created_at', before);
            fail('supersede', error);
        },
        async update(id, patch) {
            const { error } = await db().from('guided_form_links').update(patch).eq('id', id);
            fail('update', error);
        },
    };
}

let deps: GuidedLinkDeps | undefined;
let warned = false;

/** The form's links, when the page is set up: the same public address and Supabase as the signing page. Null otherwise. */
export function guidedLinksFromEnv(): GuidedLinkDeps | null {
    const publicUrl = process.env.SIGNING_PUBLIC_URL?.trim();
    if (!publicUrl || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    // The link is the client's key to their claim: never over plain http, except on localhost.
    if (!/^https:\/\/[^/]+/.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(publicUrl)) {
        if (!warned) console.error(`[ClaimForm] SIGNING_PUBLIC_URL must be https://<host>; the guided form is off (got "${publicUrl}")`);
        warned = true;
        return null;
    }
    return (deps ??= { store: supabaseLinkStore(), publicUrl: publicUrl.replace(/\/$/, '') });
}

/**
 * CLAIMS_GUIDED_FORM: "on" sends every new claim the link; a list of numbers sends only those (for trying it on your own
 * phone); anything else, or nothing, keeps chat. Off by default, so merging changes nothing until it is switched on.
 */
export function guidedFormOn(raw: string | undefined, phone: string): boolean {
    const v = (raw ?? '').trim().toLowerCase();
    if (!v || v === 'off') return false;
    if (v === 'on') return true;
    const tail = (n: string) => n.replace(/\D/g, '').slice(-9);
    return v.split(/[\s,;]+/).some((n) => tail(n).length === 9 && tail(n) === tail(phone));
}
