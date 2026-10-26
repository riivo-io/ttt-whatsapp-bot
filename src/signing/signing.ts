/**
 * TTTFG-5196: TTT's own signing page. A caller (the claims agent today; tax approvals later) creates a request with a
 * PDF, its SHA-256, the channel and the number or address the link goes to, where to stamp, and a callback URL. The
 * client opens the link, reads the whole document and signs with their finger; the signed PDF and the audit trail go
 * back to the callback. It knows nothing about claims: what to sign, who it went to and who to tell are all the
 * caller's (TTTFG-5252, "the one wrong turn").
 *
 * - No one-time PIN: the link only goes to the caller's own channel, already tied to the client (decision 9 Oct 2026).
 * - The link carries a random 256-bit token; only its SHA-256 is stored. It works once, expires after 7 days, and a
 *   new request for the same caller record supersedes the open one, so the earlier link is refused.
 * - The document's hash is checked when the request is created and again at signing: a changed PDF is refused, so
 *   the signature is on exactly the document the client saw.
 * - Each signature records when, the IP address and browser, the channel and number or address the link went to, and
 *   both hashes (ECTA: an ordinary electronic signature with this record). The signed copy is flattened, so the
 *   signature can't be lifted off it.
 * - The callback is a POST of JSON signed with HMAC-SHA256 (header x-signing-signature) under a key of the caller's
 *   own (callerCallbackKey), so one caller can't forge another's callback. It goes once the signature is stored,
 *   without the client waiting for it (the caller files the copy and writes its records, which can take a while), and
 *   is retried until the caller answers 2xx: three times straight away, then by the signing-sweep cron, backing off
 *   for about 3 days. A delivery holds a lease (callback_next_at), so the same callback never runs twice at once.
 */
import crypto from 'crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { NewSigningRequest, SignatureAudit, SignChannel, SigningRequestRow, SigningStore, SignStamp } from './store';

export const LINK_DAYS = 7;
/** The callback is tried this often in all (three straight away, the rest by the cron, backing off) before it gives up. */
export const MAX_CALLBACK_ATTEMPTS = 20;
/** How long one delivery may take before the sweep may try the callback again. */
const CALLBACK_LEASE_MS = 10 * 60_000;
const CALLBACK_TIMEOUT_MS = 120_000;
const MAX_SIGNATURE_BYTES = 1_000_000;
/** The pad is at most about 1300 x 180 CSS pixels at 3x; anything bigger isn't from the page. */
const MAX_SIGNATURE_SIDE = 5000;
export const SIGNATURE_HEADER = 'x-signing-signature';

export interface SigningDeps {
    store: SigningStore;
    /** Where the page is served, for the link (https://host, no trailing slash). */
    publicUrl: string;
    /** The base key the callbacks are signed with; each caller's key is derived from it (callerCallbackKey). */
    callbackSecret: string;
    now?: () => Date;
    /** The callback POST (fetch by default). */
    post?: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; text: string }>;
    /** How long to wait between the immediate callback attempts (tests pass 0). */
    retryDelayMs?: number;
}

export interface CreateRequestInput {
    document: Uint8Array;
    documentHash: string;
    fileName: string;
    title: string;
    channel: SignChannel;
    sentTo: string;
    caller: string;
    callerRecordId: string;
    callbackUrl: string;
    stamps: SignStamp[];
}

export const sha256 = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const nowOf = (d: SigningDeps) => d.now?.() ?? new Date();

export class SigningError extends Error {}

