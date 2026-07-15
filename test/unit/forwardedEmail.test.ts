/**
 * Unit tests for the forwarded-email parser and the forwarder round-trip
 * reply parser in src/services/forwardedEmail.service.ts.
 *
 * The headline case is the bug that prompted this work: a consultant forwards
 * a long alternating reply chain (client -> consultant -> client -> ...). The
 * parser must extract the CLIENT as the original sender, not skip past the
 * topmost quoted message and land on the consultant's reply beneath it.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseForwarded,
    extractForwarderReplyIdentifiers,
    freshReplyText,
} from '../../src/services/forwardedEmail.service';
import { GraphMessage } from '../../src/services/graphMail.service';

function msg(body: string, opts: Partial<GraphMessage> = {}): GraphMessage {
    return {
        id: 'msg-1',
        conversationId: 'conv-1',
        subject: 'Re: V Antar - Tax Returns 2026',
        from: { emailAddress: { name: 'Roscoe Dekker', address: 'roscoe@ttt-tax.co.za' } },
        toRecipients: [{ emailAddress: { address: 'tina-bot@ttt-group.co.za' } }],
        receivedDateTime: '2026-06-25T10:30:00Z',
        bodyPreview: body.slice(0, 200),
        body: { contentType: 'text', content: body },
        hasAttachments: false,
        ...opts,
    } as GraphMessage;
}

// The real-world bug: inline forward of an alternating thread, no banner.
const INLINE_ALTERNATING = `Kind Regards,

From: Vishay Antar <vishay.antar@supergrp.com>
Sent: Thursday, 25 June 2026 10:20
To: Roscoe Dekker <roscoe@ttt-tax.co.za>
Subject: Re: V Antar - Tax Returns 2026

Good day Sir
Please see bank statements and Vehicle form attached

From: Roscoe Dekker <roscoe@ttt-tax.co.za>
Sent: Thursday, June 25, 2026 10:10 AM
To: Vishay Antar <vishay.antar@supergrp.com>
Subject: RE: V Antar - Tax Returns 2026

Did you receive my previous email?
`;

test('parseForwarded: inline alternating thread resolves the CLIENT, not the consultant below', () => {
    const parsed = parseForwarded(msg(INLINE_ALTERNATING));
    assert.ok(parsed, 'should parse');
    assert.equal(parsed!.originalSenderEmail, 'vishay.antar@supergrp.com');
    assert.notEqual(parsed!.originalSenderEmail, 'roscoe@ttt-tax.co.za');
    assert.equal(parsed!.forwarderEmail, 'roscoe@ttt-tax.co.za');
});

const BANNER_FORWARD = `Please see below — can you assist?

----- Forwarded message -----
From: Vishay Antar <vishay.antar@supergrp.com>
Sent: Thursday, 25 June 2026 10:20
To: Roscoe Dekker <roscoe@ttt-tax.co.za>
Subject: Re: V Antar - Tax Returns 2026

Good day Sir, please see attached.
`;

test('parseForwarded: banner-style forward still resolves the client beneath the banner', () => {
    const parsed = parseForwarded(msg(BANNER_FORWARD));
    assert.ok(parsed);
    assert.equal(parsed!.originalSenderEmail, 'vishay.antar@supergrp.com');
});

test('parseForwarded: returns null when no From: line anywhere', () => {
    const parsed = parseForwarded(msg('Hey Tina, can you help this person? Thanks.'));
    assert.equal(parsed, null);
});

// ---- forwarder round-trip reply parsing -----------------------------------

const REPLY_WITH_NUMBER = `Hi Tina,

Sure — her mobile is 082 440 0910. Thanks!

Roscoe Dekker
TTT Tax Services
roscoe@ttt-tax.co.za

From: tina-bot@ttt-group.co.za <tina-bot@ttt-group.co.za>
Sent: Thursday, 25 June 2026 10:35
To: Roscoe Dekker <roscoe@ttt-tax.co.za>
Subject: Re: V Antar - Tax Returns 2026

Hi Roscoe, reply with the client's email address or mobile number...
`;

test('extractForwarderReplyIdentifiers: pulls the client mobile from the fresh reply, ignores quoted thread + signature email', () => {
    const ids = extractForwarderReplyIdentifiers(
        msg(REPLY_WITH_NUMBER, { from: { emailAddress: { name: 'Roscoe', address: 'roscoe@ttt-tax.co.za' } } }),
        ['roscoe@ttt-tax.co.za', 'tina-bot@ttt-group.co.za']
    );
    assert.deepEqual(ids.phones, ['0824400910']);
    // The only emails present are the forwarder's signature + tina's quoted
    // address, both excluded — so none should survive.
    assert.deepEqual(ids.emails, []);
});

const REPLY_WITH_EMAIL = `It's actually vishay.antar@supergrp.com — sorry for the mixup.

Roscoe

From: tina-bot@ttt-group.co.za
Sent: ...
`;

test('extractForwarderReplyIdentifiers: pulls a client email the consultant supplies', () => {
    const ids = extractForwarderReplyIdentifiers(
        msg(REPLY_WITH_EMAIL, { from: { emailAddress: { name: 'Roscoe', address: 'roscoe@ttt-tax.co.za' } } }),
        ['roscoe@ttt-tax.co.za', 'tina-bot@ttt-group.co.za']
    );
    assert.deepEqual(ids.emails, ['vishay.antar@supergrp.com']);
});

test('freshReplyText: drops the quoted thread below the first From: marker', () => {
    const text = freshReplyText(msg(REPLY_WITH_NUMBER));
    assert.ok(text.includes('082 440 0910'));
    assert.ok(!text.includes('reply with the client'), 'quoted thread should be cut');
});
