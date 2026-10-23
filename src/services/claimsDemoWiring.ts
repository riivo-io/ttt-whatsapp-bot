/**
 * TTTFG-4830 (claims demo): the claims package's ports against the demo CRM (TTT DEV), shared by Tina
 * (claimsDemo.service.ts) and the terminal rehearsal (src/scripts/claims-demo-chat.ts). The caller passes the raw
 * channels (a Dataverse call, a Graph call, WhatsApp text and document sends, WhatsApp media); everything else is the
 * package's own Dataverse adapters, so the demo writes what production will write:
 *  - the claim, its answers, its documents and agent actions (resume-dataverse.ts, followon-dataverse.ts);
 *  - client files in the client's SharePoint claim folder: Contact library / <client folder> / Claims / CLM-… (the
 *    store-and-register stand-in until the WhatsApp document pipeline, TTTFG-4945);
 *  - the filled claim form (TTTFG-5192, fill-dataverse.ts), re-filled when a form answer changes before signing (AC 6);
 *  - the signing step: until the signing page (TTTFG-5196), the demo sends the filled PDF on WhatsApp for the client to
 *    look at and answers notAvailable, so the claim status doesn't change and Tina moves on to the evidence.
 */
import type { Dv } from '../departments/insurance/dataverse';
import { dataverseFillPorts, type ClaimFormFiles } from '../departments/insurance/fill-dataverse';
import { CLAIM_STATUSES, type ClaimFileStore } from '../departments/insurance/followon-dataverse';
import type { ResumePorts } from '../departments/insurance/resume';
import { dataverseResumePorts, OPEN_STATUS_FILTER } from '../departments/insurance/resume-dataverse';
import { onClaimChanged, requestClaimSignature, type SigningStep } from '../departments/insurance/signature-fill';

const OPT = 463630000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (id: string) => {
    if (!GUID.test(id)) throw new Error(`Not a Dataverse id: ${id}`);
    return id;
};

// ------------------------------------------------------------------------------------------------- Dataverse calls

/** How the CRM was used for one message: logged by Tina, counted by the load test. */
export interface CrmStats { reads: number; cached: number; writes: number; throttled: number }
export const newCrmStats = (): CrmStats => ({ reads: 0, cached: 0, writes: 0, throttled: 0 });

const MAX_THROTTLE_RETRIES = 3;

/**
 * One Dataverse Web API call, with a deadline, and a "too many requests" (HTTP 429, Dataverse's service protection
 * limits) waited out as the CRM asks (Retry-After, at most 30s, up to 3 times) rather than failing the message. A
 * refused request was never carried out, so retrying a write is safe. A read past the deadline is tried once more.
 */
export function dataverseCall(
    baseUrl: string, token: () => Promise<string> | string, o: { deadlineMs?: number; stats?: CrmStats } = {},
): Dv {
    const base = baseUrl.replace(/\/$/, '');
    return (async <T,>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, opts: { formatted?: boolean; returnRow?: boolean } = {}) => {
        const prefer = [opts.formatted ? 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' : '', opts.returnRow ? 'return=representation' : ''].filter(Boolean).join(', ');
        let timedOut = false;
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                res = await fetch(`${base}/api/data/v9.2/${path}`, {
                    method,
                    signal: AbortSignal.timeout(o.deadlineMs ?? 20_000),
                    headers: {
                        Authorization: `Bearer ${await token()}`, Accept: 'application/json', 'Content-Type': 'application/json',
                        'OData-Version': '4.0', 'OData-MaxVersion': '4.0', ...(method === 'PATCH' ? { 'If-Match': '*' } : {}), ...(prefer ? { Prefer: prefer } : {}),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
            } catch (e) {
                // A read that ran past the deadline is tried once more (the load test saw the odd slow read). A write is
                // not: it may have been carried out.
                if (method === 'GET' && !timedOut && (e as Error).name === 'TimeoutError') { timedOut = true; continue; }
                throw e;
            }
            if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
                const after = Number(res.headers.get('Retry-After'));
                if (o.stats) o.stats.throttled++;
                await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(1000, (Number.isFinite(after) && after > 0 ? after : 5) * 1000))));
                continue;
            }
            if (!res.ok) {
                const err = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? '';
                throw new Error(`Dataverse ${method} ${path.split('?')[0]} ${res.status} ${err.slice(0, 300)}`);
            }
            return (res.status === 204 ? undefined : await res.json()) as T;
        }
    }) as Dv;
}

