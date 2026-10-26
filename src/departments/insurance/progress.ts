// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/progress.ts (commit 05d65be). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5176 (TTTFG-5254 steps 8 and 14): what Tina asks next on a claim, and what is still missing. Pure functions
// over the claim form's question list, the claim's saved answers and the evidence linked to the claim.
//
// Progress is worked out each time from the claim record, never stored: a client can stop and continue later
// (TTTFG-5184), finish by email (TTTFG-5188) or get a reminder (TTTFG-5212), and all three call these same functions.
// A second copy of "what's missing" drifts, so there is one, here.
//
// Three kinds of known value count as answered:
// - an answer in riivo_answers (`ClaimAnswers`), including one marked broker-to-confirm (Tina asked twice; the broker
//   takes it from there, so the client is not asked again);
// - a fact from the 5168 walkthrough or the SAPS step, on the claim's own columns. A question list item whose key is a
//   walkthrough fact name (`description`, `incidentAt`, `place`, ...) or a SAPS key is never asked twice;
// - an evidence item with a document linked to the claim for that item.
//
// TTTFG-5172's refined contract (merged later): a condition may list several values (`oneOf`) or test a claim column
// (`crm:riivo_claim.riivo_sapsinvolved`), read from the walkthrough facts; and a repeating group is asked entry by
// entry (formItems), its answers saved as `<key>.<n>` and its "is there another?" answers as `<group>.more.<n>`.
import type { ClaimAnswers, ClaimForm, Condition, QuestionItem } from './contracts';
import type { ClaimType, Facts } from './walkthrough';

/** The SAPS step's keys. A form that lists them gets the SAPS step; the values live on riivo_claim, not riivo_answers. */
export const SAPS_CASE_KEY = 'sapsCaseNumber';
export const SAPS_STATION_KEY = 'sapsStation';

/** Added in front of the form's list when the SAPS step applies (unless the form lists the key itself). */
export const SAPS_ITEMS: readonly QuestionItem[] = [
  { key: SAPS_CASE_KEY, kind: 'question', prompt: 'What is the SAPS case number?', name: 'the SAPS case number', answerType: 'text', required: true, chase: true },
  { key: SAPS_STATION_KEY, kind: 'question', prompt: 'At which police station did you report it?', name: 'the police station you reported it at', answerType: 'text', required: true, chase: true },
];

/** The claim's own columns that answer form questions: the walkthrough facts and the SAPS step. */
export type ClaimFacts = Facts & { sapsCaseNumber?: string; sapsStation?: string };

/** riivo_clientdocument rows linked to the claim, by the question list item each one answers. */
export type ReceivedEvidence = ReadonlyArray<{ key: string }>;

export interface ProgressOptions {
  facts?: ClaimFacts;
  /** The SAPS step applies to this claim (see sapsStepApplies). Adds the case number and station as required items. */
  sapsRequired?: boolean;
  /** Keys to pass over in this conversation only ("not yet"). They stay on the missing list. */
  skip?: readonly string[];
}

/**
 * TTTFG-5254 step 4: the SAPS step runs for a theft or hijacking, for a form that needs the case number, or when Claude
 * read the description as a theft, burglary or hijacking (`describedAsTheft`, a yes/no Claude supplies; code decides).
 */
export function sapsStepApplies(claimType: ClaimType | string, form: ClaimForm, describedAsTheft: boolean): boolean {
  return (
    claimType === 'Motor theft' || claimType === 'Hijacking' || form.sapsCaseRequired || describedAsTheft ||
    form.questionList.some((q) => q.key === SAPS_CASE_KEY && q.required)
  );
}

/** The form's list, with the SAPS items first when the step applies (the form's own wording if it lists them). */
export function itemsFor(form: ClaimForm, sapsRequired = false): QuestionItem[] {
  if (!sapsRequired) return form.questionList;
  const isSaps = (q: QuestionItem) => q.key === SAPS_CASE_KEY || q.key === SAPS_STATION_KEY;
  const saps = SAPS_ITEMS.map((s) => form.questionList.find((q) => q.key === s.key) ?? s);
  return [...saps, ...form.questionList.filter((q) => !isSaps(q))];
}

type Value = string | number | boolean | null | undefined;

