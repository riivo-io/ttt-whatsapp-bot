// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/claimform.ts (commit 78a9547). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5172: claim form configs and their validator (TTTFG-5251 steps 5 and 9).
//
// Each insurer form is a JSON file in config/claimforms (one per PDF, plus generic.json). A file becomes one
// riivo_claimform row per claim type it serves (decision 6 in the TTTFG-5172 handover): Momentum's motor form serves
// Windscreen, Motor accident, Motor theft and Hijacking, and each row carries only the questions for its claim type.
// A file marks claim-type-only questions with `onlyIf: { key: 'crm:riivo_claim.riivo_claimtype', … }`; expandRows()
// settles those conditions per row, so one condition language covers both. A box whose question a row drops keeps an
// entry, as `source: 'none'`, so the "every PDF field has an entry" check still holds and the fill (TTTFG-5192) does
// not list a theft-only box as missing on an accident claim. A file may also tag a question, group or entry with
// `claimTypes` (file only, removed from the rows): Momentum's 10-page forms need "accident, and the car was driven",
// a claim type and an answer at once, which one `onlyIf` cannot say.
//
// validateClaimForm() checks one row against the PDF's field list and the CRM column list, both passed in, so it stays
// pure. It returns every problem, not the first, each naming the key, column or field at fault (TTTFG-5174 check 5).
//
// Nothing here knows about a specific insurer (SPEC-01 user story 36: config, not code).
import { z } from 'zod';
import {
  ClaimFormSchema, FieldMapEntrySchema, QuestionGroupSchema, QuestionItemSchema,
  type ClaimForm, type Condition, type FieldMapEntry, type QuestionItem,
} from './contracts';

/** The CRM column that holds the claim type. Conditions on it are settled when a file is split into rows. */
export const CLAIM_TYPE_SOURCE = 'crm:riivo_claim.riivo_claimtype';

/**
 * File-only: the claim types a question, group or field map entry belongs to. expandRows() keeps it on those rows only
 * and removes the property, so rows keep the contract shape. It lets a question depend on the claim type and on an
 * earlier answer at once (Momentum: "accident, and the car was being driven"), which one `onlyIf` cannot. A key may be
 * declared twice when the two declarations' claimTypes don't overlap (the same question, asked differently per type).
 */
const ClaimTypesSchema = z.array(z.string().min(1)).min(1).optional();
export const FileQuestionItemSchema = QuestionItemSchema.extend({ claimTypes: ClaimTypesSchema });
export const FileQuestionGroupSchema = QuestionGroupSchema.extend({ claimTypes: ClaimTypesSchema });
export const FileFieldMapEntrySchema = FieldMapEntrySchema.extend({ claimTypes: ClaimTypesSchema });

/** One config file in config/claimforms. */
export const ClaimFormFileSchema = z.object({
  /** Human name, e.g. "Momentum motor". */
  name: z.string().min(1),
  /** riivo_provider.riivo_providername; null for the generic list. */
  provider: z.string().min(1).nullable(),
  /** The blank PDF's path in TTT's "Insurance Claims Forms" SharePoint library; null for the generic list. */
  formPdf: z.string().min(1).nullable(),
  /** The claim types this form serves (one row each); null for the generic list (one row, every claim type). */
  claimTypes: z.array(z.string().min(1)).min(1).nullable(),
  /** Days the insurer allows to report the incident: one number, or per claim type. Missing means 30. */
  notificationPeriodDays: z.union([z.number().int().positive(), z.record(z.string(), z.number().int().positive())]).optional(),
  /** Whether a SAPS case number is required: for every claim type, or for the listed ones. */
  sapsCaseRequired: z.union([z.boolean(), z.array(z.string().min(1))]),
  active: z.boolean(),
  /** The Insurance and Advice team has checked the client-facing wording (TTTFG-5251 step 6). */
  promptsApproved: z.boolean(),
  /** Where the PDF came from, when that matters (an old copy, a version to confirm). */
  sourceNote: z.string().optional(),
  /** Questions for TTT about this form: unclear boxes, assumed periods. Not used at run time. */
  openQuestions: z.array(z.string()).default([]),
  questionList: z.array(FileQuestionItemSchema),
  questionGroups: z.array(FileQuestionGroupSchema).default([]),
  fieldMap: z.array(FileFieldMapEntrySchema),
});
export type ClaimFormFile = z.infer<typeof ClaimFormFileSchema>;