/** Creates a request and returns its link. The caller's earlier open request for the same record stops working. */
export async function createSigningRequest(d: SigningDeps, input: CreateRequestInput): Promise<{ id: string; link: string; expiresAt: string }> {
    const bad = (why: string): never => { throw new SigningError(why); };
    if (!['whatsapp', 'email'].includes(input.channel)) bad(`channel must be whatsapp or email, not "${input.channel}"`);
    if (!input.sentTo?.trim()) bad('sentTo is missing: the number or address the link goes to');
    if (!input.caller?.trim() || !input.callerRecordId?.trim()) bad('caller and callerRecordId are needed');
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(input.callbackUrl ?? '')) bad('callbackUrl must be https');
    if (Buffer.from(input.document.subarray(0, 5)).toString('latin1') !== '%PDF-') bad('the document is not a PDF');
    if (sha256(input.document) !== input.documentHash) bad('documentHash is not the SHA-256 of the document');
    if (!input.stamps?.some((s) => s.kind === 'signature')) bad('stamps need at least one signature box');
    const pages = (await PDFDocument.load(input.document, { ignoreEncryption: true })).getPageCount();
    for (const s of input.stamps) if (!(s.page >= 1 && s.page <= pages)) bad(`a stamp is on page ${s.page}; the document has ${pages}`);

    const token = crypto.randomBytes(32).toString('base64url');
    const created = nowOf(d);
    const row: NewSigningRequest = {
        id: crypto.randomUUID(), token_hash: sha256(token), document_hash: input.documentHash, file_name: input.fileName, title: input.title,
        channel: input.channel, sent_to: input.sentTo.trim(), caller: input.caller, caller_record_id: input.callerRecordId, callback_url: input.callbackUrl,
        stamps: input.stamps, expires_at: new Date(created.getTime() + LINK_DAYS * 86_400_000).toISOString(), created_at: created.toISOString(),
    };
    await d.store.insert(row, input.document);
    await d.store.supersedeOpen(row.caller, row.caller_record_id, row.created_at);
    return { id: row.id, link: `${d.publicUrl.replace(/\/$/, '')}/sign/${token}`, expiresAt: row.expires_at };
}

export type Refusal = 'not-found' | 'expired' | 'used' | 'superseded';
export type Opened = { ok: true; row: SigningRequestRow } | { ok: false; reason: Refusal };

/** The request behind a link, or why the link is refused. The first open is recorded. */
export async function openSigningRequest(d: SigningDeps, token: string, o: { record?: boolean } = {}): Promise<Opened> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { ok: false, reason: 'not-found' };
    const row = await d.store.byTokenHash(sha256(token));
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status === 'used') return { ok: false, reason: 'used' };
    if (row.status === 'superseded') return { ok: false, reason: 'superseded' };
    if (row.status === 'expired' || Date.parse(row.expires_at) <= nowOf(d).getTime()) {
        if (row.status === 'open') await d.store.update(row.id, { status: 'expired' });
        return { ok: false, reason: 'expired' };
    }
    if (o.record !== false && !row.opened_at) {
        row.opened_at = nowOf(d).toISOString();
        await d.store.update(row.id, { opened_at: row.opened_at });
    }
    return { ok: true, row };
}

export type Signed =
    /** `delivery`: the callback, still running when the client is told; true when the caller took it. */
    | { ok: true; requestId: string; delivery: Promise<boolean> }
    | { ok: false; reason: Refusal | 'changed' | 'bad-signature' };

