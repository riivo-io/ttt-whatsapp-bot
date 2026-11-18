/**
 * TTTFG-5340: rehearse an unknown WhatsApp number against TTT DEV, and put DEV back afterwards.
 *
 *   npx tsx src/scripts/unknown-number-dev.ts --run [phone]    the scenario by acceptance criterion, then clean up
 *   npx tsx src/scripts/unknown-number-dev.ts --run [phone] --keep   the same, leaving the lead and the action to look at in My Day
 *   npx tsx src/scripts/unknown-number-dev.ts --show [phone]   the leads and agent actions on the number
 *   npx tsx src/scripts/unknown-number-dev.ts --clean [phone]  delete this script's test lead and action (DEV only)
 *
 * It runs the real src/domain/unknownNumber.ts and src/domain/signUpLead.ts against the real TTT DEV Dataverse, with the one
 * thing it must not touch faked: WhatsApp (the reply is printed, nothing is sent). The reply table is in memory, because
 * the unknown_number_replies migration is applied to Tina's Supabase by the developer, not by a script. What this proves is
 * the CRM side: the lead and the Created action are accepted, owned by the Tax team, and one lead remains after the sign-up
 * form. It signs in as a DEV user, not as Tina's application user, so the app user's own privileges are still the real test.
 *
 * The number defaults to a Test5340 number that no one owns. DEV only: it refuses any other Dataverse. Sign-in: `az login`.
 */
import { execFileSync } from 'child_process';
import { answerUnknownNumber, createdActionColumns, isPlaceholderLead, placeholderLeadParams, REPLY_WINDOW_MS, type UnknownNumberPorts } from '../domain/unknownNumber';
import { saveSignUpLead } from '../domain/signUpLead';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';
const TEST_PHONE = '27600053400';
const LINK = 'https://www.ttt-tax.co.za/client-onboarding';

function token(): string {
    return execFileSync('az', ['account', 'get-access-token', '--resource', DEV, '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8' }).trim();
}
let cached: string | undefined;
/** Signs in only when a command needs DEV, so the usage text prints without `az`. */
const bearer = () => (cached ??= token());

