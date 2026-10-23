/**
 * TTTFG-4830 claims demo rehearsal: talk to the WhatsApp claims demo in the terminal, against DEV Dataverse, DEV
 * SharePoint and real Claude, before trying it on a phone.
 *
 * It runs the code a demo number runs in Tina (src/domain/claimsDemoHost.ts with src/services/claimsDemoWiring.ts).
 * Only these are swapped out:
 *  - WhatsApp: Tina's replies print here; the filled claim form is written to .work/claims-demo/out/;
 *  - files: "/file <path> [caption]" sends a local photo or PDF as if it came from WhatsApp;
 *  - Supabase: the conversation is kept in .work/claims-demo/<phone>.json.
 * The claims, documents, agent actions and SharePoint files are real DEV rows and files ("#reset" withdraws the claims).
 *
 *   npx tsx src/scripts/claims-demo-chat.ts --phone 27723203629 --contact <DEV contact id>          chat ("exit" to stop)
 *   npx tsx src/scripts/claims-demo-chat.ts --phone 27723203629 --contact <id> "message"            one message
 *   npx tsx src/scripts/claims-demo-chat.ts --phone 27723203629 --contact <id> --script file.txt     one message per line
 * --contact defaults to the number's entry in CLAIMS_DEMO_NUMBERS.
 *
 * Sign-in: `az login` to TTT's tenant (Dataverse and Graph tokens). Claude: ANTHROPIC_API_KEY, else the DEV email
 * agent's Key Vault secret. DEV only: it refuses any other Dataverse.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { Dv } from '../departments/insurance/dataverse';
import type { ClientFile } from '../departments/insurance/followon';
import {
    claimsDemoTurn, demoContactFor, parseDemoNumbers, type ClaimsDemoDeps, type DemoConversation,
} from '../domain/claimsDemoHost';
import { demoPorts, openDemoRequest, withdrawOpenClaims, type DemoChannels, type Graph } from '../services/claimsDemoWiring';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';
const TENANT = process.env.DYNAMICS_TENANT_ID || '';
const KEY_VAULT = 'tttagentdevkv62pa5f';
const SITE = 'tttfinancialgroup.sharepoint.com:/sites/TTTDevelopment';
const STORE = path.resolve(__dirname, '../../.work/claims-demo');
const OUT = path.join(STORE, 'out');

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const phone = flag('--phone')?.replace(/\D/g, '');
const contactId = flag('--contact') ?? (phone ? demoContactFor(parseDemoNumbers(process.env.CLAIMS_DEMO_NUMBERS), phone) : null);
if (!phone || !contactId) {
    console.error('Usage: npx tsx src/scripts/claims-demo-chat.ts --phone 27XXXXXXXXX --contact <DEV contact id> ["message" | --script file]');
    process.exit(2);
}
const scriptFile = flag('--script');
const oneMessage = args.filter((a, i) => !a.startsWith('--') && !['--phone', '--contact', '--script'].includes(args[i - 1] ?? ''))[0];

// --- az login tokens ----------------------------------------------------------------------------------------------------
const tokens = new Map<string, { value: string; until: number }>();
function azToken(resource: string): string {
    const t = tokens.get(resource);
    if (t && t.until > Date.now() + 60_000) return t.value;
    const out = execFileSync('az', ['account', 'get-access-token', '--resource', resource, ...(TENANT ? ['--tenant', TENANT] : []), '-o', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out) as { accessToken: string; expires_on?: number; expiresOn: string };
    const value = { value: j.accessToken, until: j.expires_on ? j.expires_on * 1000 : Date.parse(j.expiresOn) };
    tokens.set(resource, value);
    return value.value;
}

const dv: Dv = async <T,>(method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown, opts: { formatted?: boolean; returnRow?: boolean } = {}) => {
    const prefer = [opts.formatted ? 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' : '', opts.returnRow ? 'return=representation' : ''].filter(Boolean).join(', ');
    const res = await fetch(`${DEV}/api/data/v9.2/${p}`, {
        method,
        headers: {
            Authorization: `Bearer ${azToken(DEV)}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0',
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

const graph: Graph = async (method, p, body, contentType) => fetch(p.startsWith('https://') ? p : `https://graph.microsoft.com/v1.0${p}`, {
    method, body, headers: { Authorization: `Bearer ${azToken('https://graph.microsoft.com')}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
});

// --- Claude (forced tool call, as Tina's claims.service.ts toolModel) ---------------------------------------------------
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
const INTENT_MODEL = process.env.CLAIMS_INTENT_MODEL || 'claude-haiku-4-5-20251001';
const UNDERSTAND_MODEL = process.env.CLAIMS_UNDERSTAND_MODEL || 'claude-sonnet-4-6';

// --- the blank insurer forms when SharePoint won't give them: the repo copies -------------------------------------------
function ttt(): string {
    for (let d = process.cwd(); d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, 'Shared data model'))) return d;
    return process.cwd();
}
function findFile(dir: string, name: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) { const hit = findFile(p, name); if (hit) return hit; } else if (f === name) return p;
    }
    return undefined;
}
async function localBlankForm(formUrl: string): Promise<Uint8Array | null> {
    const name = decodeURIComponent(formUrl.split('?')[0].split('/').pop() ?? '');
    const hit = [path.join(ttt(), 'ttt-preseason-agent', 'test', 'golden'), path.join(ttt(), 'Shared data model', 'TTTFG-5172', 'Forms')]
        .map((d) => findFile(d, name)).find(Boolean);
    if (hit) console.log(`  (blank form ${name}: SharePoint refused, used ${hit})`);
    return hit ? new Uint8Array(fs.readFileSync(hit)) : null;
}

// --- the conversation -----------------------------------------------------------------------------------------------------
const show = (who: string, text: string) => console.log(`\n${who}:\n${text.split('\n').map((l) => `  ${l}`).join('\n')}`);
const storeFile = path.join(STORE, `${phone}.json`);

const channels: DemoChannels = {
    dv, graph, site: SITE,
    sendText: async (_to, text) => show('Tina', text),
    sendDocument: async (_to, bytes, fileName, caption) => {
        fs.mkdirSync(OUT, { recursive: true });
        const p = path.join(OUT, fileName);
        fs.writeFileSync(p, bytes);
        show('Tina [document]', `${caption}\n📎 ${p}`);
    },
    // In the rehearsal a "media id" is the local file's path.
    mediaBytes: async (mediaId) => fs.readFileSync(mediaId),
    blankFormFallback: localBlankForm,
    note: (text) => console.log(`  [${text}]`),
};

const deps: ClaimsDemoDeps = {
    load: async () => (fs.existsSync(storeFile) ? (JSON.parse(fs.readFileSync(storeFile, 'utf8')) as DemoConversation) : null),
    save: async (_p, c) => { fs.mkdirSync(STORE, { recursive: true }); fs.writeFileSync(storeFile, JSON.stringify({ ...c, updatedAt: new Date().toISOString() }, null, 1)); },
    remove: async () => { fs.rmSync(storeFile, { force: true }); },
    ports: (_r, sent) => demoPorts(channels, phone, contactId, sent),
    intentModel: toolModel(INTENT_MODEL, 'record_claim_intent'),
    understandModel: toolModel(UNDERSTAND_MODEL, 'record_answer'),
    replyModel: toolModel(UNDERSTAND_MODEL, 'record_reply'),
    openRequest: (c, p, text) => openDemoRequest(dv, c, p, text),
    withdrawOpenClaims: (c) => withdrawOpenClaims(dv, c),
    say: async (_p, text) => show('Tina', text),
    signUpLink: 'https://www.ttt-tax.co.za/client-onboarding',
};

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
let n = 0;
async function say(line: string) {
    let text = line;
    let file: ClientFile | undefined;
    const m = line.match(/^\/file\s+(\S+)\s*(.*)$/);
    if (m) {
        const p = path.resolve(m[1]);
        if (!fs.existsSync(p)) { console.error(`  No such file: ${p}`); return; }
        const mimeType = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
        file = { id: p, fileName: path.basename(p), mimeType, media: mimeType.startsWith('image/') ? 'photo' : 'document' };
        text = m[2];
    }
    show(`Client (${phone})`, file ? `📎 ${file.fileName}${text ? ` - ${text}` : ''}` : text);
    const outcome = await claimsDemoTurn(deps, { phone: phone!, contactId: contactId!, text, file, wamid: `wamid.rehearsal.${Date.now()}.${++n}` }, new Date());
    console.log(`  (${outcome})`);
}

async function main() {
    if (oneMessage) return say(oneMessage);
    if (scriptFile) {
        for (const line of fs.readFileSync(scriptFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))) await say(line);
        return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Chatting as ${phone} (DEV contact ${contactId}) with the claims demo. "/file <path> [caption]" sends a file; "exit" stops.`);
    process.stdout.write('\nYou: ');
    for await (const line of rl) {
        const t = line.trim();
        if (t === 'exit') break;
        if (t) { try { await say(t); } catch (e) { console.error(`  ERROR: ${(e as Error).stack}`); } }
        process.stdout.write('\nYou: ');
    }
    rl.close();
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).stack}`); process.exit(1); });
