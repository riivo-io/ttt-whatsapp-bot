/**
 * TTTFG-4830 (28 Oct 2026, from QC): does Claude read an off-track message right, before trying it on a phone?
 *
 * QC wrote "Can you help me this claim is fraud or hijacked because I never logged it" on the list of what Tina still
 * needed (DEV CLM-000313), and Tina passed it to the broker as a question and asked her finance questions again. Now
 * reply.ts reads `offTrack` ('not-theirs' or 'something-else') and resume.ts asks what the client would like to do,
 * offering a new claim. This runs the real reply prompt (reply.ts readReply) on that message and others like it, on the
 * same list, and on the replies to "What would you like to do?", and prints what Claude read and what Tina would do
 * (resume.ts decide). Nothing is written to the CRM or sent on WhatsApp.
 *
 *   npx tsx src/scripts/claims-offtrack-eval.ts [--only fraud,cancel]
 *
 * Needs ANTHROPIC_API_KEY (else the DEV email agent's Key Vault secret, as claims-voice-eval.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { expandRows } from '../departments/insurance/claimform';
import type { QuestionItem } from '../departments/insurance/contracts';
import type { FollowOnState } from '../departments/insurance/followon';
import { readReply, type ReplyContext, type ReplyModel } from '../departments/insurance/reply';
import { clarifyText, decide, type OpenClaim, type Pending, type ResumeState } from '../departments/insurance/resume';

const KEY_VAULT = 'tttagentdevkv62pa5f';
const UNDERSTAND_MODEL = process.env.CLAIMS_UNDERSTAND_MODEL || 'claude-sonnet-4-6';
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const only = flag('--only')?.split(',').map((s) => s.trim());

const NOW = new Date('2026-10-28T11:32:52Z');
const CLAIM: OpenClaim = { id: 'c1', reference: 'CLM-000313', claimType: 'Motor accident', incidentAt: '2026-10-26T17:00:00Z', status: 'FNOL logged', lastClientMessageOn: '2026-10-28T10:57:55Z' };
const LABEL = { reference: CLAIM.reference, claimType: CLAIM.claimType, incidentAt: CLAIM.incidentAt, ownerName: 'Medupi' };

/** The four finance questions left on the list, from the Discovery motor damage form (the QC claim's). */
function financeItems(): QuestionItem[] {
    const file = path.join(__dirname, '..', '..', '..', 'ttt-preseason-agent', 'config', 'claimforms', 'discovery-motor-damage.json');
    const fallback: QuestionItem[] = [
        { key: 'financeInstitution', kind: 'question', prompt: 'Which bank or finance company is it with?', answerType: 'text', required: true, chase: true },
        { key: 'financeAgreementType', kind: 'question', prompt: 'What kind of finance is it? For example instalment sale, lease or balloon payment.', answerType: 'text', required: false },
        { key: 'financeAccountNumber', kind: 'question', prompt: 'What is the finance account number?', answerType: 'text', required: false },
        { key: 'financeSettlementAmount', kind: 'question', prompt: 'How much do you still owe on the car? The amount on the settlement letter is fine.', answerType: 'number', required: false },
    ];
    if (!fs.existsSync(file)) return fallback;
    const form = expandRows(JSON.parse(fs.readFileSync(file, 'utf8'))).find((r) => r.claimType === 'Motor accident');
    const keys = fallback.map((i) => i.key);
    return form?.questionList.filter((i) => keys.includes(i.key)) ?? fallback;
}
const FINANCE = financeItems();
const STILL_NEED_TEXT = `Thanks. I still need these:\n\n${FINANCE.map((i, n) => `${n + 1}. ${i.prompt}`).join('\n\n')}`;

const ON_LIST: FollowOnState = {
    claimId: 'c1', phase: 'still-need', asking: '', misses: 0, sapsRequired: false, skipped: [], signingRequested: false, evidenceStarted: false,
    introSent: true, listedAt: '2026-10-28T10:58:45Z',
};
const clarifying = (why: 'disputed' | 'unsure'): Pending => ({ kind: 'clarify', claimId: 'c1', why, held: [], back: ON_LIST, ...(why === 'unsure' ? { said: 'x' } : {}) });

interface Case {
    id: string;
    say: string;
    /** Where Tina is: on the list, or waiting on "What would you like to do?" after a dispute or when unsure. */
    on: 'list' | 'disputed' | 'unsure';
    /** What Claude should read; any of them passes. */
    want: { offTrack?: Array<'not-theirs' | 'something-else' | null>; clarify?: Array<string | null> };
}

