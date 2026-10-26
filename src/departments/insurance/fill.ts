// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/fill.ts (commit a9611ed). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5192: fill an insurer's claim form from its field map (TTTFG-5172), the client's answers (riivo_answers,
// TTTFG-5176) and the CRM rows. Pure: PDF bytes, config and values in; filled PDF bytes and the blank boxes out.
// signature-fill.ts does the reads and writes.
//
// The rule that matters most (TTTFG-5248, "the one wrong turn"): never guess a value. A box whose source is empty,
// marked "broker to confirm", or can't be read in the box's format (a date that isn't a date, an amount that isn't a
// number) stays blank and goes on the blank-fields list, which lands in riivo_claim.riivo_blankfields for the broker.
// The client checks the form before signing; nothing here fills a gap.
//
// Three kinds of PDF (handovers/TTTFG-5172-claim-forms.md):
// - AcroForm text fields (Discovery, Momentum), filled by name. A value too wide for a one-line box gets pdf-lib's
//   auto font size (DA size 0) rather than being cut off.
// - AcroForm checkboxes (Momentum), set from a `tick` entry: ticked when the value equals `tickWhen`.
// - Flat PDFs (Hybrid), where text is drawn at the entry's page and x/y. A value wider than `maxWidth` shrinks (down to
//   MIN_SIZE) and wraps; with `height`, it wraps and shrinks until it fits the box. Nothing is ever cut off.
//
// TTTFG-5172's refinements: a long answer spreads over the entry's `overflow` fields; repeating groups read
// `answer:<key>.<n>` and an entry the client never gave is not applicable; conditional entries (`when`) pick the
// source per box, and a condition we can't decide leaves the box blank and listed rather than taking the fallback.
//
// The form is not flattened: the signing page (TTTFG-5196) stamps the signature into it later. Signature fields are
// never touched.
//
// Text goes through Helvetica (WinAnsi), so a character it can't encode is reduced to its base letter (ğ to g) or, for
// emoji and the like, dropped. Either way the client sees the result before signing.
import { PDFCheckBox, PDFDocument, PDFTextField, StandardFonts, type PDFFont } from 'pdf-lib';
import type { ClaimAnswers, ClaimForm, Condition, FieldMapEntry, QuestionItem } from './contracts';

/** The CRM tables a `crm:` source may read. The rows are passed in, so the fill stays pure. Policy data is read-only. */
export const CRM_TABLES = ['contact', 'riivo_policy', 'riivo_provider', 'riivo_claim'] as const;
export type CrmTable = (typeof CRM_TABLES)[number];
export type CrmValue = string | number | boolean | null | undefined;
/**
 * Column values by table and logical name (`crm:contact.mobilephone` reads `crm.contact.mobilephone`). Choice and
 * lookup columns carry their display text (the adapter reads the formatted value), dates are ISO 8601.
 */
export type CrmValues = Partial<Record<CrmTable, Record<string, CrmValue>>>;

/** Why a box was left blank. */
export type BlankReason = 'empty' | 'broker-to-confirm' | 'unreadable' | 'too-long' | 'no-such-field';
export interface BlankField {
  /** The entry's source, for example `answer:vehicleRegistration` or `crm:contact.ttt_idnumber`. */
  key: string;
  /** The box as a person would name it: the entry's label, else the PDF field name or the question. */
  label: string;
  reason: BlankReason;
}

export const DEFAULT_SIZE = 10;
/** The smallest text drawn on a flat form before it wraps instead. */
export const MIN_SIZE = 6;
const ZONE = 'Africa/Johannesburg';

// ---------------------------------------------------------------- resolving a source

const isEmpty = (v: CrmValue) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Yes/no answers arrive as booleans or text; compare them the same way (`tickWhen: true` matches "Yes"). */
export function sameAnswer(a: CrmValue, b: CrmValue): boolean {
  const norm = (v: CrmValue) => {
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    const s = String(v ?? '').trim().toLowerCase();
    return s === 'true' ? 'yes' : s === 'false' ? 'no' : s;
  };
  return norm(a) === norm(b);
}

type Read = { value: CrmValue } | { blank: BlankReason };
type Resolved = Read | { notApplicable: true };

/** `itemValue.2` is entry 2 of the grouped question `itemValue` (TTTFG-5172 repeating groups). */
export function splitKey(key: string): { base: string; entry?: number } {
  const m = /^(.*)\.(\d+)$/.exec(key);
  return m ? { base: m[1], entry: Number(m[2]) } : { base: key };
}

