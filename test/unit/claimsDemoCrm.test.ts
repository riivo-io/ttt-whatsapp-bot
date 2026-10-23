/**
 * TTTFG-4830 claims demo: fewer CRM calls per message (cachedDv) and a "too many requests" waited out (dataverseCall).
 * The claims package reads the same rows several times for one message; each must be read once, and never be stale
 * after a write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedDv, clearSharedCrmCache, dataverseCall, newCrmStats } from '../../src/services/claimsDemoWiring';
import type { Dv } from '../../src/departments/insurance/dataverse';

function fakeCrm() {
    const calls: string[] = [];
    let version = 1;
    const dv = (async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (method !== 'GET') { version++; return undefined; }
        if (path.startsWith('broken')) throw new Error('500');
        return { path, version, nested: { n: 1 } };
    }) as Dv;
    return { dv, calls };
}

test('each row is read once per message; a write to a table makes its next read fresh, other tables stay cached', async () => {
    clearSharedCrmCache();
    const crm = fakeCrm();
    const stats = newCrmStats();
    const dv = cachedDv(crm.dv, stats);
    const a = await dv<{ version: number }>('GET', 'riivo_claims(1)?$select=x');
    await dv('GET', 'riivo_claims(1)?$select=x');
    await dv('GET', 'riivo_clientdocuments?$filter=_riivo_claim_value eq 1');
    await dv('GET', 'riivo_clientdocuments?$filter=_riivo_claim_value eq 1');
    assert.equal(crm.calls.length, 2);
    await dv('PATCH', 'riivo_claims(1)', { riivo_answers: '{}' });
    const b = await dv<{ version: number }>('GET', 'riivo_claims(1)?$select=x');
    await dv('GET', 'riivo_clientdocuments?$filter=_riivo_claim_value eq 1');
    assert.equal(a.version, 1);
    assert.equal(b.version, 2); // read again after the write
    assert.deepEqual(crm.calls, [
        'GET riivo_claims(1)?$select=x', 'GET riivo_clientdocuments?$filter=_riivo_claim_value eq 1', 'PATCH riivo_claims(1)', 'GET riivo_claims(1)?$select=x',
    ]);
    assert.deepEqual(stats, { reads: 3, cached: 3, writes: 1, throttled: 0 });
});

test('a new message starts with nothing cached, except claim forms, document types and contacts for 10 minutes', async () => {
    clearSharedCrmCache();
    const crm = fakeCrm();
    let t = 0;
    const first = cachedDv(crm.dv, undefined, () => t);
    await first('GET', 'riivo_claims(1)');
    await first('GET', 'riivo_claimforms(9)');
    const second = cachedDv(crm.dv, undefined, () => t);
    await second('GET', 'riivo_claims(1)');
    await second('GET', 'riivo_claimforms(9)');
    assert.deepEqual(crm.calls, ['GET riivo_claims(1)', 'GET riivo_claimforms(9)', 'GET riivo_claims(1)']);
    t = 11 * 60_000;
    await cachedDv(crm.dv, undefined, () => t)('GET', 'riivo_claimforms(9)');
    assert.equal(crm.calls.length, 4);
});

test('a failed read is not kept, and every caller gets its own copy', async () => {
    clearSharedCrmCache();
    const crm = fakeCrm();
    const dv = cachedDv(crm.dv);
    await assert.rejects(dv('GET', 'broken(1)'));
    await assert.rejects(dv('GET', 'broken(1)'));
    assert.equal(crm.calls.length, 2);
    const x = await dv<{ nested: { n: number } }>('GET', 'riivo_claims(2)');
    x.nested.n = 99;
    const y = await dv<{ nested: { n: number } }>('GET', 'riivo_claims(2)');
    assert.equal(y.nested.n, 1);
});

test('formatted and plain reads of the same row are kept apart', async () => {
    clearSharedCrmCache();
    const crm = fakeCrm();
    const dv = cachedDv(crm.dv);
    await dv('GET', 'riivo_claims(3)');
    await dv('GET', 'riivo_claims(3)', undefined, { formatted: true });
    assert.equal(crm.calls.length, 2);
});

test('a 429 is waited out as the CRM asks, then the call goes through; the 4th 429 in a row fails it', async () => {
    const real = globalThis.fetch;
    const answers: number[] = [];
    let n = 0;
    globalThis.fetch = (async () => {
        const status = answers[n++] ?? 200;
        return new Response(status === 200 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: { message: 'Number of requests exceeded the limit' } }),
            { status, headers: status === 429 ? { 'Retry-After': '1' } : {} });
    }) as typeof fetch;
    try {
        const stats = newCrmStats();
        const dv = dataverseCall('https://crm.example', () => 'token', { stats });
        answers.push(429, 200);
        const t = Date.now();
        assert.deepEqual(await dv('GET', 'riivo_claims(1)'), { ok: true });
        assert.ok(Date.now() - t >= 900, 'waited for Retry-After');
        assert.equal(stats.throttled, 1);
        answers.length = 0; n = 0;
        answers.push(429, 429, 429, 429);
        await assert.rejects(dv('POST', 'riivo_agentactions', {}), /429/);
        assert.equal(n, 4);
    } finally {
        globalThis.fetch = real;
    }
});
