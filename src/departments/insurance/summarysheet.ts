// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/summarysheet.ts (commit c99946b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5192: the one-page claim summary sheet, for a policy whose insurer has no mapped form (the generic
// riivo_claimform row). The client signs it like a form, and the broker still fills that insurer's own form by hand
// (SPEC-04 "Claim forms"). Pure: config, answers and CRM rows in; PDF bytes and blank fields out.
//
// What it holds (TTTFG-5248 step 5): client name, ID number, contact details, policy number, insurer, claim type,
// incident date, time and place, description, the SAPS case number and station when the police were involved (a theft
// or hijacking on an unmapped insurer), and each question on the generic list with the client's answer.
// No evidence list: most evidence arrives after the client signs, and the pack summary page (TTTFG-5200) lists it.
//
// The same never-guess rule as the form fill: an empty or "broker to confirm" value prints as an empty line and goes on
// the blank-fields list. The fixed rows read CRM columns through the same `crm:` sources as a field map, so the blank
// list names them the same way.
//
// Above the signature line: DECLARATION, a draft (draft-1) for Insurance and Advice to approve with the other templates.
// TTTFG-5196: the sheet says where its signature and date lines are (`stamps`), for the signing page.
//
// One A4 page: the text shrinks (down to MIN_SIZE) until everything fits. It is never cut off; in the unlikely case
// that it still doesn't fit (a description of several thousand words), it carries on to a second page.
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import type { ClaimAnswers, ClaimForm, FieldMapEntry } from './contracts';
import { addBlank, drawable, formatText, MIN_SIZE, resolveSource, wrap, type BlankField, type CrmValues } from './fill';
import type { SignStamp } from './signing';

export const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 48;
const LABEL_WIDTH = 150;
const BASE_SIZE = 10;

/**
 * The fixed rows. Column names: contact and riivo_policy from the 2Tables solution source, riivo_provider likewise,
 * riivo_claim from the TTTFG-4885 build script. riivo_policy has two policy-number columns ("Policy No" and
 * "Policy Number (AK)"); riivo_policy_no is the one Go4Broker fills (open question in the report).
 */
export const SUMMARY_ROWS: { section: string; label: string; source: string; format?: FieldMapEntry['format']; saps?: true }[] = [
  { section: 'Client', label: 'Name', source: 'crm:contact.fullname' },
  { section: 'Client', label: 'ID number', source: 'crm:contact.ttt_idnumber' },
  { section: 'Client', label: 'Mobile number', source: 'crm:contact.mobilephone' },
  { section: 'Client', label: 'Email address', source: 'crm:contact.emailaddress1' },
  { section: 'Policy', label: 'Insurer', source: 'crm:riivo_provider.riivo_providername' },
  { section: 'Policy', label: 'Policy number', source: 'crm:riivo_policy.riivo_policy_no' },
  { section: 'Claim', label: 'Claim reference', source: 'crm:riivo_claim.riivo_name' },
  { section: 'Claim', label: 'Claim type', source: 'crm:riivo_claim.riivo_claimtype' },
  { section: 'Claim', label: 'Incident date', source: 'crm:riivo_claim.riivo_incidentdate', format: 'date' },
  { section: 'Claim', label: 'Incident time', source: 'crm:riivo_claim.riivo_incidentdate', format: 'time' },
  { section: 'Claim', label: 'Place', source: 'crm:riivo_claim.riivo_incidentplace' },
  { section: 'Claim', label: 'What happened', source: 'crm:riivo_claim.riivo_description' },
  { section: 'Claim', label: 'SAPS case number', source: 'crm:riivo_claim.riivo_sapscasenumber', saps: true },
  { section: 'Claim', label: 'Police station', source: 'crm:riivo_claim.riivo_sapsstation', saps: true },
];

/** The SAPS rows print when the police were involved, or a case number is on file; otherwise they don't apply. */
export const sapsApplies = (crm: CrmValues) => crm.riivo_claim?.riivo_sapsinvolved === true || !!crm.riivo_claim?.riivo_sapscasenumber;

/** What the client confirms by signing the sheet. Draft: Insurance and Advice approves it with the other templates. */
export const DECLARATION = {
  version: 'draft-1',
  text: 'I confirm that the information on this summary is true and complete to the best of my knowledge, and that I have not left out anything the insurer should know about this claim.',
} as const;

export const BLANK_NOTE = 'A blank answer means we do not have it yet, or your broker still needs to confirm it.';
export const SIGN_LINES = ['Client signature', 'Date'];

export interface SummaryRow { section: string; label: string; value: string }
export interface SummaryResult { bytes: Uint8Array; blankFields: BlankField[]; rows: SummaryRow[]; pages: number; stamps: SignStamp[] }

/** The rows of the sheet with their values ('' for a blank), and the blank-fields list. */
export function summaryRows(form: ClaimForm, answers: ClaimAnswers, crm: CrmValues): { rows: SummaryRow[]; blankFields: BlankField[] } {
  const rows: SummaryRow[] = [];
  const blankFields: BlankField[] = [];
  const add = (section: string, label: string, source: string, format?: FieldMapEntry['format']) => {
    const r = resolveSource(source, form, answers, crm);
    if ('notApplicable' in r) return;
    const text = 'value' in r ? formatText(r.value, format) : null;
    if (text === null) addBlank(blankFields, { key: source, label, reason: 'blank' in r ? r.blank : 'unreadable' });
    rows.push({ section, label, value: text ?? '' });
  };
  for (const r of SUMMARY_ROWS) if (!r.saps || sapsApplies(crm)) add(r.section, r.label, r.source, r.format);
  for (const q of form.questionList) {
    if (q.kind !== 'question') continue; // evidence is the pack's job (TTTFG-5200)
    const format = q.answerType === 'date' ? 'date' : undefined;
    if (!q.group) { add('Your answers', q.prompt, `answer:${q.key}`, format); continue; }
    // A repeating group: one row per entry the client gave (entries they never gave are not applicable).
    const max = form.questionGroups.find((g) => g.key === q.group)?.max ?? 0;
    for (let n = 1; n <= max; n++) add('Your answers', `${q.prompt} (${n})`, `answer:${q.key}.${n}`, format);
  }
  return { rows, blankFields };
}

