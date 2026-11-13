// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/guided.ts (commit c765f2e). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5562: the guided claim form. Tina sends one link instead of asking the questions on WhatsApp; the client works
// through the form's question list on their phone, one topic per screen. This file is the form's logic, without the page
// (Tina's src/claimform/): what each screen shows, what's pre-filled, and saving what the client answers.
//
// The answers go exactly where chat answers go (riivo_answers against the question key, the SAPS step's two values on the
// claim), through the same checks (followon.ts accept, formats.ts), so the fill, signing and the claim pack don't know
// which way a claim was answered. What's open is still worked out from the claim record (progress.ts), never stored here.
//
// The client only sees what their own insurer's form asks. The master form (masterforms.ts) groups those questions into
// topics; the screens come in the order the form's list first reaches each topic, and a topic's questions in list order.
import type { ClaimAnswers, AnswerRecord, ClaimForm, Condition, QuestionItem } from './contracts';
import {
  accept, ADDRESS_CHECK_KEY, ADDRESS_KEY, oneLine, QUOTE_ITEMS, type FollowOnClaim, type FollowOnPorts, type ClientFile,
} from './followon';
import { emailProblem, formatProblem, isCaseNumber, phoneProblem } from './formats';
import type { Dv } from './dataverse';
import { DEPARTMENT } from './claim';
import {
  counterKey, evidenceHelp, FORM_CONTROLS, FORM_COUNTERS, FORM_DRAWINGS, formControl, formHint, formNote, formPrompt, formStepper, FORM_STEPPERS, type FormControl,
} from './formcontrols';
import { BURST_KEY, CONTRACTOR_KEY, factColumns, INSURERS_PLUMBER, plumberAsked, plumberDetail, withFacts } from './formfacts';
import { FORM_TERMS } from './templates';
import { masterFormFor, masterPlace, type MasterForm } from './masterforms';
import {
  applies, chased, CLAIM_COLUMN_FACTS, computedTotals, entryWord, deferred, filesFor, formItems, holds, moreKey, phoneFromItems,
  PHONE_OR_TABLET_KEY, SAPS_CASE_KEY, SAPS_STATION_KEY, type ClaimFacts,
} from './progress';

/** The screen of what TTT already holds. Saved against this key once the client has gone past it. */
export const DETAILS_CONFIRMED_KEY = 'guidedDetailsConfirmed';
/** The client agreed to what opens the form (FORM_TERMS). */
export const TERMS_KEY = 'guidedTermsAccepted';
/** An answer that changes a CRM value on the form: `crm:<table>.<column>`. The CRM itself is never written (fill-dataverse.ts). */
export const isDetailKey = (key: string) => key.startsWith('crm:contact.') || key.startsWith('crm:riivo_policy.');

/** A condition the page can test on the answers it holds: all of a field's must hold. `not`: holds unless the value is one of them. */
export interface GuidedCondition { key: string; oneOf: ReadonlyArray<string | number | boolean>; not?: boolean }

export interface GuidedField {
  /** The question key, `<key>.<n>` for the n-th entry of a repeating group. */
  key: string;
  prompt: string;
  /** The question's answer type on the insurer's form: what the saved value must be. */
  type: 'text' | 'number' | 'date' | 'yes/no' | 'choice';
  /** How it's answered on the form (formcontrols.ts). Tapping first; a box only where there's no way round one. */
  control: GuidedControl;
  required: boolean;
  /** What shows in an empty box: the question's example. */
  hint?: string;
  /** A line under the question, for one that needs an example to make sense (formcontrols.ts formNote). */
  note?: string;
  /** Input hints for the phone's keyboard. */
  keyboard?: 'tel' | 'email';
  /** Answered by the group's stepper, so it isn't asked itself: "is there another?" under a count of people. */
  hidden?: boolean;
  when: readonly GuidedCondition[];
  /** Other words for the prompt, the first that holds (contracts.ts variants). */
  variants?: ReadonlyArray<{ when: GuidedCondition; prompt: string }>;
  /** The entry's heading in a repeating group ("Witness 2"). */
  entry?: string;
  /** A person's card under a count of people: the cards stay together on one step, which may scroll. */
  counted?: boolean;
  /** A value from the client's earlier claim, shown filled in for them to confirm. Not an answer until they do. */
  prefill?: string | number | boolean;
}

export interface GuidedScreen { id: string; title: string; help?: string; fields: GuidedField[] }

/** A yes/no, a form's own choices, or one of formcontrols.ts. */
export type GuidedControl = FormControl | { kind: 'yes-no'; label?: string; bare?: boolean } | { kind: 'number'; label?: string };

/** One row of what TTT already holds. */
export interface GuidedDetail { key: string; label: string; value: string; editable: boolean }

export interface GuidedEvidence {
  key: string;
  prompt: string;
  kind: 'photo' | 'document' | 'video';
  required: boolean;
  /** The client can draw it with a finger on the form, as well as add a photo. */
  draw?: boolean;
  when: readonly GuidedCondition[];
  count: number;
  /** Examples of what would help, where it isn't obvious what to send (formcontrols.ts evidenceHelp). */
  help?: string;
  /**
   * The user (13 Nov 2026): a quote the client may not have yet (followon.ts QUOTE_ITEMS). Never required to sign; the
   * page outlines it and shows the badge, and the words say how to send it later, by WhatsApp (`text`) or, on an
   * email claim's form, by email (`textEmail`).
   */
  later?: { badge: string; text: string; textEmail: string };
}

/** The user (13 Nov 2026): the words on a quote the client may send after signing (GuidedEvidence.later). */
export const QUOTE_LATER = {
  badge: 'Needed later',
  text: "Add it now if you have it. If you don't have it yet, you can still sign and submit: just send it to Tina here on WhatsApp "
    + "as soon as you get it. We'll remind you each morning until it's in.",
  textEmail: "Add it now if you have it. If you don't have it yet, you can still sign and submit: just reply to our email with it "
    + "attached, or send it to Tina on WhatsApp, as soon as you get it. We'll remind you each morning until it's in.",
} as const;

