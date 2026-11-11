// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/formfacts.ts (commit 60aee91). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5562 (2 Nov 2026): when the guided form is on, Tina sends the link right after the policy and the kind of claim, so
// what the walkthrough used to ask (what happened, when, where, who else) is asked on the form. These are those questions.
// The answers go where every answer goes (riivo_answers), and also onto the claim's own columns (factColumns), because the
// insurer's form, the broker's view and the conditions on the form's questions read the claim.
import type { ClaimAnswers, ClaimForm, QuestionItem } from './contracts';
import { OWN_PLUMBER_NOTE } from './claim';
import { isTheft, type Facts } from './walkthrough';

/** Saved on a claim opened for the form: what the walkthrough asks is still to come, on the form or on chat. */
export const OPENED_FOR_FORM_KEY = 'guidedOpenedForForm';
export const factsMissing = (f: Facts) => [f.incidentAt, f.place, f.description, f.thirdParties, f.saps, f.injuries].some((v) => v === undefined || v === null || v === '');

/** What the claim's columns can hold from the form. */
export type FactColumns = Pick<Facts, 'incidentAt' | 'place' | 'description' | 'thirdParties' | 'thirdPartyDetails' | 'saps' | 'injuries' | 'injuryDetails'>;

const q = (key: string, prompt: string, answerType: QuestionItem['answerType'], required: boolean): QuestionItem => ({ key, kind: 'question', prompt, answerType, required });

const HAPPENED: readonly QuestionItem[] = [
  q('incidentAt', 'On what date and at roughly what time did it happen?', 'date', true),
  q('place', 'Where did it happen?', 'text', true),
  q('description', 'Please tell me in your own words what happened.', 'text', true),
];
export const THIRD_PARTIES = q('thirdParties', 'Was anyone else involved?', 'yes/no', false);
export const INJURIES = q('injuries', 'Was anyone hurt?', 'yes/no', false);
/** Who was hurt, on a form with no card per person hurt (a hijacking): what the walkthrough asks on chat after a yes. */
export const INJURY_DETAILS: QuestionItem = { ...q('injuryDetails', 'Who was hurt, and how?', 'text', false), onlyIf: { key: 'injuries', equals: true } };
export const SAPS_INVOLVED = q('saps', 'Was it reported to the police?', 'yes/no', false);

/** A burst geyser or pipe: it's usually best that the insurer sends the plumber, so the broker hears at once. */
export const BURST_KEY = 'burstPipe';
export const CONTRACTOR_KEY = 'contractor';
export const INSURERS_PLUMBER = "Insurer's plumber";
export const OWN_PLUMBER = 'My own plumber';
const PLUMBER: readonly QuestionItem[] = [
  q(BURST_KEY, 'Did a geyser or a water pipe burst?', 'yes/no', false),
  { ...q(CONTRACTOR_KEY, "Who should fix it? It's usually best that the insurer sends one.", 'choice', false), choices: [INSURERS_PLUMBER, OWN_PLUMBER], onlyIf: { key: BURST_KEY, equals: true } },
];

const has = (form: ClaimForm, key: string) => form.questionList.some((i) => i.key === key);

/** Before the first of the group's questions, so its count of people comes right above their cards. */
function beforeGroup(list: QuestionItem[], lead: QuestionItem, group: string): void {
  const at = list.findIndex((i) => i.group === group);
  if (at >= 0) list.splice(at, 0, lead);
  else list.push(lead);
}

/**
 * The form's list with what the walkthrough asks. Everything on the list is asked: `formOnly` is for a claim whose walkthrough
 * already asked the general questions. `known`: facts already on the claim aren't added, for the chat, which never asks twice;
 * the form passes 'show', so a client can check what Tina understood.
 */
