// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/walkthrough.ts (commit c99946b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5168: Tina opens a short-term insurance claim on WhatsApp (SPEC-04 "Tina's claim walkthrough", steps 1 to 6).
// The first piece of the Insurance and Advice department package (SPEC-05). It imports nothing from the email
// pipeline, so it moves into the shared agent package (TTTFG-4830) as it is.
//
// The walkthrough is a state machine in code, not prompt text (TTTFG-5247): a prompt can skip or reorder what to do if
// anyone is hurt, and the order is the point. Claude only understands each answer (the Answer type) and may
// phrase each question; the fixed messages (what to do if anyone is hurt, unknown number, acknowledgement) are code text.
//
// Steps, in the story's order: find client -> confirm policy -> claim type -> what to gather at the scene, and ready
// -> what, when and where -> third parties, SAPS and injuries -> summary -> confirmed (the claim opens, FNOL logged).
// TTTFG-4830 (28 Oct 2026): "Is anyone hurt or in danger?" is no longer a question. The reply to the policy starts with
// what to do if anyone is (call 10111, come back once everyone is safe), so nobody waits on a yes before getting it.
// Once Tina knows the kind of claim, she sends what to gather while they are still at the scene (claim.ts
// onSceneText), once, and waits for the client to say they're ready before the questions about what happened.
//
// TTTFG-4830 (QC, 28 Oct 2026): a numbered list of questions is asked once. After a reply Tina can't read, the rest of
// that step is asked one question at a time (oneByOne), with Yes and No to tap: the same list again and again went in
// circles, because a bare "yes" to two yes/no questions answers neither. And the client can stop: "I'll carry on later"
// keeps what they said for when they're back; "I don't want to go on with this claim" asks once whether to stop, and a
// yes ends it with nothing logged.
//
// TTTFG-4830 (28 Oct 2026, TTT's feedback): Tina asks only what fits the claim. A windscreen or damage at home (not a
// theft) is never asked about the police or injuries; a burst geyser first asks whether the insurer should send a
// plumber. The policy list shows only the policies that fit the claim (a windscreen is a motor claim). "Cancel" at any
// step asks whether to stop, a second incident is left until this claim is done, and a question the client can't
// answer is asked twice at most, then left for the broker.
//
// Only a WhatsApp number on the CRM can open a claim (decided 9 October 2026): an unknown number gets the
// unknown-number reply, no claim and no follow-up. Tina never asks for an ID number or a policy number.
//
// Pure: no reads, no clock. claim.ts does the I/O.

/** One of the client's active riivo_policy rows, with its provider. Read once when the claim starts. */
export interface Policy {
  id: string;
  providerId: string;
  insurer: string;
  product: string;
  policyNumber: string;
  /** riivo_provider.riivo_assistnumber; empty when the insurer has none on file. */
  assistNumber?: string;
}

