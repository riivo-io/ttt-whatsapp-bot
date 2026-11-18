/**
 * Service routing's eval (docs/PLAN-service-routing.md, build step 4): runs src/domain/sideIntent.ts against the real
 * model on labelled messages and fails on any message sent to the wrong side.
 *
 *   ANTHROPIC_API_KEY=... npx tsx src/scripts/side-intent-eval.ts [runs]
 *
 * `runs` (default 3): each message is asked that many times; one wrong answer in any run fails it.
 * The bar: no insurance message answered tax, no tax message answered insurance. "unsure" is safe (the client is
 * asked, or a tax client stays on tax) and is reported, not failed. Ambiguous messages may get any answer.
 * The model: CLAIMS_INTENT_MODEL, as the service (default claude-haiku-4-5-20251001).
 */
import Anthropic from '@anthropic-ai/sdk';
import { hasInsuranceWords, hasTaxWords, type SideAnswer } from '../domain/serviceRoute';
import { sideRoute, type SideModel } from '../domain/sideIntent';

type Label = 'insurance' | 'tax' | 'ambiguous';

/** Messages the router would send to the model: each has insurance words (or tax words, for the insurance side). */
export const CASES: [string, Label][] = [
    // Insurance: claims
    ['my car was stolen last night', 'insurance'],
    ['Someone drove into the back of my car at a robot in Claremont', 'insurance'],
    ['I was in an accident on the N1 this morning, nobody hurt', 'insurance'],
    ['my geyser burst and the ceiling is soaked', 'insurance'],
    ['we had a break in, they took the TV and laptops', 'insurance'],
    ['I was hijacked yesterday', 'insurance'],
    ['hail damaged my car roof', 'insurance'],
    ['my phone fell and the screen cracked, can I claim?', 'insurance'],
    ['I want to report an insurance claim.', 'insurance'],
    ['I need to open a claim for my windscreen', 'insurance'],
    ['There was a fire in the kitchen', 'insurance'],
    ['lightning struck and the power surge blew my fridge', 'insurance'],
    ['I lost my wedding ring, is that something I can claim for?', 'insurance'],
    ['my bakkie broke down on the highway, need a tow', 'insurance'],
    ['Car battery is flat and I am stuck at the mall', 'insurance'],
    ['the storm blew the roof tiles off', 'insurance'],
    ['my laptop was stolen from my car', 'insurance'],
    ['I reversed into a pole', 'insurance'],
    ['I want to claim for the dent in my door', 'insurance'],
    ['How do I claim from my insurance for my stolen bike?', 'insurance'],
    // Insurance: policies, cover, the broker
    ['can you send me my policy schedule', 'insurance'],
    ['is my laptop covered if I take it overseas?', 'insurance'],
    ['what is my excess on the car?', 'insurance'],
    ['my premium went up again this month, why?', 'insurance'],
    ['I want to add my new car to my policy', 'insurance'],
    ['Please cancel my household contents cover', 'insurance'],
    ['can I get a quote for car insurance', 'insurance'],
    ['who is my insurer for the house?', 'insurance'],
    ['I need to speak to my broker', 'insurance'],
    ['Do I have roadside assistance on my policy?', 'insurance'],
    ['What is the status of my claim for the geyser?', 'insurance'],
    ['I sold my car, please take it off the insurance', 'insurance'],
    ['Does my policy cover hail damage?', 'insurance'],
    ['my debit order for insurance bounced', 'insurance'],
    ['Need proof of insurance for the bank for my vehicle finance', 'insurance'],
    // Tax, with words that look like insurance
    ['can I claim my medical aid contributions on my tax?', 'tax'],
    ['Can I claim travel on my tax return', 'tax'],
    ['can I claim my home office as a deduction', 'tax'],
    ['how much can I claim for my retirement annuity', 'tax'],
    ['my car allowance, how does that work on my tax return?', 'tax'],
    ['do I need a logbook for my car to claim travel', 'tax'],
    ['SARS says I owe them money, what now?', 'tax'],
    ['when will I get my tax refund', 'tax'],
    ['I got my IRP5, where do I send it', 'tax'],
    ['can I deduct my medical aid gap cover premiums?', 'tax'],
    ['my employer gives me a car allowance, do I claim against it?', 'tax'],
    ['Is my car insurance tax deductible for my business?', 'tax'],
    ['my tax return was flagged for verification', 'tax'],
    ['I want to claim my donations to the church', 'tax'],
    ['what is my outstanding invoice with TTT', 'tax'],
    ['claim for my vehicle expenses as a sales rep', 'tax'],
    ['I bought a new car this year, does that change my provisional tax?', 'tax'],
    ['Can my wife and I claim the same medical expenses?', 'tax'],
    ['Do I have to declare the insurance payout from my car accident to SARS?', 'tax'],
    ['I need my tax certificate for my life cover', 'ambiguous'],
    ['When is the deadline to file my return', 'tax'],
    ['send my statement of account please', 'tax'],
    ['I want to cancel my letter of engagement', 'tax'],
    ['Who is my tax consultant?', 'tax'],
    ['What can I claim back from SARS as a freelancer?', 'tax'],
    ['Ek wil n eis instel, my motor is gesteel', 'insurance'],
    ['My car got hit while parked at work, the other guy left a note', 'insurance'],
    ['the insurer rejected my claim, can you help', 'insurance'],
    ['The assessor is coming tomorrow for the car', 'insurance'],
    ['which panelbeater must I take my car to', 'insurance'],
    ['Our office was broken into over the weekend', 'insurance'],
    ['I need a car hire while mine is being fixed after the crash', 'insurance'],
    ['My funeral cover, how much does it pay out?', 'insurance'],
    ['can I claim the interest on my bond on my tax', 'tax'],
    ['Can I claim depreciation on my work laptop', 'tax'],
    ['How do I claim my travel allowance back', 'tax'],
    ["I want to claim my child's school fees, is that allowed?", 'tax'],
    ['SARS rejected my medical expenses claim', 'tax'],
    ['Do I claim my uber trips for work on my return?', 'tax'],
    ['My employer stopped my car allowance, what does that mean for my tax?', 'tax'],
    ['I want to claim the VAT back on my new car for the business', 'tax'],
    // Ambiguous: any answer is allowed, unsure is preferred
    ['I need to claim', 'ambiguous'],
    ['I have a question about a payment', 'ambiguous'],
    ['can someone call me about my claim', 'ambiguous'],
    ['what documents do I need for my claim', 'ambiguous'],
    ['I want to cancel', 'ambiguous'],
    ['Can I get a quote', 'ambiguous'],
    ['claim', 'ambiguous'],
    ['I have a question about my policy and my tax', 'ambiguous'],
];

