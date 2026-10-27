// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/contracts.ts (commit fb95cdd). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// Shared types for the claims stories that build on TTTFG-5168: the claim form config (TTTFG-5172), the client's
// saved answers (TTTFG-5176) and the signing seam between TTTFG-5176 and TTTFG-5192.
//
// TTTFG-5172 owns this file: other stories read it and ask before changing it, so parallel branches merge cleanly.
//
// The claim form shapes follow TTTFG-5251 steps 3 and 4. A form is config, not code (SPEC-01 user story 36): one
// riivo_claimform row per insurer form and claim type, with the question list (what Tina asks, in order) and the field
// map (which answer or CRM column fills which box). The zod schemas let the validator parse the JSON as stored.
//
// Refined by TTTFG-5172 after mapping the 8 go-live PDFs (all additions are optional, so the base shapes still parse):
// - Conditions (`onlyIf`, `when`) may test a CRM value as well as an earlier answer, and may list several values
//   (`oneOf`). The walkthrough already holds third parties, SAPS and the claim type on riivo_claim; Tina must not ask
//   them again just so a later question can depend on them.
// - Repeating groups: the property forms have item tables and the motor forms have third-party blocks. A grouped
//   question is asked once per entry, up to the group's `max`, and its answers are saved as `<key>.<n>` (1-based), so
//   ClaimAnswers stays a flat record and the fill reads `answer:<key>.<n>` like any other key.
// - Field map entries can be conditional (`when`): the driver's ID number comes from the CRM when the client drove,
//   and from an answer when someone else did. Tina never asks a client for their own ID number (TTTFG-5168).
// - Formats `yesno` (a boolean as "Yes"/"No" in a text box) and `char` (one character of the value, for Momentum's
//   one-box-per-digit ID number), and `height` on a position target for the flat Hybrid forms' multi-line boxes.
// - `overflow`: a long answer that Discovery prints as several one-line fields fills them in order.
// - The generic row (no provider) has no claim type either: it serves every claim type an unmapped insurer gets.
//
// Added by TTTFG-5196 (optional, so rows loaded before it still parse): `sign` and `dateFormat` on a field map entry,
// the boxes the signing page stamps.
import { z } from 'zod';

