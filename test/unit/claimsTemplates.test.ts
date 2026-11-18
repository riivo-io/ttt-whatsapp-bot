/**
 * The user, 18 Nov 2026: the reminder for a claim the client has submitted goes as its own approved WhatsApp template
 * (CLAIMS_MISSING_TEMPLATE), and never as the other one: their variables differ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateSettings, whatsAppTemplateFor } from '../../src/domain/claimsTemplates';
import { MISSING_REMINDER_TEMPLATE, REMINDER_TEMPLATE } from '../../src/departments/insurance/templates';

const BOTH = { CLAIMS_REMINDER_TEMPLATE: 'ttt_claim_reminder', CLAIMS_MISSING_TEMPLATE: 'ttt_claim_missing_items' } as NodeJS.ProcessEnv;

test('each message goes as its own approved template', () => {
    assert.deepEqual(whatsAppTemplateFor(REMINDER_TEMPLATE.name, BOTH), { name: 'ttt_claim_reminder', language: 'en' });
    assert.deepEqual(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, BOTH), { name: 'ttt_claim_missing_items', language: 'en' });
});

test('the missing-items message never goes as the reminder template: with its own unset there is none', () => {
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, { CLAIMS_REMINDER_TEMPLATE: 'ttt_claim_reminder' } as NodeJS.ProcessEnv), undefined);
});

test('a message with no name is the reminder (as before the second template)', () => {
    assert.deepEqual(whatsAppTemplateFor(undefined, BOTH), { name: 'ttt_claim_reminder', language: 'en' });
    assert.equal(whatsAppTemplateFor(undefined, {} as NodeJS.ProcessEnv), undefined);
});

test('languages: the reminder\'s, the missing-items one defaulting to it', () => {
    const env = { ...BOTH, CLAIMS_REMINDER_TEMPLATE_LANG: 'en_GB' } as NodeJS.ProcessEnv;
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, env)?.language, 'en_GB');
    assert.equal(whatsAppTemplateFor(MISSING_REMINDER_TEMPLATE.name, { ...env, CLAIMS_MISSING_TEMPLATE_LANG: 'en_ZA' } as NodeJS.ProcessEnv)?.language, 'en_ZA');
});

test('the settings the package is told: what the host has set up, and nothing else', () => {
    assert.deepEqual(templateSettings(BOTH), { template: true, missingTemplate: true });
    assert.deepEqual(templateSettings({ CLAIMS_REMINDER_TEMPLATE: 'ttt_claim_reminder' } as NodeJS.ProcessEnv), { template: true, missingTemplate: false });
    assert.deepEqual(templateSettings({} as NodeJS.ProcessEnv), { template: false, missingTemplate: false });
    assert.deepEqual(templateSettings({ CLAIMS_MISSING_TEMPLATE: '  ' } as NodeJS.ProcessEnv), { template: false, missingTemplate: false });
});
