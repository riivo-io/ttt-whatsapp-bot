/**
 * TTTFG-4830 voice notes: how well a voice note's answers come through, end to end, before trying it on a phone.
 *
 * Each case is one of Tina's batches from the Discovery motor damage form, and what a client might say to it in a
 * voice note (numbers and letters spoken, filler words, a self-correction). For each case it
 *  1. makes the voice note: macOS `say` with Tessa (South African English), or real recordings from --audio: one
 *     person's in <dir>/<case>.ogg (or .opus, .m4a, .mp3, .wav), or one folder per person, <dir>/<name>/<case>.ogg,
 *     each scored on its own (RECORDING-GUIDE.md in handovers/claims-voice-notes-1026 says what each person says);
 *  2. transcribes it with each model in --models, with the hint Tina gives (claimsDemoHost voiceHint);
 *  3. has Claude read the transcript against the batch as Tina does (reply.ts readReply, spoken), and checks every
 *     answer against what the client said;
 * then prints, per model, the answers right, the time taken (transcription, Claude) and the cost.
 *
 *   npx tsx src/scripts/claims-voice-eval.ts [--models gpt-4o-transcribe,gpt-4o-mini-transcribe] [--only car,driver]
 *        [--audio <dir>] [--configs <dir with discovery-motor-damage.json>] [--keep <dir for the audio and results>]
 *   --dry: make the voice notes and show the batches only (no transcription, no Claude: no keys needed)
 *
 * Needs `say` (macOS) unless every case has a recording, OPENAI_API_KEY, and ANTHROPIC_API_KEY (else the DEV email
 * agent's Key Vault secret, as claims-demo-chat.ts). Nothing is written to the CRM or sent on WhatsApp.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandRows } from '../departments/insurance/claimform';
import type { ClaimForm, QuestionItem } from '../departments/insurance/contracts';
import { batchText, heardText, type FollowOnState } from '../departments/insurance/followon';
import { formItems } from '../departments/insurance/progress';
import { readReply, type ReplyContext, type ReplyModel } from '../departments/insurance/reply';
import type { ClaimType } from '../departments/insurance/walkthrough';
import { voiceHint } from '../domain/claimsDemoHost';
import { transcribeVoiceNote } from '../services/transcribe.service';

const KEY_VAULT = 'tttagentdevkv62pa5f';
const UNDERSTAND_MODEL = process.env.CLAIMS_UNDERSTAND_MODEL || 'claude-sonnet-4-6';
/** $ per minute of audio (OpenAI's list prices); $ per million tokens in and out for Claude. */
const PER_MINUTE: Record<string, number> = { 'gpt-4o-transcribe': 0.006, 'gpt-4o-mini-transcribe': 0.003, 'whisper-1': 0.006 };
const CLAUDE_PRICE: Record<string, [number, number]> = { 'claude-sonnet-4-6': [3, 15], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5-20251001': [1, 5] };

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const models = (flag('--models') ?? 'gpt-4o-transcribe,gpt-4o-mini-transcribe').split(',').map((s) => s.trim()).filter(Boolean);
const only = flag('--only')?.split(',').map((s) => s.trim());
const audioDir = flag('--audio');
const dry = args.includes('--dry');
const keep = flag('--keep') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'claims-voice-eval-'));

function ttt(): string {
    for (let d = process.cwd(); d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, 'Shared data model'))) return d;
    return process.cwd();
}
const configs = flag('--configs') ?? path.join(ttt(), 'ttt-preseason-agent', 'config', 'claimforms');

