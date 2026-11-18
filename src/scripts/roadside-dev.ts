/**
 * TTTFG-5299: get TTT DEV ready for a roadside test with src/scripts/claims-chat.ts, and put it back afterwards.
 *
 *   npx tsx src/scripts/roadside-dev.ts --show +27600051841            the client's active policies and their insurers' assist numbers
 *   npx tsx src/scripts/roadside-dev.ts --insurers                      every insurer and its assist number
 *   npx tsx src/scripts/roadside-dev.ts --set "<insurer id>" "<number>" give an insurer an assist number (DEV only)
 *   npx tsx src/scripts/roadside-dev.ts --clear "<insurer id>"          take it off again
 *   npx tsx src/scripts/roadside-dev.ts --rows +27600051841             the client's roadside requests and agent actions since today
 *   npx tsx src/scripts/roadside-dev.ts --seed                          the Test5299 clients and test assist numbers (ids kept in
 *                                                                        Shared data model/TTTFG-5299/fixtures.json)
 *   npx tsx src/scripts/roadside-dev.ts --unseed                        clear the test assist numbers; prints the rows to delete by hand
 *
 * Insurance staff keep the real numbers in each environment; in DEV a test number stands in for them. DEV only: it refuses
 * any other Dataverse. Sign-in: `az login` as a DEV user, as claims-chat.ts.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function token(): string {
    return execFileSync('az', ['account', 'get-access-token', '--resource', DEV, '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8' }).trim();
}
const t = token();

async function dv<T>(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${DEV}/api/data/v9.2/${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${t}`, Accept: 'application/json', 'Content-Type': 'application/json', 'OData-Version': '4.0',
            Prefer: `odata.include-annotations="OData.Community.Display.V1.FormattedValue"${method === 'POST' ? ', return=representation' : ''}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
}

const variants = (phone: string) => {
    const d = phone.replace(/\D/g, '');
    const local = d.startsWith('27') ? d.slice(2) : d.replace(/^0/, '');
    return [`0${local}`, `+27${local}`, `27${local}`];
};

async function contactOf(phone: string) {
    const or = variants(phone).map((v) => `mobilephone eq '${v}'`).join(' or ');
    const r = await dv<{ value: { contactid: string; fullname: string }[] }>('GET', `contacts?$select=contactid,fullname&$filter=statecode eq 0 and (${or})`);
    if (r.value.length !== 1) throw new Error(`${r.value.length} active contacts on ${phone}: roadside needs exactly one`);
    return r.value[0];
}

// --- The Test5299 clients ------------------------------------------------------------------------------------------------
const FIXTURES = path.resolve(__dirname, '../../../../Shared data model/TTTFG-5299/fixtures.json');
const MEDUPI = '17a31ce3-ad95-ed11-aad1-000d3ab479cf'; // TTT - Insurance, the broker (as the claims demo seed)
const INSURER = {
    discovery: '5506724c-dc89-f011-b4cc-7c1e52881828', momentum: 'f801f851-dc89-f011-b4cc-7c1e52348d13',
    hybrid: '0102f851-dc89-f011-b4cc-7c1e52348d13', oldMutual: 'ae0ffd4b-dc89-f011-b4cc-7ced8d485380',
} as const;
/** Test numbers only, never a real insurer's line. The Hybrid one is a household insurer's: it must never be sent. */
const TEST_ASSIST: Partial<Record<keyof typeof INSURER, string>> = { discovery: '0800 5299 01', momentum: '0800 5299 02', hybrid: '0800 5299 03' };
const CLIENTS: { key: string; firstname: string; mobile: string; policies: { insurer: keyof typeof INSURER; number: string; product: string }[] }[] = [
    { key: 'one', firstname: 'Rosa', mobile: '0600052991', policies: [{ insurer: 'discovery', number: 'RS5299-DI-1', product: 'Motor' }] },
    { key: 'two', firstname: 'Thabo', mobile: '0600052992', policies: [
        { insurer: 'discovery', number: 'RS5299-DI-2', product: 'Motor' }, { insurer: 'momentum', number: 'RS5299-MO-2', product: 'Motor' },
        { insurer: 'hybrid', number: 'RS5299-HY-2', product: 'Household' }] },
    { key: 'nonumber', firstname: 'Lindi', mobile: '0600052993', policies: [{ insurer: 'oldMutual', number: 'RS5299-OM-3', product: 'Motor' }] },
    { key: 'home', firstname: 'Pieter', mobile: '0600052994', policies: [{ insurer: 'hybrid', number: 'RS5299-HY-4', product: 'Household' }] },
];
type Fixtures = { contacts: Record<string, string>; policies: string[]; assistBefore: Record<string, string | null> };
const loadFx = (): Fixtures => (fs.existsSync(FIXTURES) ? JSON.parse(fs.readFileSync(FIXTURES, 'utf8')) : { contacts: {}, policies: [], assistBefore: {} });
const saveFx = (f: Fixtures) => { fs.mkdirSync(path.dirname(FIXTURES), { recursive: true }); fs.writeFileSync(FIXTURES, JSON.stringify(f, null, 1)); };