/** riivo_claim.riivo_claimtype. The values follow the go-live forms (TTTFG-5172) until TTTFG-4885 sets the choice. */
export const CLAIM_TYPES = [
  'Motor accident', 'Motor theft', 'Hijacking', 'Windscreen', 'Property loss or damage', 'Portable possessions', 'Other',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** What the client has told Tina about the incident so far. */
export interface Facts {
  claimType?: ClaimType;
  description?: string;
  /** Date and time of the incident, ISO 8601 with offset. */
  incidentAt?: string;
  /** Half of incidentAt, when the client gave only the date (YYYY-MM-DD, South African time) or only the time (HH:mm)
   *  so far. merge() joins them into incidentAt; Tina then asks only for the other half. Never sent to the CRM. */
  incidentDate?: string;
  incidentTime?: string;
  place?: string;
  thirdParties?: boolean;
  thirdPartyDetails?: string;
  saps?: boolean;
  injuries?: boolean;
  injuryDetails?: string;
  /**
   * TTTFG-4830 (28 Oct 2026): a burst geyser: whether the insurer sends a plumber ('insurer') or the client uses their
   * own ('own'). It's usually best that the insurer sends one. 'not-known': asked twice without an answer, so the
   * broker checks it with the client.
   */
  contractor?: 'insurer' | 'own' | 'not-known';
  /** TTTFG-4830: the client couldn't say what time it happened (asked twice). incidentAt holds 12:00 on the day. */
  timeUnknown?: true;
}
export type Fact = keyof Facts;

/** 'danger': a conversation saved before 28 Oct 2026 that was asked "Is anyone hurt or in danger?"; read as 'ready'. */
export type Step = 'policy' | 'ready' | 'danger' | 'claim-type' | 'incident' | 'parties' | 'summary';

/** Stored on the Tina conversation until the client confirms. */
export interface WalkthroughState {
  contactId: string;
  firstName: string;
  policies: Policy[];
  policyId?: string;
  step: Step;
  facts: Facts;
  /**
   * TTTFG-4830: how often each question has been asked (by askedKey), so Tina never sends the same words twice: the
   * second time is worded differently, with an example. The date and time count as one question.
   */
  asked?: Record<string, number>;
  /**
   * TTTFG-4830: how often each question was asked and the reply didn't answer it (by askedKey); giveUp() reads it. A
   * question asked again after the client answered part of a list, asked something, said "Carry on" or came back isn't
   * a miss.
   */
  misses?: Record<string, number>;
  /**
   * TTTFG-4830: the client's first words about it when too short to keep as the description ("Hi, my phone was
   * stolen"). Never sent to the CRM; read only to tell what kind of claim it is (isTheft), so Tina words her questions
   * for a stolen phone while she still asks for the whole story.
   */
  opening?: string;
  /** TTTFG-4830: the on-scene checklist has gone out (it goes once). */
  onSceneSent?: true;
  /**
   * TTTFG-4830: the insurer's assist line for a plumber has gone out: with the on-scene list of a burst geyser, or with
   * the plumber question when the geyser came out only after the list.
   */
  assistSent?: true;
  /** TTTFG-4830 (QC): the facts Tina's last question asked for; a bare "yes" or "no" answers only those. */
  lastAsked?: Fact[];
  /** TTTFG-4830 (QC): the step Tina asks one question at a time, after a reply to its list she couldn't read. */
  oneByOne?: Step;
  /** TTTFG-4830: the client said they'd carry on later. Their next message picks up where they stopped. */
  paused?: true;
  /** TTTFG-4830: the client said they don't want to go on with the claim, and Tina asked whether to stop. */
  stopping?: true;
  /**
   * TTTFG-4830 (28 Oct 2026): the client's active policies when `policies` holds only those that fit the claim (a
   * windscreen: the motor policies). A "no" to the one offered brings the others back.
   */
  allPolicies?: Policy[];
  /** TTTFG-4830: the policy was checked against the kind of claim once (it is never asked about again). */
  policyChecked?: true;
}

/** What Claude understood from the client's message. Code decides what happens next. */
export type Answer =
  | { kind: 'policy'; policyId: string }
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'facts'; facts: Facts }
  /** At the summary: the client says it is right. */
  | { kind: 'confirm' }
  /** At the summary: the client says something is wrong, with the new values when they gave them. */
  | { kind: 'correct'; facts: Facts; fields?: Fact[] }
  /**
   * TTTFG-4830 (28 Oct 2026): the client asked Tina something instead of answering. `help`: Claude's short answer about
   * Tina's question (what a word means, where to find it); absent: it's for the broker (cover, payment, advice).
   */
  | { kind: 'question'; question: string; help?: string }
  /** TTTFG-4830: "let me stop, I'll carry on later". */
  | { kind: 'pause' }
  /** TTTFG-4830: the client doesn't want to go on with this claim ("can we not continue with it?", "cancel"). */
  | { kind: 'stop' }
  /** TTTFG-4830: the client started telling Tina about another incident instead of answering. */
  | { kind: 'another' }
  | { kind: 'unclear' };

/** Something Tina says. 'ask' is a question Claude may phrase; the rest are fixed text. */
export type Say =
  /** `correcting`: the client said the summary is wrong; ask for the right value(s) instead of reading it again. */
  /** `tries`: how often each question in it was asked before this time (askedKey); absent or 0 is the first time. */
  /** `assist` (TTTFG-4830): the plumber question, with the insurer's assist line in front (WalkthroughState.assistSent). */
  | { kind: 'ask'; step: Step; missing: Fact[]; correcting?: true; tries?: Record<string, number>; assist?: true }
  /** TTTFG-4830: what to do if anyone is hurt or in danger. Said once, at the start of the reply to the policy. */
  | { kind: 'safety' }
  /** TTTFG-4830: the answer to the client's question about what Tina asked (Answer 'question'), before she asks again. */
  | { kind: 'help'; text: string }
  /** TTTFG-4830: the client's question is for the broker, who got it as a Follow-up. */
  | { kind: 'to-broker' }
  /**
   * TTTFG-4830: what to gather while still at the scene, for the kind of claim, ending with "tell me when you're ready"
   * (claim.ts onSceneText).
   */
  | { kind: 'on-scene' }
  | { kind: 'unknown-number' }
  /** TTTFG-4830: another incident: this claim first, then the other one. */
  | { kind: 'one-at-a-time' }
  /** TTTFG-4830: a question asked twice without an answer is left for the broker. */
  | { kind: 'not-known' }
  /** TTTFG-4830: the policy the client picked doesn't fit the kind of claim (`policyId`), so Tina asks again. */
  | { kind: 'policy-mismatch'; policyId: string }
  /** No active policy, or not the policy on file: a person will contact the client (date from the follow-up). */
  | { kind: 'passed-on'; reason: FollowUpReason }
  /** TTTFG-4830: fixed words in front of the next question ("Welcome back."). */
  | { kind: 'lead'; text: string }
  /** TTTFG-4830: "No problem. Send me a message when you're ready…" */
  | { kind: 'paused' }
  /** TTTFG-4830: "Would you like me to stop?", with Stop here and Carry on to tap. */
  | { kind: 'stop-ask'; again?: true }
  /** TTTFG-4830: stopped, nothing logged. */
  | { kind: 'stopped' };

/** 'client-question' (TTTFG-4830): the client asked something only a person can answer. */
export type FollowUpReason = 'no-active-policy' | 'policy-not-on-file' | 'client-question';