/** A blank PDF's field list, as scripts/claimforms/pdf_fields.py writes it. */
export interface PdfFields {
  sha256?: string;
  pages: { width: number; height: number }[];
  fields: { name: string; kind: 'text' | 'checkbox' | 'radio' | 'signature' | 'choice' | 'button' | 'other'; page: number; tooltip?: string | null }[];
}

/** Table -> column logical names, as config/claimforms/crm-columns.json holds them. */
export type CrmColumns = Record<string, readonly string[]>;

export interface ValidationContext {
  /** null for the generic row, which has no PDF. */
  pdf: PdfFields | null;
  crmColumns: CrmColumns;
  /** riivo_claim.riivo_claimtype values (walkthrough.ts CLAIM_TYPES). */
  claimTypes: readonly string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const MEDIA = new Set(['photo', 'document', 'video']);
const DEFAULT_NOTIFICATION_DAYS = 30;

type Scalar = string | number | boolean;
const matches = (c: Condition, value: Scalar): boolean => (c.oneOf ? c.oneOf.includes(value) : c.equals === value);

/** The AcroForm fields an entry fills: its target and any overflow fields. */
const boxesOf = (e: Pick<FieldMapEntry, 'target' | 'overflow'>): string[] => ('pdfField' in e.target ? [e.target.pdfField, ...(e.overflow ?? [])] : []);

/** The answer key a source reads, or null. `answer:item.2` reads key `item`, entry 2. */
function answerRef(source: string): { key: string; entry?: number } | null {
  if (!source.startsWith('answer:')) return null;
  const ref = source.slice('answer:'.length);
  const m = /^(.*)\.(\d+)$/.exec(ref);
  return m ? { key: m[1], entry: Number(m[2]) } : { key: ref };
}

/**
 * Split a config file into its riivo_claimform rows, one per claim type. Conditions on the claim type are settled:
 * a question or group that does not apply is dropped (with every question that depends on it), one that applies loses
 * the condition. Field map entries follow: a `when` on the claim type is settled the same way, an entry whose answer
 * is no longer asked becomes `source: 'none'`. The generic file (claimTypes null) gives one row and keeps its
 * conditions, because its claim type is only known at run time.
 */
export function expandRows(input: ClaimFormFile | z.input<typeof ClaimFormFileSchema>): ClaimForm[] {
  const file = ClaimFormFileSchema.parse(input); // defaults (no questionGroups means none) for a file read as plain JSON
  const common = { provider: file.provider, formPdf: file.formPdf, active: file.active };
  if (file.claimTypes === null) {
    return [ClaimFormSchema.parse({
      ...common, claimType: null,
      notificationPeriodDays: typeof file.notificationPeriodDays === 'number' ? file.notificationPeriodDays : DEFAULT_NOTIFICATION_DAYS,
      sapsCaseRequired: file.sapsCaseRequired === true,
      questionList: file.questionList, questionGroups: file.questionGroups, fieldMap: file.fieldMap,
    })];
  }
  return file.claimTypes.map((claimType) => {
    const settle = (c: Condition | undefined): 'keep' | 'drop' | 'clear' =>
      c === undefined || c.key !== CLAIM_TYPE_SOURCE ? 'keep' : matches(c, claimType) ? 'clear' : 'drop';

    // File-only claimTypes: keep what belongs to this claim type, without the property.
    const forType = <T extends { claimTypes?: string[] }>(xs: T[]): Omit<T, 'claimTypes'>[] =>
      xs.filter((x) => !x.claimTypes || x.claimTypes.includes(claimType)).map(({ claimTypes: _, ...x }) => x);
    const fileQuestions = forType(file.questionList);
    const fileMap = forType(file.fieldMap);

    // Drop what this claim type rules out, until nothing changes: a question or group on another claim type, one whose
    // condition tests an answer that is itself dropped, a question in a dropped group. Order doesn't matter here, so a
    // condition on a later question is not dropped silently: it stays for the validator to name. Only keys the file
    // has count as dropped (a misspelt key stays too), and a key declared per claim type counts while one is kept.
    const fileKeys = new Set(file.questionList.map((q) => q.key));
    const fileGroups = new Set(file.questionGroups.map((g) => g.key));
    const keptQuestions = new Set(fileQuestions.filter((q) => settle(q.onlyIf) !== 'drop'));
    const keptGroups = new Set(forType(file.questionGroups).filter((g) => settle(g.onlyIf) !== 'drop'));
    const dropped = (key: string) => fileKeys.has(key) && ![...keptQuestions].some((q) => q.key === key);
    const ruledOut = (c: Condition | undefined) => !!c && settle(c) === 'keep' && dropped(c.key);
    for (let changed = true; changed;) {
      changed = false;
      for (const g of keptGroups) if (ruledOut(g.onlyIf)) { keptGroups.delete(g); changed = true; }
      const groupKept = (key: string) => !fileGroups.has(key) || [...keptGroups].some((g) => g.key === key);
      for (const q of keptQuestions) {
        if (ruledOut(q.onlyIf) || (q.group !== undefined && !groupKept(q.group))) { keptQuestions.delete(q); changed = true; }
      }
    }
    const clear = <T extends { onlyIf?: Condition }>(x: T): T => (settle(x.onlyIf) === 'clear' ? { ...x, onlyIf: undefined } : x);
    const questionList: QuestionItem[] = fileQuestions.filter((q) => keptQuestions.has(q)).map(clear);
    const groups = [...keptGroups].map(clear);

    const reason = `Not asked on a ${claimType} claim`;
    // An entry whose `when` is this claim type becomes the box's fallback for this row, replacing the file's fallback.
    const claimTypeBoxes = new Set(fileMap.filter((e) => settle(e.when) === 'clear').flatMap(boxesOf));
    const fieldMap: FieldMapEntry[] = [];
    for (const e of fileMap) {
      const s = settle(e.when);
      if (s === 'drop') continue;
      if (s === 'keep' && e.when && dropped(e.when.key)) continue;
      if (s === 'keep' && !e.when && boxesOf(e).some((b) => claimTypeBoxes.has(b))) continue;
      const entry = s === 'clear' ? { ...e, when: undefined } : e;
      const ref = answerRef(entry.source);
      fieldMap.push(ref && dropped(ref.key)
        ? {
          target: entry.target, source: 'none', label: entry.label, reason,
          ...(entry.when ? { when: entry.when } : {}), ...(entry.overflow ? { overflow: entry.overflow } : {}),
        }
        : entry);
    }
    // A box whose every entry was dropped still needs one, so the coverage check holds.
    const covered = new Set(fieldMap.flatMap(boxesOf));
    for (const e of file.fieldMap) {
      if (!('pdfField' in e.target) || boxesOf(e).every((b) => covered.has(b))) continue;
      fieldMap.push({ target: e.target, source: 'none', label: e.label, reason, ...(e.overflow ? { overflow: e.overflow } : {}) });
      boxesOf(e).forEach((b) => covered.add(b));
    }

    const days = file.notificationPeriodDays;
    return ClaimFormSchema.parse({
      ...common, claimType,
      notificationPeriodDays: typeof days === 'number' ? days : days?.[claimType] ?? DEFAULT_NOTIFICATION_DAYS,
      sapsCaseRequired: Array.isArray(file.sapsCaseRequired) ? file.sapsCaseRequired.includes(claimType) : file.sapsCaseRequired,
      questionList, questionGroups: groups.filter((g) => questionList.some((q) => q.group === g.key)), fieldMap,
    });
  });
}

/** Checks on one riivo_claimform row (TTTFG-5251 step 5). Every problem is listed, each naming what is wrong. */
export function validateClaimForm(input: unknown, ctx: ValidationContext): ValidationResult {
  const parsed = ClaimFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `shape: ${i.path.join('.') || '(row)'}: ${i.message}`) };
  }
  const row = parsed.data;
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  // The row itself.
  if (row.provider === null) {
    if (row.claimType !== null) err(`generic row: claimType must be empty (it serves every claim type), not "${row.claimType}"`);
    if (row.formPdf !== null) err('generic row: formPdf must be empty (it produces a summary sheet)');
    if (row.fieldMap.length) err('generic row: fieldMap must be empty (there is no PDF to fill)');
  } else {
    if (row.claimType === null) err('a row with a provider needs a claim type');
    else if (!ctx.claimTypes.includes(row.claimType)) err(`claimType "${row.claimType}" is not a riivo_claimtype value (${ctx.claimTypes.join(', ')})`);
    if (row.formPdf === null) err('a row with a provider needs formPdf');
  }

  const crmOk = (source: string): boolean => {
    const m = /^crm:([a-z_]+)\.([a-z0-9_]+)$/.exec(source);
    return !!m && (ctx.crmColumns[m[1]] ?? []).includes(m[2]);
  };

  // Questions: unique keys, evidence types, choices, groups, conditions on earlier keys.
  const questions = new Map<string, QuestionItem>();
  const groups = new Map(row.questionGroups.map((g) => [g.key, g]));
  const usedGroups = new Set<string>();
  const seenGroupKeys = new Set<string>();
  for (const g of row.questionGroups) {
    if (seenGroupKeys.has(g.key)) err(`group "${g.key}" is declared twice`);
    seenGroupKeys.add(g.key);
  }

  const checkCondition = (where: string, c: Condition, earlier: Map<string, QuestionItem>, allowGrouped?: string) => {
    if (c.key.startsWith('crm:')) {
      if (!crmOk(c.key)) err(`${where}: condition on "${c.key}", which is not a CRM column`);
      if (c.key === CLAIM_TYPE_SOURCE) {
        for (const v of c.oneOf ?? [c.equals]) {
          if (typeof v !== 'string' || !ctx.claimTypes.includes(v)) err(`${where}: condition on the claim type "${String(v)}", which is not a riivo_claimtype value`);
        }
      }
      return;
    }
    const q = earlier.get(c.key);
    if (!q) {
      err(`${where}: condition on "${c.key}", which is not an earlier question key`);
      return;
    }
    if (q.group !== undefined && q.group !== allowGrouped) err(`${where}: condition on "${c.key}", which is in group "${q.group}"`);
    for (const v of c.oneOf ?? [c.equals]) {
      if (q.answerType === 'choice' && !(q.choices ?? []).includes(String(v))) err(`${where}: condition value "${String(v)}" is not one of the choices of "${c.key}"`);
      if (q.answerType === 'yes/no' && typeof v !== 'boolean') err(`${where}: condition on yes/no question "${c.key}" must test true or false`);
    }
  };

  // A group's condition may test a CRM value or a question asked before the group's first question.
  const groupChecked = new Set<string>();
  for (const g of row.questionGroups) {
    if (g.onlyIf?.key.startsWith('crm:')) { checkCondition(`group "${g.key}"`, g.onlyIf, new Map(), undefined); groupChecked.add(g.key); }
  }

  for (const q of row.questionList) {
    const where = `question "${q.key}"`;
    const g = q.group !== undefined ? groups.get(q.group) : undefined;
    if (g && !groupChecked.has(g.key)) {
      groupChecked.add(g.key);
      if (g.onlyIf) checkCondition(`group "${g.key}"`, g.onlyIf, questions, undefined);
    }
    if (questions.has(q.key)) err(`${where}: the key is used twice`);
    if (groups.has(q.key)) err(`${where}: the key is also a group key`);
    if (q.kind === 'evidence' && !MEDIA.has(q.answerType)) err(`${where}: an evidence item must be a photo, document or video, not "${q.answerType}"`);
    if (q.kind === 'question' && MEDIA.has(q.answerType)) err(`${where}: a ${q.answerType} is evidence; set kind "evidence"`);
    if (q.answerType === 'choice' && !(q.choices && q.choices.length >= 2)) err(`${where}: a choice question needs at least two choices`);
    if (q.answerType !== 'choice' && q.choices) err(`${where}: only a choice question has choices`);
    if (q.group !== undefined) {
      if (!groups.has(q.group)) err(`${where}: group "${q.group}" is not declared in questionGroups`);
      usedGroups.add(q.group);
    }
    // A grouped question may depend on an earlier question in its own group (same entry) or an ungrouped one.
    if (q.onlyIf) checkCondition(where, q.onlyIf, questions, q.group);
    questions.set(q.key, q);
  }
  for (const g of row.questionGroups) if (!usedGroups.has(g.key)) err(`group "${g.key}" has no questions`);

  // Field map: sources, conditions, formats; then PDF coverage.
  const fieldKinds = new Map((ctx.pdf?.fields ?? []).map((f) => [f.name, f.kind]));
  const entriesPerField = new Map<string, FieldMapEntry[]>();
  row.fieldMap.forEach((e, i) => {
    const t = e.target;
    const name = 'pdfField' in t ? `"${t.pdfField}"` : `${e.label ?? '(no label)'} (page ${t.page})`;
    const where = `field ${name} [${i}]`;

    if (e.source === 'none') {
      if (!e.reason) err(`${where}: source "none" needs a reason (office use, signature, broker section, ...)`);
    } else if (e.source.startsWith('crm:')) {
      if (!crmOk(e.source)) err(`${where}: "${e.source}" is not a CRM column`);
    } else if (e.source.startsWith('fixed:')) {
      // TTTFG-4830: the same value on every claim; the reason says why it is always true.
      if (!e.reason) err(`${where}: source "fixed:" needs a reason (why the value is the same on every claim)`);
      if (e.source === 'fixed:') err(`${where}: source "fixed:" needs a value`);
    } else {
      const ref = answerRef(e.source)!;
      // A grouped key needs an entry number (answer:item.2); a plain key must not have one.
      const plain = questions.get(e.source.slice('answer:'.length));
      const q = plain ?? questions.get(ref.key);
      if (!q) err(`${where}: "${e.source}" names question key "${e.source.slice('answer:'.length)}", which is not in the question list`);
      else if (q.group !== undefined) {
        const max = groups.get(q.group)?.max ?? 0;
        if (plain || ref.entry === undefined) err(`${where}: "${e.source}" is in group "${q.group}"; use answer:${q.key}.<1-${max}>`);
        else if (ref.entry < 1 || ref.entry > max) err(`${where}: "${e.source}" is entry ${ref.entry}, but group "${q.group}" has ${max}`);
      } else if (!plain) err(`${where}: "${e.source}" names question key "${e.source.slice('answer:'.length)}", which is not in the question list`);
      if (q && q.kind === 'evidence') err(`${where}: "${e.source}" is an evidence item; evidence goes in the pack, not on the form`);
      if (q && e.format === 'tick' && e.tickWhen !== undefined) {
        if (q.answerType === 'choice' && !(q.choices ?? []).includes(String(e.tickWhen))) err(`${where}: tickWhen "${String(e.tickWhen)}" is not one of the choices of "${q.key}"`);
        if (q.answerType === 'yes/no' && typeof e.tickWhen !== 'boolean') err(`${where}: tickWhen on yes/no question "${q.key}" must be true or false`);
      }
    }
    if (e.when) checkCondition(where, e.when, questions);
    if (e.format === 'tick' && e.tickWhen === undefined && e.source !== 'none') err(`${where}: a tick needs tickWhen`);
    if (e.format === 'char' && e.charIndex === undefined) err(`${where}: format "char" needs charIndex`);

    if ('pdfField' in t) {
      const kind = fieldKinds.get(t.pdfField);
      if (!ctx.pdf) err(`${where}: the row has no PDF`);
      else if (kind === undefined) err(`${where}: the PDF has no field "${t.pdfField}"`);
      else {
        if (kind === 'checkbox' && e.source !== 'none' && e.format !== 'tick') err(`${where}: a checkbox needs format "tick"`);
        if (kind !== 'checkbox' && e.format === 'tick') err(`${where}: format "tick" on a ${kind} field`);
        if (kind === 'signature' && e.source !== 'none') err(`${where}: a signature field is stamped by the signing page; use source "none"`);
      }
      for (const box of boxesOf(e)) entriesPerField.set(box, [...(entriesPerField.get(box) ?? []), e]);
      for (const box of e.overflow ?? []) {
        const k = fieldKinds.get(box);
        if (ctx.pdf && k === undefined) err(`${where}: overflow field "${box}" is not in the PDF`);
        else if (k !== undefined && k !== 'text') err(`${where}: overflow field "${box}" is a ${k} field, not text`);
      }
    } else {
      if (e.overflow) err(`${where}: overflow is for AcroForm fields; a position wraps within maxWidth and height`);
      if (!e.label) err(`${where}: a position needs a label`);
      const page = ctx.pdf?.pages[t.page - 1];
      if (!ctx.pdf) err(`${where}: the row has no PDF`);
      else if (!page) err(`${where}: page ${t.page} is past the end of the PDF (${ctx.pdf.pages.length} pages)`);
      else {
        const right = t.x + (t.maxWidth ?? 0);
        if (t.x < 0 || t.y < 0 || right > page.width || t.y > page.height) err(`${where}: position ${t.x},${t.y} is outside the page (${page.width}x${page.height})`);
        if (t.height !== undefined && t.y + (t.size ?? 10) - t.height < 0) err(`${where}: the box runs off the bottom of the page`);
      }
    }
  });

  // Every PDF field has exactly one entry: one unconditional entry, or conditional entries plus at most one fallback.
  for (const [name] of fieldKinds) {
    const entries = entriesPerField.get(name) ?? [];
    const fallbacks = entries.filter((e) => !e.when).length;
    if (entries.length === 0) err(`field "${name}": no field map entry (map it, or use source "none" with a reason)`);
    else if (fallbacks > 1) err(`field "${name}": ${fallbacks} entries without a condition; a box has one`);
  }

  return { ok: errors.length === 0, errors };
}