function readAnswer(answers: ClaimAnswers, key: string): Read {
  const a = answers[key];
  if (!a) return { blank: 'empty' };
  if (a.status === 'broker-to-confirm') return { blank: 'broker-to-confirm' };
  return isEmpty(a.value) ? { blank: 'empty' } : { value: a.value };
}

function readCrm(crm: CrmValues, source: string): Read {
  const [table, column] = source.slice('crm:'.length).split('.') as [CrmTable, string];
  const v = crm[table]?.[column];
  return isEmpty(v) ? { blank: 'empty' } : { value: v };
}

/** A condition's outcome. `unknown` when the value it tests is missing: we can't tell, so we don't pretend to. */
export type Truth = boolean | { unknown: BlankField['key']; reason: BlankReason };

/**
 * Tests an `onlyIf` or `when`. The key is a question key or a `crm:` source. Inside a repeating group, a key naming a
 * question of the same group reads the same entry (`itemType.2` for entry 2). A question that doesn't apply has no
 * answer to test, so a condition on it is false.
 */
export function evaluate(cond: Condition, form: ClaimForm, answers: ClaimAnswers, crm: CrmValues, entry?: number, depth = 0): Truth {
  let read: Read;
  let key: string;
  if (cond.key.startsWith('crm:')) {
    key = cond.key;
    read = readCrm(crm, cond.key);
  } else {
    const q = form.questionList.find((x) => x.key === cond.key);
    const answerKey = q?.group && entry !== undefined ? `${cond.key}.${entry}` : cond.key;
    key = `answer:${answerKey}`;
    if (q && applicable(q, form, answers, crm, entry, depth + 1) === false) return false;
    read = readAnswer(answers, answerKey);
  }
  if ('blank' in read) return { unknown: key, reason: read.blank };
  const wanted = cond.oneOf ?? [cond.equals!];
  return wanted.some((w) => sameAnswer(read.value, w));
}

/** Whether a grouped question's entry n exists: the client gave any answer for that entry. */
export function entryExists(form: ClaimForm, group: string, n: number, answers: ClaimAnswers): boolean {
  return form.questionList.some((q) => q.group === group && `${q.key}.${n}` in answers);
}

/** Whether a question applies: its group's and its own `onlyIf`, and for a grouped question, that the entry exists. */
function applicable(q: QuestionItem, form: ClaimForm, answers: ClaimAnswers, crm: CrmValues, entry: number | undefined, depth = 0): Truth {
  if (depth > 20) return true; // a condition loop is a config error (the validator refuses it); don't recurse forever
  if (q.group) {
    const g = form.questionGroups.find((x) => x.key === q.group);
    if (g?.onlyIf && evaluate(g.onlyIf, form, answers, crm, undefined, depth) === false) return false;
    if (entry !== undefined && !entryExists(form, q.group, entry, answers)) return false;
  }
  return q.onlyIf ? evaluate(q.onlyIf, form, answers, crm, entry, depth) : true;
}

/**
 * Reads one source. An `answer:` whose question doesn't apply (an `onlyIf` the client's earlier answer rules out, a
 * group entry the client never gave) is not applicable: the box stays blank but isn't listed. When the deciding answer
 * is itself missing we can't tell, so the box is listed.
 */
export function resolveSource(source: string, form: ClaimForm, answers: ClaimAnswers, crm: CrmValues): Resolved {
  if (source.startsWith('answer:')) {
    const key = source.slice('answer:'.length);
    const { base, entry } = splitKey(key);
    const q = form.questionList.find((x) => x.key === base) ?? form.questionList.find((x) => x.key === key);
    if (q && applicable(q, form, answers, crm, q.key === base ? entry : undefined) === false) return { notApplicable: true };
    return readAnswer(answers, key);
  }
  if (source.startsWith('crm:')) return readCrm(crm, source);
  // TTTFG-4830: a value that is the same on every claim of this form (its reason says why), e.g. "Natural person".
  if (source.startsWith('fixed:')) return { value: source.slice('fixed:'.length) };
  return { notApplicable: true }; // 'none': office use, signature, broker section
}

/** One box on the form: an AcroForm field or a position on a flat page. */
const boxOf = (e: FieldMapEntry) => ('pdfField' in e.target ? `field:${e.target.pdfField}` : `at:${e.target.page}:${e.target.x}:${e.target.y}`);

/**
 * TTTFG-5172 conditional entries: per box, the first `when` entry whose condition holds, else the entry without
 * `when`. A condition we can't decide (the client drove or not: unknown) leaves the box blank and lists what decides it,
 * because filling the fallback would be a guess.
 */
