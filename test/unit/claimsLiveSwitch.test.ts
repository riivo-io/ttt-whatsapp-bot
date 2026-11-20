/** Claims go live (20 Nov 2026): the switch (src/utils/claimsLiveSwitch.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsCrmUrl, claimsLiveMode, claimsLiveOn, claimsSite, DEV_CLAIMS_SITE, DEV_CRM_URL, resetClaimsLiveWarning } from '../../src/utils/claimsLiveSwitch';

const PROD = 'https://ttt-financial-group2.crm4.dynamics.com';
const live = (o: Record<string, string> = {}) => ({
    CLAIMS_LIVE: 'on', DYNAMICS_URL: `${PROD}/`, CLAIMS_DATAVERSE_URL: PROD, SERVICE_ROUTING_ENABLED: 'true', ...o,
}) as NodeJS.ProcessEnv;

test('the claims CRM and site: the new settings, else the demo ones, else DEV', () => {
    assert.equal(claimsCrmUrl({}), DEV_CRM_URL);
    assert.equal(claimsCrmUrl({ CLAIMS_DEMO_DATAVERSE_URL: 'https://x.crm4.dynamics.com/' }), 'https://x.crm4.dynamics.com');
    assert.equal(claimsCrmUrl({ CLAIMS_DEMO_DATAVERSE_URL: 'https://x.crm4.dynamics.com', CLAIMS_DATAVERSE_URL: `${PROD}/` }), PROD);
    assert.equal(claimsSite({}), DEV_CLAIMS_SITE);
    assert.equal(claimsSite({ CLAIMS_DEMO_SHAREPOINT_SITE: 'h:/sites/A', CLAIMS_SHAREPOINT_SITE: 'h:/sites/TTTProduction' }), 'h:/sites/TTTProduction');
});

test('live mode: only CLAIMS_LIVE=on, and only when the claims CRM is Tina\'s own CRM', () => {
    assert.equal(claimsLiveMode({}), false);
    assert.equal(claimsLiveMode(live({ CLAIMS_LIVE: 'true' })), false);
    assert.equal(claimsLiveMode(live()), true);
    assert.equal(claimsLiveMode(live({ CLAIMS_LIVE: ' ON ' })), true);
    resetClaimsLiveWarning();
    // Pointed at DEV (no CLAIMS_DATAVERSE_URL): a real client's claim must never land in DEV.
    assert.equal(claimsLiveMode(live({ CLAIMS_DATAVERSE_URL: '' })), false);
    assert.equal(claimsLiveMode(live({ CLAIMS_DATAVERSE_URL: DEV_CRM_URL })), false);
    assert.equal(claimsLiveMode(live({ DYNAMICS_URL: '' })), false);
});

test('live for a number: the number list (any SA format), and service routing on for it', () => {
    assert.equal(claimsLiveOn('27821234567', live()), true);
    assert.equal(claimsLiveOn('27821234567', live({ SERVICE_ROUTING_ENABLED: 'false' })), false);
    assert.equal(claimsLiveOn('27821234567', live({ SERVICE_ROUTING_NUMBERS: '27720000000' })), false);
    const listed = live({ CLAIMS_LIVE_NUMBERS: '082 123 4567, +27720000000' });
    assert.equal(claimsLiveOn('27821234567', listed), true);
    assert.equal(claimsLiveOn('27720000000', listed), true);
    assert.equal(claimsLiveOn('27830000000', listed), false);
    assert.equal(claimsLiveOn('27821234567', { ...listed, CLAIMS_LIVE: 'off' }), false);
});