/** The known value for a key: a saved answer first, then the claim's own columns. */
function known(key: string, answers: ClaimAnswers, facts: ClaimFacts | undefined): { value: Value; brokerToConfirm: boolean } | undefined {
  const a = answers[key];
  if (a && a.status !== 'not-yet') return { value: a.value, brokerToConfirm: a.status === 'broker-to-confirm' };
  const f = (facts as Record<string, unknown> | undefined)?.[key];
  if (f === undefined || f === null || f === '') return undefined;
  return { value: f as Value, brokerToConfirm: false };
}

const same = (a: Value, b: string | number | boolean) =>
  typeof a === 'string' && typeof b === 'string' ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;

/** The claim columns a condition may test, and the walkthrough fact that holds each one in Tina's conversation. */
const CLAIM_COLUMN_FACTS: Record<string, keyof ClaimFacts> = {
  'crm:riivo_claim.riivo_claimtype': 'claimType',
  'crm:riivo_claim.riivo_thirdpartiesinvolved': 'thirdParties',
  'crm:riivo_claim.riivo_sapsinvolved': 'saps',
  'crm:riivo_claim.riivo_injuries': 'injuries',
};

/**
 * Whether a condition holds. An earlier answer (or claim column) that is unknown or broker-to-confirm doesn't: Tina
 * doesn't ask a question that may not apply, and the broker confirms both. A CRM value Tina doesn't hold counts as
 * unknown. A SAPS case number on the claim means the police were involved.
 */
export function holds(c: Condition, answers: ClaimAnswers, facts?: ClaimFacts): boolean {
  const key = c.key.startsWith('crm:') ? CLAIM_COLUMN_FACTS[c.key] : c.key;
  if (!key) return false;
  const k = known(key, answers, facts) ?? (key === 'saps' && facts?.sapsCaseNumber ? { value: true, brokerToConfirm: false } : undefined);
  return !!k && !k.brokerToConfirm && (c.oneOf ?? [c.equals!]).some((v) => same(k.value, v));
}

/** `onlyIf`: ask only when the condition holds. */
export function applies(item: QuestionItem, answers: ClaimAnswers, facts?: ClaimFacts): boolean {
  return !item.onlyIf || holds(item.onlyIf, answers, facts);
}

/** The answer key of a group's "is there another?" question after entry `n`. */
export const moreKey = (group: string, n: number) => `${group}.more.${n}`;

/**
 * The form's items as Tina asks them (the SAPS items first when the step applies). A repeating group is asked where
 * its first question stands: its questions for entry 1 (keys `<key>.1`), then the group's `more` question, entry 2 if
 * the client says yes, and so on up to `max` (the rows on the form). A "no", or a `more` the broker must confirm, ends
 * the group. A condition on another question of the same group reads the same entry. A group whose own `onlyIf`
 * doesn't hold is left out whole.
 */
export function formItems(form: ClaimForm, answers: ClaimAnswers, facts?: ClaimFacts, sapsRequired = false): QuestionItem[] {
  const list = itemsFor(form, sapsRequired);
  const out: QuestionItem[] = [];
  const placed = new Set<string>();
  for (const item of list) {
    if (item.group === undefined) { out.push(item); continue; }
    if (placed.has(item.group)) continue;
    placed.add(item.group);
    const g = (form.questionGroups ?? []).find((x) => x.key === item.group);
    if (!g || (g.onlyIf && !holds(g.onlyIf, answers, facts))) continue;
    const members = list.filter((q) => q.group === g.key);
    const own = new Set(members.map((q) => q.key));
    for (let n = 1; n <= g.max; n++) {
      for (const q of members) {
        const onlyIf = q.onlyIf && own.has(q.onlyIf.key) ? { ...q.onlyIf, key: `${q.onlyIf.key}.${n}` } : q.onlyIf;
        out.push({ ...q, key: `${q.key}.${n}`, onlyIf });
      }
      if (n === g.max) break;
      const more = moreKey(g.key, n);
      // TTTFG-4830: said with what's already given, so "yes" can't be read as the one the client just described.
      const prompt = `Apart from ${n === 1 ? 'the one' : `the ${n}`} you've told me about, ${g.more.charAt(0).toLowerCase()}${g.more.slice(1)}`;
      // TTTFG-4830 (batches): asked with the entry it follows, so it takes the section of the entry's last question.
      const section = members.at(-1)?.section;
      out.push({ key: more, kind: 'question', prompt, answerType: 'yes/no', required: true, group: g.key, ...(section ? { section } : {}) });
      const k = known(more, answers, facts);
      if (!k || k.brokerToConfirm || k.value !== true) break;
    }
  }
  return out;
}