// --- the cases ------------------------------------------------------------------------------------------------------------
/** What the client says, and what Tina should save for each question (a RegExp for free text said in many ways). */
interface Case { id: string; keys: string[]; say: string; expect: Record<string, string | number | boolean | RegExp>; before?: Record<string, string | number | boolean> }
const CASES: Case[] = [
    {
        id: 'car',
        keys: ['vehicleMake', 'vehicleModel', 'vehicleRegistration', 'vehicleOwnedByClient', 'registeredOwner'],
        say: "Hi Tina. Um, so it's a Toyota, a Corolla Cross. The registration is C A two three four, five six seven. And yes, it's registered in my name.",
        expect: { vehicleMake: 'Toyota', vehicleModel: 'Corolla Cross', vehicleRegistration: 'CA 234 567', vehicleOwnedByClient: true },
    },
    {
        id: 'finance',
        keys: ['vehicleFinanced', 'financeInstitution', 'financeAgreementType', 'financeAccountNumber', 'financeSettlementAmount'],
        before: { vehicleMake: 'Toyota', vehicleModel: 'Corolla Cross', vehicleRegistration: 'CA 234 567', vehicleOwnedByClient: true },
        say: 'Yes, I still owe money on it. It is with Wesbank, an instalment sale. The account number is eight eight one, two three four, '
            + 'five six seven. And the settlement letter says one hundred and twenty thousand five hundred rand.',
        expect: { vehicleFinanced: true, financeInstitution: /wesbank/i, financeAgreementType: /instal+ment sale/i, financeAccountNumber: '881234567', financeSettlementAmount: 120500 },
    },
    {
        id: 'driver',
        keys: ['driverIsClient', 'driverName', 'driverIdNumber', 'driverPhone', 'driverConsent'],
        before: { vehicleMake: 'Toyota', vehicleOwnedByClient: true, vehicleFinanced: false },
        say: 'No, it was my wife driving. Her name is Lerato Dlamini. Her ID number is eight five zero three one two, five eight zero zero, '
            + 'zero eight one. Her cell is zero eight two, five five five, one two three four. And yes, she had my permission.',
        expect: { driverIsClient: false, driverName: /lerato dlamini/i, driverIdNumber: '8503125800081', driverPhone: '0825551234', driverConsent: true },
    },
    {
        id: 'licence',
        keys: ['licenceNumber', 'licenceCode', 'licenceDateIssued', 'licenceEndorsements'],
        before: { vehicleMake: 'Toyota', vehicleOwnedByClient: true, vehicleFinanced: false, driverIsClient: true },
        say: "OK so the licence number is four zero one nine, zero zero one two, three K five L. It's code E B. It was first issued on the "
            + 'fourteenth of March two thousand and nine. And there are no endorsements.',
        expect: { licenceNumber: '401900123K5L', licenceCode: 'EB', licenceDateIssued: '2009-03-14', licenceEndorsements: /^(none|no|no endorsements?)\.?$/i },
    },
    {
        id: 'trip',
        keys: ['vehicleUse', 'breathalyser', 'driverPhysicalDefects', 'hadPassengers', 'passengersReason'],
        before: { vehicleMake: 'Toyota', vehicleOwnedByClient: true, vehicleFinanced: false, driverIsClient: true, licenceCode: 'EB' },
        say: "I was driving to work. No, sorry, it was a Saturday, so a private trip, I was going to the shops. The police didn't do a "
            + 'breathalyser test. I do wear glasses for driving. And there were no passengers.',
        expect: { vehicleUse: /private/i, breathalyser: false, driverPhysicalDefects: /glasses/i, hadPassengers: false },
    },
];

// --- helpers --------------------------------------------------------------------------------------------------------------
const FACTS = { claimType: 'Motor accident' as ClaimType, description: 'A taxi drove into the back of my car at a robot.',
    incidentAt: '2026-10-24T08:30:00+02:00', place: 'Main Road, Claremont', thirdParties: true, saps: false, injuries: false };
const answered = (v: Record<string, string | number | boolean>) =>
    Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, status: 'answered' as const, at: '2026-10-26T10:00:00.000Z' }]));
const norm = (v: unknown) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
function right(want: string | number | boolean | RegExp, got: unknown): boolean {
    if (got === undefined) return false;
    if (want instanceof RegExp) return want.test(String(got));
    if (typeof want === 'string') return norm(want) === norm(got);
    return want === got;
}