async function dv<T>(method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${DEV}/api/data/v9.2/${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${bearer()}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0',
            Prefer: `odata.include-annotations="OData.Community.Display.V1.FormattedValue"${method === 'POST' ? ', return=representation' : ''}`,
            ...(method === 'PATCH' ? { 'If-Match': '*' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
}

const variants = (phone: string) => {
    const d = phone.replace(/\D/g, '');
    const local = d.startsWith('27') ? d.slice(2) : d.replace(/^0/, '');
    return [`0${local}`, `+27${local}`, `27${local}`];
};
const orOf = (field: string, phone: string) => variants(phone).map((v) => `${field} eq '${v}'`).join(' or ');

const leadsOn = (phone: string) => dv<{ value: Record<string, unknown>[] }>('GET',
    `new_leads?$select=new_leadid,ttt_firstname,ttt_lastname,ttt_email,ttt_mobilephone,riivo_leadtype,riivo_leadsource,riivo_notes,_ownerid_value&$filter=statecode eq 0 and (${orOf('ttt_mobilephone', phone)})`)
    .then((r) => r.value);
const contactsOn = (phone: string) => dv<{ value: { contactid: string }[] }>('GET',
    `contacts?$select=contactid&$filter=statecode eq 0 and (${orOf('mobilephone', phone)})`).then((r) => r.value);
const actionsOn = (phone: string) => dv<{ value: Record<string, unknown>[] }>('GET',
    `riivo_agentactions?$select=riivo_agentactionid,riivo_name,riivo_kind,riivo_status,riivo_department,riivo_recipient,_ownerid_value,_riivo_client_value&$filter=riivo_recipient eq '${phone}'`)
    .then((r) => r.value);

async function taxTeam(): Promise<{ id: string; name: string }> {
    const r = await dv<{ value: { teamid: string; name: string }[] }>('GET', "teams?$select=teamid,name&$top=1&$filter=teamtype eq 0 and name eq 'Tax'");
    if (!r.value[0]) throw new Error("no team named 'Tax' in DEV");
    return { id: r.value[0].teamid, name: r.value[0].name };
}

function line(ok: boolean, what: string, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`); return ok; }

async function show(phone: string) {
    const leads = await leadsOn(phone);
    const actions = await actionsOn(phone);
    console.log(`${phone}: ${(await contactsOn(phone)).length} contact(s), ${leads.length} lead(s), ${actions.length} agent action(s)`);
    for (const l of leads) console.log('  lead', JSON.stringify(l));
    for (const a of actions) console.log('  action', JSON.stringify(a));
}

async function clean(phone: string) {
    if (phone !== TEST_PHONE && !phone.startsWith('2760005340')) throw new Error(`refusing to clean ${phone}: only a Test5340 number`);
    for (const a of await actionsOn(phone)) { await dv('DELETE', `riivo_agentactions(${a.riivo_agentactionid})`); console.log('deleted action', a.riivo_agentactionid); }
    for (const l of await leadsOn(phone)) { await dv('DELETE', `new_leads(${l.new_leadid})`); console.log('deleted lead', l.new_leadid); }
}

/** The columns DynamicsService.createLead sets for these parameters (riivo_leadsource is dropped if this DEV does not have it). */
async function createLead(p: ReturnType<typeof placeholderLeadParams>): Promise<string> {
    const payload: Record<string, unknown> = {
        ttt_firstname: p.firstName, ttt_lastname: p.lastName, ttt_mobilephone: p.phone, riivo_leadtype: p.leadType, riivo_leadsource: p.leadSource,
        ...(p.ownerTeamId ? { 'ownerid@odata.bind': `/teams(${p.ownerTeamId})` } : {}),
    };
    try {
        return (await dv<{ new_leadid: string }>('POST', 'new_leads', payload)).new_leadid;
    } catch (e) {
        if (!/riivo_leadsource/i.test((e as Error).message)) throw e;
        console.log('note: this DEV rejects riivo_leadsource; retried without it, as createLead does');
        delete payload.riivo_leadsource;
        return (await dv<{ new_leadid: string }>('POST', 'new_leads', payload)).new_leadid;
    }
}

async function run(phone: string, keep: boolean) {
    if (phone !== TEST_PHONE && !phone.startsWith('2760005340')) throw new Error(`refusing ${phone}: only a Test5340 number (27600053400 to 27600053409)`);
    if ((await contactsOn(phone)).length || (await leadsOn(phone)).length || (await actionsOn(phone)).length) {
        throw new Error(`${phone} already has rows in DEV: run --show, then --clean, first`);
    }
    const team = await taxTeam();
    console.log(`Tax team in DEV: ${team.name} (${team.id})\n`);

    const replies = new Map<string, { at: number; leadId: string | null; actionId: string | null }>();
    const sent: string[] = [];
    const ports: UnknownNumberPorts = {
        async claim(p, now) {
            const r = replies.get(p);
            if (!r) { replies.set(p, { at: now.getTime(), leadId: null, actionId: null }); return { claimed: true, leadId: null, actionId: null }; }
            if (r.at < now.getTime() - REPLY_WINDOW_MS) { r.at = now.getTime(); return { claimed: true, leadId: r.leadId, actionId: r.actionId }; }
            return { claimed: false, leadId: r.leadId, actionId: r.actionId };
        },
        async release(p) { replies.get(p)!.at = 0; },
        createLead: (p) => createLead(placeholderLeadParams(p, team.id)),
        async createAction(p, leadId, at, source) {
            const row = await dv<{ riivo_agentactionid: string }>('POST', 'riivo_agentactions?$select=riivo_agentactionid',
                createdActionColumns({ phone: p, leadId, at, sourceMessageId: source, ownerTeamId: team.id }));
            return row.riivo_agentactionid;
        },
        async remember(p, leadId, actionId) { const r = replies.get(p)!; r.leadId = leadId; if (actionId) r.actionId = actionId; },
        async send(_p, text) { sent.push(text); console.log(`  Tina says: ${text}`); return true; },
        log: (l) => console.log(`  [log] ${l}`),
    };

    let ok = true;
    const t0 = new Date();
    console.log('AC 1, 2, 3, 5: "Hi, I\'m Jane Smith, ID 8001015009087, where is my refund?" from a number on no contact and no lead');
    const first = await answerUnknownNumber(ports, phone, LINK, t0, `rehearsal-${Date.now()}`);
    ok = line(first.replied && first.leadCreated, 'one reply and one lead') && ok;
    ok = line(sent.length === 1 && sent[0].endsWith(LINK) && !/refund|ID number|\?/.test(sent[0]), 'the reply is the fixed one with the tax link and asks nothing') && ok;
    const leads = await leadsOn(phone);
    const lead = leads[0] as Record<string, unknown> | undefined;
    ok = line(leads.length === 1, 'exactly one lead on the number') && ok;
    ok = line(lead?.riivo_leadtype === 100000000, 'the lead\'s type is Tax', `riivo_leadtype ${lead?.riivo_leadtype}`) && ok;
    ok = line(lead?._ownerid_value === team.id, 'the lead is owned by the Tax team') && ok;
    ok = line(!JSON.stringify(lead).includes('8001015009087'), 'no ID number on the lead') && ok;
    const acts = await actionsOn(phone);
    const act = acts[0] as Record<string, unknown> | undefined;
    ok = line(acts.length === 1 && act?.riivo_kind === 463630007, 'one agent action of Kind Created', `riivo_kind ${act?.riivo_kind}`) && ok;
    ok = line(act?._ownerid_value === team.id && act?.riivo_department === 463630000, 'the action is owned by the Tax team, department Tax') && ok;
    ok = line(act?._riivo_client_value === lead?.new_leadid, 'the action is regarding the lead') && ok;
    ok = line(act?.riivo_status === 463630000, 'the action is open, so it shows in My Day') && ok;

    console.log('\nAC 6: a second message an hour later, and one 25 hours later');
    const again = await answerUnknownNumber(ports, phone, LINK, new Date(t0.getTime() + 3_600_000), 'rehearsal-2');
    ok = line(!again.replied && !again.leadCreated && sent.length === 1, 'no second reply inside 24 hours') && ok;
    const next = await answerUnknownNumber(ports, phone, LINK, new Date(t0.getTime() + 25 * 3_600_000), 'rehearsal-3');
    ok = line(next.replied && !next.leadCreated && sent.length === 2, 'answered again after 24 hours, with no second lead') && ok;
    ok = line((await leadsOn(phone)).length === 1 && (await actionsOn(phone)).length === 1, 'still one lead and one action') && ok;

    console.log('\nStill the unknown number until it signs up');
    ok = line(isPlaceholderLead(replies.get(phone)!.leadId, { id: String(lead?.new_leadid), email: (lead?.ttt_email as string) ?? null }), 'the lead with no email is the placeholder') && ok;

    console.log('\nAC 5: the same person fills in the WhatsApp sign-up form');
    const saved = await saveSignUpLead({
        async findByPhone(p) { const l = (await leadsOn(p))[0]; return l ? { id: String(l.new_leadid), notes: (l.riivo_notes as string) ?? null } : null; },
        async update(id, c) {
            await dv('PATCH', `new_leads(${id})`, { ttt_firstname: c.firstName, ttt_lastname: c.lastName, ttt_email: c.email, ...(c.notes ? { riivo_notes: c.notes } : {}),
                ...(typeof c.clientType === 'number' ? { riivo_clienttype: c.clientType } : {}), ...(typeof c.leadType === 'number' ? { riivo_leadtype: c.leadType } : {}) });
            return true;
        },
        create: async () => { throw new Error('the form must update, not create'); },
    }, phone, { firstName: 'Jane', lastName: 'Smith', email: 'jane.smith.5340@example.com', notes: 'Rehearsal: signed up on WhatsApp', clientType: 0, leadType: 100000000 });
    ok = line(saved?.how === 'updated' && saved.leadId === lead?.new_leadid, 'the form updated the lead on the number') && ok;
    const after = await leadsOn(phone);
    ok = line(after.length === 1, 'one lead remains') && ok;
    ok = line(after[0]?.ttt_firstname === 'Jane' && after[0]?.ttt_email === 'jane.smith.5340@example.com', 'it has the name and email the form typed') && ok;
    ok = line(!isPlaceholderLead(replies.get(phone)!.leadId, { id: String(after[0].new_leadid), email: after[0].ttt_email as string }), 'with an email it is a normal lead, no longer the unknown number') && ok;

    console.log(`\n${ok ? 'ALL PASS' : 'SOMETHING FAILED'}`);
    if (keep) console.log('\nKept for you to look at in DEV (My Day, Tax team). Remove with --clean.'); else { console.log(''); await clean(phone); }
    if (!ok) process.exitCode = 1;
}

const args = process.argv.slice(2);
const phone = args.find((a, i) => i > 0 && /^\+?\d{9,}$/.test(a))?.replace(/\D/g, '') ?? TEST_PHONE;
(async () => {
    if (args[0] === '--run') await run(phone, args.includes('--keep'));
    else if (args[0] === '--show') await show(phone);
    else if (args[0] === '--clean') await clean(phone);
    else console.log('usage: --run [phone] [--keep] | --show [phone] | --clean [phone]');
})().catch((e) => { console.error((e as Error).message); process.exit(1); });