/** Reads that hardly ever change, kept across messages for SHARED_TTL_MS: claim forms, document types, contacts' names. */
const SHARED_SETS = new Set(['riivo_claimforms', 'riivo_documenttypes', 'contacts']);
const SHARED_TTL_MS = 10 * 60_000;
const shared = new Map<string, { at: number; value: Promise<unknown> }>();
/** The table a Web API path is about: `riivo_claims(…)`, `riivo_claims?$filter=…` → riivo_claims. */
const tableOf = (path: string) => path.split(/[(?/]/)[0];

/**
 * The claims package reads the same rows several times while handling one message (the claim, its documents, its claim
 * form, the client's open claims: about 18 reads for 2 writes). This keeps each read for the rest of the message, so
 * each row is read once. Any write to a table drops what was read from that table, so a read after a write is always
 * fresh; other tables are untouched by it. Callers get their own copy of each result. One per message: nothing but
 * SHARED_SETS outlives it.
 */
export function cachedDv(dv: Dv, stats?: CrmStats, now: () => number = Date.now): Dv {
    const mine = new Map<string, Promise<unknown>>();
    const forget = (table: string) => {
        for (const k of [...mine.keys()]) if (tableOf(k.slice(2)) === table) mine.delete(k);
        if (SHARED_SETS.has(table)) for (const k of [...shared.keys()]) if (tableOf(k.slice(2)) === table) shared.delete(k);
    };
    return (async <T,>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, opts: { formatted?: boolean; returnRow?: boolean } = {}) => {
        const table = tableOf(path);
        if (method !== 'GET') {
            forget(table);
            if (stats) stats.writes++;
            return dv<T>(method, path, body, opts);
        }
        const key = `${opts.formatted ? 'F' : '-'} ${path}`;
        const kept = SHARED_SETS.has(table) ? shared.get(key) : undefined;
        let value = kept && now() - kept.at < SHARED_TTL_MS ? kept.value : mine.get(key);
        if (value) {
            if (stats) stats.cached++;
        } else {
            if (stats) stats.reads++;
            const read = dv<T>('GET', path, undefined, opts);
            read.catch(() => { mine.delete(key); shared.delete(key); });
            mine.set(key, read);
            if (SHARED_SETS.has(table)) shared.set(key, { at: now(), value: read });
            value = read;
        }
        return structuredClone(await value) as T;
    }) as Dv;
}

/** Test use only: forget the cross-message reads. */
export const clearSharedCrmCache = () => shared.clear();

/** One Microsoft Graph call (v1.0 path or absolute URL), authenticated by the caller. */
export type Graph = (method: 'GET' | 'PUT', path: string, body?: Uint8Array, contentType?: string) => Promise<Response>;

export interface DemoChannels {
    dv: Dv;
    graph: Graph;
    /** The SharePoint site with the client folders, as Graph names it: 'host:/sites/Name'. */
    site: string;
    sendText(to: string, text: string): Promise<void>;
    sendDocument(to: string, bytes: Buffer, fileName: string, caption: string): Promise<void>;
    /** A WhatsApp media item's bytes (Meta keeps them for 30 days, so a file held for later still downloads). */
    mediaBytes(mediaId: string): Promise<Buffer>;
    /** Where the blank insurer form comes from when SharePoint won't give it (the rehearsal's local copies). */
    blankFormFallback?(formUrl: string): Promise<Uint8Array | null>;
    /** The rehearsal prints what happens; Tina logs it. */
    note?(text: string): void;
}

export const FORM_CAPTION = "Here's your claim form, filled in from your answers. Please have a look. "
    + 'Any box I left blank is one your broker will complete with you.';

