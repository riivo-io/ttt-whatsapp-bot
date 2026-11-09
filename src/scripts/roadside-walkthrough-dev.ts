/**
 * TTTFG-5299: roadside help against TTT DEV, criterion by criterion. Real Dataverse (az login, DEV only) and the real
 * package (src/departments/insurance/roadside*.ts with its Dataverse ports): the numbers read from the CRM, the
 * Roadside assistance requests and the agent actions written. What Claude decides (is it roadside, after an accident,
 * someone hurt) is given per scenario, so this runs without a Claude key; claims-chat.ts runs the same path with Claude.
 *
 *   npx tsx src/scripts/roadside-dev.ts --seed                 first: the Test5299 clients and the test assist numbers
 *   npx tsx src/scripts/roadside-walkthrough-dev.ts            every scenario; evidence in Shared data model/TTTFG-5299/
 *   npx tsx src/scripts/roadside-dev.ts --unseed               after: the test assist numbers come off again
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { claimTurn, type Outbound } from '../departments/insurance/claim';
import { dataverseRoadsidePorts, type Dv } from '../departments/insurance/dataverse';
import type { RoadsideState } from '../departments/insurance/roadside';
import type { RoadsideRoute } from '../departments/insurance/roadside-intent';
import { roadsideReply, roadsideStart } from '../departments/insurance/roadside-turn';
import { claimsConversation, roadsideRequestBody } from '../domain/claimsHost';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';
const EVIDENCE = path.resolve(__dirname, '../../../../Shared data model/TTTFG-5299');
const FIX = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'fixtures.json'), 'utf8')) as { contacts: Record<string, string> };
const MEDUPI = '17a31ce3-ad95-ed11-aad1-000d3ab479cf';
const EMERGENCY = /\b(112|10111|police|SAPS|ambulance|emergency)\b/i;

const tok = execFileSync('az', ['account', 'get-access-token', '--resource', DEV, '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8' }).trim();
const dv: Dv = async <T,>(method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown, opts: { formatted?: boolean; returnRow?: boolean } = {}) => {
    const prefer = [opts.formatted ? 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' : '', opts.returnRow ? 'return=representation' : ''].filter(Boolean).join(', ');
    const res = await fetch(`${DEV}/api/data/v9.2/${p}`, {
        method,
        headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0', ...(prefer ? { Prefer: prefer } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${p.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
};

const route = (o: Partial<RoadsideRoute> = {}): RoadsideRoute => ({ department: 'Insurance and Advice', topic: 'Roadside assistance', fromDamage: false, someoneHurt: false, ...o });
const results: { scenario: string; criteria: string; pass: boolean; checks: { check: string; ok: boolean }[]; said: string[]; rows: unknown[] }[] = [];

/** One conversation: the client's messages in, Tina's replies and the CRM rows out. */
async function conversation(phone: string, contactId: string | null, r: RoadsideRoute, messages: string[]) {
    const said: { text: string; choices?: string[] }[] = [];
    const send = async (_to: string, m: Outbound) => void said.push({ text: m.text, ...(m.kind === 'text' && m.choices ? { choices: m.choices.map((c) => c.title) } : {}) });
    const req = await dv<{ riivo_requestid: string }>('POST', 'riivo_requests?$select=riivo_requestid', roadsideRequestBody(contactId, phone, messages[0]), { returnRow: true });
    const requestId = req.riivo_requestid;
    const ports = (c: { id: string; firstName: string } | null) => ({ ...dataverseRoadsidePorts({ dv, send }), contactByWhatsApp: async () => c });
    const contact = contactId ? await ports(null).activePolicies(contactId).then(async () => {
        const c = await dv<{ firstname: string }>('GET', `contacts(${contactId})?$select=firstname`);
        return { id: contactId, firstName: c.firstname };
    }) : null;
    const conv = claimsConversation(phone, requestId, 'https://www.ttt-tax.co.za/client-onboarding');
    let res = await roadsideStart(ports(contact), conv, contact, r, messages[0], new Date());
    let state: RoadsideState | null = res.state;
    for (const m of messages.slice(1)) {
        if (!state) break;
        res = await roadsideReply(ports(contact), conv, state, m, new Date());
        state = res.state;
    }
    const rows = (await dv<{ value: Record<string, unknown>[] }>('GET',
        `riivo_agentactions?$select=riivo_name,riivo_kind,riivo_status,riivo_urgency,riivo_urgencyreason,riivo_department,riivo_actedon,riivo_duedate,_riivo_client_value,_ownerid_value`
        + `&$filter=riivo_sourcemessageid eq 'riivo_request:${requestId}'&$orderby=createdon asc`, undefined, { formatted: true })).value;
    const request = await dv<Record<string, unknown>>('GET', `riivo_requests(${requestId})?$select=riivo_classificationtopic,_riivo_client_value`);
    return { said, rows, request, requestId, claim: res.claim, ports: ports(contact), conv };
}

