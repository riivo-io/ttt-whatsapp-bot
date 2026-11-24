/**
 * TTTFG-5340: the real phone lookups in src/services/dynamics.service.ts, with Dataverse faked at the HTTP edge (axios). They
 * are what decides whether a lead Tina made for an unknown number is still the placeholder (no email) or a person who signed
 * up, so the email must come back on every lookup the worker uses, and a CRM error must not read as "no lead".
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.DYNAMICS_CLIENT_ID ||= 'dummy';
process.env.DYNAMICS_CLIENT_SECRET ||= 'dummy';
process.env.DYNAMICS_TENANT_ID ||= 'dummy';
process.env.DYNAMICS_URL ||= 'https://crm.example';
process.env.SUPABASE_URL ||= 'https://supabase.example';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy';
process.env.GRAPH_CLIENT_ID ||= 'dummy';
process.env.GRAPH_CLIENT_SECRET ||= 'dummy';
process.env.GRAPH_TENANT_ID ||= 'dummy';

type Lead = Record<string, unknown>;
const URL_OF = (u: unknown) => decodeURIComponent(String(u));

async function service() {
    const { dynamicsService } = await import('../../src/services/dynamics.service');
    (dynamicsService as unknown as { getToken: () => Promise<string> }).getToken = async () => 'token';
    return dynamicsService;
}

function crm(o: { leads?: Lead[]; fail?: boolean }) {
    const urls: string[] = [];
    mock.method(axios, 'get', async (url: unknown) => {
        urls.push(URL_OF(url));
        if (o.fail) throw new Error('Request failed with status code 429');
        const u = URL_OF(url);
        if (u.includes('/new_leads?')) return { data: { value: o.leads ?? [] } };
        return { data: { value: [] } };
    });
    return urls;
}

test('getContactByPhone returns a lead\'s email (the placeholder has none, a signed-up lead has one) and selects the column', async () => {
    const dynamics = await service();
    const urls = crm({ leads: [{ new_leadid: 'lead-1', ttt_firstname: 'WhatsApp', ttt_lastname: '27839990000', ttt_email: null }] });
    const placeholder = await dynamics.getContactByPhone('27839990000');
    assert.equal(placeholder.type, 'lead');
    assert.equal(placeholder.email, null);
    assert.ok(urls.some((u) => u.includes('/new_leads?') && u.includes('ttt_email')), 'ttt_email is in the select');
    mock.restoreAll();

    crm({ leads: [{ new_leadid: 'lead-1', ttt_firstname: 'Jane', ttt_lastname: 'Smith', ttt_email: 'jane@example.com' }] });
    const signedUp = await dynamics.getContactByPhone('27839990000');
    assert.equal(signedUp.email, 'jane@example.com');
    mock.restoreAll();
});

test('getContactByPhoneAndType and getEntityById (the cached-session lookup) return the lead\'s email too', async () => {
    const dynamics = await service();
    crm({ leads: [{ new_leadid: 'lead-1', ttt_firstname: 'Jane', ttt_lastname: 'Smith', ttt_email: 'jane@example.com' }] });
    assert.equal((await dynamics.getContactByPhoneAndType('27839990000', 'lead')).email, 'jane@example.com');
    assert.equal((await dynamics.getEntityById('lead-1', 'lead')).email, 'jane@example.com');
    mock.restoreAll();
});

test('findActiveLeadByPhone: the lead Tina made wins when the number has several; else the oldest; none is null', async () => {
    const dynamics = await service();
    crm({ leads: [{ new_leadid: 'old', riivo_notes: 'consultant note' }, { new_leadid: 'placeholder', riivo_notes: null }] });
    assert.deepEqual(await dynamics.findActiveLeadByPhone('27839990000', 'placeholder'), { id: 'placeholder', notes: null });
    assert.deepEqual(await dynamics.findActiveLeadByPhone('27839990000'), { id: 'old', notes: 'consultant note' });
    assert.deepEqual(await dynamics.findActiveLeadByPhone('27839990000', 'gone'), { id: 'old', notes: 'consultant note' });
    mock.restoreAll();
    crm({ leads: [] });
    assert.equal(await dynamics.findActiveLeadByPhone('27839990000'), null);
    mock.restoreAll();
});

test('a CRM error throws from findActiveLeadByPhone and phoneKnownStrict: it is never read as "no lead" or "unknown"', async () => {
    const dynamics = await service();
    crm({ fail: true });
    await assert.rejects(dynamics.findActiveLeadByPhone('27839990000'), /429/);
    await assert.rejects(dynamics.phoneKnownStrict('27839990000'), /429/);
    mock.restoreAll();
});

test('phoneKnownStrict: true when a contact or a lead has the number, false when neither does', async () => {
    const dynamics = await service();
    crm({ leads: [{ new_leadid: 'lead-1' }] });
    assert.equal(await dynamics.phoneKnownStrict('27839990000'), true);
    mock.restoreAll();
    crm({ leads: [] });
    assert.equal(await dynamics.phoneKnownStrict('27839990000'), false);
    mock.restoreAll();
});