const shareId = (url: string) => `u!${Buffer.from(url).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
/** The folder name Dynamics gives a contact in SharePoint: "<full name>_<CONTACTID>". */
export const contactFolderName = (fullName: string, contactId: string) =>
    `${fullName.replace(/["*:<>?/\\|#%&{}~]/g, '').replace(/\s+/g, ' ').trim()}_${contactId.replace(/-/g, '').toUpperCase()}`;
const cleanName = (s: string) => s.replace(/["*:<>?/\\|#%&{}~]/g, '-').trim() || 'file';

/** The client's SharePoint claim folder: evidence files and the filled claim form. */
export function claimFolders(ch: DemoChannels): { files: ClaimFileStore; forms: ClaimFormFiles } {
    let drive: Promise<string> | undefined;
    const driveId = () => (drive ??= (async () => {
        const site = await ch.graph('GET', `/sites/${ch.site}?$select=id`);
        if (!site.ok) throw new Error(`SharePoint site ${ch.site}: HTTP ${site.status}`);
        const { id } = (await site.json()) as { id: string };
        const drives = (await (await ch.graph('GET', `/sites/${id}/drives?$select=id,name,webUrl`)).json()) as { value: { id: string; name: string; webUrl: string }[] };
        const d = drives.value.find((x) => /\/contact$/i.test(x.webUrl)) ?? drives.value.find((x) => x.name === 'Contact');
        if (!d) throw new Error(`No Contact library on ${ch.site}`);
        return d.id;
    })().catch((e) => { drive = undefined; throw e; }));

    const put = async (path: string, bytes: Uint8Array, contentType: string): Promise<string> => {
        const res = await ch.graph('PUT', path, bytes, contentType);
        if (!res.ok) throw new Error(`SharePoint upload: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return ((await res.json()) as { webUrl: string }).webUrl;
    };
    const folder = (to: { contactId: string; contactName: string; claimReference: string }) =>
        [contactFolderName(to.contactName, to.contactId), 'Claims', to.claimReference].map(encodeURIComponent).join('/');

    return {
        files: {
            async put(file, to) {
                const bytes = await ch.mediaBytes(file.id);
                const link = await put(`/drives/${await driveId()}/root:/${folder(to)}/${encodeURIComponent(cleanName(file.fileName))}:/content?@microsoft.graph.conflictBehavior=rename`,
                    new Uint8Array(bytes), file.mimeType);
                ch.note?.(`SharePoint: ${file.fileName} filed in ${to.claimReference}`);
                return link;
            },
        },
        forms: {
            async save(to, fileName, bytes, replaces) {
                const drive = await driveId();
                let path = `/drives/${drive}/root:/${folder(to)}/${encodeURIComponent(cleanName(fileName))}:/content?@microsoft.graph.conflictBehavior=replace`;
                if (replaces) {
                    // TTTFG-5248 step 8: overwrite the very item the claim's document row links to.
                    const item = await ch.graph('GET', `/shares/${shareId(replaces)}/driveItem?$select=id`);
                    if (item.ok) path = `/drives/${drive}/items/${((await item.json()) as { id: string }).id}/content`;
                }
                const fileRef = await put(path, bytes, 'application/pdf');
                ch.note?.(`SharePoint: ${fileName} ${replaces ? 'replaced' : 'filed'} in ${to.claimReference}`);
                return { fileRef };
            },
        },
    };
}

/**
 * The insurer's blank PDF from its riivo_formurl: Graph's download link, else Graph's content route, else the caller's
 * fallback. (A delegated `az login` token reads the item but may be refused the bytes; Tina's app token is not.)
 */
export async function blankForm(ch: DemoChannels, formUrl: string): Promise<Uint8Array> {
    const why: string[] = [];
    try {
        const meta = await ch.graph('GET', `/shares/${shareId(formUrl)}/driveItem`);
        const url = meta.ok ? ((await meta.json()) as { '@microsoft.graph.downloadUrl'?: string })['@microsoft.graph.downloadUrl'] : undefined;
        why.push(`item HTTP ${meta.status}`);
        if (url) {
            const res = await fetch(url);
            if (res.ok) return new Uint8Array(await res.arrayBuffer());
            why.push(`download link HTTP ${res.status}`);
        }
        const content = await ch.graph('GET', `/shares/${shareId(formUrl)}/driveItem/content`);
        if (content.ok) return new Uint8Array(await content.arrayBuffer());
        why.push(`content HTTP ${content.status}`);
    } catch (e) {
        why.push((e as Error).message);
    }
    ch.note?.(`Blank form not downloaded from SharePoint (${why.join(', ')})`);
    const local = await ch.blankFormFallback?.(formUrl);
    if (local) return local;
    throw new Error(`The blank claim form could not be read: ${formUrl}`);
}

/** The demo's signing step: the filled form goes to the client on WhatsApp to look at; nothing to sign yet. */
export const demoSigningStep = (ch: DemoChannels, phone: string, sent?: (text: string) => void): SigningStep => async (_claimId, doc) => {
    await ch.sendDocument(phone, Buffer.from(doc.bytes), doc.fileName, FORM_CAPTION);
    sent?.(FORM_CAPTION);
    ch.note?.(`WhatsApp: ${doc.fileName} sent to the client (signing page TTTFG-5196 not built: notAvailable)`);
    return 'notAvailable';
};

/**
 * The package's ports for one conversation. `contactId` is the demo number's contact: the number lookup is replaced,
 * because a demo number may sit on several test contacts in DEV (an ambiguous number opens no claim).
 */
export function demoPorts(ch: DemoChannels, phone: string, contactId: string, sent: (text: string) => void): ResumePorts {
    const { files, forms } = claimFolders(ch);
    const fill = dataverseFillPorts({ dv: ch.dv, files: forms, blankForm: (url) => blankForm(ch, url), signingStep: demoSigningStep(ch, phone, sent) });
    const sign = requestClaimSignature(fill);
    const base = dataverseResumePorts({
        dv: ch.dv,
        files,
        // A fill that fails (the blank PDF unreachable, say) must not stop the conversation: Tina goes on to the
        // evidence and the broker fills the form. The error is logged.
        requestClaimSignature: async (claimId) => {
            try {
                return await sign(claimId);
            } catch (e) {
                console.error(`[ClaimsDemo] Claim form fill failed for ${claimId}:`, (e as Error).message);
                ch.note?.(`Claim form not filled (${(e as Error).message}): Tina moves on to the evidence`);
                return 'notAvailable';
            }
        },
        send: async (to, m) => {
            // Templates (the duty of disclosure, the deadline note) go as text: the client is inside the 24-hour window.
            await ch.sendText(to, m.text);
            sent(m.text);
        },
    });
    let contact: Promise<{ id: string; firstName: string }> | undefined;
    return {
        ...base,
        contactByWhatsApp: () => (contact ??= ch.dv<{ firstname?: string; fullname?: string }>('GET', `contacts(${guid(contactId)})?$select=firstname,fullname`)
            .then((c) => ({ id: contactId, firstName: (c.firstname || c.fullname || '').trim().split(/\s+/)[0] || 'there' }))),
        // AC 6 (TTTFG-5192): a form answer that changes after the form was filled, before signing, fills it again.
        async saveAnswers(claimId, answers) {
            const before = (await base.loadClaim(claimId)).answers;
            await base.saveAnswers(claimId, answers);
            const r = await onClaimChanged(fill, claimId, { columns: ['riivo_answers'], answersBefore: before, answersAfter: answers });
            if ('refilled' in r) ch.note?.(`Claim form filled again after an answer changed (${claimId})`);
        },
    };
}

/** A new claim conversation's riivo_request (Insurance, topic Claim), as Tina's claims path opens it. */
export async function openDemoRequest(dv: Dv, contactId: string, phone: string, text: string): Promise<string | null> {
    try {
        const r = await dv<{ riivo_requestid: string }>('POST', 'riivo_requests?$select=riivo_requestid', {
            riivo_clientmobilenumber: phone, riivo_channel: 1, riivo_category: 1, riivo_priority: 1, riivo_description: text.slice(0, 100),
            riivo_classificationtopic: 'Claim', statecode: 0, statuscode: 1, 'riivo_Client@odata.bind': `/contacts(${guid(contactId)})`,
        }, { returnRow: true });
        return r.riivo_requestid;
    } catch (e) {
        console.error('[ClaimsDemo] Could not open the claim request:', (e as Error).message);
        return null;
    }
}

/** "#reset": the demo client's open claims go to Withdrawn. Nothing is deleted. */
export async function withdrawOpenClaims(dv: Dv, contactId: string): Promise<string[]> {
    const r = await dv<{ value: { riivo_claimid: string; riivo_name: string }[] }>('GET',
        `riivo_claims?$select=riivo_claimid,riivo_name&$filter=_riivo_contact_value eq ${guid(contactId)} and ${OPEN_STATUS_FILTER}`);
    const withdrawn = OPT + CLAIM_STATUSES.indexOf('Withdrawn');
    for (const c of r.value) await dv('PATCH', `riivo_claims(${c.riivo_claimid})`, { riivo_claimstatus: withdrawn });
    return r.value.map((c) => c.riivo_name);
}
