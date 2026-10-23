/**
 * TTTFG-4830 claims demo load test: many clients reporting a claim at once, through the code a demo number runs in Tina
 * (claimsDemoTurn + claimsDemoWiring) against DEV Dataverse. It answers "what happens with hundreds on the line?" for
 * the CRM side: messages a second, the wait, CRM calls per message and Dataverse's "too many requests" (429).
 *
 * Swapped out, so the test measures Tina and the CRM and nothing else:
 *  - Claude: a fake that answers every question sensibly after --claude-ms (default 2500ms, about what Sonnet takes);
 *    Claude's own rate limits are a separate check (the Anthropic console's Limits page);
 *  - WhatsApp: nothing is sent; Supabase: kept in memory;
 *  - Tina's worker: --slots messages at a time, each client's messages in order (Service Bus sessions, MAX_CONCURRENT_SESSIONS).
 * Real: every Dataverse read and write, Dataverse's limits, the per-message cache (--no-cache to measure without it).
 *
 * Each run creates --clients throwaway DEV contacts ("Load<n> Test4830", one active Discovery motor policy each, owned by
 * whoever is signed in) and deletes them and everything the run created on them at the end. DEV only.
 *
 *   npx tsx src/scripts/claims-demo-load.ts --clients 16 --slots 8 --messages 14
 *   npx tsx src/scripts/claims-demo-load.ts --clients 16 --slots 8 --messages 14 --no-cache
 *
 * Sign-in: `az login` to TTT's tenant.
 */
import { execFileSync } from 'child_process';
import type { Dv } from '../departments/insurance/dataverse';
import { claimsDemoTurn, type ClaimsDemoDeps, type DemoConversation } from '../domain/claimsDemoHost';
import { cachedDv, dataverseCall, demoPorts, newCrmStats, openDemoRequest, withdrawOpenClaims, type CrmStats, type DemoChannels } from '../services/claimsDemoWiring';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';
const DISCOVERY = '5506724c-dc89-f011-b4cc-7c1e52881828';
const ACTIVE = 463630000;

const args = process.argv.slice(2);
const num = (name: string, d: number) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : d; };
const CLIENTS = num('--clients', 16);
const SLOTS = num('--slots', 8);
const MESSAGES = num('--messages', 14);
const CLAUDE_MS = num('--claude-ms', 2500);
const THINK_MS = num('--think-ms', 1500);
const CACHE = !args.includes('--no-cache');

// --- DEV Dataverse with the signed-in user's token -------------------------------------------------------------------
let token: { value: string; until: number } | undefined;
const azToken = () => {
    if (!token || token.until < Date.now() + 5 * 60_000) {
        const j = JSON.parse(execFileSync('az', ['account', 'get-access-token', '--resource', DEV, '-o', 'json'], { encoding: 'utf8' })) as { accessToken: string; expires_on?: number; expiresOn: string };
        token = { value: j.accessToken, until: j.expires_on ? j.expires_on * 1000 : Date.parse(j.expiresOn) };
    }
    return token.value;
};
const counting = (dv: Dv, stats: CrmStats): Dv => (<T,>(m: 'GET' | 'POST' | 'PATCH', p: string, b?: unknown, o?: { formatted?: boolean; returnRow?: boolean }) => {
    if (m === 'GET') stats.reads++; else stats.writes++;
    return dv<T>(m, p, b, o);
}) as Dv;
const setupDv = dataverseCall(DEV, azToken);

