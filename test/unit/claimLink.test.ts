/**
 * The claim link (src/domain/claimLink.ts): the message a broker's WhatsApp link types for the client. It has to be
 * recognised as a claim report by its words, and only when it is that and nothing more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_LINK_TEXT, claimLinkUrl, isClaimLinkMessage } from '../../src/domain/claimLink';
import { REPORT_CLAIM_TEXT } from '../../src/domain/serviceRoute';

test('claim link: the text the link types is recognised (the one thing that must never drift apart)', () => {
    assert.equal(isClaimLinkMessage(CLAIM_LINK_TEXT), true);
});

test('claim link: the URL carries exactly that text, and what WhatsApp decodes from it is recognised', () => {
    const url = claimLinkUrl('+27 76 444 6801');
    assert.equal(url, 'https://wa.me/27764446801?text=Hi%20Tina%2C%20I%27d%20like%20to%20open%20an%20insurance%20claim.');
    assert.doesNotMatch(url, /['"<>\s]/, 'safe inside any quoting an email or SMS app puts around it');
    const typed = decodeURIComponent(new URL(url).searchParams.get('text') ?? '');
    assert.equal(typed, CLAIM_LINK_TEXT);
    assert.equal(isClaimLinkMessage(typed), true);
});

test('claim link: the Report a claim tap\'s own text is the same thing', () => {
    assert.equal(isClaimLinkMessage(REPORT_CLAIM_TEXT), true);
});

test('claim link: light edits and phone typing still count', () => {
    for (const text of [
        "Hi Tina, I'd like to open an insurance claim.",
        'hi tina id like to open an insurance claim',
        'HI TINA, I’D LIKE TO OPEN AN INSURANCE CLAIM!', // curly apostrophe, as a phone types it
        "Hello Tina, I'd like to report an insurance claim please",
        'Hey, I want to lodge an insurance claim',
        'Good morning Tina, I need to open a new insurance claim',
        'Open an insurance claim',
        'I would like to start my insurance claim 🙏',
        'Can I open an insurance claim please',
        "Hi Tina from TTT, I'd like to make an insurance claim now",
    ]) assert.equal(isClaimLinkMessage(text), true, text);
});

test('claim link: anything with more in it is an ordinary message, never decided by the link rule', () => {
    for (const text of [
        "Hi Tina, I'd like to open an insurance claim for my stolen car",
        'My car was stolen, I want to open an insurance claim',
        'How do I open an insurance claim?',
        'Can you tell me how to report an insurance claim',
        'I want to cancel my insurance claim',
        'What is the status of my insurance claim',
        "Hi Tina, I'd like to open a tax claim",
        'Can I claim my medical aid',
        'I want to open a claim',          // no "insurance": a tax claim is possible
        'insurance claim',                 // no verb
        'Hi Tina',
        '',
        '   ',
        'x'.repeat(200),
    ]) assert.equal(isClaimLinkMessage(text), false, text);
});
