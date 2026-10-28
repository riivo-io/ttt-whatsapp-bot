/**
 * TTTFG-4830 claims demo (28 Oct 2026): one client message gets one message back, and a closed question comes with
 * taps (src/domain/claimsOutbox.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    choiceId, interactiveFor, joinParts, LIST_BUTTON, loggedText, messageMaxChars, outbox, tappedText, withChoiceLines, type OutPart,
} from '../../src/domain/claimsOutbox';
import { YES_NO } from '../../src/departments/insurance/claim';

const READY = [{ title: 'Ready' }];

test('one turn\'s texts go out as one message, a blank line apart, with the last question\'s taps', () => {
    const parts: OutPart[] = [
        { text: 'From your voice note I noted:\n\n1. *What make is the car?* Ford' },
        { text: 'Thanks. Next, a few questions about *the finance on your car*.\n\n1. Do you still owe money on it?' },
    ];
    assert.deepEqual(joinParts(parts, 700), [{ text: `${parts[0].text}\n\n${parts[1].text}` }]);
    assert.deepEqual(joinParts([{ text: 'If anyone is hurt, call 10111.' }, { text: 'Get these.', choices: READY }], 700),
        [{ text: 'If anyone is hurt, call 10111.\n\nGet these.', choices: READY }]);
});

test('a new message starts only where the joined text would be too long; a part longer than that goes alone', () => {
    const a = { text: 'a'.repeat(400) };
    const b = { text: 'b'.repeat(400) };
    const c = { text: 'c'.repeat(100) };
    assert.deepEqual(joinParts([a, b, c], 700).map((m) => m.text.length), [400, 502]);
    assert.deepEqual(joinParts([{ text: 'x'.repeat(900) }, c], 700).map((m) => m.text.length), [900, 100]);
});

test('a question with taps ends its message, so its buttons stay under it', () => {
    const asked = { text: 'Are those all the photos?', choices: YES_NO };
    assert.deepEqual(joinParts([asked, { text: 'Thanks.' }], 700), [asked, { text: 'Thanks.' }]);
});

test('CLAIMS_MESSAGE_MAX_CHARS: 700 by default; 0 sends each part on its own, as before', () => {
    assert.equal(messageMaxChars(undefined), 700);
    assert.equal(messageMaxChars(''), 700);
    assert.equal(messageMaxChars('1000'), 1000);
    assert.equal(messageMaxChars('nonsense'), 700);
    assert.deepEqual(joinParts([{ text: 'a' }, { text: 'b' }], messageMaxChars('0')), [{ text: 'a' }, { text: 'b' }]);
});

test('the outbox holds the sends until flush, then sends them joined, in order', async () => {
    const sent: [string, OutPart][] = [];
    const box = outbox(async (to, m) => void sent.push([to, m]), 700);
    box.push('27821234567', { text: 'Thanks Jane, your claim is logged.' });
    box.push('27821234567', { text: 'What is the SAPS case number?' });
    assert.equal(sent.length, 0);
    await box.flush();
    assert.deepEqual(sent, [['27821234567', { text: 'Thanks Jane, your claim is logged.\n\nWhat is the SAPS case number?' }]]);
    await box.flush();
    assert.equal(sent.length, 1);
});

test('up to three short choices are reply buttons; each id says what the tap means', () => {
    const summary = [{ title: "Yes, that's right", reply: "Yes, that's all correct" }, { title: 'Change something' }];
    assert.deepEqual(interactiveFor('Is it all correct?', summary), {
        type: 'button', body: { text: 'Is it all correct?' },
        action: { buttons: [
            { type: 'reply', reply: { id: "claims:Yes, that's all correct", title: "Yes, that's right" } },
            { type: 'reply', reply: { id: 'claims:Change something', title: 'Change something' } },
        ] },
    });
});

test('more choices, or a title too long for a button, are a list; a long title is cut, with all of it as the description', () => {
    const policies = [
        { title: 'Hybrid Risk Management', description: 'Household policy (HY-1)', reply: '1. Hybrid Risk Management Household policy (HY-1)' },
        { title: 'Discovery Insure', description: 'Motor policy (DI-1)', reply: '2. Discovery Insure Motor policy (DI-1)' },
    ];
    const list = interactiveFor('Which policy is this claim about?', policies);
    assert.equal(list?.type, 'list');
    assert.deepEqual(list?.type === 'list' && list.action, {
        button: LIST_BUTTON,
        sections: [{ title: LIST_BUTTON, rows: [
            { id: 'claims:1. Hybrid Risk Management Household policy (HY-1)', title: 'Hybrid Risk Management', description: 'Household policy (HY-1)' },
            { id: 'claims:2. Discovery Insure Motor policy (DI-1)', title: 'Discovery Insure', description: 'Motor policy (DI-1)' },
        ] }],
    });
    const outcome = interactiveFor('What happened to the car?', [{ title: 'The car is still missing' }, { title: "They tried to steal it but didn't get it" }]);
    assert.deepEqual(outcome?.type === 'list' && outcome.action.sections[0].rows[1],
        { id: "claims:They tried to steal it but didn't get it", title: 'They tried to steal it…', description: "They tried to steal it but didn't get it" });
    for (const row of outcome?.type === 'list' ? outcome.action.sections[0].rows : []) assert.ok(row.title.length <= 24, row.title);
});

test('more than ten choices, or a text too long even for a list: numbered lines under the text instead', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ title: `Place ${i + 1}` }));
    assert.equal(interactiveFor('Where?', eleven), null);
    assert.equal(interactiveFor('x'.repeat(4097), YES_NO), null);
    assert.equal(withChoiceLines('Were you hurt?', YES_NO), 'Were you hurt?\n\n1. Yes\n2. No');
    assert.equal(withChoiceLines('Which?', [{ title: 'Hybrid', description: 'Household policy' }]), 'Which?\n\n1. Hybrid (Household policy)');
});

test('a tap on a claims choice reads as what it says; any other tap, or a typed message, is left alone', () => {
    assert.equal(tappedText(choiceId({ title: 'Discovery Insure', reply: '2. Discovery Insure Motor policy (DI-1)' })), '2. Discovery Insure Motor policy (DI-1)');
    assert.equal(tappedText(choiceId({ title: 'Ready' })), 'Ready');
    assert.equal(tappedText('relay_yes'), null);
    assert.equal(tappedText(undefined), null);
});

test('the log shows what could be tapped', () => {
    assert.equal(loggedText({ text: 'Were the police involved?', choices: YES_NO }), 'Were the police involved?\n[Yes | No]');
    assert.equal(loggedText({ text: 'Hi' }), 'Hi');
});