// --- a fake Claude that answers sensibly ----------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claudeDelay = () => sleep(CLAUDE_MS * (0.7 + Math.random() * 0.6));
const yesterday = new Date(Date.now() + 2 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
const blankAnswer = { kind: 'unclear', policyNumber: null, claimType: null, description: null, incidentDate: null, incidentTime: null, place: null,
    thirdParties: null, thirdPartyDetails: null, saps: null, injuries: null, injuryDetails: null, wrongFields: [] as string[] };
const STEP_ANSWERS: [RegExp, Record<string, unknown>][] = [
    [/which policy the claim is about/, { kind: 'yes' }],
    [/hurt or in danger right now/, { kind: 'no' }],
    [/what kind of claim it is/, { kind: 'facts', claimType: 'Motor accident', description: 'Someone drove into the back of my car at the Claremont robot' }],
    [/what happened, when and where/, { kind: 'facts', incidentDate: yesterday, incidentTime: '17:30', place: 'Claremont' }],
    [/anyone else was involved/, { kind: 'facts', thirdParties: true, thirdPartyDetails: 'A white Polo', saps: false, injuries: false }],
    [/read back a summary/, { kind: 'confirm' }],
];
const blankReply = { kind: 'unparsed', valueText: null, valueNumber: null, valueBool: null, sapsCaseNumber: null, sapsStation: null, differentIncident: false,
    chosenClaim: null, yesNo: null, forItem: null, claimType: null, description: null, incidentDate: null, place: null, otherAnswers: [], corrections: [] };
const models = {
    intentModel: async () => (await claudeDelay(), { reportingClaim: true }),
    understandModel: async (req: { system: string }) => (await claudeDelay(), { ...blankAnswer, ...(STEP_ANSWERS.find(([re]) => re.test(req.system))?.[1] ?? {}) }),
    replyModel: async (req: { system: string }) => {
        await claudeDelay();
        const s = req.system;
        if (/Tina asked the client to send/.test(s)) return { ...blankReply, kind: 'not-yet' };
        if (/ANOTHER one/.test(s)) return { ...blankReply, kind: 'value', valueBool: false };
        const choice = s.match(/exactly one of these choices: "([^"]+)"/)?.[1];
        if (choice) return { ...blankReply, kind: 'value', valueText: choice };
        if (/the date as YYYY-MM-DD/.test(s)) return { ...blankReply, kind: 'value', valueText: yesterday };
        return { ...blankReply, kind: 'value', valueText: 'Load test answer', valueNumber: 10, valueBool: false };
    },
    reportedModel: async () => (await claudeDelay(), { answers: [] }),
};

// --- Tina's worker: SLOTS at a time ----------------------------------------------------------------------------------
let free = SLOTS;
const waiting: (() => void)[] = [];
const acquire = () => new Promise<void>((r) => { if (free > 0) { free--; r(); } else waiting.push(r); });
const release = () => { const next = waiting.shift(); if (next) next(); else free++; };

interface Done { client: number; ms: number; waitMs: number; outcome: string; stats: CrmStats; error?: string }

async function client(n: number, contactId: string, done: Done[]) {
    const phone = `276000${String(48300 + n).padStart(5, '0')}`;
    let conv: DemoConversation | null = null;
    for (let i = 0; i < MESSAGES; i++) {
        await sleep(THINK_MS * Math.random());
        const queued = Date.now();
        await acquire();
        const started = Date.now();
        const stats = newCrmStats();
        const dv = CACHE ? cachedDv(dataverseCall(DEV, azToken, { stats }), stats) : counting(dataverseCall(DEV, azToken, { stats }), stats);
        const ch: DemoChannels = {
            dv, site: '', graph: async () => { throw new Error('SharePoint is not part of the load test'); },
            sendText: async () => {}, sendDocument: async () => {}, mediaBytes: async () => Buffer.alloc(0),
        };
        const deps: ClaimsDemoDeps = {
            load: async () => conv, save: async (_p, c) => { conv = { ...structuredClone(c), updatedAt: new Date().toISOString() }; }, remove: async () => { conv = null; },
            ports: (_r, sent) => demoPorts(ch, phone, contactId, sent), ...models,
            openRequest: (c, p, t) => openDemoRequest(dv, c, p, t), withdrawOpenClaims: (c) => withdrawOpenClaims(dv, c),
            say: async () => {}, signUpLink: 'x',
        };
        const text = i === 0 ? 'Someone drove into the back of my car yesterday at the Claremont robot' : 'reply';
        try {
            const outcome = await claimsDemoTurn(deps, { phone, contactId, text, wamid: `wamid.load.${n}.${i}` }, new Date());
            done.push({ client: n, ms: Date.now() - started, waitMs: started - queued, outcome, stats });
        } catch (e) {
            done.push({ client: n, ms: Date.now() - started, waitMs: started - queued, outcome: 'error', stats, error: (e as Error).message.slice(0, 160) });
        } finally {
            release();
        }
    }
}

// --- DEV test clients ------------------------------------------------------------------------------------------------
async function makeClients(): Promise<{ contact: string; policy: string }[]> {
    const me = (await setupDv<{ UserId: string }>('GET', 'WhoAmI')).UserId;
    const out: { contact: string; policy: string }[] = [];
    for (let n = 0; n < CLIENTS; n++) {
        const c = await setupDv<{ contactid: string }>('POST', 'contacts?$select=contactid', {
            firstname: `Load${n}`, lastname: 'Test4830', description: 'Claims demo load test (TTTFG-4830): deleted at the end of the run.',
            'ownerid@odata.bind': `/systemusers(${me})`,
        }, { returnRow: true });
        const p = await setupDv<{ riivo_policyid: string }>('POST', 'riivo_policies?$select=riivo_policyid', {
            'riivo_policyholderid@odata.bind': `/contacts(${c.contactid})`, riivo_policy_status: ACTIVE, riivo_policynumber: `DI-LOAD-${n}`, riivo_product_2: 'Motor',
            'riivo_Provider@odata.bind': `/riivo_providers(${DISCOVERY})`, 'ownerid@odata.bind': `/systemusers(${me})`,
        }, { returnRow: true });
        out.push({ contact: c.contactid, policy: p.riivo_policyid });
    }
    return out;
}

