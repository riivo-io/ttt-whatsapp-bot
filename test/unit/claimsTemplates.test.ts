/**
 * The user, 18 Nov 2026: the reminder for a claim the client has submitted goes as its own approved WhatsApp template
 * (CLAIMS_MISSING_TEMPLATE), and never as the other one: their variables differ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateSettings, urlButtonSuffix, whatsAppTemplateFor } from '../../src/domain/claimsTemplates';
import { urlButtonComponent } from '../../src/services/metaTemplateButtons';
import { MISSING_REMINDER_MAX_ITEMS, MISSING_REMINDER_TEMPLATE, REMINDER_TEMPLATE } from '../../src/departments/insurance/templates';

const BOTH = { CLAIMS_REMINDER_TEMPLATE: 'ttt_claim_reminder', CLAIMS_MISSING_TEMPLATE: 'ttt_claim_missing_items' } as NodeJS.ProcessEnv;

test('each message goes as its own approved template; the missing-items one is numbered for its bullets', () => {
    assert.deepEqual(whatsAppTemplateFor(REMINDER_TEMPLATE.name, BOTH), { name: 'ttt_claim_reminder', language: 'en' });
    assert.deepEqual(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH, 1), { name: 'ttt_claim_missing_items_1', language: 'en' });
    assert.deepEqual(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH, 3), { name: 'ttt_claim_missing_items_3', language: 'en' });
    assert.deepEqual(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH, MISSING_REMINDER_MAX_ITEMS), { name: `ttt_claim_missing_items_${MISSING_REMINDER_MAX_ITEMS}`, language: 'en' });
});

test('no template is named for a number of bullets there is none for', () => {
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH), undefined);
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH, 0), undefined);
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH, MISSING_REMINDER_MAX_ITEMS + 1), undefined);
});

test('the missing-items message never goes as the reminder template: with its own unset there is none', () => {
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, { CLAIMS_REMINDER_TEMPLATE: 'ttt_claim_reminder' } as NodeJS.ProcessEnv, 2), undefined);
});

test('a message with no name is the reminder (as before the second template)', () => {
    assert.deepEqual(whatsAppTemplateFor(undefined, BOTH), { name: 'ttt_claim_reminder', language: 'en' });
    assert.equal(whatsAppTemplateFor(undefined, {} as NodeJS.ProcessEnv), undefined);
});

test('languages: the reminder\'s, the missing-items one defaulting to it', () => {
    const env = { ...BOTH, CLAIMS_REMINDER_TEMPLATE_LANG: 'en_GB' } as NodeJS.ProcessEnv;
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, env, 2)?.language, 'en_GB');
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, { ...env, CLAIMS_MISSING_TEMPLATE_LANG: 'en_ZA' } as NodeJS.ProcessEnv, 2)?.language, 'en_ZA');
});

test('the settings the package is told: what the host has set up, and nothing else', () => {
    assert.deepEqual(templateSettings(BOTH), { template: true, missingTemplate: true });
    assert.deepEqual(templateSettings({ CLAIMS_REMINDER_TEMPLATE: 'ttt_claim_reminder' } as NodeJS.ProcessEnv), { template: true, missingTemplate: false });
    assert.deepEqual(templateSettings({} as NodeJS.ProcessEnv), { template: false, missingTemplate: false });
    assert.deepEqual(templateSettings({ CLAIMS_MISSING_TEMPLATE: '  ' } as NodeJS.ProcessEnv), { template: false, missingTemplate: false });
});

test('the form link goes in the template\'s URL button as its token, whatever the host\'s own base', () => {
    const env = { SIGNING_PUBLIC_URL: 'https://claims.ttt-tax.co.za/' } as NodeJS.ProcessEnv;
    assert.equal(urlButtonSuffix('https://claims.ttt-tax.co.za/claim-form/abc123_-XYZ', env), 'abc123_-XYZ');
    // Not one of our links, or not a bare token: no button can be filled, so the send is refused rather than opening the wrong page.
    assert.equal(urlButtonSuffix('https://other.example/claim-form/abc123', env), undefined);
    assert.equal(urlButtonSuffix('https://claims.ttt-tax.co.za/claim-form/abc123?x=1', env), undefined);
    assert.equal(urlButtonSuffix('https://claims.ttt-tax.co.za/claim-form/', env), undefined);
    assert.equal(urlButtonSuffix('https://claims.ttt-tax.co.za/claim-form/abc123', {} as NodeJS.ProcessEnv), undefined);
});

test('Meta\'s send call takes the button as a url component with the token as its text', () => {
    assert.deepEqual(urlButtonComponent(0, 'abc123'), { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc123' }] });
});