const F = (r: Record<string, unknown>, k: string) => String(r[`${k}@OData.Community.Display.V1.FormattedValue`] ?? r[k]);

function record(scenario: string, criteria: string, said: { text: string }[], rows: unknown[], checks: [string, boolean][]) {
    const pass = checks.every(([, ok]) => ok);
    results.push({ scenario, criteria, pass, checks: checks.map(([check, ok]) => ({ check, ok })), said: said.map((s) => s.text), rows });
    console.log(`\n${pass ? 'PASS' : 'FAIL'} ${scenario} (${criteria})`);
    for (const s of said) console.log(`  Tina: ${s.text.replace(/\n/g, '\n        ')}`);
    for (const [c, ok] of checks) console.log(`  ${ok ? 'ok ' : 'NO '} ${c}`);
}

async function main() {
    const PHONE = { one: '+27600052991', two: '+27600052992', nonumber: '+27600052993', home: '+27600052994', unknown: '+27600052999' };

    // S1: AC 1, 5, 7, 9 — one motor policy.
    {
        const c = await conversation(PHONE.one, FIX.contacts.one, route(), ["I've broken down on the N1 near Worcester, the car won't start"]);
        const a = c.rows[0] ?? {};
        record('S1 Rosa, one Discovery motor policy, breaks down', 'AC 1, 5, 7, 9', c.said, c.rows, [
            ['the reply gives the CRM number 0800 5299 01', c.said[0]?.text.includes('*0800 5299 01*')],
            ['the reply says the insurer will confirm what the policy includes', /Discovery Insure will confirm what your policy includes when you call\./.test(c.said[0]?.text ?? '')],
            ['no emergency number, no word on cover', !EMERGENCY.test(c.said[0]?.text ?? '') && !/\bcover(ed|s)?\b/i.test(c.said[0]?.text ?? '')],
            ['the request: Roadside assistance, on Rosa', c.request.riivo_classificationtopic === 'Roadside assistance' && c.request._riivo_client_value === FIX.contacts.one],
            ['one agent action: Created, Open, Insurance and Advice, the broker, on Rosa', c.rows.length === 1 && F(a, 'riivo_kind') === 'Created' && F(a, 'riivo_status') === 'Open'
                && F(a, 'riivo_department') === 'Insurance and Advice' && a._ownerid_value === MEDUPI && a._riivo_client_value === FIX.contacts.one],
            ['its text: insurer, number, policy and time', /Discovery Insure's assist number 0800 5299 01 \(policy Motor RS5299-DI-1\)/.test(String(a.riivo_name)) && /\d{2}:\d{2}/.test(String(a.riivo_name))],
        ]);
    }

    // S2: AC 3 — motor at two insurers, and a household policy whose number must never go.
    {
        const c = await conversation(PHONE.two, FIX.contacts.two, route(), ['My car broke down, I need a tow', '2']);
        record('S2 Thabo, motor at Discovery and Momentum, picks the second', 'AC 3, 9', c.said, c.rows, [
            ['first "Which policy is this car on?" with the two motor policies to tap', c.said[0]?.text === 'Which policy is this car on?'
                && JSON.stringify((c.said[0] as { choices?: string[] }).choices) === JSON.stringify(['Discovery Insure', 'Momentum Insure'])],
            ['no number before the choice', !/0800/.test(c.said[0]?.text ?? '')],
            ['the tap sends Momentum\'s 0800 5299 02 only', (c.said[1]?.text ?? '').includes('0800 5299 02') && !(c.said[1]?.text ?? '').includes('0800 5299 01')],
            ['the household insurer\'s number never goes', !c.said.some((s) => s.text.includes('0800 5299 03'))],
            ['one Created row, for the Momentum policy', c.rows.length === 1 && /RS5299-MO-2/.test(String(c.rows[0].riivo_name))],
        ]);
    }

    // S3: AC 4 — someone hurt, two insurers: every number at once, no question, no emergency number.
    {
        const c = await conversation(PHONE.two, FIX.contacts.two, route({ someoneHurt: true }), ["We hit a cow on the R62, my wife is hurt and the car won't go"]);
        record('S3 Thabo, someone hurt', 'AC 4 (no 112, the developer\'s decision)', c.said, c.rows, [
            ['the first reply holds both assist numbers', (c.said[0]?.text ?? '').includes('0800 5299 01') && (c.said[0]?.text ?? '').includes('0800 5299 02')],
            ['it says to tell the insurer someone is hurt, before any question', /^Call your insurer's assist line now and tell them someone is hurt:/.test(c.said[0]?.text ?? '') && c.said.length === 1],
            ['no 112, 10111, police or emergency services', !c.said.some((s) => EMERGENCY.test(s.text))],
            ['a Created row per insurer, each saying someone is hurt', c.rows.length === 2 && c.rows.every((r) => /someone is hurt/.test(String(r.riivo_name)))],
        ]);
    }

    // S4: AC 6 — the insurer has no assist number on file.
    {
        const c = await conversation(PHONE.nonumber, FIX.contacts.nonumber, route(), ['Stuck on the M5, flat battery']);
        const f = c.rows.find((r) => F(r, 'riivo_kind') === 'Follow-up') ?? {};
        record('S4 Lindi, Old Mutual motor, no assist number on file', 'AC 6, 9', c.said, c.rows, [
            ['the policy card, no number', /Please call the roadside or assist number on your policy card or schedule\./.test(c.said[0]?.text ?? '') && !/\d{3}/.test(c.said[0]?.text ?? '')],
            ['an urgent Follow-up for the broker, open, due within two working hours', F(f, 'riivo_urgency') === 'Urgent' && F(f, 'riivo_status') === 'Open' && f._ownerid_value === MEDUPI && !!f.riivo_duedate],
            ['its reason: no assist number on file', f.riivo_urgencyreason === 'The client broke down and the insurer has no assist number on file'],
            ['and the open Created row', c.rows.some((r) => F(r, 'riivo_kind') === 'Created' && F(r, 'riivo_status') === 'Open')],
        ]);
    }

    // S5: AC 6 — no active motor policy (household only).
    {
        const c = await conversation(PHONE.home, FIX.contacts.home, route(), ['My bakkie broke down on the way to work']);
        const f = c.rows.find((r) => F(r, 'riivo_kind') === 'Follow-up') ?? {};
        record('S5 Pieter, household policy only', 'AC 6', c.said, c.rows, [
            ['"I can\'t see a car policy", the policy card, no number', /^I can't see a car policy for you on our system\. Please call the roadside or assist number on your policy card or schedule\./.test(c.said[0]?.text ?? '')
                && !(c.said[0]?.text ?? '').includes('0800 5299 03')],
            ['an urgent Follow-up: no active motor policy on file', F(f, 'riivo_urgency') === 'Urgent' && f.riivo_urgencyreason === 'The client broke down and has no active motor policy on file'],
        ]);
    }

    // S6: AC 8 — after an accident: the offer, yes, and the walkthrough on the same policy (no claim opened here).
    {
        const c = await conversation(PHONE.one, FIX.contacts.one, route({ fromDamage: true }), ['A taxi hit me on Main Road and I need a tow', 'Yes']);
        const t = c.claim ? await claimTurn(c.ports, c.conv, null, { kind: 'start', facts: { claimType: 'Motor accident' }, opening: c.claim.opening, ...(c.claim.policyId ? { policyId: c.claim.policyId } : {}) }, new Date()) : null;
        record('S6 Rosa, a breakdown after an accident, says yes to a claim', 'AC 8', c.said, c.rows, [
            ['the number first, then "Once you\'re safe, would you like me to start a claim for the damage?"', (c.said[0]?.text ?? '').includes('0800 5299 01')
                && c.said[1]?.text === "Once you're safe, would you like me to start a claim for the damage?"],
            ['yes hands over on Rosa\'s policy, with her words', !!c.claim?.policyId && c.claim.opening === 'A taxi hit me on Main Road and I need a tow'],
            ['the walkthrough goes on from that policy: no policy question, the on-scene list', t?.state?.policyId === c.claim?.policyId && t?.state?.step === 'ready'
                && /^While you're still at the scene/.test(c.said.at(-1)?.text ?? '')],
        ]);
    }
    {
        const c = await conversation(PHONE.one, FIX.contacts.one, route({ fromDamage: true }), ['Hit a pothole, the tyre and rim are gone', 'No thanks']);
        record('S6b Rosa, after damage, says no', 'AC 8', c.said, c.rows, [
            ['no claim handed over, and she can come back', !c.claim && c.said.at(-1)?.text === "No problem. If you'd like to claim later, just send me a message."],
        ]);
    }
    {
        const c = await conversation(PHONE.one, FIX.contacts.one, route(), ['The car just died on the highway']);
        record('S6c Rosa, a plain breakdown', 'AC 8', c.said, c.rows, [['no claim and no offer of one', !c.claim && c.said.length === 1]]);
    }

    // S7: AC 2 — an unknown number.
    {
        const c = await conversation(PHONE.unknown, null, route(), ['Hi, my car broke down on the N2, please help', 'Momentum']);
        const a = c.rows[0] ?? {};
        record('S7 an unknown number, with Momentum', 'AC 2, 9', c.said, c.rows, [
            ['asked which insurer, never for an ID number', /Which insurer is your car insured with\?/.test(c.said[0]?.text ?? '') && !/\bID\b|identity/i.test(c.said[0]?.text ?? '')],
            ['Momentum\'s CRM number, the cover line and how to claim', (c.said[1]?.text ?? '').includes('*0800 5299 02*') && /will confirm what your policy includes/.test(c.said[1]?.text ?? '')
                && /I can't open a claim from this number\. If you'd like to claim, please email TTT from the email address we have on file for you\./.test(c.said[1]?.text ?? '')],
            ['the request has no client', c.request._riivo_client_value === null && c.request.riivo_classificationtopic === 'Roadside assistance'],
            ['one open Created row for the Insurance and Advice team, no client, with the WhatsApp number, insurer, number and time',
                c.rows.length === 1 && F(a, 'riivo_kind') === 'Created' && F(a, 'riivo_status') === 'Open' && a._riivo_client_value === null && a._ownerid_value !== MEDUPI
                && String(a.riivo_name).includes('+27600052999') && /Momentum/.test(String(a.riivo_name)) && String(a.riivo_name).includes('0800 5299 02') && /\d{2}:\d{2}/.test(String(a.riivo_name))],
        ]);
    }
    {
        const c = await conversation(PHONE.unknown, null, route(), ['Broke down. I am with Old Mutual']);
        record('S7b an unknown number with an insurer that has no assist number', 'AC 2, 9', c.said, c.rows, [
            ['the policy card, no number, and how to claim', /I don't have a roadside number for Old Mutual Insure on our system\. Please call the roadside or assist number on your policy card or schedule\./.test(c.said[0]?.text ?? '')
                && !/\d{3}/.test(c.said[0]?.text ?? '') && /email TTT/.test(c.said[0]?.text ?? '')],
        ]);
    }

    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} PASS`);
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(EVIDENCE, `evidence-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`);
    fs.writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), environment: DEV, results }, null, 1));
    console.log(`Evidence: ${file}`);
    if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