const CASES: Case[] = [
    { id: 'fraud', on: 'list', say: 'Can you help me this claim is fraud or hijacked because I never logged it', want: { offTrack: ['not-theirs'] } },
    { id: 'not-mine', on: 'list', say: 'This is not my claim', want: { offTrack: ['not-theirs'] } },
    { id: 'someone-else', on: 'list', say: 'I never reported anything, someone is using my details', want: { offTrack: ['not-theirs'] } },
    { id: 'no-policy', on: 'list', say: 'I have no policy', want: { offTrack: ['not-theirs', 'something-else'] } },
    { id: 'cancel', on: 'list', say: 'I want to cancel this claim', want: { offTrack: ['something-else'] } },
    { id: 'person', on: 'list', say: 'Can I please speak to a person', want: { offTrack: ['something-else'] } },
    { id: 'lost', on: 'list', say: "I don't know what this is about", want: { offTrack: ['something-else', 'not-theirs'] } },
    { id: 'answers', on: 'list', say: 'Wesbank, instalment sale, account 881234567, about R80 000', want: { offTrack: [null] } },
    { id: 'dont-know', on: 'list', say: "I don't know the account number, I'll check tonight", want: { offTrack: [null] } },
    { id: 'meaning', on: 'list', say: 'What is a settlement letter?', want: { offTrack: [null] } },
    { id: 'approved', on: 'list', say: 'Is the claim approved?', want: { offTrack: [null] } },
    { id: 'later', on: 'list', say: "Let me stop now, I'll continue later", want: { offTrack: [null] } },
    { id: 'phone', on: 'list', say: 'Also my phone was stolen yesterday at the mall', want: { offTrack: [null] } },
    { id: 'yes-please', on: 'disputed', say: 'yes please', want: { clarify: ['new-claim'] } },
    { id: 'no-fine', on: 'disputed', say: "no it's fine thanks", want: { clarify: ['nothing'] } },
    { id: 'mine-after-all', on: 'disputed', say: 'Sorry my mistake, it is my claim', want: { clarify: ['carry-on'] } },
    { id: 'stolen-car', on: 'disputed', say: 'My car was stolen last night in Sea Point', want: { clarify: ['new-claim'] } },
    { id: 'talk', on: 'unsure', say: 'I want to talk to Medupi', want: { clarify: ['broker'] } },
    { id: 'carry-on', on: 'unsure', say: 'ok carry on', want: { clarify: ['carry-on'] } },
];

let claude: Anthropic | undefined;
const model: ReplyModel = async (req) => {
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
    return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')?.input;
};

async function main() {
    let right = 0;
    const run = CASES.filter((c) => !only || only.includes(c.id));
    for (const c of run) {
        const pending = c.on === 'list' ? null : clarifying(c.on);
        const state: ResumeState = { followOn: pending ? null : ON_LIST, pending };
        const ctx: ReplyContext = {
            open: [CLAIM], pending, missingEvidence: [],
            ...(pending ? {} : { stillNeed: FINANCE, openQuestions: FINANCE, answered: [] }),
            lastSent: pending ? clarifyText(c.on === 'disputed' ? 'disputed' : 'unsure', LABEL, c.on === 'disputed' ? 'dispute' : 'first') : STILL_NEED_TEXT,
        };
        const m = await readReply(model, ctx, c.say, undefined, `w-${c.id}`, NOW);
        const d = decide({ open: [CLAIM], state, message: m, now: NOW });
        const off = m.offTrack?.kind ?? null;
        const ok = (!c.want.offTrack || c.want.offTrack.includes(off)) && (!c.want.clarify || c.want.clarify.includes(m.clarify ?? null));
        if (ok) right++;
        const read = [`understood ${m.understood.kind}`, off && `offTrack ${off}`, m.clarify && `clarify ${m.clarify}`, m.differentIncident && 'differentIncident',
            m.newClaim && 'newClaim'].filter(Boolean).join(', ');
        console.log(`${ok ? 'OK  ' : 'MISS'} ${c.id.padEnd(15)} "${c.say}"\n     read: ${read}\n     Tina: ${d.kind}${d.kind === 'clarify' ? ` (${d.why}${d.dispute ? ', broker told' : ''})` : ''}\n`);
    }
    console.log(`${right}/${run.length} read as expected (${UNDERSTAND_MODEL}).`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