function done(item: QuestionItem, answers: ClaimAnswers, evidence: ReceivedEvidence, facts?: ClaimFacts): boolean {
  if (item.kind === 'evidence') return evidence.some((e) => e.key === item.key);
  return known(item.key, answers, facts) !== undefined;
}

/** Applicable items not yet answered or received, in the list's order. */
function open(form: ClaimForm, answers: ClaimAnswers, evidence: ReceivedEvidence, o: ProgressOptions): QuestionItem[] {
  return formItems(form, answers, o.facts, o.sapsRequired).filter((i) => applies(i, answers, o.facts) && !done(i, answers, evidence, o.facts));
}

/** TTTFG-5184: the client said "not yet" to this item in an earlier message (riivo_answers keeps it). */
export const deferred = (key: string, answers: ClaimAnswers) => answers[key]?.status === 'not-yet';

/**
 * TTTFG-5254 step 8: the next item to ask, or null when there is nothing left. Every question comes before any evidence
 * item, because the signing step sits between them (SPEC-04 walkthrough step 8). Optional items are asked too; the
 * client can say they don't have one.
 */
export function nextItem(form: ClaimForm, answers: ClaimAnswers, evidence: ReceivedEvidence, o: ProgressOptions = {}): QuestionItem | null {
  const skip = new Set(o.skip ?? []);
  // TTTFG-5184: an optional item the client said "not yet" to is never asked again; a required one comes after
  // everything not asked yet, so a client who comes back is asked the new things first.
  const items = open(form, answers, evidence, o).filter((i) => !skip.has(i.key) && (i.required || !deferred(i.key, answers)));
  const pick = (kind: QuestionItem['kind']) => {
    const of = items.filter((i) => i.kind === kind);
    return of.find((i) => !deferred(i.key, answers)) ?? of[0];
  };
  return pick('question') ?? pick('evidence') ?? null;
}

/** TTTFG-4830 (batches): at most this many questions in one message. */
export const BATCH_MAX = 5;

/** A yes/no condition ("If yes to 2"): the only kind of question that is asked ahead of the answer it depends on. */
const yesNoCondition = (c: Condition | undefined): c is Condition & { equals: boolean } => !!c && typeof c.equals === 'boolean';

/**
 * TTTFG-4830 (batches): the questions to ask together in one message, in the order Tina numbers them. The first is
 * nextItem(). When it is a question with a `section`, the open questions after it in the same section join it, in the
 * list's order, up to BATCH_MAX:
 * - a question that applies only after a yes or a no to a question in the batch ("If no to 4: whose name is the car
 *   registered in?") goes straight after that question. A question brings these only when all of them fit, or, when
 *   they could never fit in one message, as many as fit. The rest are asked once the answer is in;
 * - a question that hangs on a choice ("If it was a vehicle: …") waits for the answer, so a client is never shown a
 *   branch that may not be theirs;
 * - the batch ends at an open question of another section or at an evidence item. A question the client said "not yet"
 *   to is left out (nextItem() asks it after everything else).
 * A batch of one is asked as before. Pure, like the rest of this file.
 */
export function nextBatch(form: ClaimForm, answers: ClaimAnswers, evidence: ReceivedEvidence, o: ProgressOptions = {}): QuestionItem[] {
  const first = nextItem(form, answers, evidence, o);
  if (!first) return [];
  if (first.kind !== 'question' || !first.section || deferred(first.key, answers)) return [first];
  const skip = new Set(o.skip ?? []);
  const list = formItems(form, answers, o.facts, o.sapsRequired);
  const isOpen = (i: QuestionItem) => i.kind === 'question' && !skip.has(i.key) && !deferred(i.key, answers) && !done(i, answers, evidence, o.facts);
  // The questions waiting on a yes or a no to `parent` (and on their own yes or no), in the list's order.
  const family = (parent: QuestionItem): QuestionItem[] => {
    const keys = new Set([parent.key]);
    const out: QuestionItem[] = [];
    for (const i of list.slice(list.indexOf(parent) + 1)) {
      if (i.section !== first.section || !isOpen(i) || !yesNoCondition(i.onlyIf) || !keys.has(i.onlyIf.key)) continue;
      out.push(i);
      keys.add(i.key);
    }
    return out;
  };
  const batch: QuestionItem[] = [];
  const placed = new Set<string>();
  for (const item of list.slice(list.findIndex((i) => i.key === first.key))) {
    if (batch.length >= BATCH_MAX) break;
    if (placed.has(item.key) || !isOpen(item)) continue;
    if (!applies(item, answers, o.facts)) continue; // waits for an answer (placed with its question, or asked later)
    if (item.section !== first.section) break;
    const waiting = family(item);
    const room = BATCH_MAX - batch.length - 1;
    if (waiting.length > room && batch.length && waiting.length < BATCH_MAX) break; // they fit in the next message
    for (const i of [item, ...waiting.slice(0, room)]) {
      batch.push(i);
      placed.add(i.key);
    }
  }
  return batch;
}