export interface GuidedView {
  reference: string;
  title: string;
  insurer: string;
  /** What TTT holds, for the client to confirm or change (AC 3). */
  details: GuidedDetail[];
  detailsConfirmed: boolean;
  /** What opens the form, until the client has agreed to it. */
  terms?: { title: string; lines: readonly string[]; agree: string };
  screens: GuidedScreen[];
  evidence: GuidedEvidence[];
  /** Examples for the "Anything else that may help" row. */
  otherHelp?: string;
  /** Everything known so far, for the conditions and to fill the boxes. */
  answers: Record<string, string | number | boolean>;
  /** Questions the client said they don't know or don't have yet. */
  notKnown: string[];
  /** The screen to open on (AC 5): the first with an unanswered question, `screens.length` for the photos. */
  startAt: number;
  /**
   * The user (9 Nov 2026): the questions that can't be left blank before signing (BEFORE_SIGNING), as this form asks them.
   * The page shows each only when its conditions hold (the case number only when the police were involved).
   */
  beforeSigning: string[];
}

/** What the page needs from the CRM to show what TTT holds (fill-dataverse.ts crmValues). */
export interface GuidedCrm {
  contact: Record<string, string | null | undefined>;
  riivo_policy: Record<string, string | null | undefined>;
}

const DETAILS: ReadonlyArray<{ source: string; label: string; editable: boolean }> = [
  { source: 'crm:contact.fullname', label: 'Full name', editable: true },
  { source: 'crm:contact.firstname', label: 'First name', editable: true },
  { source: 'crm:contact.lastname', label: 'Surname', editable: true },
  { source: 'crm:riivo_policy.riivo_policy_no', label: 'Policy number', editable: true },
  { source: 'crm:contact.mobilephone', label: 'Cellphone', editable: true },
  { source: 'crm:contact.telephone1', label: 'Other number', editable: true },
  { source: 'crm:contact.emailaddress1', label: 'Email', editable: true },
];
const ADDRESS_LABEL = 'Home address';
/** The Discovery form prints the broker, so the client sees it; it isn't theirs to change. */
const BROKER = { source: 'crm:riivo_policy.riivo_broker', label: 'Broker' };

const KEYBOARD: ReadonlyArray<[RegExp, GuidedField['keyboard']]> = [[/phone|cell|mobile|contactnumber/i, 'tel'], [/email/i, 'email']];
const keyboardFor = (key: string) => KEYBOARD.find(([re]) => re.test(key))?.[1];

const factsOf = (claim: FollowOnClaim): ClaimFacts => ({
  ...claim.facts, claimType: claim.claimType, sapsCaseNumber: claim.sapsCaseNumber || undefined, sapsStation: claim.sapsStation || undefined,
});

const isSaps = (key: string) => key === SAPS_CASE_KEY || key === SAPS_STATION_KEY;

/** The value the claim already holds for a question: the walkthrough's facts and the SAPS step are never asked twice. */
const factFor = (key: string, facts: ClaimFacts) => {
  const v = (facts as Record<string, unknown>)[key];
  return v === undefined || v === null || v === '' ? undefined : (v as string | number | boolean);
};

/**
 * Every entry of every repeating group, with what shows it. progress.ts formItems stops at the first "is there another?"
 * nobody has answered; here each one is said to be yes, so the page holds them all and shows the next entry the moment
 * the client says yes, with no trip to the server.
 */
function allEntries(form: ClaimForm, facts: ClaimFacts, sapsRequired: boolean) {
  const groups = form.questionGroups ?? [];
  const yes: ClaimAnswers = {};
  for (const g of groups) for (let n = 1; n < g.max; n++) yes[moreKey(g.key, n)] = { value: true, status: 'answered', at: '' };
  const open = { ...form, questionGroups: groups.map(({ onlyIf: _o, ...g }) => g) };
  return formItems(open, yes, facts, sapsRequired);
}

/** A condition as the page tests it, or true / false when only the claim's own columns decide it. */
function pageCondition(c: Condition, facts: ClaimFacts): GuidedCondition | boolean {
  // The claim's own columns that the form itself asks for are tested on the answer, so the next question shows on the tap.
  const fact = c.key.startsWith('crm:') ? CLAIM_COLUMN_FACTS[c.key] : c.key;
  if (fact && fact !== 'claimType') return { key: fact, oneOf: c.oneOf ?? [c.equals!] };
  if (c.key.startsWith('crm:')) return holds(c, {}, facts);
  return { key: c.key, oneOf: c.oneOf ?? [c.equals!] };
}

/** The conditions that show a question, or null when the claim's own columns already rule it out. */
function conditionsFor(item: QuestionItem, form: ClaimForm, facts: ClaimFacts): GuidedCondition[] | null {
  const group = item.group ? (form.questionGroups ?? []).find((g) => g.key === item.group) : undefined;
  const entry = group ? Number(/\.(\d+)$/.exec(item.key)?.[1] ?? 0) : 0;
  const isMore = group ? item.key.startsWith(`${group.key}.more.`) : false;
  const n = isMore ? Number(item.key.split('.').pop()) : entry;
  const raw: Condition[] = [item.onlyIf, item.andIf, group?.onlyIf].filter((c): c is Condition => !!c);
  // Entry n shows once the client said there's another after entry n-1, which shows the same way.
  if (group && n > 1) raw.push({ key: moreKey(group.key, n - 1), equals: true });
  const out: GuidedCondition[] = [];
  for (const c of raw) {
    const p = pageCondition(c, facts);
    if (p === false) return null;
    if (p !== true) out.push(p);
  }
  return out;
}

const fieldType = (item: QuestionItem): GuidedField['type'] =>
  item.answerType === 'number' || item.answerType === 'date' || item.answerType === 'yes/no' || item.answerType === 'choice' ? item.answerType : 'text';