export function chooseEntries(form: ClaimForm, answers: ClaimAnswers, crm: CrmValues): ({ entry: FieldMapEntry } | { undecided: FieldMapEntry; unknown: string; reason: BlankReason })[] {
  const boxes = new Map<string, FieldMapEntry[]>();
  for (const e of form.fieldMap) boxes.set(boxOf(e), [...(boxes.get(boxOf(e)) ?? []), e]);
  const out: ReturnType<typeof chooseEntries> = [];
  for (const entries of boxes.values()) {
    let chosen: (typeof out)[number] | undefined;
    for (const e of entries.filter((x) => x.when)) {
      const entry = e.source.startsWith('answer:') ? splitKey(e.source.slice('answer:'.length)).entry : undefined;
      const t = evaluate(e.when!, form, answers, crm, entry);
      if (t === true) { chosen = { entry: e }; break; }
      if (t !== false) { chosen = { undecided: e, unknown: t.unknown, reason: t.reason }; break; }
    }
    const fallback = entries.find((x) => !x.when);
    if (!chosen && fallback) chosen = { entry: fallback };
    if (chosen) out.push(chosen);
  }
  return out;
}

// ---------------------------------------------------------------- formats

const pad = (n: number) => String(n).padStart(2, '0');
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Date and time parts in South African time. Only ISO 8601 is read: "next Tuesday" is not a date we fill. */
function parts(v: CrmValue): { date?: string; time?: string } | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const d = DATE_ONLY.exec(s);
  if (d) return { date: `${d[3]}/${d[2]}/${d[1]}` };
  // TTTFG-4830: a month and year ("when did you buy it?") prints as mm/yyyy.
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
  if (m) return { date: `${m[2]}/${m[1]}` };
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return { date: s };
  const t = /^(\d{1,2}):(\d{2})(:\d{2})?$/.exec(s);
  if (t && +t[1] < 24 && +t[2] < 60) return { time: `${pad(+t[1])}:${t[2]}` };
  if (!ISO_DATETIME.test(s) || Number.isNaN(Date.parse(s))) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(s)).map((x) => [x.type, x.value]),
  );
  return { date: `${p.day}/${p.month}/${p.year}`, time: `${p.hour}:${p.minute}` };
}

