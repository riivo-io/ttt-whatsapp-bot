/**
 * The claim form's photos and documents (18 Nov 2026): a photo taken for the form sometimes didn't go up. What the page and the
 * route do about it, and the helpers the page runs, which these tests run too.
 */
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createGuidedLink, memoryLinkStore, type GuidedLinkDeps, type GuidedLinkRow } from '../../src/claimform/links';
import { claimFormPage } from '../../src/claimform/page';
import { PHOTO_JS, sniffFile, UPLOAD_MAX_BYTES } from '../../src/claimform/photo';
import { captureDate } from '../../src/departments/insurance/exif';
import { claimFormRouter, type ClaimFormSession } from '../../src/routes/claimForm.route';
import { uploadInChunks, SIMPLE_UPLOAD_MAX, type Graph } from '../../src/services/claimsDemoWiring';

const INPUT = { claimId: 'claim-1', phone: '27820000000', contactId: 'contact-1' };
const deps = (): GuidedLinkDeps => ({ store: memoryLinkStore(), publicUrl: 'https://tina.example', now: () => new Date() });
const tokenOf = (url: string) => url.split('/').pop()!;

// ---- what a file really is -------------------------------------------------------------------------------------------------

const bytes = (...parts: Array<number[] | string>) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
const PAD = [0, 0, 0, 0, 0, 0, 0, 0];