/**
 * TTTFG-4830 (still need): an item the client can get and the form can't go without (contracts.ts `chase`). It goes on
 * "Things we still need from you" and the morning reminder until it's in; "I don't know" makes it "not yet", not the
 * broker's. Every required evidence item is; so are the SAPS case number and station, whatever the form calls them.
 */
export const chased = (item: QuestionItem): boolean =>
  item.required && (item.kind === 'evidence' || !!item.chase || item.key === SAPS_CASE_KEY || item.key === SAPS_STATION_KEY);

/** TTTFG-5254 step 14: the required items still missing (skipped ones included). Empty means evidence complete. */
export function missingItems(form: ClaimForm, answers: ClaimAnswers, evidence: ReceivedEvidence, o: ProgressOptions = {}): QuestionItem[] {
  return open(form, answers, evidence, { ...o, skip: [] }).filter((i) => i.required);
}

const words = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').toLowerCase();

/** One entry of a repeating group, in words: "witnesses" -> "witness", "otherParties" -> "other party". */
function entryWord(group: string): string {
  const w = words(group);
  if (/ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (/(?:ss|sh|ch|x)es$/.test(w)) return w.replace(/es$/, '');
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * What Tina calls an item to the client: "Thanks, I've got the photo of the damage." The item's `name` when the config
 * gives one; else from an imperative prompt ("Please send a photo of the damage." -> "the photo of the damage"); any
 * other prompt falls back to the key in words.
 *
 * TTTFG-5184: an entry of a repeating group is named by its entry, not its key ("the details of witness 1", not "the
 * witness name 1"), so a list of what's missing says each entry once (`list()` in followon.ts drops repeats). The
 * "is there another?" item is "whether there's another witness". A group whose key isn't a plural ("injured") reads
 * "the details of injured 1".
 */
export function itemName(item: QuestionItem): string {
  if (item.group) {
    if (item.key.startsWith(`${item.group}.more.`)) return `whether there's another ${entryWord(item.group).replace(/^other /, '')}`;
    const n = /\.(\d+)$/.exec(item.key)?.[1];
    if (n) return `the details of ${entryWord(item.group)} ${n}`;
  }
  if (item.name) return item.name;
  // A form that lists a SAPS item in its own words: still named as the SAPS step names it.
  const saps = SAPS_ITEMS.find((s) => s.key === item.key);
  if (saps?.name) return saps.name;
  const first = item.prompt.split(/(?<=[.?!])\s/)[0].trim();
  const m = /^(?:please\s+)?(?:send|upload|share|attach)\s+(?:me\s+|us\s+)?(.+?)(?:,?\s+if you have (?:one|it|them|any))?[.!]?$/i.exec(first);
  if (m) return m[1].replace(/^(?:a|an|any)\s+/i, 'the ');
  // A prompt that describes the item, as the go-live configs do ("A copy of the car's registration papers (NaTIS
  // document).", "If the car was found damaged: a damage report from the panelbeater."): the item up to the first
  // comma, colon or bracket, as "the ...".
  if (item.kind === 'evidence' && !first.endsWith('?')) {
    const what = first.replace(/^if [^:]+:\s*/i, '').split(/,|:|\s\(/)[0].replace(/[.!]$/, '').trim();
    if (/^anything\b/i.test(what)) return 'that';
    const noun = what.replace(/^a copy of\s+/i, '').replace(/^(?:a|an|any|some|the)\s+/i, '');
    if (noun) return `the ${noun.charAt(0).toLowerCase()}${noun.slice(1)}`;
  }
  return 'the ' + words(item.key);
}