async function removeClients(clients: { contact: string; policy: string }[]) {
    const del = async (path: string) => {
        const res = await fetch(`${DEV}/api/data/v9.2/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${azToken()}` } });
        if (!res.ok && res.status !== 404) console.warn(`  could not delete ${path}: HTTP ${res.status}`);
    };
    let claims = 0;
    for (const { contact, policy } of clients) {
        const list = async (q: string) => (await setupDv<{ value: Record<string, string>[] }>('GET', q)).value;
        for (const c of await list(`riivo_claims?$select=riivo_claimid&$filter=_riivo_contact_value eq ${contact}`)) {
            for (const d of await list(`riivo_clientdocuments?$select=riivo_clientdocumentid&$filter=_riivo_claim_value eq ${c.riivo_claimid}`)) await del(`riivo_clientdocuments(${d.riivo_clientdocumentid})`);
            await del(`riivo_claims(${c.riivo_claimid})`);
            claims++;
        }
        for (const a of await list(`riivo_agentactions?$select=riivo_agentactionid&$filter=_riivo_client_value eq ${contact}`)) await del(`riivo_agentactions(${a.riivo_agentactionid})`);
        for (const r of await list(`riivo_requests?$select=riivo_requestid&$filter=_riivo_client_value eq ${contact}`)) await del(`riivo_requests(${r.riivo_requestid})`);
        await del(`riivo_policies(${policy})`);
        await del(`contacts(${contact})`);
    }
    console.log(`Cleaned up: ${clients.length} clients, ${claims} claims and everything on them.`);
}

// --- report ----------------------------------------------------------------------------------------------------------
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
    console.log(`Load test on DEV: ${CLIENTS} clients x ${MESSAGES} messages, ${SLOTS} slots, Claude ~${CLAUDE_MS}ms, cache ${CACHE ? 'on' : 'off'}`);
    const clients = await makeClients();
    const done: Done[] = [];
    const t0 = Date.now();
    try {
        await Promise.all(clients.map((c, n) => client(n, c.contact, done)));
    } finally {
        const wall = Date.now() - t0;
        const ok = done.filter((d) => d.outcome !== 'error');
        const follow = ok.filter((d) => d.outcome === 'follow-on');
        const sum = (k: keyof CrmStats, xs = done) => xs.reduce((a, d) => a + d.stats[k], 0);
        console.log(`\nMessages: ${done.length} in ${sec(wall)} = ${(done.length / (wall / 1000)).toFixed(2)} messages/s; errors ${done.length - ok.length}`);
        console.log(`Handling time: p50 ${sec(pct(ok.map((d) => d.ms), 50))}, p95 ${sec(pct(ok.map((d) => d.ms), 95))}, max ${sec(Math.max(0, ...ok.map((d) => d.ms)))}`);
        console.log(`Waiting for a slot: p50 ${sec(pct(done.map((d) => d.waitMs), 50))}, p95 ${sec(pct(done.map((d) => d.waitMs), 95))}`);
        console.log(`Client waits for a reply (wait + handling): p50 ${sec(pct(done.map((d) => d.waitMs + d.ms), 50))}, p95 ${sec(pct(done.map((d) => d.waitMs + d.ms), 95))}`);
        console.log(`CRM per message: ${(sum('reads') / done.length).toFixed(1)} reads + ${(sum('writes') / done.length).toFixed(1)} writes (${(sum('cached') / done.length).toFixed(1)} reads from the cache)`);
        if (follow.length) console.log(`  follow-on messages only: ${(sum('reads', follow) / follow.length).toFixed(1)} reads + ${(sum('writes', follow) / follow.length).toFixed(1)} writes`);
        console.log(`CRM calls/s: ${((sum('reads') + sum('writes')) / (wall / 1000)).toFixed(1)}; "too many requests" (429): ${sum('throttled')}`);
        const outcomes: Record<string, number> = {};
        for (const d of done) outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
        console.log(`Outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        for (const e of [...new Set(done.filter((d) => d.error).map((d) => d.error))].slice(0, 5)) console.log(`  error: ${e}`);
        await removeClients(clients);
    }
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).stack}`); process.exit(1); });