test('a file is known by its first bytes: photos, a PDF, a video; anything else is not taken', () => {
    assert.deepEqual(sniffFile(bytes([0xff, 0xd8, 0xff, 0xe0], PAD)), { mime: 'image/jpeg', ext: 'jpg', media: 'photo' });
    assert.deepEqual(sniffFile(bytes([0x89], 'PNG\r\n', [0x1a, 0x0a], PAD)), { mime: 'image/png', ext: 'png', media: 'photo' });
    assert.deepEqual(sniffFile(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')), { mime: 'image/webp', ext: 'webp', media: 'photo' });
    assert.deepEqual(sniffFile(bytes([0, 0, 0, 24], 'ftypheic', PAD)), { mime: 'image/heic', ext: 'heic', media: 'photo' });
    assert.deepEqual(sniffFile(bytes([0, 0, 0, 24], 'ftypmif1', PAD)), { mime: 'image/heif', ext: 'heif', media: 'photo' });
    assert.deepEqual(sniffFile(bytes('%PDF-1.7\n', PAD)), { mime: 'application/pdf', ext: 'pdf', media: 'document' });
    assert.deepEqual(sniffFile(bytes('\n\n  %PDF-1.4\n', PAD)), { mime: 'application/pdf', ext: 'pdf', media: 'document' }, 'a few bytes before the header are allowed');
    assert.deepEqual(sniffFile(bytes([0, 0, 0, 24], 'ftypisom', PAD)), { mime: 'video/mp4', ext: 'mp4', media: 'video' });
    assert.deepEqual(sniffFile(bytes([0, 0, 0, 20], 'ftyp3gp4', PAD)), { mime: 'video/mp4', ext: 'mp4', media: 'video' });
    assert.deepEqual(sniffFile(bytes([0, 0, 0, 20], 'ftypqt  ', PAD)), { mime: 'video/quicktime', ext: 'mov', media: 'video' });
    assert.equal(sniffFile(bytes('<html><script>alert(1)</script>')), null);
    assert.equal(sniffFile(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>', PAD)), null);
    assert.equal(sniffFile(bytes([0xff, 0xd8])), null, 'too short to say');
});

// ---- the route: what it takes, in what order, and never twice ------------------------------------------------------------

type Filed = { fileName: string; mimeType: string; media: string; size: number; item?: string };

async function uploadServer(file: (f: Filed, link: GuidedLinkRow) => Promise<{ count: number }>) {
    const d = deps();
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({
        ...d, whatsApp: '27111111111',
        session: (link: GuidedLinkRow) => ({
            view: async () => ({} as never), save: async () => ({ problems: [], answers: {}, notKnown: [], open: [] }), hear: async () => ({ text: '' }),
            finish: async () => ({ open: [] }), carryOn: async () => undefined,
            file: (f, b, item) => file({ fileName: f.fileName, mimeType: f.mimeType, media: f.media, size: b.length, item }, link),
        } as ClaimFormSession),
    })));
    const s = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/claim-form`;
    const link = async (claim = INPUT.claimId) => tokenOf((await createGuidedLink(d, { ...INPUT, claimId: claim })).url);
    return { base, link, close: () => new Promise((r) => s.close(r)) };
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const post = (base: string, token: string, body: Buffer | string, headers: Record<string, string> = {}, item = 'driversLicence') =>
    fetch(`${base}/${token}/file?item=${item}`, { method: 'POST', headers, body });

test('a phone that sends no type, or the wrong one, still gets its photo in: the bytes decide', async () => {
    const filed: Filed[] = [];
    const s = await uploadServer(async (f) => { filed.push(f); return { count: filed.length }; });
    try {
        const t = await s.link();
        // No Content-Type at all (fetch sends none for a Buffer without one set), and the generic one a file picker may use.
        assert.equal((await fetch(`${s.base}/${t}/file?item=driversLicence`, { method: 'POST', body: JPEG })).status, 200);
        assert.equal((await post(s.base, t, JPEG, { 'Content-Type': 'application/octet-stream' })).status, 200);
        // It says PNG; it is a JPEG: filed as what it is.
        assert.equal((await post(s.base, t, JPEG, { 'Content-Type': 'image/png' })).status, 200);
        const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
        assert.equal((await post(s.base, t, pdf, { 'Content-Type': 'application/octet-stream' }, 'policySchedule')).status, 200);
        assert.deepEqual(filed.map((f) => [f.mimeType, f.media, f.fileName.endsWith(f.mimeType === 'application/pdf' ? '.pdf' : '.jpg')]), [
            ['image/jpeg', 'photo', true], ['image/jpeg', 'photo', true], ['image/jpeg', 'photo', true], ['application/pdf', 'document', true],
        ]);
        // Anything that isn't a photo, a PDF or a video is still refused, whatever it says it is.
        assert.equal((await post(s.base, t, '<script>alert(1)</script>', { 'Content-Type': 'application/octet-stream' })).status, 415);
        assert.equal((await post(s.base, t, '<svg/>', { 'Content-Type': 'image/svg+xml' })).status, 415);
        assert.equal(filed.length, 4);
    } finally { await s.close(); }
});

test('a file over the limit is refused with a sentence that names the limit', async () => {
    const s = await uploadServer(async () => ({ count: 1 }));
    try {
        const t = await s.link();
        const r = await post(s.base, t, Buffer.alloc(UPLOAD_MAX_BYTES + 1024, 0xff), { 'Content-Type': 'image/jpeg' });
        assert.equal(r.status, 413);
        assert.match(((await r.json()) as { message: string }).message, /25 MB is the most/);
    } finally { await s.close(); }
});

test('a try the page repeats (its id is the same) is filed once; a try that failed is run again', async () => {
    let calls = 0, fail = true;
    const s = await uploadServer(async () => { calls++; if (fail) { fail = false; throw new Error('Dataverse is slow'); } return { count: 7 }; });
    try {
        const t = await s.link();
        const withId = (id: string) => post(s.base, t, JPEG, { 'Content-Type': 'image/jpeg', 'X-Upload-Id': id });
        assert.equal((await withId('abcdef0123456789')).status, 500, 'the first try failed');
        const second = await withId('abcdef0123456789');
        assert.deepEqual([second.status, (await second.json())], [200, { ok: true, count: 7 }], 'a failed try is forgotten: this one runs');
        const third = await withId('abcdef0123456789');
        assert.deepEqual([third.status, (await third.json())], [200, { ok: true, count: 7 }], 'the try that got through is not filed again');
        assert.equal(calls, 2);
        // Another id is another upload; no id (or a bad one) is never treated as a repeat.
        await withId('zzzzzzzzzzzzzzzz');
        await post(s.base, t, JPEG, { 'Content-Type': 'image/jpeg' });
        await post(s.base, t, JPEG, { 'Content-Type': 'image/jpeg', 'X-Upload-Id': 'x' });
        assert.equal(calls, 5);
    } finally { await s.close(); }
});

test('a try that is repeated while the first is still being filed waits for it, and is not filed twice', async () => {
    let calls = 0, release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = await uploadServer(async () => { calls++; await gate; return { count: 3 }; });
    try {
        const t = await s.link();
        const h = { 'Content-Type': 'image/jpeg', 'X-Upload-Id': 'slow0000000000001' };
        const first = post(s.base, t, JPEG, h), again = post(s.base, t, JPEG, h);
        await new Promise((r) => setTimeout(r, 80));
        release();
        const [a, b] = await Promise.all([first, again]);
        assert.deepEqual([a.status, b.status, calls], [200, 200, 1]);
    } finally { await s.close(); }
});

test('one link\'s files are filed one at a time (each scores the claim and may raise a flag); other links go alongside', async () => {
    let running = 0, most = 0;
    const byLink = new Map<string, number>();
    const s = await uploadServer(async (_f, link) => {
        running++; most = Math.max(most, running);
        byLink.set(link.id, (byLink.get(link.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        return { count: 1 };
    });
    try {
        const t = await s.link();
        const h = { 'Content-Type': 'image/jpeg' };
        await Promise.all([1, 2, 3, 4].map(() => post(s.base, t, JPEG, h)));
        assert.equal(most, 1, 'four photos from one page never overlap');
        most = 0;
        const other = await s.link('claim-2');
        await Promise.all([post(s.base, t, JPEG, h), post(s.base, other, JPEG, h)]);
        assert.equal(most, 2, 'two clients are not held up by each other');
    } finally { await s.close(); }
});

// ---- what the page runs ----------------------------------------------------------------------------------------------------

type Ph = {
    phExifRange(b: Uint8Array): [number, number] | null; phOrientation(s: Uint8Array): number; phOrientationOne(s: Uint8Array): Uint8Array;
    phWithExif(j: Uint8Array, s: Uint8Array): Uint8Array; phJpegSize(b: Uint8Array): [number, number] | null; phMatrix(t: number, w: number, h: number): number[];
    phScale(w: number, h: number, e: number): [number, number]; phTimeout(n: number): number; phRetryable(s: number): boolean; phId(): string;
};
const ph = new Function('window', `${PHOTO_JS}; return { phExifRange: phExifRange, phOrientation: phOrientation, phOrientationOne: phOrientationOne, phWithExif: phWithExif, phJpegSize: phJpegSize, phMatrix: phMatrix, phScale: phScale, phTimeout: phTimeout, phRetryable: phRetryable, phId: phId };`)({ crypto: webcrypto }) as Ph;

/** An EXIF APP1 segment: Orientation, and the date the camera took the photo (yyyy:mm:dd hh:mm:ss). */
function exifSegment(orientation: number, date: string, le = false): Uint8Array {
    const tiff = new Uint8Array(76), dv = new DataView(tiff.buffer);
    tiff.set(le ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a], 0);
    dv.setUint32(4, 8, le);
    dv.setUint16(8, 2, le);
    dv.setUint16(10, 0x0112, le); dv.setUint16(12, 3, le); dv.setUint32(14, 1, le); dv.setUint16(18, orientation, le);
    dv.setUint16(22, 0x8769, le); dv.setUint16(24, 4, le); dv.setUint32(26, 1, le); dv.setUint32(30, 38, le);
    dv.setUint16(38, 1, le); dv.setUint16(40, 0x9003, le); dv.setUint16(42, 2, le); dv.setUint32(44, 20, le); dv.setUint32(48, 56, le);
    tiff.set(Buffer.from(date, 'latin1'), 56);
    const seg = new Uint8Array(4 + 6 + 76);
    seg.set([0xff, 0xe1, 0x00, 0x54], 0);
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    seg.set(tiff, 10);
    return seg;
}
/** A JPEG skeleton: its start, the segments given, a frame header that says w by h, a scan and its end. */
function jpegOf(w: number, h: number, ...before: Uint8Array[]): Uint8Array {
    const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
    const sos = [0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 1, 2, 3, 4, 5, 0xff, 0xd9];
    return Uint8Array.from([0xff, 0xd8, ...before.flatMap((s) => [...s]), ...sof, ...sos]);
}
const DATE = '2026:11:14 10:30:00';

test('a photo\'s EXIF goes with the small copy the page makes, so the capture date still reaches the risk flag', () => {
    for (const le of [false, true]) {
        const original = jpegOf(4032, 3024, exifSegment(6, DATE, le));
        const range = ph.phExifRange(original)!;
        assert.deepEqual(range, [2, 88], 'the whole APP1 segment: its marker, its length and its 84 bytes');
        const seg = original.subarray(range[0], range[1]);
        assert.equal(ph.phOrientation(seg), 6);
        assert.equal(captureDate(original), '2026-11-14', 'the date the flag reads from the original');
        // The canvas gives a JPEG with no EXIF (and, in some browsers, a JFIF header). The page puts the camera's EXIF in front.
        const jfif = Uint8Array.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
        const fromCanvas = jpegOf(1800, 2400, jfif);
        const sent = ph.phWithExif(fromCanvas, ph.phOrientationOne(seg));
        assert.equal(captureDate(sent), '2026-11-14', 'the date survives the resize');
        assert.equal(ph.phOrientation(sent.subarray(2, 2 + seg.length)), 1, 'the pixels are upright now, so the file says so');
        assert.deepEqual(ph.phJpegSize(sent), [1800, 2400], 'the picture itself is the canvas\'s');
        assert.deepEqual([...sent.subarray(0, 2)], [0xff, 0xd8]);
        assert.deepEqual([...sent.subarray(sent.length - 2)], [0xff, 0xd9]);
        assert.equal(sent.length, fromCanvas.length + seg.length, 'nothing else added or lost');
    }
});

test('a JPEG that has EXIF already gets the camera\'s, not two; one with none reads as no date, as before', () => {
    const seg = exifSegment(1, DATE);
    const two = jpegOf(10, 10, exifSegment(3, '2020:01:01 00:00:00'));
    const merged = ph.phWithExif(two, seg);
    assert.equal(captureDate(merged), '2026-11-14');
    assert.equal(merged.length, two.length - 86 + seg.length, 'the old block is replaced, not added to');
    assert.equal(ph.phExifRange(jpegOf(10, 10)), null);
    assert.equal(captureDate(jpegOf(10, 10)), undefined);
    assert.equal(ph.phOrientation(new Uint8Array(20)), 1, 'no orientation is upright');
    assert.equal(ph.phExifRange(Uint8Array.from([1, 2, 3, 4, 5])), null, 'not a JPEG');
    assert.deepEqual([...ph.phWithExif(Uint8Array.from([1, 2, 3, 4, 5]), seg)], [1, 2, 3, 4, 5], 'what is not a JPEG is handed back as it was');
});

test('a truncated or odd EXIF block never throws: the page then sends the photo without it', () => {
    const seg = exifSegment(6, DATE);
    for (const cut of [3, 5, 12, 20, 40, 70, 85]) {
        const bad = jpegOf(100, 100, seg).subarray(0, cut);
        assert.doesNotThrow(() => { const r = ph.phExifRange(bad); if (r) ph.phOrientation(bad.subarray(r[0], r[1])); ph.phJpegSize(bad); });
    }
    const garbage = Uint8Array.from([...exifSegment(6, DATE)].map((b, i) => (i > 14 ? (b + 97 * i) & 255 : b)));
    assert.doesNotThrow(() => { ph.phOrientation(garbage); ph.phOrientationOne(garbage); });
});

test('the size a JPEG is stored at, before any turning, is read from its frame header', () => {
    assert.deepEqual(ph.phJpegSize(jpegOf(4032, 3024, exifSegment(6, DATE))), [4032, 3024]);
    assert.deepEqual(ph.phJpegSize(jpegOf(640, 480)), [640, 480]);
    assert.equal(ph.phJpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null);
});

test('turning a photo upright by hand: each of the eight orientations puts the corners where the camera meant', () => {
    // A photo stored w by h. Where do its corners go on the upright canvas? (the transform: x\' = a x + c y + e, y\' = b x + d y + f)
    const w = 40, h = 30;
    const at = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const corners = { topLeft: [0, 0], topRight: [w, 0], bottomLeft: [0, h], bottomRight: [w, h] };
    const expected: Record<number, Record<keyof typeof corners, number[]>> = {
        1: { topLeft: [0, 0], topRight: [w, 0], bottomLeft: [0, h], bottomRight: [w, h] },
        2: { topLeft: [w, 0], topRight: [0, 0], bottomLeft: [w, h], bottomRight: [0, h] },              // mirrored
        3: { topLeft: [w, h], topRight: [0, h], bottomLeft: [w, 0], bottomRight: [0, 0] },              // upside down
        4: { topLeft: [0, h], topRight: [w, h], bottomLeft: [0, 0], bottomRight: [w, 0] },              // flipped
        5: { topLeft: [0, 0], topRight: [0, w], bottomLeft: [h, 0], bottomRight: [h, w] },              // transposed
        6: { topLeft: [h, 0], topRight: [h, w], bottomLeft: [0, 0], bottomRight: [0, w] },              // a quarter turn clockwise: the phone held upright
        7: { topLeft: [h, w], topRight: [h, 0], bottomLeft: [0, w], bottomRight: [0, 0] },              // transverse
        8: { topLeft: [0, w], topRight: [0, 0], bottomLeft: [h, w], bottomRight: [h, 0] },              // a quarter turn the other way
    };
    for (let turn = 1; turn <= 8; turn++) {
        const m = ph.phMatrix(turn, w, h);
        for (const [name, [x, y]] of Object.entries(corners)) assert.deepEqual(at(m, x, y), expected[turn][name as keyof typeof corners], `orientation ${turn}, ${name}`);
    }
});

test('a photo is cut to fit and never made bigger; an upload gets time for its size, and only a passing fault is tried again', () => {
    assert.deepEqual(ph.phScale(4032, 3024, 2400), [2400, 1800]);
    assert.deepEqual(ph.phScale(3024, 4032, 2400), [1800, 2400]);
    assert.deepEqual(ph.phScale(800, 600, 2400), [800, 600]);
    assert.deepEqual(ph.phScale(10000, 1, 2400), [2400, 1]);
    assert.equal(ph.phTimeout(500_000), 58_000);
    assert.equal(ph.phTimeout(3_000_000), 120_000);
    assert.equal(ph.phTimeout(UPLOAD_MAX_BYTES), 300_000, 'never more than five minutes');
    for (const status of [0, 408, 425, 429, 500, 502, 503, 504]) assert.equal(ph.phRetryable(status), true, String(status));
    for (const status of [400, 401, 403, 404, 413, 415, 422]) assert.equal(ph.phRetryable(status), false, String(status));
    const ids = new Set(Array.from({ length: 200 }, () => ph.phId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[0-9a-f]{24}$/);
});

// ---- the page --------------------------------------------------------------------------------------------------------------

test('the page\'s file inputs are outside the steps, which are drawn again; the camera input asks for the back camera', () => {
    const html = claimFormPage();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    assert.doesNotThrow(() => new Function(script), 'the page\'s script is valid');
    // A photo that came back from the camera to an input the page had drawn away was lost. The inputs live in the page's frame.
    assert.match(html, /<input class="sr" type="file" id="inCam" accept="image\/\*" capture="environment"/);
    assert.match(html, /<input class="sr" type="file" id="inFile" accept="image\/\*,application\/pdf" multiple/);
    assert.match(html, /<input class="sr" type="file" id="inVid" accept="video\/\*" capture="environment"/);
    const frame = html.indexOf('id="inCam"'), body = html.indexOf('id="body"');
    assert.ok(frame > body && html.indexOf('</main>') < frame, 'after the step\'s own container, not in it');
    assert.doesNotMatch(script, /data-up=/);
    assert.doesNotMatch(script, /<input class="sr" type="file" id="' \+/);
    assert.doesNotMatch(script, /\$\('body'\)\.addEventListener\('change'/);
    for (const id of ['inCam', 'inFile', 'inVid']) assert.match(script, new RegExp(`'${id}'`));
});

test('photos and documents are one list that scrolls, so no row waits on a second page (the drawing of the accident)', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(claimFormPage())![1];
    const render = /function render\(\) \{[\s\S]*?\n  \}\n/.exec(script)![0];
    // Photos are drawn whole, without fit(): the step doesn't measure what fits.
    assert.match(render, /if \(step\.id === 'photos'\) \{[\s\S]*?body\.innerHTML = stepHtml\(step, rows\);[\s\S]*?morePages = false;[\s\S]*?\} else if \(step\.id === 'screen'\) \{/);
    assert.doesNotMatch(render.slice(render.indexOf("if (step.id === 'photos')"), render.indexOf("else if (step.id === 'screen')")), /fit\(/);
    // Going back into the step, or back a page inside it, only pages a question screen.
    assert.match(script, /if \(by < 0 && t\.id === 'screen'\) here\.anchor = pageStarts\(t\)\.pop\(\) \|\| null;/);
    assert.match(script, /if \(here\.id === 'screen' && here\.anchor\) \{/);
});

test('Submit stops at a file that never went up, and what is on its way is waited for', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(claimFormPage())![1];
    const submit = /function submit\(sig\) \{[\s\S]*?\n  \}\n/.exec(script)![0];
    assert.match(submit, /uploads\.some\(busyUp\) \? 'Uploading your photos…'/);
    assert.match(submit, /whenIdle\(function \(\) \{\s*\/\/[^\n]*\n\s*if \(uploads\.some\(function \(u\) \{ return u\.state === 'fail'; \}\)\) \{[\s\S]*?here = \{ id: 'photos', anchor: null \};/);
    assert.match(script, /function idle\(\) \{ return !queue\.length && !sending && !hearing && !uploads\.some\(busyUp\); \}/);
    // Every try carries the upload's id, has a time limit, and a failed upload can be tried again or taken off.
    assert.match(script, /'X-Upload-Id': u\.uid/);
    assert.match(script, /new AbortController\(\)/);
    assert.match(script, /data-retry/);
    assert.match(script, /data-drop/);
    assert.match(script, /window\.addEventListener\('online'/);
});

// ---- a big file into SharePoint --------------------------------------------------------------------------------------------

test('a file over what one call takes goes into SharePoint in pieces, each said where it belongs, without our token', async () => {
    const sessionBodies: string[] = [];
    const graph: Graph = async (method, path, body, contentType) => {
        assert.equal(method, 'POST');
        assert.equal(path, '/drives/d1/root:/Client/Claims/CLM-1/photo.pdf:/createUploadSession');
        assert.equal(contentType, 'application/json');
        sessionBodies.push(new TextDecoder().decode(body));
        return new Response(JSON.stringify({ uploadUrl: 'https://upload.example/session/abc' }), { status: 200 });
    };
    const puts: Array<{ url: string; range: string; auth: string | null; size: number }> = [];
    const send = (async (url: string, init: RequestInit) => {
        const h = new Headers(init.headers);
        puts.push({ url, range: h.get('Content-Range')!, auth: h.get('Authorization'), size: (init.body as Uint8Array).length });
        const last = h.get('Content-Range')!.endsWith(`-${SIZE - 1}/${SIZE}`);
        return new Response(JSON.stringify(last ? { webUrl: 'https://sp.example/photo.pdf' } : { nextExpectedRanges: ['x-'] }), { status: last ? 201 : 202 });
    }) as unknown as typeof fetch;
    const CHUNK = 10 * 320 * 1024, SIZE = CHUNK * 2 + 1000;
    const link = await uploadInChunks(graph, '/drives/d1/root:/Client/Claims/CLM-1/photo.pdf', new Uint8Array(SIZE), send);
    assert.equal(link, 'https://sp.example/photo.pdf');
    assert.deepEqual(puts.map((p) => p.range), [`bytes 0-${CHUNK - 1}/${SIZE}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${SIZE}`, `bytes ${2 * CHUNK}-${SIZE - 1}/${SIZE}`]);
    assert.deepEqual(puts.map((p) => p.size), [CHUNK, CHUNK, 1000]);
    assert.ok(puts.every((p) => p.url === 'https://upload.example/session/abc' && p.auth === null), 'the address is already authorised: no token goes to it');
    assert.ok(puts.every((p) => p.size % (320 * 1024) === 0 || p.range.endsWith(`-${SIZE - 1}/${SIZE}`)), 'every piece but the last is a multiple of 320 KiB');
    assert.match(sessionBodies[0], /"@microsoft.graph.conflictBehavior":"rename"/);
    assert.ok(SIMPLE_UPLOAD_MAX < 4 * 1024 * 1024, 'under the 4 MB Graph documents for one call');
});

test('a piece that fails for a passing reason is sent again; one that is refused stops the upload', async () => {
    const graph: Graph = async () => new Response(JSON.stringify({ uploadUrl: 'https://upload.example/s' }), { status: 200 });
    let n = 0;
    const flaky = (async () => { n++; return n < 3 ? new Response('busy', { status: n === 1 ? 503 : 429 }) : new Response(JSON.stringify({ webUrl: 'https://sp.example/f' }), { status: 201 }); }) as unknown as typeof fetch;
    const instantly = async () => undefined;
    assert.equal(await uploadInChunks(graph, '/p', new Uint8Array(100), flaky, instantly), 'https://sp.example/f');
    assert.equal(n, 3);
    const refused = (async () => new Response('conflict', { status: 409 })) as unknown as typeof fetch;
    await assert.rejects(() => uploadInChunks(graph, '/p', new Uint8Array(100), refused, instantly), /HTTP 409/);
    let tries = 0;
    const down = (async () => { tries++; throw new Error('socket hang up'); }) as unknown as typeof fetch;
    await assert.rejects(() => uploadInChunks(graph, '/p', new Uint8Array(100), down, instantly), /socket hang up/);
    assert.equal(tries, 4, 'four tries, then it says so');
    const noSession: Graph = async () => new Response('no', { status: 403 });
    await assert.rejects(() => uploadInChunks(noSession, '/p', new Uint8Array(100), flaky, instantly), /upload session: HTTP 403/);
});