/** Builds the sheet. */
export async function summarySheet(form: ClaimForm, answers: ClaimAnswers, crm: CrmValues): Promise<SummaryResult> {
  const { rows, blankFields } = summaryRows(form, answers, crm);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const insurer = rows.find((r) => r.label === 'Insurer')?.value;
  doc.setTitle(`Claim summary${insurer ? ` - ${insurer}` : ''}`);

  const blocks = [
    paragraph('Claim summary', bold, 1.6), paragraph(BLANK_NOTE, font, 1, 0.4), ...sectionedRows(rows, font, bold),
    paragraph(DECLARATION.text, font, 1, 2), paragraph(SIGN_LINES.map((l) => `${l}: ______________________________`).join('\n\n'), font, 1, 1.5),
  ];
  const stamps: SignStamp[] = [];
  drawBlocks(doc, blocks, fitSize(blocks), (line, at) => {
    // The signature goes on the line after "Client signature:", the date after "Date:".
    const sign = SIGN_LINES.find((l) => line.text?.startsWith(`${l}: _`));
    if (!sign) return;
    const x = MARGIN + at.block.font.widthOfTextAtSize(`${sign}: `, at.size);
    const right = MARGIN + at.block.font.widthOfTextAtSize(line.text!, at.size);
    stamps.push(sign === SIGN_LINES[0]
      ? { kind: 'signature', page: at.page, x, y: at.y - 2, width: right - x, height: at.size * 2.2 }
      : { kind: 'date', page: at.page, x: x + 2, y: at.y + 1.5, size: at.size });
  });
  return { bytes: await doc.save(), blankFields, rows, pages: doc.getPageCount(), stamps };
}

// ---------------------------------------------------------------- layout (shared with claimpack.ts's summary page)

/** A heading, a paragraph or a label-and-value row, laid out at a base size. */
export interface Block {
  /** Space above, in multiples of the base size. */
  lead: number;
  /** Font size relative to the base size. */
  scale: number;
  font: PDFFont;
  /** A row: label in the left column (bold), value to its right; either may wrap. */
  row?: true;
  /** A row's label font. */
  labelFont?: PDFFont;
  lines: (size: number) => { label?: string; text?: string }[];
}

const lineHeight = (s: number) => s * 1.3;
const CONTENT_WIDTH = A4.width - 2 * MARGIN;

/** A paragraph, `scale` times the base size, with `lead` base sizes of space above. */
export const paragraph = (t: string, f: PDFFont, scale = 1, lead = 0): Block => ({
  lead, scale, font: f, lines: (s) => wrap(drawable(t, f), f, s * scale, CONTENT_WIDTH).map((text) => ({ text })),
});

/** The rows, with a heading wherever the section changes. */
export function sectionedRows(rows: SummaryRow[], font: PDFFont, bold: PDFFont): Block[] {
  const blocks: Block[] = [];
  let section = '';
  for (const r of rows) {
    if (r.section !== section) blocks.push(paragraph((section = r.section), bold, 1.2, 1));
    blocks.push({
      lead: 0.3, scale: 1, font, row: true, labelFont: bold,
      lines: (s) => {
        const label = wrap(drawable(r.label, bold), bold, s, LABEL_WIDTH - 8);
        const value = wrap(drawable(r.value, font), font, s, CONTENT_WIDTH - LABEL_WIDTH);
        return Array.from({ length: Math.max(label.length, value.length) }, (_, i) => ({ label: label[i], text: value[i] }));
      },
    });
  }
  return blocks;
}

const height = (blocks: Block[], size: number) => blocks.reduce((h, b) => h + size * b.lead + b.lines(size).length * lineHeight(size * b.scale), 0);

/** One A4 page: the base size, shrinking (down to MIN_SIZE) until everything fits. */
export function fitSize(blocks: Block[]): number {
  let size = BASE_SIZE;
  while (size > MIN_SIZE && height(blocks, size) > A4.height - 2 * MARGIN) size -= 0.25;
  return size;
}

/** Draws the blocks from the top of a new page, onto more pages if they don't fit. `onLine` sees each line drawn. */
export function drawBlocks(doc: PDFDocument, blocks: Block[], size: number,
  onLine?: (line: { label?: string; text?: string }, at: { page: number; y: number; size: number; block: Block }) => void): void {
  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;
  for (const b of blocks) {
    const s = size * b.scale;
    y -= size * b.lead;
    for (const line of b.lines(size)) {
      if (y - lineHeight(s) < MARGIN) {
        page = doc.addPage([A4.width, A4.height]);
        y = A4.height - MARGIN;
      }
      y -= lineHeight(s);
      if (line.label) page.drawText(line.label, { x: MARGIN, y, size: s, font: b.labelFont ?? b.font });
      if (line.text) page.drawText(line.text, { x: b.row ? MARGIN + LABEL_WIDTH : MARGIN, y, size: s, font: b.font });
      onLine?.(line, { page: doc.getPageCount(), y, size: s, block: b });
    }
  }
}
