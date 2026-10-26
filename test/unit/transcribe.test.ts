/**
 * TTTFG-4830 voice notes: what src/services/transcribe.service.ts decides before anything is sent to the speech model
 * (a voice note's length from its Ogg header, the audio types it takes, notes that are too long). The model call itself
 * is checked live with src/scripts/claims-voice-eval.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { echoesHint, oggSeconds, transcribeVoiceNote } from '../../src/services/transcribe.service';

/** One Ogg page header (27 bytes, no segments) with this granule position, then `body` bytes. */
function oggPage(granule: bigint, body = 0): Buffer {
    const h = Buffer.alloc(27 + body);
    h.write('OggS', 0, 'latin1');
    h.writeBigUInt64LE(granule, 6);
    return h;
}
const voiceNote = (seconds: number) => Buffer.concat([oggPage(0n, 100), oggPage(BigInt(seconds * 48_000), 60)]);

test('a voice note\'s length is read from its last Ogg page (48 kHz samples); anything else has none', () => {
    assert.equal(oggSeconds(voiceNote(23.4)), 23.4);
    assert.equal(oggSeconds(voiceNote(600)), 600);
    assert.equal(oggSeconds(Buffer.from('ID3 not ogg at all, an mp3 header and then some more bytes')), null);
    assert.equal(oggSeconds(Buffer.alloc(10)), null);
    assert.equal(oggSeconds(oggPage(0xffffffffffffffffn, 10)), null); // no finished packet
});

test('refused before anything is sent: an audio type speech recognition can\'t take, or a note over the limit', async () => {
    const before = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY; // a call to the model would throw: these never get that far
    try {
        assert.deepEqual(await transcribeVoiceNote(Buffer.from('#!AMR\n'), 'audio/amr', 'hint'), { problem: 'unsupported', seconds: null });
        assert.deepEqual(await transcribeVoiceNote(voiceNote(601), 'audio/ogg; codecs=opus', 'hint'), { problem: 'too-long', seconds: 601 });
        process.env.CLAIMS_VOICE_MAX_SECONDS = '60';
        assert.deepEqual(await transcribeVoiceNote(voiceNote(61), 'audio/ogg', 'hint'), { problem: 'too-long', seconds: 61 });
        await assert.rejects(transcribeVoiceNote(voiceNote(59), 'audio/ogg', 'hint'), /OPENAI_API_KEY is not set/);
    } finally {
        delete process.env.CLAIMS_VOICE_MAX_SECONDS;
        if (before !== undefined) process.env.OPENAI_API_KEY = before;
    }
});

test('a transcript that is only the hint read back is nothing the client said; a short answer that is in the hint is kept', () => {
    const hint = 'A South African client answers Tina. Tina asked: 1. What make is the car? For example Toyota or VW. 2. Is the car registered in your name?';
    assert.equal(echoesHint('Tina asked: 1. What make is the car? For example Toyota or VW.', hint), true);
    assert.equal(echoesHint('Toyota', hint), false);
    assert.equal(echoesHint('VW', hint), false);
    assert.equal(echoesHint('It is a Toyota and yes it is in my name', hint), false);
});