/** TTTFG-5251 step 3: how an answer is captured. Evidence items are photo, document or video. */
export const ANSWER_TYPES = ['text', 'date', 'number', 'yes/no', 'choice', 'photo', 'document', 'video'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * A test on an earlier answer (a question key) or a CRM value (`crm:<table>.<column>`, for example
 * `crm:riivo_claim.riivo_claimtype`). Exactly one of `equals` or `oneOf`.
 */
export const ConditionSchema = z
  .object({ key: z.string().min(1), equals: ScalarSchema.optional(), oneOf: z.array(ScalarSchema).min(1).optional() })
  .refine((c) => (c.equals === undefined) !== (c.oneOf === undefined), { message: 'a condition needs exactly one of equals or oneOf' });
export type Condition = z.infer<typeof ConditionSchema>;

/** One question or evidence item on a form's question list. */
export const QuestionItemSchema = z.object({
  /** Unique within the form; `answer:<key>` in the field map points here (`answer:<key>.<n>` for a grouped question). */
  key: z.string().min(1),
  kind: z.enum(['question', 'evidence']),
  /** Plain-language text Tina asks. Claude may make it simpler, never more technical. */
  prompt: z.string().min(1),
  /**
   * What Tina calls the item when it arrives: "Thanks, I've got the settlement letter." Optional (added by TTTFG-5176
   * for the evidence items); without it the name comes from the prompt.
   */
  name: z.string().min(1).optional(),
  answerType: z.enum(ANSWER_TYPES),
  required: z.boolean(),
  /** For answerType 'choice'. */
  choices: z.array(z.string()).optional(),
  /** Ask only when an earlier answer, or a CRM value, matches. */
  onlyIf: ConditionSchema.optional(),
  /** The repeating group this question belongs to (see QuestionGroup). */
  group: z.string().min(1).optional(),
  /**
   * TTTFG-4830 (batches): the topic, in words that follow "A few questions about" ("your car", "the other car"). Tina
   * asks the open questions of one section together, up to five in a numbered list, in the list's order. A question
   * without a section is asked on its own, as before.
   */
  section: z.string().min(1).optional(),
  /**
   * TTTFG-4830: an evidence item's number of files: 2 for the front and back of a licence, 'any' for photos of the
   * scene (Tina asks whether that's all of them). Absent: worked out from the prompt (progress.ts fileCount).
   */
  count: z.union([z.number().int().min(1).max(10), z.literal('any')]).optional(),
  /**
   * TTTFG-4830 (still need): the client can get this (it's written down somewhere they can look: the registration
   * papers, the SAPS slip, a bank statement) and the form can't go without it. A required question only; a required
   * evidence item is always chased. "I don't know" makes it "not yet" rather than the broker's, and it stays on
   * "Things we still need from you" and the morning reminder until it's in. Give it a `name`: that is how the list
   * shows it. A required question without `chase` (who did it, how fast the car was going) goes to the broker as before.
   */
  chase: z.boolean().optional(),
});
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

/**
 * A set of questions asked once per entry (an item lost, a third party, a witness). Tina asks the group's questions
 * for entry 1, then asks `more` ("Is there another …?") until the client says no or `max` is reached. The form has
 * `max` rows, so `max` is the number of rows printed on the PDF.
 */
export const QuestionGroupSchema = z.object({
  key: z.string().min(1),
  /** The "is there another one?" question, asked after each entry. */
  more: z.string().min(1),
  max: z.number().int().min(1),
  /** Ask the group at all only when this holds (for example third parties involved). */
  onlyIf: ConditionSchema.optional(),
});
export type QuestionGroup = z.infer<typeof QuestionGroupSchema>;

/**
 * Where a value goes: a named AcroForm field, or a position on a flat PDF (points from the bottom-left, 1-based page;
 * x, y is the baseline of the first line). `maxWidth` wraps the text; `height` is the box height the wrapped text must
 * fit in (shrink the font when it does not). A `tick` on a position target draws an "X".
 */
export const FieldTargetSchema = z.union([
  z.object({ pdfField: z.string().min(1) }),
  z.object({
    page: z.number().int().min(1), x: z.number(), y: z.number(),
    size: z.number().optional(), maxWidth: z.number().optional(), height: z.number().optional(),
  }),
]);
export type FieldTarget = z.infer<typeof FieldTargetSchema>;

/** `crm:<table>.<column>`, `answer:<key>`, or `none` (office use, signature, broker section: say why in `reason`). */
export const FieldSourceSchema = z.union([
  z.string().regex(/^crm:[a-z_]+\.[a-z0-9_]+$/),
  z.string().regex(/^answer:[A-Za-z0-9_.-]+$/),
  /** TTTFG-4830: the same value on every claim of the form; the entry's `reason` says why ("Natural person"). */
  z.string().regex(/^fixed:.+$/),
  z.literal('none'),
]);
export type FieldSource = z.infer<typeof FieldSourceSchema>;

/**
 * Value formats. date dd/mm/yyyy, time HH:mm, datetime both, currency in rand (R 12 345.00), yesno a boolean as
 * "Yes"/"No", char the single character at `charIndex` (0-based) of the value, tick sets a checkbox (or draws an "X"
 * on a flat form) when the value equals `tickWhen`.
 */
export const FORMATS = ['text', 'date', 'time', 'datetime', 'currency', 'tick', 'yesno', 'char'] as const;

/** TTTFG-5251 step 4: one box on the form and what fills it. */
export const FieldMapEntrySchema = z.object({
  target: FieldTargetSchema,
  source: FieldSourceSchema,
  format: z.enum(FORMATS).optional(),
  tickWhen: ScalarSchema.optional(),
  charIndex: z.number().int().min(0).optional(),
  /**
   * More AcroForm text fields, in order, that the text continues into when it does not fit the target field: the
   * forms print a long answer (description of the accident) as several one-line fields. pdfField targets only. The
   * listed fields belong to this entry and have no entry of their own.
   */
  overflow: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Use this entry only when the condition holds. A box may have several `when` entries plus at most one entry without
   * `when` (the fallback); the fill uses the first entry whose condition holds, else the fallback.
   */
  when: ConditionSchema.optional(),
  /** Human label for the blank-fields list and reviews. Required on position targets (they have no field name). */
  label: z.string().optional(),
  reason: z.string().optional(),
  /**
   * TTTFG-5196: a box the signing page stamps when the client signs (source `none` only): `signature`, their drawn
   * signature, or `date`, the day they signed. On a flat form a signature's x, y is the start of the line signed on,
   * `maxWidth` its length and `height` the room above it; a date's x, y is where the text sits, as for any value.
   * `dateFormat` prints part of the date, for a form that splits it ("on this __ day of ______ 20__").
   */
  sign: z.enum(['signature', 'date']).optional(),
  dateFormat: z.enum(['date', 'day', 'month', 'yy']).optional(),
});
export type FieldMapEntry = z.infer<typeof FieldMapEntrySchema>;

/**
 * One riivo_claimform row. `provider` is null on the generic row (an insurer with no mapped form), and so are its
 * `claimType` (it serves every claim type) and `formPdf` (it produces a summary sheet).
 */
export const ClaimFormSchema = z.object({
  provider: z.string().nullable(),
  claimType: z.string().min(1).nullable(),
  /** Path or SharePoint link to the blank PDF; null on the generic row. */
  formPdf: z.string().nullable(),
  notificationPeriodDays: z.number().int().positive().default(30),
  sapsCaseRequired: z.boolean(),
  active: z.boolean(),
  questionList: z.array(QuestionItemSchema),
  questionGroups: z.array(QuestionGroupSchema).default([]),
  fieldMap: z.array(FieldMapEntrySchema),
});
export type ClaimForm = z.infer<typeof ClaimFormSchema>;

/** One saved answer in riivo_claim.riivo_answers (TTTFG-5176 step 10). */
export interface AnswerRecord {
  value: string | number | boolean | null;
  /**
   * broker-to-confirm: after two unreadable replies Tina moved on; the form fill (TTTFG-5192) treats this as empty.
   * not-yet (TTTFG-5184): the client said they don't have it yet (an evidence item, an optional question or the SAPS
   * case number); `value` is null. Tina never asks an optional item again, and asks a required one again only when the
   * client comes back, as "Have you got … yet?". The form fill treats it as empty.
   */
  status: 'answered' | 'broker-to-confirm' | 'not-yet';
  /** ISO 8601. */
  at: string;
  /** The Meta message id of the client's reply. */
  wamid?: string;
  /**
   * TTTFG-4830: where the value came from when it wasn't the reply to this question: `report`, what the client said
   * while reporting the claim (before the form's questions); `same-message`, a reply to another question that answered
   * this one too; `correction`, the client changed their earlier answer. Absent: the client's reply to this question.
   */
  source?: 'report' | 'same-message' | 'correction';
  /**
   * TTTFG-4830: the value doesn't look right (formats.ts: a phone number with too many digits, an email without "@",
   * an ID number that fails its check digit). Tina pointed it out and the client sent it again still that way, so it's
   * kept as given, with the reason, for the broker to check.
   */
  doubt?: string;
}
/** riivo_claim.riivo_answers, keyed by question key (`<key>.<n>` for the n-th entry of a grouped question). */
export type ClaimAnswers = Record<string, AnswerRecord>;

/**
 * The seam TTTFG-5176 calls at the end of the conversation, once every item is in or passed over (TTTFG-5196 moved it
 * there from after the last form question). TTTFG-5192 fills and files the form, then calls the signing step
 * (TTTFG-5196). 'sent' moves the claim to Form sent; 'notAvailable' (no signing page yet) leaves the status alone, and
 * the closing line points at no link.
 */
export type SignatureResult = 'sent' | 'notAvailable';
export type RequestClaimSignature = (claimId: string) => Promise<SignatureResult>;