async function main() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    const runs = Math.max(1, Number(process.argv[2] ?? 3));
    const modelId = process.env.CLAIMS_INTENT_MODEL || 'claude-haiku-4-5-20251001';
    const client = new Anthropic({ apiKey: key });
    const model: SideModel = async (req) => {
        const res = await client.messages.create({
            model: modelId, max_tokens: 256, system: req.system, messages: [{ role: 'user', content: req.user }],
            tools: [{ name: 'record_side', description: 'Record the answer.', input_schema: req.schema as unknown as Anthropic.Tool.InputSchema }],
            tool_choice: { type: 'tool', name: 'record_side' },
        });
        return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')?.input;
    };

    // The cases must be ones the router sends to the model, or the eval tests nothing.
    const unreachable = CASES.filter(([t]) => !hasInsuranceWords(t) && !hasTaxWords(t));
    if (unreachable.length) console.warn(`Not sent to the model by the router (no words): ${unreachable.map(([t]) => `"${t}"`).join(', ')}`);

    let wrong = 0;
    let unsureOnClear = 0;
    const lines: string[] = [];
    for (const [text, label] of CASES) {
        const answers: SideAnswer[] = [];
        for (let i = 0; i < runs; i++) answers.push(await sideRoute(model, text));
        const bad = label !== 'ambiguous' && answers.some((a) => a !== label && a !== 'unsure');
        const unsure = label !== 'ambiguous' && answers.includes('unsure');
        if (bad) wrong++;
        if (unsure) unsureOnClear++;
        lines.push(`${bad ? 'WRONG ' : unsure ? 'unsure' : 'ok    '} ${label.padEnd(9)} ${answers.join(',').padEnd(28)} ${text}`);
    }
    console.log(lines.join('\n'));
    const clear = CASES.filter(([, l]) => l !== 'ambiguous').length;
    console.log(`\n${modelId}, ${runs} run(s) each: ${CASES.length} messages, ${wrong} sent to the wrong side, ${unsureOnClear} of ${clear} clear messages answered unsure at least once.`);
    if (wrong > 0) process.exit(1);
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(2); });
}