/** The client signs: stamp, store, mark used, and tell the caller (in the background). */
export async function signRequest(d: SigningDeps, token: string, s: { signature: string; ip: string | null; userAgent: string | null }): Promise<Signed> {
    const opened = await openSigningRequest(d, token, { record: false });
    if (!opened.ok) return opened;
    const row = opened.row;
    const png = signaturePng(s.signature);
    if (!png) return { ok: false, reason: 'bad-signature' };

    // The hash again: the client signs exactly the document they were shown.
    const unsigned = await d.store.unsignedPdf(row);
    if (sha256(unsigned) !== row.document_hash) return { ok: false, reason: 'changed' };

    const signedAt = nowOf(d);
    const signed = await stampPdf(unsigned, row.stamps, png, signedAt, { title: row.title, requestId: row.id });
    const audit: SignatureAudit = {
        requestId: row.id, signedAt: signedAt.toISOString(), ip: s.ip, userAgent: s.userAgent?.slice(0, 400) ?? null,
        channel: row.channel, sentTo: row.sent_to, documentHash: row.document_hash, signedHash: sha256(signed),
        linkCreatedAt: row.created_at, openedAt: row.opened_at,
    };
    // A copy of its own: a second signature at the same moment (two tabs) can't overwrite the one the row names.
    const signedPath = await d.store.saveSignedPdf(row, signed, audit.signedHash);
    // The delivery below holds the lease, so the sweep leaves this callback alone while it runs.
    const lease = new Date(signedAt.getTime() + CALLBACK_LEASE_MS).toISOString();
    const patch: Partial<SigningRequestRow> = { signed_at: audit.signedAt, signed_path: signedPath, audit, callback_status: 'pending', callback_next_at: lease };
    if (!(await d.store.markUsed(row.id, patch))) {
        // Another signature, a newer request or the expiry got there first: say which.
        const now = await openSigningRequest(d, token, { record: false });
        return { ok: false, reason: now.ok ? 'used' : now.reason };
    }
    const delivery = deliverCallback(d, { ...row, ...patch, status: 'used' }, signed, 3)
        .catch((e) => { console.error(`[Signing] callback for ${row.id} failed: ${(e as Error).message}`); return false; });
    return { ok: true, requestId: row.id, delivery };
}

/** A PNG from the page's data URL, or null. */
export function signaturePng(dataUrl: string): Uint8Array | null {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '');
    if (!m) return null;
    const bytes = Buffer.from(m[1], 'base64');
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 100 || bytes.length > MAX_SIGNATURE_BYTES || PNG.some((b, i) => bytes[i] !== b)) return null;
    // The size it says it is (IHDR), before pdf-lib unpacks every pixel: a small file can claim to be enormous.
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (bytes.toString('latin1', 12, 16) !== 'IHDR' || !width || !height || width > MAX_SIGNATURE_SIDE || height > MAX_SIGNATURE_SIDE) return null;
    return new Uint8Array(bytes);
}

// ------------------------------------------------------------------------------------------------- stamping

const SAST = 'Africa/Johannesburg';
export function formatDate(d: Date, format: 'date' | 'day' | 'month' | 'yy' = 'date'): string {
    const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: SAST, ...o }).format(d);
    if (format === 'day') return part({ day: 'numeric' });
    if (format === 'month') return part({ month: 'long' });
    if (format === 'yy') return part({ year: '2-digit' });
    return part({ day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * The signed copy: the form flattened (its boxes become part of the page, so nothing can be changed or lifted off),
 * the signature drawn into each signature box (fitted, sitting on the box's bottom edge) and the date written at
 * each date stamp. The request id and time go in the PDF's metadata.
 */
export async function stampPdf(pdf: Uint8Array, stamps: SignStamp[], png: Uint8Array, signedAt: Date, meta: { title: string; requestId: string }): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
    try {
        doc.getForm().flatten();
    } catch (e) {
        // A form pdf-lib can't flatten keeps its boxes; the stamps are still drawn on the pages.
        console.warn(`[Signing] could not flatten ${meta.requestId}: ${(e as Error).message}`);
    }
    const image = await doc.embedPng(png);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    for (const s of stamps) {
        const page = pages[s.page - 1];
        if (!page) continue;
        if (s.kind === 'signature') {
            const scale = Math.min(s.width / image.width, s.height / image.height);
            page.drawImage(image, { x: s.x, y: s.y, width: image.width * scale, height: image.height * scale });
        } else {
            const text = formatDate(signedAt, s.format);
            let size = s.size;
            while (s.maxWidth && size > 6 && font.widthOfTextAtSize(text, size) > s.maxWidth) size -= 0.25;
            page.drawText(text, { x: s.x, y: s.y, size, font });
        }
    }
    doc.setSubject(`${meta.title}. Signed electronically on ${signedAt.toISOString()} (signing request ${meta.requestId}).`);
    doc.setModificationDate(signedAt);
    return doc.save();
}

// ------------------------------------------------------------------------------------------------- the callback

const defaultPost: NonNullable<SigningDeps['post']> = async (url, body, headers) => {
    const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) });
    return { ok: res.ok, status: res.status, text: (await res.text().catch(() => '')).slice(0, 500) };
};

