/**
 * The claim form's photos and documents: what both sides agree on.
 *
 * Server: `sniffFile` says what a file really is from its first bytes, so a phone that sends no Content-Type (some Android file
 * pickers), or a wrong one, still gets its photo in.
 *
 * Page: `PHOTO_JS` is plain ES5 that goes into the page's script and is also run by the tests, so what the tests prove is the
 * code the phone runs. It has no DOM in it. The page uses it to turn a camera photo into a small, upright JPEG before it
 * uploads (a 12 MP photo is 4 to 10 MB: slow on a phone's data, and over what SharePoint takes in one call), and to carry the
 * photo's own EXIF across, because the "Photo date before incident" flag (TTTFG-5263) reads the capture date from the bytes
 * that arrive. A canvas drops EXIF, so without that carry-over every photo the form sent would read as "no date".
 */

/** The most one file may be, on the page and on the server (WhatsApp's own limit for an image is 5 MB, a document 100 MB). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type SniffedFile = { mime: string; ext: string; media: 'photo' | 'document' | 'video' };

const ascii = (b: Uint8Array, at: number, text: string) => {
    if (b.length < at + text.length) return false;
    for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
    return true;
};

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx'];
const HEIF_BRANDS = ['heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV', 'f4v '];

/** What the bytes are, if they are a photo, a PDF or a video we take. Null when they are anything else. */
export function sniffFile(b: Uint8Array): SniffedFile | null {
    if (b.length < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', media: 'photo' };
    if (b[0] === 0x89 && ascii(b, 1, 'PNG\r\n') && b[6] === 0x1a && b[7] === 0x0a) return { mime: 'image/png', ext: 'png', media: 'photo' };
    if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return { mime: 'image/webp', ext: 'webp', media: 'photo' };
    // A PDF may have a few bytes in front of its header (the spec allows the first kilobyte).
    for (let i = 0; i < Math.min(1024, b.length - 4); i++) if (ascii(b, i, '%PDF-')) return { mime: 'application/pdf', ext: 'pdf', media: 'document' };
    if (ascii(b, 4, 'ftyp')) {
        const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
        if (HEIC_BRANDS.includes(brand)) return { mime: 'image/heic', ext: 'heic', media: 'photo' };
        if (HEIF_BRANDS.includes(brand)) return { mime: 'image/heif', ext: 'heif', media: 'photo' };
        if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', media: 'video' };
        if (MP4_BRANDS.includes(brand) || brand.startsWith('3gp') || brand.startsWith('3g2')) return { mime: 'video/mp4', ext: 'mp4', media: 'video' };
    }
    return null;
}

/** A client-made id for one upload, the same on every try of it, so a try that really got through isn't added twice. */
export const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The page's helpers. ES5, no DOM. Names start with `ph` so they can't meet the page's own.
 *   phExifRange(bytes)        [start, end) of a JPEG's EXIF APP1 segment, or null
 *   phOrientation(segment)    the Orientation in that segment, 1 to 8 (1 when there is none)
 *   phOrientationOne(segment) a copy of that segment whose Orientation says "upright" (the pixels have been turned already)
 *   phJpegSize(bytes)         [width, height] as the JPEG stores them (before any turning), or null
 *   phMatrix(turn, w, h)      the canvas transform that turns a photo stored w by h upright, for Orientation 2 to 8
 *   phWithExif(jpeg, segment) the JPEG with that segment straight after its start, and no other EXIF
 *   phScale(w, h, longEdge)   [w, h] cut to fit, never made bigger
 *   phTimeout(bytes)          how long one try may take: 45 s and a second more for every 40 kB, up to 5 minutes
 *   phRetryable(status)       whether another try can help (0 is "no answer at all")
 *   phId()                    a new upload id
 */
export const PHOTO_JS = `
  function phExifRange(b) {
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    var i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      var m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xda || m === 0xd9) return null;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      var size = (b[i + 2] << 8) | b[i + 3];
      if (size < 2 || i + 2 + size > b.length) return null;
      if (m === 0xe1 && size >= 8 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) return [i, i + 2 + size];
      i += 2 + size;
    }
    return null;
  }
  function phOrientationAt(s) {
    var t = 10;
    if (!s || s.length < t + 8) return null;
    var le = s[t] === 0x49 && s[t + 1] === 0x49;
    if (!le && !(s[t] === 0x4d && s[t + 1] === 0x4d)) return null;
    var u16 = function (at) { return le ? s[at] | (s[at + 1] << 8) : (s[at] << 8) | s[at + 1]; };
    var u32 = function (at) { return le ? (s[at] | (s[at + 1] << 8) | (s[at + 2] << 16) | (s[at + 3] * 16777216)) : (s[at] * 16777216 + (s[at + 1] << 16) + (s[at + 2] << 8) + s[at + 3]); };
    var ifd = t + u32(t + 4);
    if (ifd + 2 > s.length) return null;
    var n = u16(ifd);
    for (var k = 0; k < n; k++) {
      var e = ifd + 2 + k * 12;
      if (e + 12 > s.length) return null;
      if (u16(e) === 0x0112) return { at: e + 8, le: le };
    }
    return null;
  }
  function phOrientation(seg) {
    var o = phOrientationAt(seg);
    if (!o) return 1;
    var v = o.le ? seg[o.at] | (seg[o.at + 1] << 8) : (seg[o.at] << 8) | seg[o.at + 1];
    return v >= 1 && v <= 8 ? v : 1;
  }
  function phOrientationOne(seg) {
    var out = new Uint8Array(seg.length);
    out.set(seg);
    var o = phOrientationAt(out);
    if (o) { if (o.le) { out[o.at] = 1; out[o.at + 1] = 0; } else { out[o.at] = 0; out[o.at + 1] = 1; } }
    return out;
  }
  function phJpegSize(b) {
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    var i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) return null;
      var m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd9 || m === 0xda) return null;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      var size = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += 2 + size;
    }
    return null;
  }
  function phMatrix(turn, w, h) {
    switch (turn) {
      case 2: return [-1, 0, 0, 1, w, 0];
      case 3: return [-1, 0, 0, -1, w, h];
      case 4: return [1, 0, 0, -1, 0, h];
      case 5: return [0, 1, 1, 0, 0, 0];
      case 6: return [0, 1, -1, 0, h, 0];
      case 7: return [0, -1, -1, 0, h, w];
      case 8: return [0, -1, 1, 0, 0, w];
      default: return [1, 0, 0, 1, 0, 0];
    }
  }
  function phWithExif(jpeg, seg) {
    if (!jpeg || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
    var own = phExifRange(jpeg), from = 2, until = jpeg.length, skip = own ? own[1] - own[0] : 0;
    var out = new Uint8Array(2 + seg.length + (jpeg.length - 2 - skip));
    out[0] = 0xff; out[1] = 0xd8;
    out.set(seg, 2);
    if (own) { out.set(jpeg.subarray(2, own[0]), 2 + seg.length); out.set(jpeg.subarray(own[1], until), 2 + seg.length + (own[0] - 2)); }
    else out.set(jpeg.subarray(from, until), 2 + seg.length);
    return out;
  }
  function phScale(w, h, longEdge) {
    var big = Math.max(w, h);
    if (big <= longEdge) return [w, h];
    var f = longEdge / big;
    return [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
  }
  function phTimeout(bytes) { return Math.min(300000, 45000 + Math.ceil(bytes / 40000) * 1000); }
  function phRetryable(status) { return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500; }
  function phId() {
    var a = new Uint8Array(12), s = '';
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < a.length; j++) s += (a[j] < 16 ? '0' : '') + a[j].toString(16);
    return s;
  }
`;
