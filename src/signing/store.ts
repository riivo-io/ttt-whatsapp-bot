/**
 * TTTFG-5196: where the signing page keeps its requests and their PDFs. Supabase in Tina (table signing_requests and
 * the private storage bucket "signing", migration 20261027120000_signing_requests.sql); in memory for the tests and
 * the terminal rehearsal. Nothing here knows what is being signed.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Where the page stamps, in PDF points from the page's bottom-left, 1-based page (the caller works it out). A signature
 * is fitted into its box; a date is written with its baseline at x, y, smaller when it's wider than `maxWidth`.
 */
export type SignStamp =
    | { kind: 'signature'; page: number; x: number; y: number; width: number; height: number }
    | { kind: 'date'; page: number; x: number; y: number; size: number; maxWidth?: number; format?: 'date' | 'day' | 'month' | 'yy' };

export type SignChannel = 'whatsapp' | 'email';
export type RequestStatus = 'open' | 'used' | 'expired' | 'superseded';

/** What the page records with a signature, and sends with the callback. */
export interface SignatureAudit {
    requestId: string;
    signedAt: string;
    ip: string | null;
    userAgent: string | null;
    channel: SignChannel;
    /** The number or address the link was sent to. */
    sentTo: string;
    /** SHA-256 of the unsigned PDF, as created and as checked again at signing. */
    documentHash: string;
    signedHash: string;
    linkCreatedAt: string;
    openedAt: string | null;
}

export interface SigningRequestRow {
    id: string;
    /** SHA-256 of the link's token: the token itself is never stored. */
    token_hash: string;
    document_path: string;
    document_hash: string;
    file_name: string;
    title: string;
    channel: SignChannel;
    sent_to: string;
    /** Who asked, for example "claim", and their record. */
    caller: string;
    caller_record_id: string;
    callback_url: string;
    stamps: SignStamp[];
    status: RequestStatus;
    expires_at: string;
    created_at: string;
    opened_at: string | null;
    signed_at: string | null;
    signed_path: string | null;
    audit: SignatureAudit | null;
    callback_status: 'pending' | 'done' | 'failed' | null;
    callback_attempts: number;
    callback_error: string | null;
}

export type NewSigningRequest = Omit<SigningRequestRow,
    'document_path' | 'status' | 'opened_at' | 'signed_at' | 'signed_path' | 'audit' | 'callback_status' | 'callback_attempts' | 'callback_error'>;

export interface SigningStore {
    insert(row: NewSigningRequest, pdf: Uint8Array): Promise<SigningRequestRow>;
    byTokenHash(tokenHash: string): Promise<SigningRequestRow | null>;
    unsignedPdf(row: SigningRequestRow): Promise<Uint8Array>;
    signedPdf(row: SigningRequestRow): Promise<Uint8Array>;
    /** Marks the caller record's open requests superseded (all but `exceptId`); returns how many. */
    supersedeOpen(caller: string, callerRecordId: string, exceptId: string): Promise<number>;
    update(id: string, patch: Partial<SigningRequestRow>): Promise<void>;
    saveSignedPdf(row: SigningRequestRow, pdf: Uint8Array): Promise<string>;
    /** open to used, only if still open: false when another signature got there first. */
    markUsed(id: string, patch: Partial<SigningRequestRow>): Promise<boolean>;
    /** Signed requests whose callback hasn't been answered, oldest first. */
    pendingCallbacks(maxAttempts: number): Promise<SigningRequestRow[]>;
    /** Open requests past their expiry become expired; returns how many. */
    expireOpen(now: Date): Promise<number>;
}

// ------------------------------------------------------------------------------------------------- in memory

