/**
 * TTTFG-5212 (claims demo): what the 08:00 reminder would send each demo number, read from the demo CRM (TTT DEV) and
 * printed, with the claim owner's day-5 and stop-day Follow-ups. Nothing is sent and nothing is written: every Dataverse
 * call that isn't a read is refused, and the WhatsApp send and the agent actions only print. Run it the evening before,
 * or after changing a claim, to see the morning.
 *
 *   npx tsx src/scripts/claims-reminder-preview.ts [--at 2026-10-27T06:00:00Z] [--template]
 *
 * The numbers come from CLAIMS_DEMO_NUMBERS (as on Tina). `--at`: when the reminder runs (default: the next 08:00 South
 * African time). `--template`: as if CLAIMS_REMINDER_TEMPLATE were set (clients quiet for over 24 hours get the
 * template). CLAIMS_BROKER_ALERT_DAYS and CLAIMS_STOP_AFTER_DAYS as on Tina. Tina's conversation state isn't read
 * here: a client mid-way through "which claim?" would get no reminder there (the Follow-ups still go).
 * Sign-in: `az login` to TTT's tenant.
 */
import { execFileSync } from 'child_process';
import type { AgentActionRow } from '../departments/insurance/claim';
import type { Dv } from '../departments/insurance/dataverse';
import { remindTurn } from '../departments/insurance/reminder';
import { NO_RESUME_STATE } from '../departments/insurance/resume';
import { dataverseReminderPorts } from '../departments/insurance/resume-dataverse';
import { demoPhones, reminderDays } from '../domain/claimsDemoHost';
import { dataverseCall } from '../services/claimsDemoWiring';

const DEV = process.env.CLAIMS_DEMO_DATAVERSE_URL || 'https://tttdevelopment.crm4.dynamics.com';
const TENANT = process.env.DYNAMICS_TENANT_ID || '';
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

/** The next 08:00 in South Africa (06:00 UTC). */
function nextMorning(now = new Date()): Date {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6));
    return at > now ? at : new Date(at.getTime() + 86_400_000);
}
const at = flag('--at') ? new Date(flag('--at')!) : nextMorning();

let token: { value: string; until: number } | undefined;
function azToken(): string {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const out = execFileSync('az', ['account', 'get-access-token', '--resource', DEV, ...(TENANT ? ['--tenant', TENANT] : []), '-o', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out) as { accessToken: string; expires_on?: number; expiresOn: string };
    token = { value: j.accessToken, until: j.expires_on ? j.expires_on * 1000 : Date.parse(j.expiresOn) };
    return token.value;
}
const read: Dv = dataverseCall(DEV, async () => azToken());
const dv: Dv = (async (method: string, ...rest: unknown[]) => {
    if (method !== 'GET') throw new Error(`Preview: refused ${method} ${String(rest[0]).split('?')[0]}`);
    return (read as (...a: unknown[]) => Promise<unknown>)(method, ...rest);
}) as Dv;

async function main() {
    const phones = demoPhones(process.env.CLAIMS_DEMO_NUMBERS);
    if (!phones.length) throw new Error('Set CLAIMS_DEMO_NUMBERS (27XXXXXXXXX:<contact id>, comma separated), as on Tina');
    console.log(`Morning reminders at ${at.toISOString()} (${phones.length} demo numbers, ${DEV})\n`);
    for (const { phone, contactId } of phones) {
        const base = dataverseReminderPorts({
            dv,
            files: { put: async () => { throw new Error('Preview: no files'); } },
            send: async (_to, m) => {
                const how = m.kind === 'template' && m.params ? `TEMPLATE ${JSON.stringify(m.params)}` : 'MESSAGE';
                console.log(`  ${how}\n${m.text.split('\n').map((l) => `    | ${l}`).join('\n')}`);
            },
        });
        const first = await dv<{ firstname?: string; fullname?: string }>('GET', `contacts(${contactId})?$select=firstname,fullname`);
        const firstName = (first.firstname || first.fullname || '').trim().split(/\s+/)[0] || 'there';
        const ports = {
            ...base,
            contactByWhatsApp: async () => ({ id: contactId, firstName }),
            createAgentAction: async (row: AgentActionRow) => {
                console.log(row.kind === 'Follow-up' ? `  FOLLOW-UP for ${row.owner.name}: ${row.detail}` : `  (agent action: ${row.detail})`);
                return { id: 'preview' };
            },
        };
        console.log(`${phone} ${firstName} (${contactId})`);
        const r = await remindTurn(ports, { phone, requestId: '', signUpLink: '' }, NO_RESUME_STATE, contactId, at, {
            template: args.includes('--template'), ...reminderDays(process.env.CLAIMS_BROKER_ALERT_DAYS, process.env.CLAIMS_STOP_AFTER_DAYS),
        });
        for (const o of r.outcomes) {
            console.log(`  ${o.reference}: ${'sent' in o ? `sent as ${o.sent}` : `no reminder (${o.skipped})`}${o.broker ? `; owner's ${o.broker} Follow-up` : ''}`);
        }
        if (!r.outcomes.length) console.log('  no open claims');
        console.log('');
    }
}

main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
});
