/**
 * Service routing, DEV check (docs/PLAN-service-routing.md, build step 8): runs routeClientMessage against TTT DEV's
 * Dataverse with real writes (requests, Follow-ups, notes, WhatsApp communication rows), and WhatsApp + Supabase faked
 * in memory. Prints what Tina would send and the [Route] line for each message.
 *
 *   npx tsx src/scripts/route-dev-check.ts <insuranceContactId> <taxContactId> <bothContactId>
 *
 * Dataverse with your own `az login` token. DEV only: it refuses any other DYNAMICS_URL. No Anthropic key needed: with
 * none, the model step fails, which must read as "unsure" (the safe fallback) — this checks that too.
 * Prints the time it started, so the rows it made can be found and removed afterwards.
 */
import { execSync } from 'node:child_process';

const DEV = 'https://tttdevelopment.crm4.dynamics.com';

async function main() {
    const [insId, taxId, bothId] = process.argv.slice(2);
    if (!insId || !taxId || !bothId) throw new Error('usage: route-dev-check.ts <insuranceContactId> <taxContactId> <bothContactId>');
    const url = (process.env.DYNAMICS_URL || DEV).replace(/\/$/, '');
    if (url !== DEV) throw new Error(`DEV only: DYNAMICS_URL is ${url}`);
    // The services check their settings on import. Dataverse uses the az token below; Supabase and Meta are faked.
    Object.assign(process.env, {
        DYNAMICS_URL: DEV, DYNAMICS_CLIENT_ID: 'az-cli', DYNAMICS_CLIENT_SECRET: 'az-cli', DYNAMICS_TENANT_ID: 'common',
        SUPABASE_URL: 'http://localhost:1', SUPABASE_SERVICE_ROLE_KEY: 'fake', SERVICE_ROUTING_ENABLED: 'true',
    });
    delete process.env.CLAIMS_ENABLED; // as PROD today: claims off
    const token = execSync(`az account get-access-token --resource ${DEV} --query accessToken -o tsv`).toString().trim();

    const { dynamicsService } = await import('../services/dynamics.service');
    const { supabaseService } = await import('../services/supabase.service');
    const { metaWhatsAppService } = await import('../services/meta.service');
    const { routeClientMessage } = await import('../services/serviceRouting.service');
    const { ROUTE_IDS } = await import('../domain/serviceRoute');

    (dynamicsService as any).getToken = async () => token;
    const history = new Map<string, string[]>();
    const sessions = new Map<string, any>();
    Object.assign(supabaseService, {
        getHistory: async (id: string) => (history.get(id) ?? []).map((content) => ({ role: 'user', content })),
        saveMessage: async (id: string, _role: string, text: string) => void history.set(id, [...(history.get(id) ?? []), text]),
        setSessionRoute: async (id: string, patch: object) => void Object.assign(sessions.get(id), patch),
        getClaimWalkthrough: async () => null,
    });
    Object.assign(metaWhatsAppService, {
        sendMessage: async (_to: string, text: string) => (console.log(`   Tina: ${text.replace(/\n/g, ' / ')}`), 'wamid.fake'),
        sendReplyButtons: async (_to: string, text: string, b: { title: string }[]) => console.log(`   Tina: ${text.replace(/\n/g, ' / ')}  [${b.map((x) => x.title).join('] [')}]`),
    });

    const contact = async (id: string) => {
        const c = await dynamicsService.webApi<{ contactid: string; fullname: string; mobilephone: string }>('GET', `contacts(${id})?$select=contactid,fullname,mobilephone`);
        return { entity: { id: c.contactid, type: 'client' as const, fullname: c.fullname }, phone: c.mobilephone.replace(/\s+/g, '') };
    };
    const session = (name: string, extra: object = {}) => {
        const s = { id: `dev-check-${name}`, service_side: null, route_pending: null, insurance_handover: null, ...extra };
        sessions.set(s.id, s);
        return s;
    };
    const send = async (who: { entity: any; phone: string }, s: any, text: string, o: { tapId?: string; file?: boolean } = {}) => {
        console.log(`\n Client: ${o.file ? '(file) ' : ''}${o.tapId ? `(tap ${o.tapId}) ` : ''}${text}`);
        const r = await routeClientMessage({
            from: who.phone, entity: who.entity, session: s, text, tapId: o.tapId, wamid: undefined,
            file: o.file ? { name: 'route-dev-check.png', mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgo=', 'base64') } : null,
        });
        if (!r.handled) console.log(`   → Tina's tax path${r.text !== undefined ? ` answers: "${r.text}"` : ''}`);
        return r;
    };

    console.log(`Started ${new Date().toISOString()} against ${DEV}`);
    const ins = await contact(insId);
    const tax = await contact(taxId);
    const both = await contact(bothId);

    console.log('\n=== Insurance only ===');
    const s1 = session('ins');
    await send(ins, s1, 'hi');
    await send(ins, s1, 'can you send me my policy schedule');
    await send(ins, s1, 'the one for the car please');
    await send(ins, s1, 'I just sent you a document.', { file: true });
    await send(ins, s1, 'thank you');
    await send(ins, session('ins-claim'), 'Report a claim', { tapId: ROUTE_IDS.INSURANCE_CLAIM });

    console.log('\n=== Tax only ===');
    const s2 = session('tax');
    await send(tax, s2, 'when is my tax return due');
    await send(tax, s2, 'my car was stolen last night');
    await send(tax, s2, 'insurance');
    await send(tax, s2, 'Yes, contact me', { tapId: ROUTE_IDS.OFFER_YES });
    await send(tax, s2, 'it was a white polo');

    console.log('\n=== Both ===');
    const s3 = session('both');
    await send(both, s3, 'question about my excess');
    await send(both, s3, '🛡️ Insurance', { tapId: ROUTE_IDS.INSURANCE });
    await send(both, s3, 'and the excess on the house?');
    const s4 = session('both-tax');
    await send(both, s4, 'question about my excess');
    await send(both, s4, '🧾 Tax', { tapId: ROUTE_IDS.TAX });
    await send(both, session('both-hi'), 'hi');

    console.log('\nSessions:');
    for (const s of sessions.values()) console.log(` ${s.id}: side=${s.service_side ?? '-'} pending=${s.route_pending ? s.route_pending.kind : '-'} handover=${s.insurance_handover ? `${s.insurance_handover.requestId} (${s.insurance_handover.ownerKind})` : '-'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