/** Checks a whole config file: its own settings, then every row it expands to. Errors name the row's claim type. */
export function validateClaimFormFile(input: unknown, ctx: ValidationContext): ValidationResult {
  const parsed = ClaimFormFileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `shape: ${i.path.join('.') || '(file)'}: ${i.message}`) };
  }
  const file = parsed.data;
  const errors: string[] = [];
  const types = file.claimTypes ?? [];
  for (const t of types) if (!ctx.claimTypes.includes(t)) errors.push(`claimTypes: "${t}" is not a riivo_claimtype value`);
  if (new Set(types).size !== types.length) errors.push('claimTypes: a claim type is listed twice');
  if (Array.isArray(file.sapsCaseRequired)) {
    for (const t of file.sapsCaseRequired) if (!types.includes(t)) errors.push(`sapsCaseRequired: "${t}" is not one of this form's claim types`);
  }
  if (file.notificationPeriodDays && typeof file.notificationPeriodDays === 'object') {
    for (const t of Object.keys(file.notificationPeriodDays)) if (!types.includes(t)) errors.push(`notificationPeriodDays: "${t}" is not one of this form's claim types`);
  }
  const tagged: [string, { claimTypes?: string[] }][] = [
    ...file.questionList.map((q) => [`question "${q.key}"`, q] as [string, { claimTypes?: string[] }]),
    ...file.questionGroups.map((g) => [`group "${g.key}"`, g] as [string, { claimTypes?: string[] }]),
    ...file.fieldMap.map((e, i) => [`field ${'pdfField' in e.target ? `"${e.target.pdfField}"` : e.label ?? '(no label)'} [${i}]`, e] as [string, { claimTypes?: string[] }]),
  ];
  for (const [where, x] of tagged) {
    if (!x.claimTypes) continue;
    if (file.claimTypes === null) errors.push(`${where}: claimTypes on the generic list, which serves every claim type`);
    else for (const t of x.claimTypes) if (!types.includes(t)) errors.push(`${where}: claimTypes "${t}" is not one of this form's claim types`);
  }
  // A key declared twice is the same question asked differently per claim type: the declarations may not overlap.
  const declared = new Map<string, (string[] | undefined)[]>();
  for (const q of file.questionList) declared.set(q.key, [...(declared.get(q.key) ?? []), q.claimTypes]);
  for (const [key, decls] of declared) {
    if (decls.length < 2) continue;
    const seen = new Set<string>();
    const overlap = decls.some((ts) => !ts || ts.some((t) => (seen.has(t) ? true : (seen.add(t), false))));
    if (overlap) errors.push(`question "${key}": declared ${decls.length} times; each declaration needs claimTypes that don't overlap`);
  }
  if (errors.length) return { ok: false, errors };
  for (const row of expandRows(file)) {
    const r = validateClaimForm(row, ctx);
    errors.push(...r.errors.map((e) => `${row.claimType ?? 'generic'}: ${e}`));
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The row for a claim: the active row for the insurer and claim type, else the active generic row (summary sheet and
 * evidence only, SPEC-04 "Claim forms"). Null when there is neither.
 */
export function pickClaimForm(rows: readonly ClaimForm[], provider: string, claimType: string): ClaimForm | null {
  return rows.find((r) => r.active && r.provider === provider && r.claimType === claimType)
    ?? rows.find((r) => r.active && r.provider === null)
    ?? null;
}

// ---------------------------------------------------------------- riivo_claimform columns (TTTFG-5251 step 8)
//
// How a row is stored in Dataverse, and read back. The loader (scripts/claimforms) writes these columns from the config
// files; the agent and the DEV check read them back with fromColumns(), so a row edited by hand in the CRM is checked the
// same way as a file. The JSON is written one item per line so the Claim form page in the CRM stays readable.

/** riivo_claimform as the loader writes it. Lookups and choices are by name; the loader resolves them to ids. */
export interface ClaimFormColumns {
  riivo_name: string;
  /** riivo_provider.riivo_providername; null on the generic row. */
  provider: string | null;
  /** riivo_claimtype label; null on the generic row. */
  claimType: string | null;
  /** SharePoint link to the blank PDF; null on the generic row. */
  riivo_formurl: string | null;
  /** `{ questionGroups, questionList }`: every question and evidence item, in the order Tina asks them. */
  riivo_questionlist: string;
  /** The evidence items of the question list (key, prompt, type, required), for the broker. Derived, never edited. */
  riivo_evidencechecklist: string;
  riivo_fieldmap: string;
  riivo_notificationperioddays: number;
  riivo_sapscaserequired: boolean;
  /** statecode 0. */
  active: boolean;
}

/** JSON with one array item per line: `[\n  {...},\n  {...}\n]`. */
const linesJson = (xs: readonly unknown[]): string => (xs.length ? `[\n${xs.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n]` : '[]');

/** The row name: the form's name, then the claim type ("Momentum motor - Windscreen"). */
export const rowName = (formName: string, claimType: string | null): string => (claimType ? `${formName} - ${claimType}` : formName);

/** The evidence checklist column: the evidence items of a question list. */
export const evidenceChecklist = (questions: readonly QuestionItem[]) => questions
  .filter((q) => q.kind === 'evidence')
  .map((q) => ({ key: q.key, prompt: q.prompt, answerType: q.answerType, required: q.required, ...(q.onlyIf ? { onlyIf: q.onlyIf } : {}) }));

/** A row's columns. `formUrl` is the SharePoint link to the blank PDF (the loader builds it from the library URL). */
export function toColumns(form: ClaimForm, formName: string, formUrl: string | null): ClaimFormColumns {
  const groups = form.questionGroups.length ? `  "questionGroups": ${linesJson(form.questionGroups).replace(/\n/g, '\n  ')},\n` : '';
  return {
    riivo_name: rowName(formName, form.claimType),
    provider: form.provider,
    claimType: form.claimType,
    riivo_formurl: formUrl,
    riivo_questionlist: `{\n${groups}  "questionList": ${linesJson(form.questionList).replace(/\n/g, '\n  ')}\n}`,
    riivo_evidencechecklist: linesJson(evidenceChecklist(form.questionList)),
    riivo_fieldmap: linesJson(form.fieldMap),
    riivo_notificationperioddays: form.notificationPeriodDays,
    riivo_sapscaserequired: form.sapsCaseRequired,
    active: form.active,
  };
}

/** A saved row as the check and the agent read it: the columns above, as Dataverse returns them. */
export interface SavedClaimFormRow {
  riivo_name: string;
  provider: string | null;
  claimType: string | null;
  riivo_formurl: string | null;
  riivo_questionlist: string | null;
  riivo_evidencechecklist: string | null;
  riivo_fieldmap: string | null;
  riivo_notificationperioddays: number | null;
  riivo_sapscaserequired: boolean | null;
  active: boolean;
}

/**
 * A saved row back into the contract shape, for validateClaimForm(). Unreadable JSON is not guessed at: the column is
 * named in `errors` and read as empty, so the validator still lists everything else that is wrong.
 */
export function fromColumns(row: SavedClaimFormRow): { form: unknown; errors: string[] } {
  const errors: string[] = [];
  const parse = (column: string, text: string | null): unknown => {
    if (text === null || text.trim() === '') return undefined;
    try { return JSON.parse(text); } catch (e) { errors.push(`${column}: not valid JSON (${(e as Error).message})`); return undefined; }
  };
  const ql = parse('riivo_questionlist', row.riivo_questionlist);
  // A bare array is a question list without groups.
  const lists = Array.isArray(ql) ? { questionList: ql } : (ql ?? {}) as { questionList?: unknown; questionGroups?: unknown };
  const form = {
    provider: row.provider,
    claimType: row.claimType,
    formPdf: row.riivo_formurl,
    notificationPeriodDays: row.riivo_notificationperioddays ?? undefined,
    sapsCaseRequired: row.riivo_sapscaserequired ?? false,
    active: row.active,
    questionList: lists.questionList ?? [],
    questionGroups: lists.questionGroups ?? [],
    fieldMap: parse('riivo_fieldmap', row.riivo_fieldmap) ?? [],
  };
  // The evidence checklist is derived; a hand edit that drifts from the question list is named.
  const saved = parse('riivo_evidencechecklist', row.riivo_evidencechecklist);
  const parsedList = z.array(QuestionItemSchema).safeParse(form.questionList);
  if (parsedList.success && saved !== undefined && JSON.stringify(saved) !== JSON.stringify(evidenceChecklist(parsedList.data))) {
    errors.push('riivo_evidencechecklist: does not match the evidence items in the question list (re-run the loader)');
  }
  return { form, errors };
}