/** A caller's own callback key: what signs (and checks) its callbacks. Another caller's key can't make one. */
export const callerCallbackKey = (secret: string, caller: string) => crypto.createHmac('sha256', secret).update(`caller:${caller}`).digest('hex');
export const callbackSignature = (body: string, key: string) => crypto.createHmac('sha256', key).update(body).digest('hex');

/** After the n-th failed attempt, the wait before the next: 5 minutes, doubling, at most 6 hours (about 3 days in all). */
const backoffMs = (attempts: number) => Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.max(0, attempts - 3));

/**
 * POSTs the signed PDF and the audit to the caller, up to `attempts` times now (the caller holds the lease). Returns
 * whether the caller took it. A failure sets when to try next; after MAX_CALLBACK_ATTEMPTS it gives up and says so.
 */
export async function deliverCallback(d: SigningDeps, row: SigningRequestRow, signed?: Uint8Array, attempts = 1): Promise<boolean> {
    let tried = row.callback_attempts;
    let error = '';
    try {
        const pdf = signed ?? (await d.store.signedPdf(row));
        const body = JSON.stringify({
            requestId: row.id, caller: row.caller, callerRecordId: row.caller_record_id, fileName: row.file_name,
            signedPdf: Buffer.from(pdf).toString('base64'), audit: row.audit,
        });
        const headers = { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: callbackSignature(body, callerCallbackKey(d.callbackSecret, row.caller)) };
        for (let i = 0; i < attempts && tried < MAX_CALLBACK_ATTEMPTS; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, (d.retryDelayMs ?? 2000) * i));
            tried++;
            try {
                const res = await (d.post ?? defaultPost)(row.callback_url, body, headers);
                if (res.ok) {
                    await d.store.update(row.id, { callback_status: 'done', callback_attempts: tried, callback_error: null, callback_next_at: null });
                    return true;
                }
                error = `HTTP ${res.status} ${res.text}`;
            } catch (e) {
                error = (e as Error).message;
            }
        }
    } catch (e) {
        error = `could not read the signed copy: ${(e as Error).message}`;
    }
    const givenUp = tried >= MAX_CALLBACK_ATTEMPTS;
    const next = givenUp ? null : new Date(nowOf(d).getTime() + backoffMs(tried)).toISOString();
    console.error(givenUp
        ? `[Signing] GAVE UP on the callback for ${row.id} (${row.caller} ${row.caller_record_id}) after ${tried} attempts: ${error}. The client has signed; the caller never took it.`
        : `[Signing] callback for ${row.id} not taken (${tried} attempts, next ${next}): ${error}`);
    await d.store.update(row.id, { callback_status: 'failed', callback_attempts: tried, callback_error: error.slice(0, 500), callback_next_at: next });
    return false;
}

/**
 * The signing-sweep cron: open requests past 7 days expire, and callbacks that are due are tried again, each under its
 * own lease (an overlapping sweep or a delivery still running skips it). One that fails doesn't stop the rest.
 */
export async function sweepSigning(d: SigningDeps): Promise<{ expired: number; delivered: number; failed: number }> {
    const now = nowOf(d);
    const expired = await d.store.expireOpen(now);
    let delivered = 0;
    let failed = 0;
    for (const row of await d.store.pendingCallbacks(now)) {
        try {
            const lease = new Date(now.getTime() + CALLBACK_LEASE_MS).toISOString();
            if (!(await d.store.leaseCallback(row.id, row.callback_next_at, lease))) continue;
            if (await deliverCallback(d, { ...row, callback_next_at: lease })) delivered++;
            else failed++;
        } catch (e) {
            failed++;
            console.error(`[Signing] sweep: ${row.id}: ${(e as Error).message}`);
        }
    }
    return { expired, delivered, failed };
}
