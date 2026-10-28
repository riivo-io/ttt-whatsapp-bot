/**
 * WhatsApp messages on the client's own timeline, for the rows Tina logged before she put the client on them herself
 * (src/domain/whatsappLog.ts WhatsAppParty). A message filed under a request or a claim showed only there; with the
 * client as its From (the client's message) or To (Tina's), it shows on the contact's or lead's timeline too.
 *
 * Only rows filed under a request (its client, else its lead) or a claim (its contact) with no one but the system's
 * own owner and regarding entries on them yet. Rows filed under the contact or lead already show there; rows TTT's
 * flows write already carry the client as To. Nothing else on a row changes.
 *
 * Dry run by default: counts what it would change, with a few examples. --apply writes. Safe to run again: a row that
 * has its client is skipped.
 *
 *   npx tsx src/scripts/whatsapp-on-contact-backfill.ts --org https://tttdevelopment.crm4.dynamics.com
 *   npx tsx src/scripts/whatsapp-on-contact-backfill.ts --org https://<org>.crm4.dynamics.com --since 2026-01-01 --apply
 *
 * Sign-in: `az login` as someone who can write WhatsApp communications in that CRM.
 */
import { execFileSync } from 'child_process';
import type { WhatsAppParty } from '../domain/whatsappLog';
import { dataverseCall } from '../services/claimsDemoWiring';

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ORG = (arg('--org') ?? '').replace(/\/$/, '');
const SINCE = arg('--since');
const APPLY = args.includes('--apply');
if (!/^https:\/\/[a-z0-9-]+\.crm\d*\.dynamics\.com$/.test(ORG)) {
    console.error('Usage: whatsapp-on-contact-backfill.ts --org https://<org>.crm4.dynamics.com [--since YYYY-MM-DD] [--apply]');
    process.exit(2);
}
if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) throw new Error('--since is a date, YYYY-MM-DD');

let token: { value: string; until: number } | undefined;
function azToken(): string {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const j = JSON.parse(execFileSync('az', ['account', 'get-access-token', '--resource', ORG, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as
        { accessToken: string; expires_on?: number; expiresOn: string };
    token = { value: j.accessToken, until: j.expires_on ? j.expires_on * 1000 : Date.parse(j.expiresOn) };
    return token.value;
}
const dv = dataverseCall(ORG, azToken);

const INCOMING = 463630000;
const FROM = 1;
const TO = 2;
/** The entries the CRM puts on every activity itself: the regarding record (8) and the owner (9). */
const SYSTEM_PARTIES = new Set([8, 9]);

type Row = {
    activityid: string; createdon: string; riivo_messagedirection: number | null;
    riivo_WhatsAppCommunications_activity_parties: { participationtypemask: number }[];
    regardingobjectid_riivo_request: { _riivo_client_value: string | null; _riivo_lead_value: string | null } | null;
    regardingobjectid_riivo_claim: { _riivo_contact_value: string | null } | null;
};
const SELECT = 'riivo_whatsappcommunicationses?$select=activityid,createdon,riivo_messagedirection'
    + '&$expand=riivo_WhatsAppCommunications_activity_parties($select=participationtypemask)'
    + ',regardingobjectid_riivo_request($select=_riivo_client_value,_riivo_lead_value)'
    + ',regardingobjectid_riivo_claim($select=_riivo_contact_value)'
    + `&$filter=_regardingobjectid_value ne null${SINCE ? ` and createdon ge ${SINCE}T00:00:00Z` : ''}&$orderby=createdon asc`;

/** One page at a time: a page of rows with their participants expanded is kept small. */
async function* pages(): AsyncGenerator<Row[]> {
    let url: string | undefined = `${ORG}/api/data/v9.2/${SELECT}`;
    while (url) {
        const res: Response = await fetch(url, {
            headers: { Authorization: `Bearer ${azToken()}`, Accept: 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0', Prefer: 'odata.maxpagesize=200' },
        });
        if (res.status === 429) { await new Promise((r) => setTimeout(r, (Number(res.headers.get('Retry-After')) || 5) * 1000)); continue; }
        if (!res.ok) throw new Error(`Dataverse GET ${res.status} ${(await res.text()).slice(0, 300)}`);
        const page = await res.json() as { value: Row[]; '@odata.nextLink'?: string };
        yield page.value;
        url = page['@odata.nextLink'];
    }
}

/** Who the row is with, from the record it is filed under. */
function clientOf(r: Row): WhatsAppParty | null {
    const rq = r.regardingobjectid_riivo_request;
    if (rq?._riivo_client_value) return { table: 'contact', id: rq._riivo_client_value };
    if (rq?._riivo_lead_value) return { table: 'new_lead', id: rq._riivo_lead_value };
    const cl = r.regardingobjectid_riivo_claim;
    return cl?._riivo_contact_value ? { table: 'contact', id: cl._riivo_contact_value } : null;
}

(async () => {
    console.log(`${ORG}: ${APPLY ? 'writing' : 'dry run (--apply writes)'}${SINCE ? `, rows since ${SINCE}` : ''}`);
    const n = { scanned: 0, other: 0, has: 0, noClient: 0, set: 0, failed: 0 };
    const examples: string[] = [];
    for await (const page of pages()) {
        const todo: { r: Row; party: WhatsAppParty }[] = [];
        for (const r of page) {
            n.scanned++;
            if (!r.regardingobjectid_riivo_request && !r.regardingobjectid_riivo_claim) { n.other++; continue; }
            if (r.riivo_WhatsAppCommunications_activity_parties.some((p) => !SYSTEM_PARTIES.has(p.participationtypemask))) { n.has++; continue; }
            const party = clientOf(r);
            if (!party) { n.noClient++; continue; }
            todo.push({ r, party });
        }
        // A few at a time: Dataverse's limits are per user, and dataverseCall waits out a 429.
        for (let i = 0; i < todo.length; i += 4) {
            await Promise.all(todo.slice(i, i + 4).map(async ({ r, party }) => {
                const mask = r.riivo_messagedirection === INCOMING ? FROM : TO;
                if (examples.length < 5) examples.push(`${r.createdon} ${r.activityid}: ${party.table} ${party.id} as ${mask === FROM ? 'From' : 'To'}`);
                if (!APPLY) { n.set++; return; }
                try {
                    await dv('PATCH', `riivo_whatsappcommunicationses(${r.activityid})`, {
                        riivo_WhatsAppCommunications_activity_parties: [{
                            [`partyid_${party.table}@odata.bind`]: `/${party.table === 'contact' ? 'contacts' : 'new_leads'}(${party.id})`, participationtypemask: mask,
                        }],
                    });
                    n.set++;
                } catch (e) {
                    n.failed++;
                    console.error(`  ${r.activityid}: ${(e as Error).message}`);
                }
            }));
        }
        process.stdout.write(`\r  ${n.scanned} rows read, ${n.set} ${APPLY ? 'given' : 'to give'} their client`);
    }
    console.log(`\n\n${n.scanned} rows filed under a record`);
    console.log(`  ${n.other} under something other than a request or claim (left alone)`);
    console.log(`  ${n.has} already have a client or other participant (left alone)`);
    console.log(`  ${n.noClient} under a request or claim with no client on it (left alone)`);
    console.log(`  ${n.set} ${APPLY ? 'now have' : 'would get'} their client as From or To${n.failed ? `; ${n.failed} failed` : ''}`);
    if (examples.length) console.log(`\nFor example:\n${examples.map((e) => `  ${e}`).join('\n')}`);
    if (n.failed) process.exit(1);
})().catch((e) => { console.error(`\nERROR: ${(e as Error).message}`); process.exit(1); });
