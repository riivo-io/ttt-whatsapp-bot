/**
 * TTTFG-4830 claims demo rehearsal: talk to the WhatsApp claims demo in the terminal, against DEV Dataverse, DEV
 * SharePoint and real Claude, before trying it on a phone.
 *
 * It runs the code a demo number runs in Tina (src/domain/claimsDemoHost.ts with src/services/claimsDemoWiring.ts).
 * Only these are swapped out:
 *  - WhatsApp: Tina's replies print here; the filled claim form is written to .work/claims-demo/out/;
 *  - files: "/file <path> [caption]" sends a local photo or PDF as if it came from WhatsApp;
 *  - voice notes (TTTFG-4830): "/voice <path>" sends a local recording (.ogg, .m4a, .mp3, .wav) as a voice note. It
 *    is transcribed for real (OPENAI_API_KEY) and the transcript is printed before Tina's reply;
 *  - Supabase: the conversation is kept in .work/claims-demo/<phone>.json;
 *  - taps (TTTFG-4830): what one message makes Tina say prints as the one WhatsApp message it would be, with its reply
 *    buttons or list under it ("[tap: Yes | No]"). Type a choice's title, or "/tap 2", to tap it.
 * The claims, documents, agent actions and SharePoint files are real DEV rows and files ("#reset" withdraws the claims).
 *
 *   npx tsx src/scripts/claims-demo-chat.ts --phone 27723203629 --contact <DEV contact id>          chat ("exit" to stop)
 *   npx tsx src/scripts/claims-demo-chat.ts --phone 27723203629 --contact <id> "message"            one message
 *   npx tsx src/scripts/claims-demo-chat.ts --phone 27723203629 --contact <id> --script file.txt     one message per line
 * --contact defaults to the number's entry in CLAIMS_DEMO_NUMBERS.
 * --sign 4319: TTTFG-5196's signing page on http://localhost:4319 (requests in memory): the form's "ready to sign" link
 *   prints here; open it in a browser and sign, and the callback files the signed copy and sets the DEV claim to Signed.
 *   When a message or a script sends the link, the rehearsal waits for that signature (--wait <seconds>, default 900).
 *
 * Sign-in: `az login` to TTT's tenant (Dataverse and Graph tokens). Claude: ANTHROPIC_API_KEY, else the DEV email
 * agent's Key Vault secret. DEV only: it refuses any other Dataverse.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { Dv } from '../departments/insurance/dataverse';
import type { Choice } from '../departments/insurance/claim';
import type { ClientFile } from '../departments/insurance/followon';
import { interactiveFor, messageMaxChars, outbox, withChoiceLines } from '../domain/claimsOutbox';
import {
    claimsDemoTurn, demoContactFor, parseDemoNumbers, type ClaimsDemoDeps, type DemoConversation, type DemoVoice,
} from '../domain/claimsDemoHost';
import { claimsContactNumber } from '../domain/claimsHost';
import { transcribeVoiceNote } from '../services/transcribe.service';
import {
    cachedDv, dataverseCall, demoClaimSigned, demoPorts, newCrmStats, openDemoRequest, withdrawOpenClaims, type DemoChannels, type DemoSigning, type Graph,
} from '../services/claimsDemoWiring';
import { signingRouter } from '../routes/signing.route';
import { callerCallbackKey, createSigningRequest, SIGNATURE_HEADER, type SigningDeps } from '../signing/signing';
import { memorySigningStore } from '../signing/store';
import { verifyHmacSha256 } from '../utils/hmac';

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
const signPort = flag('--sign');
const waitSeconds = Number(flag('--wait') ?? 900);
const oneMessage = args.filter((a, i) => !a.startsWith('--') && !['--phone', '--contact', '--script', '--sign', '--wait'].includes(args[i - 1] ?? ''))[0];

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

// Tina's own Dataverse call (429s waited out); cachedDv below gives each message the same per-message cache as Tina.
const rawDv: Dv = dataverseCall(DEV, () => azToken(DEV));

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
        model, max_tokens: 2048, system: req.system, messages: [{ role: 'user', content: req.user }],
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

let dv: Dv = rawDv;

// --- TTTFG-5196: the signing page on localhost ----------------------------------------------------------------------------
let signedCount = 0;
let linksSent = 0;
function localSigning(port: number): DemoSigning {
    const deps: SigningDeps = { store: memorySigningStore(), publicUrl: `http://localhost:${port}`, callbackSecret: crypto.randomBytes(16).toString('hex') };
    const app = express();
    app.use('/sign', signingRouter(() => deps));
    app.post('/webhook/claim-signed', express.raw({ type: 'application/json', limit: '40mb' }), async (req, res) => {
        if (!verifyHmacSha256(req.body, req.header(SIGNATURE_HEADER), callerCallbackKey(deps.callbackSecret, 'claim'))) return void res.status(401).end();
        const b = JSON.parse(req.body.toString('utf8'));
        try {
            dv = cachedDv(rawDv, newCrmStats());
            const signedPdf = Buffer.from(b.signedPdf, 'base64');
            fs.mkdirSync(OUT, { recursive: true });
            const local = path.join(OUT, `signed-${b.requestId}.pdf`);
            fs.writeFileSync(local, signedPdf);
            const outcome = await demoClaimSigned(channels, { requestId: b.requestId, caller: b.caller, callerRecordId: b.callerRecordId, signedPdf: new Uint8Array(signedPdf), audit: b.audit });
            show('Signing page', `The client signed (${b.audit.ip ?? 'no IP'}): ${JSON.stringify(outcome)}\n📎 ${local}`);
            signedCount++;
            res.json({ ok: true, outcome });
        } catch (e) {
            console.error(`  ERROR in the callback: ${(e as Error).stack}`);
            res.status(500).end();
        }
    });
    app.listen(port, () => console.log(`  [signing page on http://localhost:${port}]`));
    return {
        create: (input) => { linksSent++; return createSigningRequest(deps, { ...input, callbackUrl: `http://localhost:${port}/webhook/claim-signed` }); },
        signedOff: true,
    };
}
const signing = signPort ? localSigning(Number(signPort)) : undefined;

/** What Tina's last message offered to tap: typing one of its titles (or "/tap 2") taps it. */
let lastChoices: Choice[] = [];
const box = outbox(async (_to, m) => {
    lastChoices = m.choices ?? [];
    const interactive = m.choices?.length ? interactiveFor(m.text, m.choices) : null;
    if (!interactive) return show('Tina', m.choices?.length ? withChoiceLines(m.text, m.choices) : m.text);
    const taps = interactive.type === 'button'
        ? interactive.action.buttons.map((b) => b.reply.title)
        : interactive.action.sections[0].rows.map((r) => `${r.title}${r.description ? ` (${r.description})` : ''}`);
    show(`Tina [${interactive.type === 'button' ? 'buttons' : 'list'}]`, `${m.text}\n[tap: ${taps.join(' | ')}]`);
}, messageMaxChars(process.env.CLAIMS_MESSAGE_MAX_CHARS));