/** How a question is answered: the form's own choices or yes/no as they are, anything else as formcontrols.ts says. */
function controlFor(item: QuestionItem, baseKey: string, master: MasterForm, claimType?: string): GuidedControl {
  if (item.answerType === 'yes/no') return { kind: 'yes-no' };
  if (item.answerType === 'choice') return { kind: 'pills', options: item.choices ?? [] };
  const c = formControl(master.id, baseKey, claimType);
  if (c) return c;
  return item.answerType === 'date' ? { kind: 'date' } : item.answerType === 'number' ? { kind: 'number' } : { kind: 'short' };
}
/** The control formPrompt words the question for; a yes/no or a plain number keeps its words. */
const wordedFor = (c: GuidedControl): FormControl | undefined => (c.kind === 'yes-no' || c.kind === 'number' ? undefined : c);

const ORDINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "Was another car or person involved, other than the one mentioned already?" */
const anotherPrompt = (more: string, n: number) =>
  `${more.replace(/[?.\s]+$/, '')}, other than the ${ORDINAL[n - 1] ?? n} mentioned already?`;

/** "witnesses" -> "Witness 2". */
function entryHeading(group: string, n: number): string {
  const one = group === 'injured' ? 'person hurt' : entryWord(group);
  return `${one.charAt(0).toUpperCase()}${one.slice(1)} ${n}`;
}

/**
 * The value of a question from the client's earlier claims: the most recent answer under any of the master field's names,
 * only for the vehicle or property itself, and only a value this form's question takes.
 */