const RECORDINGS = [['ogg', 'audio/ogg'], ['opus', 'audio/ogg'], ['m4a', 'audio/mp4'], ['mp3', 'audio/mpeg'], ['wav', 'audio/wav']] as const;
const recording = (dir: string, id: string) => {
    for (const [ext, mimeType] of RECORDINGS) if (fs.existsSync(path.join(dir, `${id}.${ext}`))) return { file: path.join(dir, `${id}.${ext}`), mimeType };
    return null;
};

/** Whose voice notes: Tessa without --audio; else the folder itself, or each folder in it that holds a recording. */
function speakers(): { name: string; dir?: string }[] {
    if (!audioDir) return [{ name: 'Tessa (macOS say)' }];
    const dirs = [audioDir, ...fs.readdirSync(audioDir).map((d) => path.join(audioDir, d)).filter((d) => fs.statSync(d).isDirectory())];
    const found = dirs.filter((d) => CASES.some((c) => recording(d, c.id))).map((d) => ({ name: path.basename(d), dir: d }));
    if (!found.length) throw new Error(`No recordings in ${audioDir}: expected car.ogg, finance.ogg, ... (or one folder per person).`);
    return found;
}

/** The case's voice note: the speaker's recording, Tessa when there is no --audio, null when the speaker has none. */
function voiceNote(c: Case, dir?: string): { file: string; mimeType: string } | null {
    if (dir) return recording(dir, c.id);
    const file = path.join(keep, `${c.id}.m4a`);
    if (!fs.existsSync(file)) execFileSync('say', ['-v', 'Tessa', '-o', file, '--file-format=m4af', '--data-format=aac', c.say]);
    return { file, mimeType: 'audio/mp4' };
}
const seconds = (file: string) => {
    try {
        return Number(/estimated duration: ([\d.]+)/.exec(execFileSync('afinfo', [file], { encoding: 'utf8' }))?.[1]) || null;
    } catch {
        return null;
    }
};

let claude: Anthropic | undefined;
const usage = { input: 0, output: 0 };
const replyModel: ReplyModel = async (req) => {
    claude ??= new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
            || execFileSync('az', ['keyvault', 'secret', 'show', '--vault-name', KEY_VAULT, '--name', 'anthropic-api-key', '--query', 'value', '-o', 'tsv'], { encoding: 'utf8' }).trim(),
        maxRetries: 3, timeout: 60_000,
    });
    const res = await claude.messages.create({
        model: UNDERSTAND_MODEL, max_tokens: 2048, system: req.system, messages: [{ role: 'user', content: req.user }],
        tools: [{ name: 'record_reply', description: 'Record the answer.', input_schema: req.schema as unknown as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: 'record_reply' },
    });
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')?.input;
};