async function seed() {
    const fx = loadFx();
    for (const [k, number] of Object.entries(TEST_ASSIST) as [keyof typeof INSURER, string][]) {
        const id = INSURER[k];
        if (!(id in fx.assistBefore)) {
            fx.assistBefore[id] = (await dv<{ riivo_assistnumber: string | null }>('GET', `riivo_providers(${id})?$select=riivo_assistnumber`)).riivo_assistnumber;
            saveFx(fx);
        }
        await dv('PATCH', `riivo_providers(${id})`, { riivo_assistnumber: number });
        console.log(`  ${k}: assist number ${number} (test)`);
    }
    for (const c of CLIENTS) {
        if (!fx.contacts[c.key]) {
            const row = await dv<{ contactid: string }>('POST', 'contacts?$select=contactid', {
                firstname: c.firstname, lastname: 'Roadside Test5299', mobilephone: c.mobile, description: 'TTTFG-5299 roadside test client (Claude, 9 Nov 2026)',
                riivo_clienttypenew: '0,3', 'ownerid@odata.bind': `/systemusers(${MEDUPI})`, 'riivo_MainBroker@odata.bind': `/systemusers(${MEDUPI})`,
            });
            fx.contacts[c.key] = row.contactid;
            saveFx(fx);
            for (const p of c.policies) {
                const pol = await dv<{ riivo_policyid: string }>('POST', 'riivo_policies?$select=riivo_policyid', {
                    'riivo_policyholderid@odata.bind': `/contacts(${row.contactid})`, riivo_policy_status: 463630000, riivo_policynumber: p.number,
                    riivo_linkedpolicyid: p.number, riivo_product_2: p.product, riivo_broker: 'TTT - Insurance',
                    'riivo_Provider@odata.bind': `/riivo_providers(${INSURER[p.insurer]})`, 'ownerid@odata.bind': `/systemusers(${MEDUPI})`,
                });
                fx.policies.push(pol.riivo_policyid);
                saveFx(fx);
            }
        }
        console.log(`  ${c.firstname} Roadside Test5299 +27${c.mobile.slice(1)}: ${fx.contacts[c.key]}`);
    }
}

async function unseed() {
    const fx = loadFx();
    for (const [id, before] of Object.entries(fx.assistBefore)) {
        await dv('PATCH', `riivo_providers(${id})`, { riivo_assistnumber: before });
        console.log(`  ${id}: assist number back to ${before ?? '(none)'}`);
    }
    console.log('Rows to delete by hand (with the developer\'s go-ahead): contacts', Object.values(fx.contacts).join(', '), '| policies', fx.policies.join(', '));
}