/** I/O the walkthrough asks for. claim.ts carries it out. */
export type Effect =
  /** A riivo_agentaction Follow-up. 'broker' = the chosen policy's owner, else the Insurance and Advice team. */
  /** `question`: the client's question, for 'client-question'. */
  | { kind: 'follow-up'; to: 'broker' | 'team'; reason: FollowUpReason; question?: string }
  | { kind: 'open-claim' };

export interface Turn {
  /** null when the walkthrough has ended (claim opened, or handed to a person). */
  state: WalkthroughState | null;
  say: Say[];
  effects: Effect[];
}

/** The facts each step needs, in order. A yes on third parties or injuries also needs the details. */
export function missingFor(step: Step, f: Facts, opening?: string): Fact[] {
  switch (step) {
    case 'claim-type':
      return f.claimType ? [] : ['claimType'];
    case 'incident': {
      const m: Fact[] = [];
      // TTTFG-4830 (28 Oct 2026): a burst geyser asks first, on its own (it's tapped), whether the insurer should send a plumber.
      if (isGeyser(f, opening) && !f.contractor) return ['contractor'];
      if (!f.description) m.push('description');
      if (!f.incidentAt) m.push(f.incidentDate ? 'incidentTime' : f.incidentTime ? 'incidentDate' : 'incidentAt');
      if (!f.place) m.push('place');
      return m;
    }
    case 'parties': {
      const m: Fact[] = [];
      if (f.thirdParties === undefined) m.push('thirdParties');
      else if (f.thirdParties && !f.thirdPartyDetails) m.push('thirdPartyDetails');
      if (f.saps === undefined) m.push('saps');
      if (f.injuries === undefined) m.push('injuries');
      else if (f.injuries && !f.injuryDetails) m.push('injuryDetails');
      return m;
    }
    default:
      return [];
  }
}

const FACT_STEPS: Step[] = ['claim-type', 'incident', 'parties'];

/** The first fact step with something missing, else the summary. Facts the client volunteers early are kept. */
function nextFactStep(f: Facts, opening?: string): Step {
  return FACT_STEPS.find((s) => missingFor(s, f, opening).length > 0) ?? 'summary';
}

const ask = (step: Step, f: Facts, opening?: string): Say => ({ kind: 'ask', step, missing: missingFor(step, f, opening) });

/** TTTFG-4830 (28 Oct 2026): words that say a geyser or a water pipe burst or leaked. */
const GEYSER_WORDS = /\b(geyser|water heater|burst pipe|pipe burst|burst water|water pipe|plumb)/i;

/** TTTFG-4830: damage at home from a burst geyser or pipe (not a theft). The insurer usually sends the plumber. */
export function isGeyser(f: Facts, opening?: string): boolean {
  return f.claimType === 'Property loss or damage' && !isTheft(f, opening) && GEYSER_WORDS.test(`${f.description ?? ''} ${opening ?? ''}`);
}

/**
 * TTTFG-4830 (28 Oct 2026, TTT's feedback): the parties questions that never fit this kind of claim, answered no without
 * asking. SAPS isn't involved in a windscreen or in damage at home, and nobody is hurt. Read once the client has said
 * what happened, when Tina gets to the parties step. Anyone else is still asked about: a neighbour's geyser or the
 * plumber who hit a pipe matters to the insurer (B3 asked to skip only the police and injuries).
 */
export function partiesNotAsked(f: Facts, opening?: string): Pick<Facts, 'saps' | 'injuries'> {
  const home = f.claimType === 'Property loss or damage' && !isTheft(f, opening);
  if (f.claimType !== 'Windscreen' && !home) return {};
  return { saps: false, injuries: false };
}

const MOTOR_TYPES: readonly ClaimType[] = ['Motor accident', 'Motor theft', 'Hijacking', 'Windscreen'];
const HOME_TYPES: readonly ClaimType[] = ['Property loss or damage', 'Portable possessions'];

/**
 * TTTFG-4830 (28 Oct 2026): whether the policy is the kind that covers this kind of claim, by its product name: a motor
 * policy for a car, a household (or all risks) policy for the home and things the client carries. undefined when the
 * name doesn't say, or the claim type isn't known: then any policy fits.
 */
export function policyFits(p: Policy, t?: ClaimType): boolean | undefined {
  if (!t) return undefined;
  const motor = /\b(motor|vehicle|car|auto)/i.test(p.product);
  const home = /\b(household|home|house|building|contents|property|all ?risks?|portable)/i.test(p.product);
  if (motor === home) return undefined;
  if (MOTOR_TYPES.includes(t)) return motor;
  if (HOME_TYPES.includes(t)) return home;
  return undefined;
}

/** The policies that fit the claim, when that leaves some out but not all; otherwise all of them. */
function fitting(policies: Policy[], t?: ClaimType): Policy[] {
  const fit = policies.filter((p) => policyFits(p, t) !== false);
  return fit.length ? fit : policies;
}

/** TTTFG-4830: a question that has been asked this often without an answer (WalkthroughState.misses) is left for the broker. */
export const MAX_ASKS = 2;