export function memorySigningStore(): SigningStore & { rows: Map<string, SigningRequestRow>; files: Map<string, Uint8Array> } {
    const rows = new Map<string, SigningRequestRow>();
    const files = new Map<string, Uint8Array>();
    const copy = (r: SigningRequestRow): SigningRequestRow => JSON.parse(JSON.stringify(r));
    return {
        rows,
        files,
        async insert(row, pdf) {
            const document_path = `${row.id}/unsigned.pdf`;
            files.set(document_path, pdf);
            const full: SigningRequestRow = {
                ...row, document_path, status: 'open', opened_at: null, signed_at: null, signed_path: null, audit: null,
                callback_status: null, callback_attempts: 0, callback_error: null,
            };
            rows.set(row.id, full);
            return copy(full);
        },
        async byTokenHash(h) {
            const r = [...rows.values()].find((x) => x.token_hash === h);
            return r ? copy(r) : null;
        },
        async unsignedPdf(r) { return files.get(r.document_path)!; },
        async signedPdf(r) { return files.get(r.signed_path!)!; },
        async supersedeOpen(caller, recordId, exceptId) {
            let n = 0;
            for (const r of rows.values()) {
                if (r.caller === caller && r.caller_record_id === recordId && r.status === 'open' && r.id !== exceptId) { r.status = 'superseded'; n++; }
            }
            return n;
        },
        async update(id, patch) { Object.assign(rows.get(id)!, patch); },
        async saveSignedPdf(r, pdf) {
            const p = `${r.id}/signed.pdf`;
            files.set(p, pdf);
            return p;
        },
        async markUsed(id, patch) {
            const r = rows.get(id);
            if (!r || r.status !== 'open') return false;
            Object.assign(r, patch, { status: 'used' });
            return true;
        },
        async pendingCallbacks(max) {
            return [...rows.values()].filter((r) => (r.callback_status === 'pending' || r.callback_status === 'failed') && r.callback_attempts < max).map(copy);
        },
        async expireOpen(now) {
            let n = 0;
            for (const r of rows.values()) if (r.status === 'open' && Date.parse(r.expires_at) <= now.getTime()) { r.status = 'expired'; n++; }
            return n;
        },
    };
}

// ------------------------------------------------------------------------------------------------- Supabase

const TABLE = 'signing_requests';
const BUCKET = 'signing';

export function supabaseSigningStore(client: SupabaseClient = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '')): SigningStore {
    const fail = (what: string, e: { message: string } | null) => {
        if (e) throw new Error(`[Signing] ${what}: ${e.message}`);
    };
    const upload = async (path: string, pdf: Uint8Array) => {
        const { error } = await client.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
        fail(`upload ${path}`, error);
        return path;
    };
    const download = async (path: string) => {
        const { data, error } = await client.storage.from(BUCKET).download(path);
        fail(`download ${path}`, error);
        return new Uint8Array(await data!.arrayBuffer());
    };
    return {
        async insert(row, pdf) {
            const document_path = await upload(`${row.id}/unsigned.pdf`, pdf);
            const { data, error } = await client.from(TABLE).insert({ ...row, document_path, status: 'open' }).select().single();
            fail('insert', error);
            return data as SigningRequestRow;
        },
        async byTokenHash(h) {
            const { data, error } = await client.from(TABLE).select('*').eq('token_hash', h).maybeSingle();
            fail('byTokenHash', error);
            return (data as SigningRequestRow | null) ?? null;
        },
        unsignedPdf: (r) => download(r.document_path),
        signedPdf: (r) => download(r.signed_path!),
        async supersedeOpen(caller, recordId, exceptId) {
            const { data, error } = await client.from(TABLE).update({ status: 'superseded' })
                .eq('caller', caller).eq('caller_record_id', recordId).eq('status', 'open').neq('id', exceptId).select('id');
            fail('supersedeOpen', error);
            return data?.length ?? 0;
        },
        async update(id, patch) {
            const { error } = await client.from(TABLE).update(patch).eq('id', id);
            fail('update', error);
        },
        saveSignedPdf: (r, pdf) => upload(`${r.id}/signed.pdf`, pdf),
        async markUsed(id, patch) {
            const { data, error } = await client.from(TABLE).update({ ...patch, status: 'used' }).eq('id', id).eq('status', 'open').select('id');
            fail('markUsed', error);
            return (data?.length ?? 0) === 1;
        },
        async pendingCallbacks(max) {
            const { data, error } = await client.from(TABLE).select('*').in('callback_status', ['pending', 'failed'])
                .lt('callback_attempts', max).order('signed_at', { ascending: true }).limit(50);
            fail('pendingCallbacks', error);
            return (data as SigningRequestRow[]) ?? [];
        },
        async expireOpen(now) {
            const { data, error } = await client.from(TABLE).update({ status: 'expired' }).eq('status', 'open').lte('expires_at', now.toISOString()).select('id');
            fail('expireOpen', error);
            return data?.length ?? 0;
        },
    };
}