async function main() {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === '--show') {
        const c = await contactOf(a);
        const r = await dv<{ value: Record<string, unknown>[] }>('GET',
            `riivo_policies?$select=riivo_policyid,riivo_policynumber,riivo_product&$filter=_riivo_policyholderid_value eq ${c.contactid} and riivo_policy_status eq 463630000`
            + '&$expand=riivo_Provider($select=riivo_providerid,riivo_providername,riivo_assistnumber)');
        console.log(`${c.fullname} (${c.contactid})`);
        for (const p of r.value) {
            const prov = p.riivo_Provider as { riivo_providerid: string; riivo_providername: string; riivo_assistnumber: string | null } | null;
            console.log(`  ${p['riivo_product@OData.Community.Display.V1.FormattedValue'] ?? p.riivo_product} ${p.riivo_policynumber}: ${prov?.riivo_providername ?? '(no insurer)'} ${prov?.riivo_providerid ?? ''} assist=${prov?.riivo_assistnumber ?? '(none)'}`);
        }
    } else if (cmd === '--insurers') {
        const r = await dv<{ value: { riivo_providerid: string; riivo_providername: string; riivo_assistnumber: string | null }[] }>('GET',
            'riivo_providers?$select=riivo_providerid,riivo_providername,riivo_assistnumber&$filter=statecode eq 0&$orderby=riivo_providername asc');
        for (const p of r.value) console.log(`  ${p.riivo_providerid} ${p.riivo_providername} assist=${p.riivo_assistnumber ?? '(none)'}`);
    } else if (cmd === '--set' || cmd === '--clear') {
        if (!GUID.test(a ?? '')) throw new Error('An insurer id (riivo_providerid) is needed');
        await dv('PATCH', `riivo_providers(${a})`, { riivo_assistnumber: cmd === '--set' ? b : null });
        console.log(`${a}: assist number ${cmd === '--set' ? `set to ${b}` : 'cleared'}`);
    } else if (cmd === '--rows') {
        const c = await contactOf(a);
        const today = new Date().toISOString().slice(0, 10);
        const req = await dv<{ value: Record<string, unknown>[] }>('GET',
            `riivo_requests?$select=riivo_requestid,riivo_classificationtopic,riivo_description,createdon&$filter=riivo_clientmobilenumber eq '${a}' and createdon ge ${today}&$orderby=createdon asc`);
        for (const r of req.value) console.log(`  request ${r.riivo_requestid} ${r.riivo_classificationtopic}: ${r.riivo_description}`);
        const act = await dv<{ value: Record<string, unknown>[] }>('GET',
            `riivo_agentactions?$select=riivo_name,riivo_kind,riivo_status,riivo_urgency,riivo_urgencyreason,riivo_department,riivo_sourcemessageid,createdon`
            + `&$filter=_riivo_client_value eq ${c.contactid} and createdon ge ${today}&$orderby=createdon asc&$expand=owninguser($select=fullname),owningteam($select=name)`);
        const f = (r: Record<string, unknown>, k: string) => r[`${k}@OData.Community.Display.V1.FormattedValue`] ?? r[k];
        for (const r of act.value) {
            const owner = (r.owninguser as { fullname?: string } | null)?.fullname ?? (r.owningteam as { name?: string } | null)?.name;
            console.log(`  ${f(r, 'riivo_kind')} | ${f(r, 'riivo_status')} | ${f(r, 'riivo_urgency')} | ${f(r, 'riivo_department')} | ${owner} | ${r.riivo_sourcemessageid}\n    ${r.riivo_name}`);
        }
    } else if (cmd === '--seed') {
        await seed();
    } else if (cmd === '--unseed') {
        await unseed();
    } else {
        console.error('Usage: --show <phone> | --insurers | --set <insurer id> <number> | --clear <insurer id> | --rows <phone>');
        process.exit(2);
    }
}

main().catch((e) => { console.error(`ERROR: ${(e as Error).message}`); process.exit(1); });
