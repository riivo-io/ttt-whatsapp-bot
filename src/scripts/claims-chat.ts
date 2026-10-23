/**
 * TTTFG-5168 test harness: talk to Tina's claims flow in the terminal, against DEV Dataverse and real Claude.
 *
 * It runs the same code Tina runs for a claim: src/domain/claimsHost.ts (routing and the walkthrough between messages),
 * the claims package in src/departments/insurance (walkthrough, gate, owner, acknowledgement, the Dataverse adapter)
 * and Claude reading each reply. Only two things are swapped out:
 *  - WhatsApp: Tina's replies print here instead of going to a phone;
 *  - Supabase: the walkthrough in progress is kept in .work/claims-chat/<phone>.json.
 * Every message in and out is logged on the claim's riivo_request in DEV (riivo_whatsappcommunications), as Tina logs
 * it, so the conversation shows on the request's timeline.
 *
 * DEV only: it refuses any other Dataverse.
 *   npx tsx src/scripts/claims-chat.ts --phone +27600005101               chat (type messages; "exit" to stop)
 *   npx tsx src/scripts/claims-chat.ts --phone +27600005101 "message"     one message, then exit
 *   npx tsx src/scripts/claims-chat.ts --phone +27600005101 --gate "Your claim has been approved"
 *                                                                          check 9: send that text on the client's latest claim
 *   npx tsx src/scripts/claims-chat.ts --phone +27600005101 --reset       forget the walkthrough in progress
 *
 * Sign-in: `az login` as a DEV user (the Dataverse token). Claude: ANTHROPIC_API_KEY, else the DEV email agent's Key
 * Vault secret (az keyvault secret show; needs Key Vault read on tttagentdevkv62pa5f).
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { sendText, type Owner } from '../departments/insurance/claim';
import { dataverseClaimPorts, type Dv } from '../departments/insurance/dataverse';
import { claimFromClient, claimFromUnknownNumber, type ClaimsHostDeps, type StoredWalkthrough } from '../domain/claimsHost';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';
const INSURANCE_APP = '9eb7f4ec-38b3-f011-bbd2-7ced8d7556e1';
const ADMIN_HUB = 'a2fec042-3cb3-f011-bbd2-7ced8d7556e1';
const KEY_VAULT = 'tttagentdevkv62pa5f';
const STORE = path.resolve(__dirname, '../../.work/claims-chat');

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const phone = flag('--phone');
if (!phone) {
    console.error('Usage: npx tsx src/scripts/claims-chat.ts --phone +27XXXXXXXXX ["message" | --gate "text" | --reset]');
    process.exit(2);
}
const gateText = flag('--gate');
const oneMessage = args.filter((a, i) => !a.startsWith('--') && !['--phone', '--gate'].includes(args[i - 1] ?? ''))[0];

// --- Dataverse (az login token) ---------------------------------------------------------------------------------------
let token: { value: string; at: number } | undefined;
function dvToken(): string {
    if (!token || Date.now() - token.at > 40 * 60_000) {
        const value = execFileSync('az', ['account', 'get-access-token', '--resource', DEV, '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8' }).trim();
        token = { value, at: Date.now() };
    }
    return token.value;
}

const dv: Dv = async <T,>(method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown, opts: { formatted?: boolean; returnRow?: boolean } = {}) => {
    const prefer = [opts.formatted ? 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' : '', opts.returnRow ? 'return=representation' : ''].filter(Boolean).join(', ');
    const res = await fetch(`${DEV}/api/data/v9.2/${p}`, {
        method,
        headers: {
            Authorization: `Bearer ${dvToken()}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0',
            ...(method === 'PATCH' ? { 'If-Match': '*' } : {}), ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        const err = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? '';
        throw new Error(`Dataverse ${method} ${p.split('?')[0]} ${res.status} ${err}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
};

const link = (app: string, etn: string, id: string) => `${DEV}/main.aspx?appid=${app}&pagetype=entityrecord&etn=${etn}&id=${id}`;

// --- Claude (forced tool call, as in Tina's claims.service.ts) ----------------------------------------------------------
let anthropic: Anthropic | undefined;
function claude(): Anthropic {
    if (!anthropic) {
        const apiKey = process.env.ANTHROPIC_API_KEY
            || execFileSync('az', ['keyvault', 'secret', 'show', '--vault-name', KEY_VAULT, '--name', 'anthropic-api-key', '--query', 'value', '-o', 'tsv'], { encoding: 'utf8' }).trim();
        anthropic = new Anthropic({ apiKey });
    }
    return anthropic;
}
const toolModel = (model: string, name: string) => async (req: { system: string; user: string; schema: object }) => {
    const res = await claude().messages.create({
        model, max_tokens: 1024, system: req.system, messages: [{ role: 'user', content: req.user }],
        tools: [{ name, description: 'Record the answer.', input_schema: req.schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name },
    });
    return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')?.input;
};

// --- The conversation -------------------------------------------------------------------------------------------------
const file = (p: string) => path.join(STORE, `${p.replace(/\D/g, '')}.json`);
const show = (who: string, text: string) => console.log(`\n${who}:\n${text.split('\n').map((l) => `  ${l}`).join('\n')}`);

async function logWhatsApp(direction: 'Incoming' | 'Outgoing', text: string, requestId: string) {
    if (!requestId) return;
    await dv('POST', 'riivo_whatsappcommunicationses', {
        subject: `WhatsApp ${direction}: ${phone}`, description: text, riivo_messagedirection: direction === 'Incoming' ? 463630000 : 463630001,
        riivo_from: direction === 'Incoming' ? phone : 'Bot', riivo_to: direction === 'Incoming' ? 'Bot' : phone,
        riivo_timestamp: new Date().toISOString(), 'regardingobjectid_riivo_request@odata.bind': `/riivo_requests(${requestId})`,
    }).catch((e) => console.warn(`  (CRM log failed: ${(e as Error).message})`));
}

function deps(): ClaimsHostDeps {
    return {
        enabled: true,
        signUpLink: 'https://www.ttt-tax.co.za/client-onboarding',
        load: async (p) => (fs.existsSync(file(p)) ? (JSON.parse(fs.readFileSync(file(p), 'utf8')) as StoredWalkthrough) : null),
        save: async (p, w) => { fs.mkdirSync(STORE, { recursive: true }); fs.writeFileSync(file(p), JSON.stringify({ ...w, updatedAt: new Date().toISOString() }, null, 1)); },
        remove: async (p) => { fs.rmSync(file(p), { force: true }); },
        intentModel: toolModel(process.env.CLAIMS_INTENT_MODEL || 'claude-haiku-4-5-20251001', 'record_claim_intent'),
        understandModel: toolModel(process.env.CLAIMS_UNDERSTAND_MODEL || 'claude-sonnet-4-6', 'record_answer'),
        async openRequest(contactId, p, text) {
            // Same payload as Tina's claims.service.ts openRequest (owned by whoever runs this, as Tina's app user owns it).
            const r = await dv<{ riivo_requestid: string }>('POST', 'riivo_requests?$select=riivo_requestid', {
                riivo_clientmobilenumber: p, riivo_channel: 1, riivo_category: 1, riivo_priority: 1, riivo_description: text.slice(0, 100),
                riivo_classificationtopic: 'Claim', statecode: 0, statuscode: 1, 'riivo_Client@odata.bind': `/contacts(${contactId})`,
            }, { returnRow: true });
            console.log(`  [CRM] request opened (Insurance, topic Claim): ${link(ADMIN_HUB, 'riivo_request', r.riivo_requestid)}`);
            return r.riivo_requestid;
        },
        logIncoming: (requestId, text) => logWhatsApp('Incoming', text, requestId),
        ports(requestId, contact) {
            const ports = dataverseClaimPorts({
                dv,
                send: async (_to, m) => {
                    show(m.kind === 'template' ? `Tina [template ${m.name}, ${m.version}]` : 'Tina', m.text);
                    await logWhatsApp('Outgoing', m.text, requestId);
                },
            });
            return { ...ports, contactByWhatsApp: async () => contact };
        },
    };
}

async function say(text: string) {
    const d = deps();
    // Tina's resolveSender: the contact on this WhatsApp number (an exact, single match).
    const contact = await dataverseClaimPorts({ dv, send: async () => {} }).contactByWhatsApp(phone!);
    const out = contact ? await claimFromClient(d, phone!, contact, text, new Date()) : await claimFromUnknownNumber(d, phone!, text);
    if (!out.handled) {
        console.log(contact ? "\n  (Not a claim report: Tina's normal reply would answer this one.)" : "\n  (Unknown number, not a claim: Tina's sign-up template would answer this one.)");
        return;
    }
    if (out.kind === 'opened') {
        const c = await dv<{ value: { riivo_claimid: string }[] }>('GET', `riivo_claims?$select=riivo_claimid&$filter=riivo_name eq '${out.reference}'`);
        if (c.value[0]) console.log(`\n  [CRM] claim ${out.reference}: ${link(INSURANCE_APP, 'riivo_claim', c.value[0].riivo_claimid)}`);
    }
}

/** Check 9: a reply that says the claim is approved, on the client's latest claim, through the same gate Tina uses. */
async function gate(text: string) {
    const contact = await dataverseClaimPorts({ dv, send: async () => {} }).contactByWhatsApp(phone!);
    if (!contact) throw new Error('No contact on that number');
    const c = (await dv<{ value: { riivo_claimid: string; riivo_name: string; owninguser?: { systemuserid: string; firstname?: string } | null; owningteam?: { teamid: string; name: string } | null }[] }>('GET',
        `riivo_claims?$select=riivo_claimid,riivo_name&$top=1&$orderby=createdon desc&$filter=_riivo_contact_value eq ${contact.id}`
        + '&$expand=owninguser($select=systemuserid,firstname),owningteam($select=teamid,name)')).value[0];
    if (!c) throw new Error('This client has no claim yet: open one first');
    const owner: Owner = c.owninguser ? { kind: 'user', id: c.owninguser.systemuserid, name: c.owninguser.firstname ?? '' } : { kind: 'team', id: c.owningteam!.teamid, name: c.owningteam!.name };
    const r = (await dv<{ value: { riivo_requestid: string }[] }>('GET', `riivo_requests?$select=riivo_requestid&$top=1&$orderby=createdon desc&$filter=_riivo_client_value eq ${contact.id}`)).value[0];
    const requestId = r?.riivo_requestid ?? '';
    console.log(`  Tina's reply as generated: "${text}" (claim ${c.riivo_name}, owner ${owner.name})`);
    await sendText(deps().ports(requestId, contact), { phone: phone!, requestId, signUpLink: '' }, text, { id: c.riivo_claimid, owner }, new Date().toISOString(), contact.id);
}

async function main() {
    if (args.includes('--reset')) { fs.rmSync(file(phone!), { force: true }); console.log('Walkthrough forgotten.'); return; }
    if (gateText) return gate(gateText);
    if (oneMessage) { show(`Client (${phone})`, oneMessage); return say(oneMessage); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Chatting as ${phone} with Tina's claims flow on DEV. Type a message, or "exit".`);
    for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        if (t === 'exit') break;
        try { await say(t); } catch (e) { console.error(`  ERROR: ${(e as Error).message}`); }
        process.stdout.write('\nYou: ');
    }
    rl.close();
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