const channels: DemoChannels = {
    get dv() { return dv; }, graph, site: SITE,
    sendText: async (to, text, choices) => box.push(to, { text, ...(choices?.length ? { choices } : {}) }),
    sendDocument: async (_to, bytes, fileName, caption) => {
        await box.flush();
        fs.mkdirSync(OUT, { recursive: true });
        const p = path.join(OUT, fileName);
        fs.writeFileSync(p, bytes);
        show('Tina [document]', `${caption}\n📎 ${p}`);
    },
    // In the rehearsal a "media id" is the local file's path.
    mediaBytes: async (mediaId) => fs.readFileSync(mediaId),
    blankFormFallback: localBlankForm,
    note: (text) => console.log(`  [${text}]`),
    ...(signing ? { signing } : {}),
};

const deps: ClaimsDemoDeps = {
    load: async () => (fs.existsSync(storeFile) ? (JSON.parse(fs.readFileSync(storeFile, 'utf8')) as DemoConversation) : null),
    save: async (_p, c) => { fs.mkdirSync(STORE, { recursive: true }); fs.writeFileSync(storeFile, JSON.stringify({ ...c, updatedAt: new Date().toISOString() }, null, 1)); },
    remove: async () => { fs.rmSync(storeFile, { force: true }); },
    ports: (_r, sent) => demoPorts(channels, phone, contactId, sent),
    intentModel: toolModel(INTENT_MODEL, 'record_claim_intent'),
    understandModel: toolModel(UNDERSTAND_MODEL, 'record_answer'),
    replyModel: toolModel(UNDERSTAND_MODEL, 'record_reply'),
    reportedModel: toolModel(UNDERSTAND_MODEL, 'record_known_answers'),
    openRequest: (c, p, text) => openDemoRequest(dv, c, p, text),
    withdrawOpenClaims: (c) => withdrawOpenClaims(dv, c),
    say: (p, text) => channels.sendText(p, text),
    signUpLink: 'https://www.ttt-tax.co.za/client-onboarding',
    contactNumber: claimsContactNumber(process.env.CLAIMS_CONTACT_NUMBER), // as on Tina
    // TTTFG-4830: the voice note's "media id" is the local file's path.
    transcribe: async (voice, hint) => {
        const r = await transcribeVoiceNote(fs.readFileSync(voice.id), voice.mimeType, hint);
        if ('problem' in r) return { problem: r.problem };
        console.log(`  (heard in ${r.ms}ms by ${r.model}${r.seconds === null ? '' : `, ${r.seconds}s of audio`}: "${r.text}")`);
        return { text: r.text };
    },
};

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
const AUDIO: Record<string, string> = { '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
let n = 0;
async function say(line: string) {
    let text = line;
    let file: ClientFile | undefined;
    let voice: DemoVoice | undefined;
    const v = line.match(/^\/voice\s+(\S+)\s*$/);
    if (v) {
        const p = path.resolve(v[1]);
        if (!fs.existsSync(p)) { console.error(`  No such file: ${p}`); return; }
        voice = { id: p, mimeType: AUDIO[path.extname(p).toLowerCase()] ?? 'application/octet-stream' };
        text = '';
    }
    const m = line.match(/^\/file\s+(\S+)\s*(.*)$/);
    if (m) {
        const p = path.resolve(m[1]);
        if (!fs.existsSync(p)) { console.error(`  No such file: ${p}`); return; }
        const mimeType = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
        file = { id: p, fileName: path.basename(p), mimeType, media: mimeType.startsWith('image/') ? 'photo' : 'document' };
        text = m[2];
    }
    // A tap: a title of what Tina's last message offered, or "/tap 2". It says what the choice says, as on WhatsApp.
    const n2 = /^\/tap\s+(\d+)\s*$/.exec(line)?.[1];
    const tapped = n2 ? lastChoices[Number(n2) - 1] : lastChoices.find((c) => c.title.toLowerCase() === line.trim().toLowerCase());
    if (tapped && !voice && !file) text = tapped.reply ?? tapped.title;
    show(`Client (${phone})`, voice ? `🎙️ ${path.basename(voice.id)}` : file ? `📎 ${file.fileName}${text ? ` - ${text}` : ''}` : tapped ? `[tapped ${tapped.title}] ${text}` : text);
    const stats = newCrmStats();
    dv = cachedDv(rawDv, stats);
    const outcome = await claimsDemoTurn(deps, {
        phone: phone!, contactId: contactId!, text, file, ...(voice ? { voice } : {}), wamid: `wamid.rehearsal.${Date.now()}.${++n}`,
    }, new Date());
    await box.flush();
    console.log(`  (${outcome}; CRM ${stats.reads} reads, ${stats.cached} from cache, ${stats.writes} writes)`);
}

/** With --sign, after a message or a script that sent a signing link: wait for the client to sign on the page. */
async function waitForSignature() {
    if (!signPort || !linksSent) process.exit(0);
    console.log(`\n  Waiting up to ${waitSeconds}s for the form to be signed on the page...`);
    const until = Date.now() + waitSeconds * 1000;
    while (signedCount === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    console.log(signedCount ? '  Signed.' : '  Not signed in time.');
    process.exit(0);
}

async function main() {
    if (oneMessage) { await say(oneMessage); return waitForSignature(); }
    if (scriptFile) {
        for (const line of fs.readFileSync(scriptFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))) await say(line);
        return waitForSignature();
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Chatting as ${phone} (DEV contact ${contactId}) with the claims demo. "/file <path> [caption]" sends a file; "/voice <path>" a voice note; "exit" stops.`);
    process.stdout.write('\nYou: ');
    for await (const line of rl) {
        const t = line.trim();
        if (t === 'exit') break;
        if (t) { try { await say(t); } catch (e) { console.error(`  ERROR: ${(e as Error).stack}`); } }
        process.stdout.write('\nYou: ');
    }
    rl.close();
    process.exit(0);
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).stack}`); process.exit(1); });