/** Rand with a space between thousands: R 12 345.00. Accepts a number or plain digits; "12,50" is ambiguous, so unread. */
export function rand(v: CrmValue): string | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim().replace(/^R\s*/i, '').replace(/\s/g, '');
    if (!/^-?(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(s)) return null;
    n = Number(s.replace(/,/g, ''));
  } else return null;
  if (!Number.isFinite(n)) return null;
  const [whole, cents] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents}`;
}

/**
 * The text for a box, or null when the value can't be read in the entry's format (the box is then left blank and
 * listed). '' means nothing to write: a `char` box past the end of a shorter value.
 */
export function formatText(v: CrmValue, format: FieldMapEntry['format'], charIndex?: number): string | null {
  switch (format) {
    case 'date': return parts(v)?.date ?? null;
    case 'time': return parts(v)?.time ?? null;
    case 'datetime': {
      const p = parts(v);
      return p?.date && p.time ? `${p.date} ${p.time}` : null;
    }
    case 'currency': return rand(v);
    case 'yesno': return sameAnswer(v, true) ? 'Yes' : sameAnswer(v, false) ? 'No' : null;
    // One box per character (Momentum's ID and registration numbers): spaces and hyphens don't take a box.
    case 'char': return charIndex === undefined ? null : (charsOf(v)[charIndex] ?? '');
    case 'tick': return null; // handled by tickState
    default:
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      return String(v).trim();
  }
}

/** A value as printed one character per box: "CA 123-456" is CA123456 on the form, as on the registration papers. */
export const charsOf = (v: CrmValue) => String(v).replace(/[\s-]/g, '');

/** Whether a tick box is ticked: the value equals `tickWhen` (default yes). */
export const tickState = (v: CrmValue, tickWhen: FieldMapEntry['tickWhen']) => sameAnswer(v, tickWhen ?? true);

/** Reduces text to what Helvetica can draw: accents to their base letter, the rest (emoji) dropped. */
export function drawable(text: string, font: PDFFont): string {
  const ok = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    if (ch === '\n' || ok.has(ch.codePointAt(0)!)) out += ch;
    else for (const base of ch.normalize('NFKD')) if (ok.has(base.codePointAt(0)!)) out += base;
  }
  return out;
}

// ---------------------------------------------------------------- flat forms

/** Line spacing on flat forms, as a multiple of the font size. */
export const LINE = 1.15;

/**
 * Lines and size for text at a position, never cutting anything off:
 * - with `height` (a multi-line box): wrapped to `maxWidth`, shrinking until the lines fit the height;
 * - with only `maxWidth`: one line, shrinking until it fits, else wrapped;
 * either way not below MIN_SIZE, where the text wraps and may run past the box rather than lose words.
 */
export function layout(text: string, font: PDFFont, size: number, maxWidth?: number, height?: number): { size: number; lines: string[] } {
  const paragraphs = text.split('\n');
  if (!maxWidth) return { size, lines: paragraphs };
  for (let s = size; s >= MIN_SIZE; s -= 0.5) {
    if (height !== undefined) {
      const lines = wrap(text, font, s, maxWidth);
      if ((lines.length - 1) * s * LINE + s <= height) return { size: s, lines };
    } else if (Math.max(...paragraphs.map((p) => font.widthOfTextAtSize(p, s))) <= maxWidth) {
      return { size: s, lines: paragraphs };
    }
  }
  return { size: MIN_SIZE, lines: wrap(text, font, MIN_SIZE, maxWidth) };
}

/** Word-wraps each paragraph to `width` at `size`; a word wider than the line (a long email address) is broken by character. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= width;
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let next = line ? `${line} ${word}` : word;
      if (!fits(next) && line) { out.push(line); next = word; }
      while (!fits(next) && next.length > 1) {
        let cut = next.length - 1;
        while (cut > 1 && !fits(next.slice(0, cut))) cut--;
        out.push(next.slice(0, cut));
        next = next.slice(cut);
      }
      line = next;
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- the fill

/** What was drawn on a flat form, for the golden tests and the review. */
export interface Drawn { page: number; x: number; y: number; size: number; lines: string[] }

export interface FillResult {
  bytes: Uint8Array;
  blankFields: BlankField[];
  drawn: Drawn[];
}

function labelFor(entry: FieldMapEntry, questions: QuestionItem[]): string {
  if (entry.label) return entry.label;
  if ('pdfField' in entry.target) return entry.target.pdfField;
  const q = entry.source.startsWith('answer:') ? questions.find((x) => `answer:${x.key}` === entry.source) : undefined;
  return q?.prompt ?? `page ${entry.target.page} at (${entry.target.x}, ${entry.target.y})`;
}

/**
 * One line per missing value: two boxes fed by the same empty answer (Momentum's Yes and No ticks) are one gap to
 * fix. A problem with the box itself (not on the PDF, too long) is listed per box.
 */
export function addBlank(list: BlankField[], b: BlankField) {
  const perBox = b.reason === 'no-such-field' || b.reason === 'too-long';
  if (!list.some((x) => x.key === b.key && x.reason === b.reason && (!perBox || x.label === b.label))) list.push(b);
}

/** Fills `pdf` from the form's field map. The PDF is the insurer's blank form; the generic row has none (summarysheet.ts). */
export async function fillClaimForm(pdf: Uint8Array, form: ClaimForm, answers: ClaimAnswers, crm: CrmValues): Promise<FillResult> {
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const acro = doc.getForm();
  const blankFields: BlankField[] = [];
  const drawn: Drawn[] = [];
  // How many boxes a value printed one character per box has: a value with more characters is never cut short.
  const charBoxes = new Map<string, number>();
  for (const e of form.fieldMap) {
    if (e.format === 'char' && e.charIndex !== undefined) charBoxes.set(e.source, Math.max(charBoxes.get(e.source) ?? 0, e.charIndex + 1));
  }

  for (const choice of chooseEntries(form, answers, crm)) {
    if ('undecided' in choice) {
      addBlank(blankFields, { key: choice.unknown, label: labelFor(choice.undecided, form.questionList), reason: choice.reason });
      continue;
    }
    const { entry } = choice;
    if (entry.source === 'none') continue;
    const blank = (reason: BlankReason) => addBlank(blankFields, { key: entry.source, label: labelFor(entry, form.questionList), reason });
    const r = resolveSource(entry.source, form, answers, crm);
    if ('notApplicable' in r) continue;
    if ('blank' in r) { blank(r.blank); continue; }
    if (entry.format === 'char' && charsOf(r.value).length > (charBoxes.get(entry.source) ?? 0)) {
      // Every box of the value stays blank; the broker sees it once, under the label without "(character n)".
      const label = labelFor(entry, form.questionList).replace(/\s*\(character \d+\)$/, '');
      addBlank(blankFields, { key: entry.source, label, reason: 'too-long' });
      continue;
    }
    const raw = entry.format === 'tick' ? (tickState(r.value, entry.tickWhen) ? 'X' : '') : formatText(r.value, entry.format, entry.charIndex);

    if ('pdfField' in entry.target) {
      const field = acro.getFieldMaybe(entry.target.pdfField);
      if (field instanceof PDFCheckBox) {
        if (tickState(r.value, entry.tickWhen)) field.check(); else field.uncheck();
        continue;
      }
      const more = (entry.overflow ?? []).map((n) => acro.getFieldMaybe(n));
      if (!(field instanceof PDFTextField) || !more.every((f) => f instanceof PDFTextField)) {
        // Missing from this PDF, or a signature or other field a value must not go into: a config error, never a guess.
        blank('no-such-field');
        continue;
      }
      if (raw === null) { blank('unreadable'); continue; }
      if (raw === '') continue;
      const fields = [field, ...(more as PDFTextField[])];
      const text = drawable(raw, font);
      const parts = fields.length > 1 ? spread(text, fields, font) : [field.isMultiline() ? text : text.replace(/\s*\n\s*/g, ' ')];
      if (fields.some((f, i) => f.getMaxLength() !== undefined && (parts[i] ?? '').length > f.getMaxLength()!)) { blank('too-long'); continue; }
      fields.forEach((f, i) => {
        if (!parts[i]) return;
        f.setText(parts[i]);
        if (!f.isMultiline() && fitsAtDaSize(f, parts[i], font) === false) f.setFontSize(0);
      });
      continue;
    }

    const { page, x, y } = entry.target;
    if (page > doc.getPageCount()) { blank('no-such-field'); continue; }
    if (raw === null) { blank('unreadable'); continue; }
    if (raw === '') continue; // an unticked box on a flat form: nothing to draw
    const { size, lines } = layout(drawable(raw, font), font, entry.target.size ?? DEFAULT_SIZE, entry.target.maxWidth, entry.target.height);
    const p = doc.getPage(page - 1);
    lines.forEach((line, i) => p.drawText(line, { x, y: y - i * size * LINE, size, font }));
    drawn.push({ page, x, y, size, lines });
  }

  return { bytes: await doc.save(), blankFields, drawn };
}

/**
 * TTTFG-5172 `overflow`: a long answer printed over several one-line fields. Each field but the last takes the words
 * that fit at its own font size; the last takes the rest (auto-sized if it must). Nothing is dropped.
 */
export function spread(text: string, fields: PDFTextField[], font: PDFFont): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const [i, f] of fields.entries()) {
    if (i === fields.length - 1) { out.push(words.join(' ')); break; }
    let line = '';
    while (words.length && (fitsAtDaSize(f, line ? `${line} ${words[0]}` : words[0], font) !== false || !line)) {
      line = line ? `${line} ${words.shift()}` : words.shift()!;
      if (fitsAtDaSize(f, line, font) === false) break; // one word wider than the field: it goes alone, auto-sized
    }
    out.push(line);
  }
  return out;
}

/** False when a one-line value is wider than its box at the field's own font size; null when we can't tell. */
function fitsAtDaSize(field: PDFTextField, text: string, font: PDFFont): boolean | null {
  const size = Number(/(\d+(?:\.\d+)?)\s+Tf/.exec(field.acroField.getDefaultAppearance() ?? '')?.[1]);
  const width = field.acroField.getWidgets()[0]?.getRectangle().width;
  if (!size || !width) return null;
  return font.widthOfTextAtSize(text, size) <= width - 4; // pdf-lib pads the box by 2pt each side
}

/** riivo_claim.riivo_blankfields: one line per gap, for the broker. The column holds 4000 characters. */
export function blankFieldsText(list: BlankField[], limit = 4000): string {
  const why: Record<BlankReason, string> = {
    'empty': 'no answer',
    'broker-to-confirm': 'broker to confirm',
    'unreadable': "answer can't be read in this box's format",
    'too-long': "answer too long for the box",
    'no-such-field': 'box not found on the form (check the field map)',
  };
  // A CRM value is never asked of the client: say where it is missing.
  const lines = list.map((b) => `${b.label} [${b.key}]: ${b.reason === 'empty' && b.key.startsWith('crm:') ? 'not on file in the CRM' : why[b.reason]}`);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const more = `\n...and ${lines.length - i} more`;
    const next = (out ? '\n' : '') + lines[i];
    if (out.length + next.length + (i < lines.length - 1 ? more.length : 0) > limit) return out + more;
    out += next;
  }
  return out;
}
