// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/exif.ts (commit c99946b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5263 step 3: a photo's capture date, read in code from the original bytes before anything resizes or converts
// them. It feeds one risk flag (Photo date before incident) and nothing else.
//
// Only some photos have one. WhatsApp re-encodes an image sent as a photo and drops its EXIF; an image sent as a WhatsApp
// document, or attached to an email, keeps it. A photo with no date is normal, never a flag.
//
// Read: JPEG (EXIF in the APP1 segment) and TIFF. Not read: HEIC/HEIF (EXIF sits in an ISO-BMFF item), PNG and WebP,
// which phones rarely send as files; they give no date. No library: Tina loads a copy of this package, and a dependency
// here would be one for Tina too.

const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME_DIGITIZED = 0x9004;
const EXIF_IFD = 0x8769;

/** The date the camera says the photo was taken, as yyyy-mm-dd (the camera's own clock, no time zone), or undefined. */
export function captureDate(bytes: Uint8Array): string | undefined {
  try {
    const tiff = bytes[0] === 0xff && bytes[1] === 0xd8 ? exifInJpeg(bytes) : 0;
    if (tiff === undefined) return undefined;
    return dateIn(bytes, tiff);
  } catch {
    // A truncated or odd file: no date.
    return undefined;
  }
}

/** Where the TIFF header of a JPEG's EXIF starts: the APP1 segment that opens with "Exif\0\0". */
function exifInJpeg(b: Uint8Array): number | undefined {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    // Start of scan or end of image: the metadata segments are over.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const size = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === 'Exif\0\0') return i + 10;
    i += 2 + size;
  }
  return undefined;
}

function dateIn(b: Uint8Array, t: number): string | undefined {
  const order = String.fromCharCode(b[t], b[t + 1]);
  if (order !== 'II' && order !== 'MM') return undefined;
  const little = order === 'II';
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(t + 2) !== 42) return undefined;

  /** The value offset of `tag` in the IFD at `ifd` (relative to the TIFF header), or undefined. */
  const find = (ifd: number, tag: number): { count: number; value: number } | undefined => {
    const n = u16(t + ifd);
    for (let k = 0; k < n; k++) {
      const e = t + ifd + 2 + 12 * k;
      if (u16(e) === tag) return { count: u32(e + 4), value: u32(e + 8) };
    }
    return undefined;
  };
  const exif = find(u32(t + 4), EXIF_IFD);
  if (!exif) return undefined;
  for (const tag of [DATE_TIME_ORIGINAL, DATE_TIME_DIGITIZED]) {
    const d = find(exif.value, tag);
    // "YYYY:MM:DD HH:MM:SS\0", 20 bytes: always stored at an offset.
    if (!d || d.count < 10) continue;
    const text = String.fromCharCode(...b.subarray(t + d.value, t + d.value + 10));
    const m = /^(\d{4}):(\d{2}):(\d{2})$/.exec(text);
    if (!m) continue;
    const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // A camera with no clock set writes zeros or 1970.
    if (y < 1990 || mo < 1 || mo > 12 || day < 1 || day > 31) continue;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return undefined;
}