// --- the run --------------------------------------------------------------------------------------------------------------
async function main() {
    if (!dry && !process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY (the key Tina uses for embeddings), or use --dry.');
    const file = path.join(configs, 'discovery-motor-damage.json');
    if (!fs.existsSync(file)) throw new Error(`No claim form config at ${file}: pass --configs <dir>.`);
    const form: ClaimForm = expandRows(JSON.parse(fs.readFileSync(file, 'utf8'))).find((r) => r.claimType === 'Motor accident')!;
    const now = new Date('2026-10-26T12:00:00Z');
    const cases = CASES.filter((c) => !only || only.includes(c.id));
    const totals = new Map<string, { right: number; of: number; ms: number; claudeMs: number; seconds: number; notes: number }>();
    const add = (key: string, x: { right: number; of: number; ms: number; claudeMs: number; seconds: number }) => {
        const t = totals.get(key) ?? { right: 0, of: 0, ms: 0, claudeMs: 0, seconds: 0, notes: 0 };
        totals.set(key, { right: t.right + x.right, of: t.of + x.of, ms: t.ms + x.ms, claudeMs: t.claudeMs + x.claudeMs, seconds: t.seconds + x.seconds, notes: t.notes + 1 });
    };
    const results: unknown[] = [];
    const who = speakers();

    for (const speaker of who) for (const c of cases) {
        const items = c.keys.map((k) => formItems(form, answered(c.before ?? {}), FACTS).find((i) => i.key === k))
            .filter((i): i is QuestionItem => !!i);
        const asked = batchText(items, { intro: { hint: false, same: false } });
        const audio = voiceNote(c, speaker.dir);
        if (!audio) {
            console.log(`\n=== ${speaker.name} / ${c.id}: no recording, skipped`);
            continue;
        }
        const length = seconds(audio.file);
        console.log(`\n=== ${speaker.name} / ${c.id} (${length ?? '?'}s, ${path.basename(audio.file)})\nTina: ${asked.replace(/\n/g, '\n      ')}\nScript: ${c.say}`);
        if (items.length !== c.keys.length) console.log(`  (not on this form: ${c.keys.filter((k) => !items.some((i) => i.key === k)).join(', ')})`);
        for (const model of dry ? [] : models) {
            process.env.CLAIMS_TRANSCRIBE_MODEL = model;
            const t = await transcribeVoiceNote(fs.readFileSync(audio.file), audio.mimeType, voiceHint(asked));
            if ('problem' in t) {
                console.log(`  ${model}: not used (${t.problem})`);
                continue;
            }
            const ctx: ReplyContext = { open: [], pending: null, missingEvidence: [], asking: items[0], batch: items, openQuestions: [], lastSent: asked };
            const started = Date.now();
            const reading = await readReply(replyModel, ctx, t.text, undefined, `wamid.eval.${c.id}`, now, { spoken: true });
            const claudeMs = Date.now() - started;
            const got = new Map((reading.understood.kind === 'batch' ? reading.understood.answers : []).map((a) => [a.key, a.value] as const));
            const checks = Object.entries(c.expect).map(([key, want]) => ({ key, want: String(want), got: got.get(key), ok: right(want, got.get(key)) }));
            const ok = checks.filter((x) => x.ok).length;
            const scored = { right: ok, of: checks.length, ms: t.ms, claudeMs, seconds: length ?? 0 };
            add(model, scored);
            if (who.length > 1) add(`${model}, ${speaker.name}`, scored);
            const st = { phase: 'items', asking: items[0].key, batch: c.keys } as FollowOnState;
            const echo = heardText([...got].map(([key, value]) => ({ key, value, item: items.find((i) => i.key === key) })), st);
            console.log(`  ${model}: ${ok}/${checks.length} right; heard in ${t.ms}ms, read in ${claudeMs}ms\n    heard: ${t.text}`);
            for (const x of checks.filter((y) => !y.ok)) console.log(`    WRONG ${x.key}: wanted ${x.want}, got ${x.got === undefined ? '(nothing)' : JSON.stringify(x.got)}`);
            if (echo) console.log(`    Tina says back:\n      ${echo.replace(/\n/g, '\n      ')}`);
            results.push({ speaker: speaker.name, case: c.id, model, seconds: length, transcript: t.text, transcribeMs: t.ms, claudeMs, checks });
        }
    }

    if (dry) return console.log(`\nDry run: voice notes in ${keep}`);
    console.log('\n=== Summary');
    const [inPrice, outPrice] = CLAUDE_PRICE[UNDERSTAND_MODEL] ?? [NaN, NaN];
    for (const [model, s] of totals) {
        const minutes = s.seconds / 60;
        const cost = PER_MINUTE[model] !== undefined ? `$${(minutes * PER_MINUTE[model]).toFixed(4)} for ${minutes.toFixed(1)} min` : 'price unknown';
        console.log(`${model}: ${s.right}/${s.of} answers right (${Math.round((100 * s.right) / Math.max(1, s.of))}%); `
            + `transcription ${Math.round(s.ms / s.notes)}ms a note, Claude ${Math.round(s.claudeMs / s.notes)}ms a note; transcription ${cost}`);
    }
    const claudeCost = (usage.input * inPrice + usage.output * outPrice) / 1e6;
    console.log(`Claude (${UNDERSTAND_MODEL}): ${usage.input} tokens in, ${usage.output} out${Number.isFinite(claudeCost) ? `, $${claudeCost.toFixed(4)}` : ''} for every reading above`);
    fs.writeFileSync(path.join(keep, 'results.json'), JSON.stringify(results, null, 1));
    console.log(`Audio and results.json in ${keep}`);
}

main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