/** TTTFG-4830: what goes on the claim for a fact the client couldn't give after MAX_ASKS. Absent: Tina keeps asking. */
function notKnown(fact: Fact, f: Facts, opening?: string): Facts | undefined {
  switch (fact) {
    case 'incidentTime':
      return f.incidentDate ? { incidentTime: '12:00', timeUnknown: true } : undefined;
    case 'place':
    case 'thirdPartyDetails':
    case 'injuryDetails':
      return { [fact]: 'Not known' };
    case 'description':
      return { description: opening ?? 'Not given' };
    case 'claimType':
      return { claimType: 'Other' };
    case 'contractor':
      // No plumber is arranged: the broker checks with the client which they want.
      return { contractor: 'not-known' };
    default:
      return undefined;
  }
}

/** TTTFG-4830: the client said it happened at night ("last night"), not in the afternoon or evening. */
export const atNight = (said: string) => /\b(tonight|last night|at night)\b/i.test(said) && !/\b(afternoon|evening)\b/i.test(said);

/**
 * TTTFG-4830 (28 Oct 2026, from the client who wrote "I already told you"): a time with no part of the day is read
 * against what the client said about it. "Yesterday afternoon" then "6h00" is 18:00, not 06:00. A client who also said
 * "this morning" or "9am" ("parked at 9 this morning, gone this afternoon") keeps the morning.
 */
export function partOfDay(time: string, said: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  const later = /\b(afternoon|evening|tonight|last night)\b/i.test(said) && !/\bmorning\b|\d\s*a\.?m\b/i.test(said);
  if (!later || h === 0 || h >= 12) return time;
  // At night, 1 to 5 is early morning ("last night, around 2"); in the afternoon or evening any hour is after noon.
  if (atNight(said) && h < 6) return time;
  return `${String(h + 12).padStart(2, '0')}:${m[2]}`;
}

/**
 * The question a fact belongs to. The date and time asked together are "when"; asked for on their own, after part of
 * "when" came back, they count on from it ("Thanks. Roughly what time was that?", never "At roughly what time…" again).
 */
export const askedKey = (f: Fact): string => (f === 'incidentAt' ? 'when' : f === 'incidentTime' ? 'when-time' : f === 'incidentDate' ? 'when-date' : f);

/** TTTFG-4830: an ask, with how often each of its questions was asked before; the state counts this time. */
function counted(state: WalkthroughState, say: Say): { state: WalkthroughState; say: Say } {
  if (say.kind !== 'ask' || say.correcting) return { state, say };
  // TTTFG-4830 (QC): what this ask asks for, so a bare yes or no is read against it. Asked one at a time: the first.
  if (state.oneByOne === say.step && say.missing.length > 1) say = { ...say, missing: [say.missing[0]] };
  const lastAsked = FACT_STEPS.includes(say.step) ? say.missing : undefined;
  const keys = say.missing.length ? [...new Set(say.missing.map(askedKey))] : [say.step];
  // The summary is "the same question" only while it says the same: after a correction it's read out in full again.
  const counter = (k: string) => (k === 'summary' ? `summary:${JSON.stringify(state.facts)}` : k);
  const asked = { ...(state.asked ?? {}) };
  const after = (k: string) => ((k === 'when-time' || k === 'when-date') && (asked.when ?? 0) > 0 ? 1 : 0);
  const tries = Object.fromEntries(keys.map((k) => [k, (asked[counter(k)] ?? 0) + after(k)]));
  for (const k of keys) asked[counter(k)] = (asked[counter(k)] ?? 0) + 1;
  const { lastAsked: _l, ...rest } = state;
  return { state: { ...rest, asked, ...(lastAsked ? { lastAsked } : {}) }, say: { ...say, tries } };
}

/** TTTFG-4830: words that say something was stolen (with the claim type, isTheft decides). */
const THEFT_WORDS = /\b(stole|stolen|steal|theft|thief|thieves|burglar|burglary|broke in|broke into|broken into|break[- ]?in|robbed|robbery|hijack|mugged|pickpocket|snatched|grabbed|took|taken)/i;

/**
 * TTTFG-4830: a theft, break-in or hijacking. Someone else is always involved, so Tina doesn't ask whether anyone else
 * was ("for example another driver" makes no sense after a break-in); she asks what the client knows about who did it,
 * and whether it was reported to the police.
 */
export function isTheft(f: Facts, opening?: string): boolean {
  if (f.claimType === 'Motor theft' || f.claimType === 'Hijacking') return true;
  return !!f.claimType && ['Property loss or damage', 'Portable possessions', 'Other'].includes(f.claimType)
    && THEFT_WORDS.test(`${f.description ?? ''} ${opening ?? ''}`);
}

/**
 * `correcting`: the client put it right at the summary. A time is then taken as they gave it: the summary read back
 * the part of the day Tina worked out, and "no, 6 in the morning" means 06:00.
 */