export function withFacts<F extends ClaimForm>(form: F, claim: { claimType: string; facts: Facts; opening?: string }, known: 'skip' | 'show'): F {
  const wanted = (i: QuestionItem) => !has(form, i.key) && (known === 'show' || (claim.facts as Record<string, unknown>)[i.key] === undefined);
  const list: QuestionItem[] = form.questionList.map(({ formOnly: _f, ...i }) => i);
  const home = claim.claimType === 'Property loss or damage' && !isTheft(claim.facts, claim.opening);
  list.unshift(...HAPPENED.filter(wanted));
  if (wanted(THIRD_PARTIES)) beforeGroup(list, THIRD_PARTIES, 'otherParties');
  if (wanted(INJURIES)) beforeGroup(list, INJURIES, 'injured');
  const hurtCards = (form.questionGroups ?? []).some((g) => g.key === 'injured');
  if (!hurtCards && wanted(INJURY_DETAILS)) {
    const at = list.findIndex((i) => i.key === INJURIES.key);
    list.splice(at >= 0 ? at + 1 : list.length, 0, INJURY_DETAILS);
  }
  if (wanted(SAPS_INVOLVED)) {
    const at = list.findIndex((i) => i.key.startsWith('sapsCase') || i.key.startsWith('sapsDate') || i.key.startsWith('sapsStation'));
    if (at >= 0) list.splice(at, 0, SAPS_INVOLVED);
    else list.push(SAPS_INVOLVED);
  }
  if (home) list.splice(HAPPENED.filter(wanted).length, 0, ...PLUMBER.filter(wanted));
  return { ...form, questionList: list } as F;
}

const SAST = '+02:00';
/** "2026-11-02 14:30" as the form saves it, or a date alone (midday, as the walkthrough does for a time not known). */
export function incidentIso(v: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v.trim());
  if (!m) return undefined;
  const iso = `${m[1]}T${m[2] ?? '12:00'}:00${SAST}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** One line per person, from the answers on their card: what the claim's "details" column holds for the broker. */
function entriesOf(form: ClaimForm, group: string, answers: ClaimAnswers): string | undefined {
  const members = form.questionList.filter((i) => i.group === group).map((i) => i.key);
  const max = form.questionGroups?.find((g) => g.key === group)?.max ?? 0;
  const lines: string[] = [];
  for (let n = 1; n <= max; n++) {
    const parts = members.flatMap((k) => {
      const a = answers[`${k}.${n}`];
      return a?.status === 'answered' && (typeof a.value === 'string' || typeof a.value === 'number') ? [String(a.value)] : [];
    });
    if (parts.length) lines.push(parts.join(', '));
  }
  return lines.length ? lines.join('; ') : undefined;
}

/**
 * What the answers say for the claim's own columns, where that differs from what the claim holds. A blank never clears a
 * column: the client may just have skipped it.
 */
export function factColumns(form: ClaimForm, facts: Facts, answers: ClaimAnswers): Partial<FactColumns> {
  const out: Partial<FactColumns> = {};
  const said = (key: string) => (answers[key]?.status === 'answered' ? answers[key].value : undefined);
  const when = said('incidentAt');
  if (typeof when === 'string') {
    const iso = incidentIso(when);
    if (iso && (!facts.incidentAt || Date.parse(iso) !== Date.parse(facts.incidentAt))) out.incidentAt = iso;
  }
  const place = said('place');
  if (typeof place === 'string' && place.trim() && place !== facts.place) out.place = place.trim();
  const text = said('description');
  const own = said(CONTRACTOR_KEY) === OWN_PLUMBER ? ` (${OWN_PLUMBER_NOTE})` : '';
  const base = typeof text === 'string' && text.trim() ? text.trim() : facts.description;
  if (base && !base.includes(OWN_PLUMBER_NOTE) && `${base}${own}` !== facts.description) out.description = `${base}${own}`;
  for (const key of ['thirdParties', 'saps', 'injuries'] as const) {
    const v = said(key);
    if (typeof v === 'boolean' && v !== facts[key]) out[key] = v;
  }
  // A count taken back to nobody takes the details with it.
  const others = said('thirdParties') === false ? '' : entriesOf(form, 'otherParties', answers);
  if (others !== undefined && others !== (facts.thirdPartyDetails ?? '')) out.thirdPartyDetails = others;
  const told = said(INJURY_DETAILS.key);
  const hurt = said('injuries') === false ? '' : typeof told === 'string' && told.trim() ? told.trim() : entriesOf(form, 'injured', answers);
  if (hurt !== undefined && hurt !== (facts.injuryDetails ?? '')) out.injuryDetails = hurt;
  return out;
}

/** The Follow-up that goes once the client asks for the insurer's plumber, as openClaim does on chat. */
export const plumberAsked = (before: ClaimAnswers, after: ClaimAnswers) =>
  after[CONTRACTOR_KEY]?.value === INSURERS_PLUMBER && before[CONTRACTOR_KEY]?.value !== INSURERS_PLUMBER;
export const plumberDetail = (reference: string, insurer: string) =>
  `Claim ${reference}: the client asked on the claim form for ${insurer} to send a plumber. Please arrange it with the insurer.`;