function earlierValue(item: QuestionItem, master: MasterForm, earlier: readonly ClaimAnswers[]) {
  const field = masterPlace(master, item.key)?.field;
  if (!field?.prefill) return undefined;
  for (const answers of earlier) {
    for (const k of field.keys) {
      const a = answers[k];
      if (a?.status !== 'answered' || a.value === null) continue;
      const v = accept(item, a.value);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** The form's own view of a list: its general questions are asked here, even though Tina doesn't ask them on chat. */
const asGuided = (form: ClaimForm, claim: Pick<FollowOnClaim, 'claimType' | 'facts'>): ClaimForm => withFacts(form, claim, 'show');

const POLICE_HELP = "Not reported yet? Please report it at a police station first: we need the case number before you can sign.";

/** The key whose answer says a burst geyser or pipe damaged the home: then the loss was damage, so it isn't asked. */
const LOSS_KIND_KEY = 'lossKind';
const DAMAGED = 'Damaged';
const burstAsked = (form: ClaimForm) =>
  form.questionList.some((q) => q.key === BURST_KEY) && form.questionList.some((q) => q.key === LOSS_KIND_KEY && (q.choices ?? []).includes(DAMAGED));

/** A group whose "is there another?" questions a count answers: a count of people (FORM_STEPPERS) or of items (FORM_COUNTERS). */
const countedGroup = (form: ClaimForm, group: string) =>
  !!FORM_COUNTERS[group] || Object.entries(FORM_STEPPERS).some(([lead, x]) => x.group === group && form.questionList.some((q) => q.key === lead));

/** One topic's screen per topic of the form, in the order the form's list reaches them (AC 2). */
function screensFor(form: ClaimForm, claim: FollowOnClaim, earlier: readonly ClaimAnswers[], sapsRequired: boolean): GuidedScreen[] {
  const master = masterFormFor(form);
  const facts = factsOf(claim);
  const answers = claim.answers;
  const screens = new Map<string, GuidedScreen>();
  // The SAPS step's questions lead on WhatsApp because Tina asks them first. They aren't on the insurer's list, so on the
  // form they sit with the rest of the police questions, where the list reaches those (or last, on a form with none).
  // Off a claim that doesn't need them, they're still on the page, for a yes to "Was it reported to the police?".
  const all = allEntries(form, facts, true);
  const added = (i: QuestionItem) => isSaps(i.key) && !form.questionList.some((q) => q.key === i.key);
  for (const item of [...all.filter((i) => !isSaps(i.key)), ...all.filter((i) => isSaps(i.key))]) {
    if (item.kind !== 'question') continue;
    const baseKey = item.group ? item.key.replace(/\.\d+$/, '') : item.key;
    // Worked out from the items and amounts the client gives (progress.ts), so it isn't a question here.
    if (item.sumOf || baseKey === PHONE_OR_TABLET_KEY) continue;
    const when = conditionsFor(item, form, facts);
    if (!when) continue;
    if (added(item) && !sapsRequired) when.push({ key: 'saps', oneOf: [true] });
    // TTTFG-5734: a claim that must have a case never asks whether there is one (below), so the case number and station
    // can't wait on that answer, even where the insurer's list (the generic one) puts them under "reported? yes". Otherwise
    // the box never shows while signing still needs it (BEFORE_SIGNING), and Submit holds the client on nothing they can see.
    if (sapsRequired && isSaps(item.key)) {
      const free = when.filter((w) => w.key !== 'saps');
      when.splice(0, when.length, ...free);
    }
    const isMore = !!item.group && item.key.startsWith(`${item.group}.more.`);
    // A question no master form places yet still shows, under its own section, so a new question is never lost.
    const place = masterPlace(master, baseKey);
    const groupPlace = isMore ? (form.questionList.find((q) => q.group === item.group && masterPlace(master, q.key)) ?? null) : null;
    const stepper = formStepper(master.id, baseKey);
    const hasGroup = !!stepper && form.questionList.some((q) => q.group === stepper.group);
    // A count of people sits right above their cards, and "Was it reported?" above the case number.
    const leads = hasGroup ? form.questionList.find((q) => q.group === stepper.group) : baseKey === 'saps' ? { key: SAPS_CASE_KEY } : undefined;
    const topic = (leads ? masterPlace(master, leads.key)?.topic : undefined) ?? place?.topic ?? (groupPlace ? masterPlace(master, groupPlace.key)?.topic : undefined);
    const id = topic?.id ?? `section:${item.section ?? 'more'}`;
    const title = topic?.title ?? (item.section ? `${item.section.charAt(0).toUpperCase()}${item.section.slice(1)}` : 'A few more questions');
    const screen: GuidedScreen = screens.get(id) ?? { id, title, ...(id === 'police' && sapsRequired && !claim.sapsCaseNumber ? { help: POLICE_HELP } : {}), fields: [] };
    screens.set(id, screen);
    // A claim that must have a police case has no use for asking whether there is one.
    if (baseKey === 'saps' && sapsRequired) continue;
    const n = item.group && !isMore ? Number(/\.(\d+)$/.exec(item.key)?.[1] ?? 0) : 0;
    const original = form.questionList.find((q) => q.key === baseKey);
    const variants = original?.variants?.map((v) => ({ cond: pageCondition(v.when, facts), prompt: v.prompt }));
    const held = variants?.find((v) => v.cond === true);
    const known = answers[item.key]?.status === 'answered';
    const pre = !known && !item.group ? earlierValue(item, master, earlier) : undefined;
    const control: GuidedControl = hasGroup ? stepper : controlFor(item, baseKey, master, claim.claimType);
    const hidden = isMore && countedGroup(form, item.group!);
    // A burst geyser or pipe is damage: "stolen, lost or damaged?" is answered for them (applyGuidedSave).
    if (baseKey === LOSS_KIND_KEY && burstAsked(form)) when.push({ key: BURST_KEY, oneOf: [true], not: true });
    const note = formNote(master.id, baseKey);
    screen.fields[added(item) ? 'unshift' : 'push']({
      key: item.key,
      prompt: formPrompt(held?.prompt ?? item.prompt, wordedFor(control)),
      ...(formHint(item.prompt, wordedFor(control)) ? { hint: formHint(item.prompt, wordedFor(control)) } : {}),
      ...(note ? { note } : {}),
      type: fieldType(item),
      control,
      ...(hidden ? { hidden: true } : {}),
      required: item.required,
      ...(keyboardFor(baseKey) ? { keyboard: keyboardFor(baseKey) } : {}),
      when,
      ...(variants?.some((v) => typeof v.cond === 'object') ? {
        variants: variants.filter((v): v is { cond: GuidedCondition; prompt: string } => typeof v.cond === 'object').map((v) => ({ when: v.cond, prompt: formPrompt(v.prompt, wordedFor(control)) })),
      } : {}),
      ...(item.group && n ? { entry: entryHeading(item.group, n) } : {}),
      ...(item.group && countedGroup(form, item.group) ? { counted: true } : {}),
      ...(pre !== undefined ? { prefill: pre } : {}),
    });
  }
  // The case number before the station, as the SAPS step asks them (each was put in front in turn).
  const police = screens.get('police')?.fields;
  if (police && police[0]?.key === SAPS_STATION_KEY && police[1]?.key === SAPS_CASE_KEY) [police[0], police[1]] = [police[1], police[0]];
  const lead = police?.findIndex((f) => f.key === 'saps') ?? -1;
  if (police && lead > 0) police.unshift(...police.splice(lead, 1));
  // A count of items, where the list has no yes/no in front of them: it goes where the first item's card is, and shows
  // when that card would. It is the page's own: it saves nothing but the "is there another?" answers.
  for (const g of form.questionGroups ?? []) {
    const counter = FORM_COUNTERS[g.key];
    const first = form.questionList.find((q) => q.group === g.key);
    if (!counter || !first) continue;
    for (const s of screens.values()) {
      const card = s.fields.find((f) => f.key === `${first.key}.1`);
      if (!card) continue;
      s.fields.splice(s.fields.indexOf(card), 0, { key: counterKey(g.key), prompt: counter.label, type: 'number', control: counter, required: false, when: card.when });
    }
  }
  // A count of people has their cards right under it, on one step. What else hangs on the count comes after the cards.
  for (const s of screens.values()) {
    for (const lead of s.fields.filter((f) => f.control.kind === 'stepper')) {
      const group = (lead.control as Extract<GuidedControl, { kind: 'stepper' }>).group;
      const cards = s.fields.filter((f) => f.counted && (f.key.startsWith(`${group}.more.`) || form.questionList.some((q) => q.group === group && f.key.startsWith(`${q.key}.`))));
      const moved = new Set([lead, ...cards]);
      const rest = s.fields.filter((f) => !moved.has(f));
      const before = s.fields.slice(0, s.fields.indexOf(lead)).filter((f) => !moved.has(f));
      const firstDependent = before.findIndex((f) => f.when.some((w) => w.key === lead.key));
      const at = firstDependent >= 0 ? firstDependent : before.length;
      s.fields = [...rest.slice(0, at), lead, ...cards, ...rest.slice(at)];
    }
  }
  // "Is there another?" reads as a question of its own under the entry it follows.
  for (const s of screens.values()) {
    for (const f of s.fields) {
      const m = /^(.+)\.more\.(\d+)$/.exec(f.key);
      if (!m) continue;
      const g = (form.questionGroups ?? []).find((x) => x.key === m[1]);
      if (g) f.prompt = anotherPrompt(g.more, Number(m[2]));
    }
  }
  return [...screens.values()];
}

function detailsFor(form: ClaimForm, claim: FollowOnClaim, crm: GuidedCrm): GuidedDetail[] {
  const used = new Set(form.fieldMap.map((e) => e.source));
  const value = (source: string) => {
    const changed = claim.answers[source];
    if (changed?.status === 'answered' && typeof changed.value === 'string') return changed.value;
    const [table, column] = source.slice('crm:'.length).split('.') as ['contact' | 'riivo_policy', string];
    return crm[table]?.[column]?.trim() ?? '';
  };
  const rows: GuidedDetail[] = DETAILS.filter((d) => used.has(d.source) && (d.editable || value(d.source))).map((d) => ({ key: d.source, label: d.label, value: value(d.source), editable: d.editable }));
  // A form with a first name and a surname box shows those, not the full name as well.
  if (rows.some((r) => r.key === 'crm:contact.firstname') && rows.some((r) => r.key === 'crm:contact.fullname')) rows.splice(rows.findIndex((r) => r.key === 'crm:contact.fullname'), 1);
  // The generic row maps nothing: the client still sees who the claim is for.
  if (!rows.some((r) => r.key === 'crm:contact.fullname' || r.key === 'crm:contact.firstname')) rows.unshift({ key: 'crm:contact.fullname', label: 'Full name', value: value('crm:contact.fullname'), editable: true });
  const given = claim.answers[ADDRESS_KEY];
  rows.push({
    key: ADDRESS_KEY, label: ADDRESS_LABEL, editable: true,
    value: given?.status === 'answered' && typeof given.value === 'string' ? given.value : oneLine(claim.contactAddress?.trim() ?? ''),
  });
  if (used.has(BROKER.source) && value(BROKER.source)) rows.push({ key: BROKER.source, label: BROKER.label, value: value(BROKER.source), editable: false });
  return rows;
}

/** "2026-11-02T07:40:00Z" as the form holds it: "2026-11-02 09:40". */
function sastText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + 2 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Everything a condition may test, and what fills the boxes. */
function knownValues(form: ClaimForm, claim: FollowOnClaim) {
  const facts = factsOf(claim);
  const answers: Record<string, string | number | boolean> = {};
  const notKnown: string[] = [];
  for (const [k, v] of Object.entries(facts)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') answers[k] = v;
  // The claim's column holds an instant; the form's pickers show the date and time in South Africa.
  if (facts.incidentAt) answers.incidentAt = sastText(facts.incidentAt);
  if (facts.sapsCaseNumber) answers.saps = true;
  for (const [k, a] of Object.entries(claim.answers)) {
    if (a.status === 'answered' && a.value !== null) answers[k] = a.value;
    else if (a.status !== 'answered') notKnown.push(k);
  }
  return { answers, notKnown };
}

const evidenceKind = (item: QuestionItem): GuidedEvidence['kind'] => (item.answerType === 'video' ? 'video' : item.answerType === 'document' ? 'document' : 'photo');

/** The form as the page shows it. `earlier`: the riivo_answers of the client's earlier claims, latest first. */
export function guidedView(list: ClaimForm, claim: FollowOnClaim, crm: GuidedCrm, earlier: readonly ClaimAnswers[] = []): GuidedView {
  const form = asGuided(list, claim);
  const master = masterFormFor(form);
  const facts = factsOf(claim);
  const sapsRequired = !!claim.sapsRequired;
  const screens = screensFor(form, claim, earlier, sapsRequired);
  const { answers, notKnown } = knownValues(form, claim);
  // The user (13 Nov 2026): a quote shows too, never required, unless the insurer appoints the repairer: never on a
  // windscreen, and on a burst geyser or pipe only when the client chose their own plumber.
  const quote = (q: { key: string; onHand?: boolean }) => QUOTE_ITEMS.has(q.key) && q.onHand === false && facts.claimType !== 'Windscreen';
  const ownPlumber: GuidedCondition[] = form.questionList.some((q) => q.key === CONTRACTOR_KEY) ? [{ key: CONTRACTOR_KEY, oneOf: [INSURERS_PLUMBER], not: true }] : [];
  const evidence: GuidedEvidence[] = form.questionList.filter((q) => q.kind === 'evidence' && (q.onHand !== false || FORM_DRAWINGS.has(q.key) || quote(q))).flatMap((q) => {
    const when = conditionsFor(q, form, facts);
    const help = evidenceHelp(master.id, q.key);
    const later = quote(q);
    return when ? [{
      key: q.key, prompt: FORM_DRAWINGS.has(q.key) ? 'A drawing of the accident' : q.prompt, kind: evidenceKind(q), required: later ? false : q.required,
      ...(FORM_DRAWINGS.has(q.key) ? { draw: true } : {}), when: later ? [...when, ...ownPlumber] : when, count: filesFor(q, claim.evidence), ...(help ? { help } : {}),
      ...(later ? { later: { badge: QUOTE_LATER.badge, text: QUOTE_LATER.text, textEmail: QUOTE_LATER.textEmail } } : {}),
    }] : [];
  });
  const otherHelp = evidenceHelp(master.id, 'other');
  const open = guidedOpen(form, claim, policeOpen(claim));
  const startAt = screens.findIndex((s) => s.fields.some((f) => open.includes(f.key)));
  const detailsConfirmed = claim.answers[DETAILS_CONFIRMED_KEY]?.status === 'answered';
  return {
    reference: claim.reference,
    title: master.title,
    insurer: claim.insurer,
    details: detailsFor(form, claim, crm),
    detailsConfirmed,
    ...(claim.answers[TERMS_KEY]?.status === 'answered' ? {} : { terms: { title: FORM_TERMS.title, lines: FORM_TERMS.lines, agree: FORM_TERMS.agree } }),
    screens,
    evidence,
    ...(otherHelp ? { otherHelp } : {}),
    answers,
    notKnown,
    startAt: startAt < 0 ? screens.length : startAt,
    beforeSigning: beforeSigningOn(screens),
  };
}

/**
 * The user (9 Nov 2026): the bare minimum the broker needs to send the claim pack, so the client can't sign (or submit)
 * without it, even though any other question may be left blank: when and where it happened, what happened in their own
 * words, and the police case number when the police were involved. The user (13 Nov 2026): the police station too (it is
 * on the same slip), and a case number with no digit in it ("....") doesn't count.
 */
export const BEFORE_SIGNING: readonly string[] = ['incidentAt', 'place', 'description', SAPS_CASE_KEY, SAPS_STATION_KEY];

/** BEFORE_SIGNING as this form asks it: never a question the client has no box for. */
const beforeSigningOn = (screens: readonly GuidedScreen[]) =>
  BEFORE_SIGNING.filter((k) => screens.some((s) => s.fields.some((f) => f.key === k)));

/** What BEFORE_SIGNING still lacks: a question left blank or "don't know" counts as missing. */
export function missingBeforeSigning(form: ClaimForm, claim: FollowOnClaim, sapsRequired: boolean): string[] {
  const facts = factsOf(claim);
  const police = sapsRequired || policeOpen(claim);
  const has = (k: string) => {
    const a = claim.answers[k];
    const v = a?.status === 'answered' && a.value !== null && a.value !== '' ? a.value : factFor(k, facts);
    if (v === undefined || v === null || v === '') return false;
    return k !== SAPS_CASE_KEY || isCaseNumber(String(v));
  };
  return beforeSigningOn(screensFor(asGuided(form, claim), claim, [], sapsRequired))
    .filter((k) => (!isSaps(k) || police) && !has(k));
}

/** Whether the police case's own questions are open on the form: the claim needs them, or the client said it was reported. */
const policeOpen = (claim: Pick<FollowOnClaim, 'sapsRequired' | 'facts' | 'answers'>) =>
  !!claim.sapsRequired || claim.facts.saps === true || claim.answers.saps?.value === true;

/** The questions that still apply and have no answer, in the list's order. An evidence item is never one: Tina asks for those. */
export function guidedOpen(form: ClaimForm, claim: Pick<FollowOnClaim, 'answers' | 'facts' | 'claimType' | 'sapsCaseNumber' | 'sapsStation'>, sapsRequired: boolean): string[] {
  const facts = factsOf(claim as FollowOnClaim);
  return formItems(form, claim.answers, facts, sapsRequired)
    .filter((i) => i.kind === 'question' && applies(i, claim.answers, facts))
    .filter((i) => !i.sumOf && i.key !== PHONE_OR_TABLET_KEY && !claim.answers[i.key] && factFor(i.key, facts) === undefined)
    .map((i) => i.key);
}

// ---------------------------------------------------------------------------------------------------- saving

export type GuidedPorts = Pick<FollowOnPorts, 'loadClaim' | 'claimForm' | 'saveAnswers' | 'saveSaps' | 'fileToPipeline' | 'storeVideo' | 'claimEvidence' | 'claimFlags'>
  & Partial<Pick<FollowOnPorts, 'saveFacts' | 'createAgentAction'>>;

export interface GuidedSave {
  answers?: ReadonlyArray<{ key: string; value: string | number | boolean }>;
  /** Questions the client says they don't know or don't have yet (followon.ts advanceBatch reads a "don't know" the same way). */
  notKnown?: readonly string[];
  /** Questions the client has cleared: an answer they took back. */
  cleared?: readonly string[];
  /** Answers whose problem the client was already shown: the same again is kept, with the reason for the broker. */
  checked?: readonly string[];
  /** The client has gone past the screen of what TTT holds. */
  detailsConfirmed?: boolean;
  /** The client agreed to what opens the form. */
  termsAccepted?: boolean;
}

export interface GuidedSaved {
  /** An answer that wasn't saved, and why, for the box it came from. */
  problems: Array<{ key: string; text: string }>;
  answers: GuidedView['answers'];
  notKnown: string[];
  open: string[];
}

const NOT_READ = "That doesn't look right. Could you check it?";

/** Entries past a "no" to "is there another?" are dropped, as for a correction on WhatsApp, so they never reach the form. */
function dropEndedEntries(form: ClaimForm, answers: ClaimAnswers): void {
  for (const g of form.questionGroups ?? []) {
    const members = form.questionList.filter((q) => q.group === g.key).map((q) => q.key);
    let ended = false;
    for (let n = 1; n <= g.max; n++) {
      if (ended) {
        for (const k of members) delete answers[`${k}.${n}`];
        delete answers[moreKey(g.key, n)];
      }
      const more = answers[moreKey(g.key, n)];
      if (more?.status === 'answered' && more.value === false) ended = true;
    }
  }
}

/**
 * Saves what the client answered on one screen (AC 5): each value checked as a chat answer is, against the question that
 * applies right now. An answer can open another question on the same screen (a yes to "Were there passengers?"), so it
 * goes round until nothing more fits. A value that doesn't look right comes back as a problem the first time.
 */
export function applyGuidedSave(
  form: ClaimForm, claim: FollowOnClaim, sapsRequired: boolean, input: GuidedSave, now: Date,
): { answers: ClaimAnswers; saps: { caseNumber?: string; station?: string }; problems: GuidedSaved['problems'] } {
  const at = now.toISOString();
  const answers: ClaimAnswers = { ...claim.answers };
  const facts = factsOf(claim);
  const saps: { caseNumber?: string; station?: string } = {};
  const problems: GuidedSaved['problems'] = [];
  const checked = new Set(input.checked ?? []);
  for (const key of input.cleared ?? []) if (answers[key]?.status === 'answered' || deferred(key, answers)) delete answers[key];
  const given = new Map((input.answers ?? []).map((a) => [a.key, a.value] as const));
  const blanks: string[] = [];

  // What TTT holds: a changed value on the form. The CRM stays as it is; the broker gets a Follow-up (followon.ts formDone).
  for (const [key, v] of [...given]) {
    // Only what the page offers: not the ID number, the broker or anything else a crafted request names.
    if (!DETAILS.some((d) => d.source === key) && key !== ADDRESS_KEY) continue;
    given.delete(key);
    const value = typeof v === 'string' ? v.trim() : '';
    // A number or email the client took off stays off the form. An address can only be changed.
    if (!value && key !== ADDRESS_KEY) { answers[key] = { value: '', status: 'answered', at, source: 'form' }; continue; }
    if (!value) continue;
    const problem = checked.has(key) ? null : /mobilephone|telephone/.test(key) ? phoneProblem(value) : /emailaddress/.test(key) ? emailProblem(value) : null;
    if (problem) { problems.push({ key, text: problem }); continue; }
    answers[key] = { value, status: 'answered', at, source: 'form' };
    if (key === ADDRESS_KEY) answers[ADDRESS_CHECK_KEY] = { value: 'Another address', status: 'answered', at, source: 'form' };
  }
  if (input.termsAccepted) answers[TERMS_KEY] = { value: true, status: 'answered', at, source: 'form' };
  if (input.detailsConfirmed) {
    answers[DETAILS_CONFIRMED_KEY] = { value: true, status: 'answered', at, source: 'form' };
    // The address question on WhatsApp is settled too, if the client later moves to chat (AC 8).
    if (!answers[ADDRESS_KEY] && !answers[ADDRESS_CHECK_KEY] && claim.contactAddress?.trim()) answers[ADDRESS_CHECK_KEY] = { value: 'Still the same', status: 'answered', at, source: 'form' };
  }

  const list = () => formItems(form, answers, { ...facts, ...saps.caseNumber ? { sapsCaseNumber: saps.caseNumber } : {}, ...saps.station ? { sapsStation: saps.station } : {} }, sapsRequired || answers.saps?.value === true);
  for (let pass = 0, more = true; more && pass < 8 && given.size; pass++) {
    more = false;
    for (const [key, v] of [...given]) {
      const item = list().find((i) => i.key === key);
      // TTTFG-5734: the case number and station of a claim that must have a case are kept whatever the list's "reported?"
      // says, as screensFor shows them: that question is never asked on such a claim.
      if (!item || item.kind !== 'question' || !(applies(item, answers, facts) || (sapsRequired && isSaps(key)))) continue;
      given.delete(key);
      more = true;
      // "Yes" with nothing typed, where the box wants the thing itself: a blank, so "Yes" never prints as an ID number.
      const c = FORM_CONTROLS[key.replace(/\.\d+$/, '')];
      if (c?.kind === 'yes-text' && c.needsText && typeof v === 'string' && /^\s*yes\s*$/i.test(v)) { blanks.push(key); continue; }
      const value = accept(item, v);
      if (value === undefined) { problems.push({ key, text: NOT_READ }); continue; }
      const problem = formatProblem(item, value);
      if (problem && !checked.has(key)) { problems.push({ key, text: problem }); continue; }
      if (isSaps(key)) {
        if (key === SAPS_CASE_KEY) saps.caseNumber = String(value).trim();
        else saps.station = String(value).trim();
        delete answers[key];
        continue;
      }
      answers[key] = { value, status: 'answered', at, source: 'form', ...(problem ? { doubt: problem.replace(/ Could you.*$/, '') } : {}) };
    }
  }

  for (const key of [...(input.notKnown ?? []), ...blanks]) {
    const item = list().find((i) => i.key === key);
    if (!item || item.kind !== 'question') continue;
    if (answers[key]?.status === 'answered') delete answers[key];
    // As for "I don't know" on WhatsApp: the broker confirms it, unless the client can get it (then it stays on their list).
    const record: AnswerRecord = { value: null, status: item.required && !chased(item) ? 'broker-to-confirm' : 'not-yet', at, source: 'form' };
    answers[key] = record;
  }
  dropEndedEntries(form, answers);

  // A burst geyser or pipe: the loss was damage, so the page doesn't ask (screensFor). A no later shows the question again,
  // with Damaged still picked for the client to change.
  if (burstAsked(form) && answers[BURST_KEY]?.status === 'answered' && answers[BURST_KEY].value === true && answers[LOSS_KIND_KEY]?.value !== DAMAGED) {
    const item = list().find((i) => i.key === LOSS_KIND_KEY);
    if (item && applies(item, answers, facts)) answers[LOSS_KIND_KEY] = { value: DAMAGED, status: 'answered', at, source: 'form' };
  }

  // Worked out, not asked: the total of the amounts, and whether a phone or tablet was among the items.
  for (const t of computedTotals(form, answers, facts, sapsRequired)) {
    if (t.value === null) delete answers[t.key];
    else answers[t.key] = { value: t.value, status: 'answered', at, source: 'computed' };
  }
  const phone = phoneFromItems(form, answers);
  if (phone !== undefined) answers[PHONE_OR_TABLET_KEY] = { value: phone, status: 'answered', at, source: 'computed' };
  return { answers, saps, problems };
}

/** The claim and its form, for the page's calls. */
async function loaded(ports: GuidedPorts, claimId: string) {
  const claim = await ports.loadClaim(claimId);
  if (!claim.claimFormId) throw new Error(`TTTFG-5562: claim ${claimId} has no claim form yet`);
  const form = asGuided(await ports.claimForm(claim.claimFormId), claim);
  return { claim, form, sapsRequired: policeOpen(claim) };
}

export async function loadGuided(ports: GuidedPorts, claimId: string, crm: (claim: FollowOnClaim) => Promise<GuidedCrm>, earlier: (claim: FollowOnClaim) => Promise<ClaimAnswers[]>): Promise<GuidedView> {
  const { claim, form } = await loaded(ports, claimId);
  const [c, e] = await Promise.all([crm(claim), earlier(claim).catch(() => [])]);
  return guidedView(form, claim, c, e);
}

/** The riivo_answers of the client's other claims, latest first: what pre-fills the vehicle or property (AC 3). */
export async function earlierClaimAnswers(dv: Dv, contactId: string, claimId: string): Promise<ClaimAnswers[]> {
  const r = await dv<{ value: { riivo_answers: string | null }[] }>('GET',
    `riivo_claims?$select=riivo_answers&$filter=_riivo_contact_value eq ${contactId} and riivo_claimid ne ${claimId}&$orderby=createdon desc&$top=5`);
  return r.value.flatMap((c) => {
    try {
      return c.riivo_answers ? [JSON.parse(c.riivo_answers) as ClaimAnswers] : [];
    } catch {
      return [];
    }
  });
}

/** One screen's answers, saved as chat answers are. */
export async function saveGuided(ports: GuidedPorts, claimId: string, input: GuidedSave, now: Date): Promise<GuidedSaved> {
  const { claim, form, sapsRequired } = await loaded(ports, claimId);
  const { answers, saps, problems } = applyGuidedSave(form, claim, sapsRequired, input, now);
  if (saps.caseNumber || saps.station) await ports.saveSaps(claimId, saps);
  if (JSON.stringify(answers) !== JSON.stringify(claim.answers)) await ports.saveAnswers(claimId, answers);
  // What the walkthrough asks on chat goes on the claim's own columns: the insurer's form and the broker read those.
  const columns = factColumns(form, claim.facts, answers);
  if (Object.keys(columns).length) await ports.saveFacts?.(claimId, columns);
  const at = now.toISOString();
  const by = { department: DEPARTMENT as typeof DEPARTMENT, owner: claim.owner, regarding: { table: 'riivo_claim' as const, id: claimId }, contactId: claim.contactId, at };
  if (input.termsAccepted && claim.answers[TERMS_KEY]?.status !== 'answered') {
    await ports.createAgentAction?.({
      kind: 'Created', ...by, detail: `The client agreed to the notes that open the claim form for ${claim.reference}.`,
      template: { name: FORM_TERMS.name, version: FORM_TERMS.version, text: FORM_TERMS.lines.join(' ') },
    });
  }
  if (plumberAsked(claim.answers, answers)) {
    await ports.createAgentAction?.({ kind: 'Follow-up', ...by, urgent: true, urgencyReason: 'The client needs a plumber', detail: plumberDetail(claim.reference, claim.insurer) });
  }
  // saveSaps sets riivo_sapsinvolved with a case number, so the questions that hang on the police being involved are open now.
  const after: FollowOnClaim = {
    ...claim, answers, sapsCaseNumber: saps.caseNumber ?? claim.sapsCaseNumber, sapsStation: saps.station ?? claim.sapsStation,
    facts: { ...claim.facts, ...columns, ...(saps.caseNumber ? { saps: true } : {}) },
  };
  return { problems, ...knownValues(form, after), open: guidedOpen(form, after, policeOpen(after)) };
}

/**
 * The client tapped Submit. A required question with no answer sends them back to it. Otherwise an optional one they left
 * empty counts as "not yet", which on WhatsApp means it's never asked, so Tina only follows up on what's still required.
 * `open` empty: ready; the host carries on with { kind: 'form-done' } on the client's own queue.
 */
export async function finishGuided(ports: GuidedPorts, claimId: string, now: Date): Promise<{ open: string[] }> {
  const { claim, form, sapsRequired } = await loaded(ports, claimId);
  const facts = factsOf(claim);
  const open = guidedOpen(form, claim, sapsRequired);
  const items = formItems(form, claim.answers, facts, sapsRequired);
  const required = open.filter((k) => items.find((i) => i.key === k)?.required);
  // The user (9 Nov 2026): the client signs at the end of the form, so what the form asks them to send and is required
  // must be in first. Only what a client can always get is required (a driver's licence, the drawing of the accident);
  // photos of damage never are (contracts.ts `required`).
  const files = missingOnForm(form, claim, items, facts);
  const minimum = missingBeforeSigning(form, claim, sapsRequired).filter((k) => !required.includes(k));
  if (required.length || minimum.length || files.length) return { open: [...required, ...minimum, ...files] };
  const left = open.filter((k) => !required.includes(k));
  if (left.length) {
    const answers: ClaimAnswers = { ...claim.answers };
    for (const k of left) answers[k] = { value: null, status: 'not-yet', at: now.toISOString(), source: 'form' };
    await ports.saveAnswers(claimId, answers);
  }
  return { open: [] };
}

/** The required photos and documents the form asks for (its last screen) that still have no file. */
export function missingOnForm(form: ClaimForm, claim: Pick<FollowOnClaim, 'answers' | 'evidence'>, items: readonly QuestionItem[], facts: ClaimFacts): string[] {
  // The drawing of the accident isn't asked on chat (TTT gets it), but the form lets the client draw it, so it counts here.
  const drawings = form.questionList.filter((q) => FORM_DRAWINGS.has(q.key) && !items.some((i) => i.key === q.key));
  return [...items, ...drawings].filter((i) => i.kind === 'evidence' && i.required && (i.onHand !== false || FORM_DRAWINGS.has(i.key))
    && applies(i, claim.answers, facts) && filesFor(i, claim.evidence) === 0).map((i) => i.key);
}

/** A file from the form's last screen, through the same document pipeline as a file sent on WhatsApp (AC 7). */
export async function fileGuided(ports: GuidedPorts, claimId: string, file: ClientFile, itemKey: string | undefined, now: Date): Promise<{ count: number }> {
  const { claim, form } = await loaded(ports, claimId);
  const item = form.questionList.find((q) => q.key === itemKey && q.kind === 'evidence');
  const to = { claimId, ...(item ? { itemKey: item.key } : {}) };
  if (file.media === 'video') await ports.storeVideo(file, to);
  else await ports.fileToPipeline(file, to);
  // The score and the risk flags read the claim's documents; neither may fail the upload.
  await ports.claimEvidence?.(claimId)?.catch(() => undefined);
  await ports.claimFlags?.({ claimId, triggers: ['document'], at: now.toISOString() })?.catch(() => undefined);
  return { count: (item ? filesFor(item, claim.evidence) : 0) + 1 };
}

// ------------------------------------------------------------------------------------------------ chat instead

/**
 * AC 8: the client says they'd rather answer on WhatsApp, or can't open the link. Plain words, not a model call: a miss
 * only means Tina answers with the reminder, which says how to ask, and a voice note is read as its transcript.
 */
const PREFERS_CHAT = [
  /^\s*(chat|whats ?app)\s*(please|pls|instead)?\s*[.!]*\s*$/i,
  /\b(prefer|rather|instead|can we|could we|let'?s|want to|like to)\b.*\b(chat|whats ?app|on here|here)\b/i,
  /\b(ask|answer|do it|do this|tell you)\b.*\b(here|on whats ?app|by chat|in chat|over chat|on chat)\b/i,
  /\b(can'?t|cannot|won'?t|doesn'?t|does not|not|unable to)\b.*\b(open|work|working|load|loading)\b.*\b(link|form|page)\b/i,
  /\b(link|form|page)\b.*\b(can'?t|cannot|won'?t|doesn'?t|does not|not|unable to)\b.*\b(open|work|working|load|loading)\b/i,
  /\b(don'?t|do not)\b.*\b(want|like)\b.*\b(link|form)\b/i,
];
export const prefersChat = (text: string) => PREFERS_CHAT.some((re) => re.test(text));