function merge(f: Facts, more: Facts, opening?: string, correcting = false): Facts {
  const out: Facts = { ...f };
  for (const [k, v] of Object.entries(more) as [Fact, Facts[Fact]][]) {
    if (v === undefined || v === '') continue;
    (out as Record<Fact, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (more.incidentTime && !correcting) out.incidentTime = partOfDay(more.incidentTime, `${out.description ?? ''} ${opening ?? ''}`);
  if ((more.incidentTime || more.incidentAt) && !more.timeUnknown) delete out.timeUnknown;
  if (out.claimType && !CLAIM_TYPES.includes(out.claimType)) delete out.claimType;
  if (isTheft(out, opening)) out.thirdParties = true;
  // A no clears the details that only a yes needs.
  if (out.thirdParties === false) delete out.thirdPartyDetails;
  if (out.injuries === false) delete out.injuryDetails;
  joinWhen(out, more);
  return out;
}

const SAST = '+02:00'; // South Africa has no daylight saving.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * A South African date and time as an ISO instant. TTTFG-4830: "24:00" is midnight at the end of that date (Claude
 * writes "yesterday at midnight" as yesterday 24:00), so it becomes 00:00 the next day: the night the client meant.
 */
export function sastInstant(date: string, time: string): string {
  if (time !== '24:00') return `${date}T${time}:00${SAST}`;
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${next}T00:00:00${SAST}`;
}

/** Joins a date and a time given in different messages into incidentAt. A new date alone keeps the time already on
 *  file, and the other way round ("no, it was the 2nd"). A whole incidentAt in `more` wins. */
function joinWhen(out: Facts, more: Facts): void {
  if (more.incidentAt) {
    delete out.incidentDate;
    delete out.incidentTime;
    return;
  }
  const prev = out.incidentAt ? sastParts(out.incidentAt) : undefined;
  const date = out.incidentDate ?? prev?.date;
  const time = out.incidentTime ?? prev?.time;
  if (date && DAY.test(date) && time && TIME.test(time)) {
    out.incidentAt = sastInstant(date, time);
    delete out.incidentDate;
    delete out.incidentTime;
  }
}

/**
 * TTTFG-4830 (voice notes): the client can answer by voice note as well as by typing. Said once in the walkthrough (with
 * the first "what happened" question) and once in the follow-on (with the first batch of the insurer's questions).
 */
export const VOICE_OR_TEXT = 'You can type your answers or send a voice note.';

/**
 * TTTFG-4830 (voice notes): told to Claude with a message that is the transcript of a WhatsApp voice note (the host
 * transcribes it). Speech recognition mishears letters and digits, so a registration or ID number that came out garbled
 * is left for Tina to ask again rather than read into a value; followon.ts says back what was saved.
 */
export const SPOKEN_HELP = `The client recorded this message as a voice note; <client_message> is what speech recognition made of it.
- Read it for what the client meant: it may have no punctuation, filler words ("um", "ja", "so ja"), a misheard word or
  numbers written as words.
- A client who corrects themselves while speaking ("on the Tuesday, no sorry, the Wednesday") means the last value.
- Write numbers, amounts and letters the usual way: "C A one two three four five six" is "CA 123456", "twelve thousand
  five hundred rand" is 12500, "C for Charlie" is C.
- Copy a registration, ID, policy, account or phone number exactly as the transcript has it; never add or change a
  character. When one is plainly incomplete or garbled, leave it out (null), so Tina asks for it again.
- The client may speak Afrikaans or another South African language, or mix languages. Give a text answer in English,
  with names, places and numbers as they said them.`;

/** TTTFG-4830 (28 Oct 2026, TTT's feedback): Tina's answer to "What happens next?". */
export const WHAT_NEXT = 'A broker at TTT will check your claim and register it with your insurer. The insurer will then contact you, or send someone to assess the damage. We\'ll keep you updated here.';

/**
 * TTTFG-4830 (28 Oct 2026): told to Claude with every client message (understand.ts, reply.ts). The client may ask
 * Tina something instead of answering. Claude may explain what Tina asked, in a sentence or two; anything about cover,
 * payment, the insurer's decision or advice goes to the broker. The gate (gate.ts) checks the answer like any text.
 */
export const QUESTION_HELP = `The client may ask Tina something instead of answering: what a word means, why she needs it, where to find it,
what to do if they don't have it, or they may say they want to change something they told her. Then use kind
"question", set clientQuestion to what they asked (short, in their words), and:
- explain: Tina's answer to what the client actually asked, when it is about the claim's questions or documents (what
  a word means, why it's needed, where to find something, what to do if they don't have it): one or two short
  sentences, under 35 words, in everyday words (no dashes), as Tina ("I"). For example what a NaTIS document is and
  where to find it, that a licence number is on the front of the licence card, that a rough time is fine, or that they
  can tell her the change now. Say only what you're sure of. Tina asks her question again after it, so don't repeat it.
- "What happens next?", "when will I hear?" or "what now?" (TTTFG-4830, 28 Oct 2026): explain with exactly this:
  "${WHAT_NEXT}"
- forBroker: true, with explain null, when the question is about anything else: whether the claim is covered, will be
  paid or approved, amounts, the excess, the policy's terms, what the insurer will decide, or advice. Never answer
  those, and never state a fact about the client's claim or policy that isn't in this conversation.
A message that answers Tina's question is never kind "question", even if it ends with "?" or also asks something.`;

/** TTTFG-4830: the fixed words of stopping and carrying on later (DRAFT WORDING, as the rest of the walkthrough's). */
export const PAUSED_TEXT = "No problem. Send me a message when you're ready, and we'll carry on from where we stopped.";
export const STOP_QUESTION = "Would you like me to stop? I haven't logged a claim yet, so nothing goes to your insurer.";
export const STOP_AGAIN = "Sorry, I didn't quite get that. Should I stop, or carry on with your claim?";
export const STOPPED_TEXT = "No problem, I've stopped, and no claim was logged. If you want to report something later, just send me a message.";
export const WELCOME_BACK = 'Welcome back.';
/** TTTFG-4830 (QC): said only when Tina couldn't read the reply (not because a question is asked again). */
export const NOT_UNDERSTOOD = "Sorry, I didn't quite get that.";
export const CARRY_ON = "No problem, let's carry on.";

/**
 * TTTFG-4830 (QC): told to Claude with every walkthrough message (understand.ts). A client who wants out says so in
 * many ways, often as a question; before, "Can we not continue with this claim?" went to the broker as a question and
 * Tina asked for the summary again.
 */
export const STOP_HELP = `The client may not want to go on with Tina's questions right now:
- kind "stop": they don't want to go on reporting this claim at all, even when they say it as a question ("can we not
  continue with this claim?"): they want to cancel it, say it isn't a real claim or is fraud, or started it by mistake.
- kind "pause": they want to stop for now and carry on later ("let me stop, we'll continue later", "I'm driving").
A message that answers Tina's question is never "stop" or "pause".`;

/** TTTFG-4830: Claude's answer to the client's question, when it's short enough to be one; otherwise the broker's. */
export function questionHelp(explain: unknown): string | undefined {
  const t = typeof explain === 'string' ? explain.trim() : '';
  return t && t.length <= 400 ? t : undefined;
}

/** The South African date and time of an ISO instant. */
export function sastParts(iso: string): { date: string; time: string } {
  const local = new Date(new Date(iso).getTime() + 2 * 3600_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/**
 * Step 1: the sender's WhatsApp number against the CRM, then the client's active policies. `known`: what the client
 * already said about this incident (TTTFG-5184: the message that made Tina ask "Is this a new claim?"; TTTFG-4830: the
 * first message, read before the policy question), so the later steps don't ask it again. `opening`: a first message
 * too short to keep as the description (WalkthroughState.opening). TTTFG-4830 (28 Oct 2026): when the kind of claim is
 * known, only the policies that fit it are offered.
 */
export function start(contact: { id: string; firstName: string } | null, policies: Policy[], known: Facts = {}, opening?: string): Turn {
  if (!contact) return { state: null, say: [{ kind: 'unknown-number' }], effects: [] };
  if (policies.length === 0) {
    return {
      state: null,
      say: [{ kind: 'passed-on', reason: 'no-active-policy' }],
      effects: [{ kind: 'follow-up', to: 'team', reason: 'no-active-policy' }],
    };
  }
  const facts = merge({}, known, opening);
  const offered = fitting(policies, facts.claimType);
  const state: WalkthroughState = {
    contactId: contact.id, firstName: contact.firstName, policies: offered, step: 'policy', facts,
    ...(opening ? { opening } : {}), ...(offered.length < policies.length ? { allPolicies: policies } : {}),
  };
  const first = counted(state, ask('policy', {}));
  return { state: first.state, say: [first.say], effects: [] };
}

/**
 * TTTFG-4830: a whole message that only asks to stop the claim ("cancel", "Cancel request please", "I want to cancel my
 * claim"). Read without a model. Anything more goes to Claude: "my policy was cancelled", "don't cancel my claim", "can
 * I cancel it later?", or "cancel that, it was at 3pm" (a correction).
 */
export const CANCEL_WORDS = /^\W*(please\s+)?(i\s*(want|would like|'?d like)\s+to\s+)?((cancel|withdraw)(\s+(it|this|that|(my|the|this)\s+(claim|request)|request))?|stop\s+(my|the|this)\s+(claim|request))(\s+please)?[\s.!]*$/i;

/** One client message. */
export function advance(state: WalkthroughState, answer: Answer): Turn {
  const askIn = (s: WalkthroughState, before: Say[] = []): Turn => {
    // TTTFG-4830 (28 Oct 2026): at the parties step, what never fits this kind of claim is answered without asking. What
    // the client already said stays: a windscreen client who said the glass cut them keeps the injury.
    if (s.step === 'parties') {
      const skip = Object.entries(partiesNotAsked(s.facts, s.opening)).filter(([k]) => s.facts[k as Fact] === undefined);
      const facts = merge(s.facts, Object.fromEntries(skip), s.opening);
      s = { ...s, facts, step: nextFactStep(facts, s.opening) };
    }
    const c = counted(s, ask(s.step, s.facts, s.opening));
    // TTTFG-4830: a geyser that came out only after the on-scene list gets the insurer's assist line with the plumber question.
    if (c.say.kind === 'ask' && c.say.missing.includes('contractor') && !s.assistSent) {
      return { state: { ...c.state, assistSent: true }, say: [...before, { ...c.say, assist: true }], effects: [] };
    }
    return { state: c.state, say: [...before, c.say], effects: [] };
  };
  const same = (): Turn => askIn(state);
  // TTTFG-4830 (QC): a reply Tina couldn't read. She says so, and the rest of a list of questions goes one at a time.
  const missed = (s: WalkthroughState): Turn => askIn({ ...s, oneByOne: s.step }, [{ kind: 'lead', text: NOT_UNDERSTOOD }]);
  // The safety line goes with the first reply to the policy question only, not when Tina asks again after a mismatch.
  const safety = (): Say[] => (state.onSceneSent || state.policyChecked ? [] : [{ kind: 'safety' }]);
  // TTTFG-4830: once the kind of claim is known, the on-scene checklist (once), and Tina waits for "ready" before the
  // questions about what happened. Until it's known, the claim type is asked first. A policy that doesn't fit the kind
  // of claim (a break-in on the motor policy) is checked once, against the policies that do.
  const toReady = (s: WalkthroughState, before: Say[] = []): Turn => {
    if (!s.facts.claimType) return askIn({ ...s, step: 'claim-type' }, before);
    const chosen = s.policies.find((p) => p.id === s.policyId);
    const all = s.allPolicies ?? s.policies;
    if (chosen && !s.policyChecked && policyFits(chosen, s.facts.claimType) === false && all.some((p) => policyFits(p, s.facts.claimType) !== false)) {
      const offered = fitting(all, s.facts.claimType);
      const { policyId: _p, ...rest } = s;
      return askIn({ ...rest, step: 'policy', policies: offered, allPolicies: all, policyChecked: true }, [...before, { kind: 'policy-mismatch', policyId: chosen.id }]);
    }
    if (s.onSceneSent) return askIn({ ...s, step: nextFactStep(s.facts, s.opening) }, before);
    const assist = isGeyser(s.facts, s.opening) ? { assistSent: true as const } : {};
    return { state: { ...s, step: 'ready', onSceneSent: true, ...assist }, say: [...before, { kind: 'on-scene' }], effects: [] };
  };

  // TTTFG-4830 (QC): Tina asked whether to stop. Yes ends the walkthrough with nothing logged; no carries on.
  if (state.stopping) {
    const { stopping: _s, ...on } = state;
    if (answer.kind === 'yes' || answer.kind === 'stop') return { state: null, say: [{ kind: 'stopped' }], effects: [] };
    if (answer.kind === 'no') return askIn(on, [{ kind: 'lead', text: CARRY_ON }]);
    if (answer.kind === 'pause') return { state: { ...on, paused: true }, say: [{ kind: 'paused' }], effects: [] };
    return { state, say: [{ kind: 'stop-ask', again: true }], effects: [] };
  }
  if (answer.kind === 'stop') {
    const { paused: _p, ...on } = state;
    return { state: { ...on, stopping: true }, say: [{ kind: 'stop-ask' }], effects: [] };
  }
  if (answer.kind === 'pause') return { state: { ...state, paused: true }, say: [{ kind: 'paused' }], effects: [] };
  if (state.paused) {
    const { paused: _p, ...back } = state;
    // Back after "I'll carry on later": a "hi" isn't a miss on the question; Tina asks it again.
    if (answer.kind === 'unclear') return askIn(back, [{ kind: 'lead', text: WELCOME_BACK }]);
    return advance(back, answer);
  }
  // TTTFG-4830: another incident in the middle of this one: this claim first. It isn't a miss.
  if (answer.kind === 'another') {
    const t = same();
    return { ...t, say: [{ kind: 'one-at-a-time' }, ...t.say] };
  }

  // TTTFG-4830: a question about what Tina asked gets its short answer, a question only a person can answer goes to the
  // broker; then she asks again. It isn't a miss, and nothing the client told her changes.
  if (answer.kind === 'question') {
    const t = same();
    if (answer.help) return { ...t, say: [{ kind: 'help', text: answer.help }, ...t.say] };
    return { ...t, say: [{ kind: 'to-broker' }, ...t.say], effects: [{ kind: 'follow-up', to: 'broker', reason: 'client-question', question: answer.question }] };
  }

  switch (state.step) {
    case 'policy': {
      const only = state.policies.length === 1 ? state.policies[0] : undefined;
      const chosen =
        answer.kind === 'policy' ? state.policies.find((p) => p.id === answer.policyId)
        : answer.kind === 'yes' ? only
        : undefined;
      if (chosen) return toReady({ ...state, policyId: chosen.id }, safety());
      if (answer.kind === 'no' && state.allPolicies) {
        // TTTFG-4830: not the one (or none of those) that fit: the client's other policies, and no second check. The
        // safety line comes with them, as it would with a choice.
        const { allPolicies, ...rest } = state;
        return askIn({ ...rest, policies: allPolicies, policyChecked: true }, safety());
      }
      if (answer.kind === 'no' && only) {
        // Not the policy on file: TTT doesn't hold it, so a person takes it from here.
        return {
          state: null,
          say: [{ kind: 'passed-on', reason: 'policy-not-on-file' }],
          effects: [{ kind: 'follow-up', to: 'team', reason: 'policy-not-on-file' }],
        };
      }
      return same();
    }

    case 'danger':
      // Asked "Is anyone hurt or in danger?" before 28 Oct 2026: whatever the answer, what to do if anyone is, then on.
      return toReady({ ...state, step: 'ready' }, [{ kind: 'safety' }]);

    case 'ready': {
      // Anything but a "not yet" moves on; what happened, when or where, if the client already said it, is kept.
      if (answer.kind === 'no') return same();
      const facts = answer.kind === 'facts' ? merge(state.facts, answer.facts, state.opening) : state.facts;
      return askIn({ ...state, facts, step: nextFactStep(facts, state.opening) });
    }

    case 'claim-type':
    case 'incident':
    case 'parties': {
      if (answer.kind !== 'facts') {
        const s = missedOn(state);
        return giveUp(s) ?? missed(s);
      }
      const facts = merge(state.facts, answer.facts, state.opening);
      if (state.step === 'claim-type' && facts.claimType) return toReady({ ...state, facts });
      // Nothing new (Claude repeated what Tina already had): a miss too.
      if (sameFacts(facts, state.facts)) {
        const s = missedOn(state);
        return giveUp(s) ?? missed(s);
      }
      // The client answered something else, and nothing Tina asked: a miss, and left for the broker after the second.
      // An answer to part of her list is the client getting on with it ("1. what happened" now, "2. when" next).
      const next = nextFactStep(facts, state.opening);
      const open = missingFor(state.step, facts, state.opening);
      const asked = state.lastAsked ?? missingFor(state.step, state.facts, state.opening);
      if (next === state.step && !asked.some((f) => !open.includes(f))) {
        const s = missedOn({ ...state, facts });
        return giveUp(s) ?? askIn(s);
      }
      return askIn({ ...state, facts, step: next });
    }

    case 'summary': {
      if (answer.kind === 'confirm') {
        // TTTFG-4830: a walkthrough saved before a question was added (a burst geyser's plumber) is asked it first.
        const step = nextFactStep(state.facts, state.opening);
        if (step !== 'summary') return askIn({ ...state, step });
        return { state: null, say: [], effects: [{ kind: 'open-claim' }] };
      }
      if (answer.kind === 'correct' || answer.kind === 'facts') {
        const facts = reaskParties(state, merge(state.facts, answer.facts, state.opening, true), answer.facts);
        // TTTFG-4830: a different kind of claim is checked against the policy, as it was the first time.
        if (facts.claimType !== state.facts.claimType && state.onSceneSent) return toReady({ ...state, facts });
        const step = nextFactStep(facts, state.opening);
        // Only a value that differs from what is on file is a correction. The model may repeat known values alongside
        // "the date is wrong" (seen 21 Oct 2026); that is not a new date, so Tina asks for it.
        const changed = !sameFacts(facts, state.facts);
        if (step !== 'summary') return askIn({ ...state, facts, step });
        if (!changed) {
          // "No, the date is wrong": ask for the right value. No claim yet.
          const fields = answer.kind === 'correct' && answer.fields?.length ? answer.fields : [];
          return { state: { ...state, facts }, say: [{ kind: 'ask', step: 'summary', missing: fields, correcting: true }], effects: [] };
        }
        return askIn({ ...state, facts, step: 'summary' });
      }
      return same();
    }
  }

  /**
   * TTTFG-4830 (28 Oct 2026, TTT's feedback: Tina "kept on asking the same question"): the facts of this step asked
   * MAX_ASKS times without an answer (misses) get what notKnown() puts on the claim, and Tina says the broker will check
   * them. undefined when nothing was missed that often, or nothing can stand in for it (the date, a yes or no).
   */
  function giveUp(s: WalkthroughState): Turn | undefined {
    const missing = missingFor(s.step, s.facts, s.opening);
    const stand: Facts = {};
    for (const f of missing) {
      if ((s.misses?.[askedKey(f)] ?? 0) < MAX_ASKS) continue;
      Object.assign(stand, notKnown(f, s.facts, s.opening) ?? {});
    }
    if (!Object.keys(stand).length) return undefined;
    const facts = merge(s.facts, stand, s.opening);
    const next = { ...s, facts };
    if (s.step === 'claim-type' && facts.claimType) return toReady(next, [{ kind: 'not-known' }]);
    return askIn({ ...next, step: nextFactStep(facts, s.opening) }, [{ kind: 'not-known' }]);
  }
}

function sameFacts(a: Facts, b: Facts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Fact>;
  return [...keys].every((k) => a[k] === b[k]);
}

/** TTTFG-4830: a reply that answered none of what Tina asked: one miss more on each of it (giveUp). */
function missedOn(s: WalkthroughState): WalkthroughState {
  const misses = { ...(s.misses ?? {}) };
  for (const k of new Set((s.lastAsked ?? missingFor(s.step, s.facts, s.opening)).map(askedKey))) misses[k] = (misses[k] ?? 0) + 1;
  return { ...s, misses };
}

/**
 * TTTFG-4830: a correction at the summary to a kind of claim that needs the police or injury question its old kind
 * never asked (a windscreen that was a car accident): the no filled in for the old kind goes, so Tina asks it.
 */
function reaskParties(s: WalkthroughState, facts: Facts, said: Facts): Facts {
  const before = partiesNotAsked(s.facts, s.opening);
  const after = partiesNotAsked(facts, s.opening);
  const out = { ...facts };
  for (const k of ['saps', 'injuries'] as const) {
    if (before[k] === false && after[k] === undefined && out[k] === false && said[k] === undefined && !s.asked?.[k]) delete out[k];
  }
  return out;
}

/** The facts are complete: everything the claim row needs from the client. */
export function complete(state: WalkthroughState): state is WalkthroughState & { policyId: string } {
  return !!state.policyId && FACT_STEPS.every((s) => missingFor(s, state.facts, state.opening).length === 0);
}
